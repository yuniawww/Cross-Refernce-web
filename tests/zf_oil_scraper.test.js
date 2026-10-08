const { renderHtml, publicConfigScript } = require('../public_config');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { launchBrowser } = require('../browser');
const { parseOilQueries, extractOilProducts, extractOilOeSection, clickOilProduct, readOilDetails } = require('../zf_oil_scraper');
const { waitForZfSearchOutcome } = require('../zf_scraper');

test('oil queries preserve model suffixes and support models without digits', () => {
    assert.deepEqual(parseOilQueries([' LifeguardFluid 9\nLifeguardFluid 9.1', 'lifeguardfluid 9', 'ZF LifeguardFluid CVT']), [
        { input: 'LifeguardFluid 9', candidates: ['LifeguardFluid 9'] },
        { input: 'LifeguardFluid 9.1', candidates: ['LifeguardFluid 9.1'] },
        { input: 'ZF LifeguardFluid CVT', candidates: ['ZF LifeguardFluid CVT'] }
    ]);
});

test('oil search reads the ZF number only when the first visible title contains the query', () => {
    const link = (title, number, style = {}) => {
        const details = { querySelectorAll: () => [
            { textContent: 'ZF' }, { textContent: number }
        ] };
        return {
            textContent: title, href: `https://aftermarket.zf.com/cn/catalog/products/${number}?srv=y&producttype=00`,
            isConnected: true, getClientRects: () => [1], querySelectorAll: () => [], style,
            closest: () => ({ querySelector: () => details })
        };
    };
    const first = link('自动变速器机油 | ZF LifeguardFluid 9', 'AA01.500.001');
    const second = link('自动变速器机油 | ZF LifeguardFluid 9.1', 'AA01.500.002');
    const evaluate = (links, query, returnLink = false, expectedUrl = '') => vm.runInNewContext(
        `(${extractOilProducts.toString()})(query, returnLink, expectedUrl)`, {
            query, returnLink, expectedUrl, URL, location: new URL('https://aftermarket.zf.com/cn/catalog/'),
            document: { querySelectorAll: () => links },
            getComputedStyle: element => ({ display: 'block', visibility: 'visible', ...element.style })
        });
    const products = evaluate([first, second], 'LifeguardFluid 9');
    assert.equal(products.length, 2);
    assert.equal(products[0].partNumber, 'AA01.500.001');
    assert.equal(products[0].zfNumber, 'AA01.500.001');
    assert.equal(products[0].model, 'LifeguardFluid 9');
    assert.equal(products[0].url, first.href);
    assert.equal(products[1].partNumber, 'AA01.500.002');
    assert.equal(evaluate([first, second], 'LifeguardFluid 9', true, first.href), first);
    assert.deepEqual(Array.from(evaluate([link('自动变速器机油 | ZF LifeguardFluid 8', 'AA01.500.008'), first], 'LifeguardFluid 9')), []);
    assert.deepEqual(Array.from(evaluate([link('维修套件 | ZF LifeguardFluid 9', 'KIT'), first], 'LifeguardFluid 9')), []);
    assert.equal(evaluate([link('双离合变速器油 | ZF LifeguardFluid 8.3 DCT', 'AA01.500.083')], 'LifeguardFluid 8.3')[0].partNumber, 'AA01.500.083');
});

test('oil click reacquires the exact model after its result node is replaced', async () => {
    const product = { partNumber: 'AA01.500.001', model: 'LifeguardFluid 9', title: '自动变速器机油 | ZF LifeguardFluid 9', url: 'https://aftermarket.zf.com/zh/catalog/products/AA01.500.001' };
    let opened = false;
    let handles = 0;
    let disposed = 0;
    let clicked = 0;
    const frame = {
        evaluate: async () => opened,
        evaluateHandle: async (fn, model, returnLink, url) => {
            assert.equal(fn, extractOilProducts);
            assert.equal(model, product.model);
            assert.equal(returnLink, true);
            assert.equal(url, product.url);
            handles++;
            const number = handles;
            return { asElement: () => ({
                click: async () => { clicked++; throw new Error('Node is detached from document'); },
                evaluate: async () => { clicked++; assert.equal(number, 2); opened = true; }
            }), dispose: async () => { disposed++; } };
        }
    };
    const outer = { evaluate: async () => false, evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }) };
    await clickOilProduct({ isClosed: () => false, frames: () => [outer, frame] }, product, { timeout: 5000 });
    assert.equal(opened, true);
    assert.equal(clicked, 2);
    assert.equal(disposed, 2);
});

test('oil search waits for a matching model and pending requests before opening details', async () => {
    let reads = 0;
    const state = { url: 'https://aftermarket.zf.com/zh/catalog/', resultSignature: 'LifeguardFluid 9', resultCount: 1, loading: false, noResults: false };
    const page = { evaluate: async (fn, ...args) => {
        if (fn.name === 'readZfSearchState') { reads++; return { ...state, loading: reads < 3 }; }
        if (fn === extractOilProducts) {
            assert.equal(args[0], 'LifeguardFluid 9');
            return [{ partNumber: 'LifeguardFluid 9' }];
        }
        return false;
    } };
    const tracker = { getState: () => ({ started: 1, pending: reads < 3 ? 1 : 0, lastActivity: 0 }) };
    const outcome = await waitForZfSearchOutcome(page, state, {}, tracker, 'LifeguardFluid 9', extractOilProducts);
    assert.equal(outcome.loading, false);
    assert.ok(reads >= 3);
});

test('oil click reports a failed transition instead of returning an empty OE result', async () => {
    const product = { partNumber: 'LifeguardFluid 9', url: 'https://aftermarket.zf.com/zh/catalog/products/LG9' };
    const page = { isClosed: () => false, frames: () => [] };
    await assert.rejects(clickOilProduct(page, product, { timeout: 1 }), /点击后未跳转/);
});

test('oil search keeps the ZF number when the detail page has no readable OE section', async () => {
    const product = {
        partNumber: 'AA01.500.001', zfNumber: 'AA01.500.001', model: 'LifeguardFluid 9',
        url: 'https://aftermarket.zf.com/cn/catalog/products/AA01.500.001'
    };
    const frame = { evaluate: async fn => fn === extractOilOeSection ? null : true };
    const page = { isClosed: () => false, frames: () => [frame] };
    assert.deepEqual(await readOilDetails(page, [product], { timeout: 250 }), [{ ...product, oeGroups: [] }]);
});

test('ZF oil browser: contained search text, detail navigation, scoped OE extraction and UI', {
    skip: process.env.ZF_BROWSER_TEST !== '1'
}, async () => {
    const browser = await launchBrowser({
        headless: true,
        args: ['--no-first-run', '--no-default-browser-check']
    });
    try {
        const page = await browser.newPage();
        const numbers = ['00K68218925AA', '00K68218925AB', '68218925AA', '68218925AB', 'K68218925AA', 'K68218925AB'];
        const oeTable = `<table class="v-table"><tbody><tr><th><span>ALFA ROMEO</span></th><td>${[...numbers, numbers[0]].map(number => `<div class="v-table__cell-data"><span>${number}</span><!----></div>`).join('')}</td></tr><tr><th>BMW</th><td><div class="v-table__cell-data"><span>0000123456</span></div></td></tr></tbody></table>`;
        const detail = `<h1>自动变速器机油 | ZF LifeguardFluid 9</h1><h2>技术信息</h2><table class="v-table"><tr><th>Wrong</th><td><div class="v-table__cell-data"><span>BEFORE</span></div></td></tr></table>
            <section><h2 class="h4">对应OE编号</h2>${oeTable}</section><section><h2>其他信息</h2><table class="v-table"><tr><th>Wrong</th><td><div class="v-table__cell-data"><span>AFTER</span></div></td></tr></table></section>`;
        const productPath = '/zh/catalog/products/AA01.500.001?srv=y&producttype=00';
        const resultCard = (model, extra = '', category = '自动变速器机油') => {
            const number = model === 'LifeguardFluid 9' ? 'AA01.500.001' : encodeURIComponent(model);
            const href = model === 'LifeguardFluid 9' ? productPath : `/zh/catalog/products/${number}`;
            return `<div class="v-product-list-item"><a href="${href}" class="v-product-list-item__details"><span class="v-product-list-item__brand-name">ZF</span><span>${number}</span></a><a href="${href}" class="v-product-list-item__title" ${extra}><div>${category} | ZF <span class="highlighted">${model}</span></div></a></div>`;
        };
        let apiBody;
        let apiResults;
        await page.setRequestInterception(true);
        page.on('request', async request => {
            const url = new URL(request.url());
            if (url.hostname === 'oil-ui.test') {
                if (url.pathname === '/') {
                    const html = await fs.readFile(path.join(__dirname, '../OE号智能匹配工具 (1).html'), 'utf8');
                    return request.respond({ contentType: 'text/html; charset=utf-8', body: renderHtml(html) });
                }
                if (url.pathname === '/api/search/zf_oil_cn') {
                    apiBody = JSON.parse(request.postData());
                    return request.respond({ contentType: 'application/json', body: JSON.stringify({ results: apiResults }) });
                }
                if (url.pathname === '/runtime-config.js') return request.respond({ contentType: 'application/javascript', body: publicConfigScript() });
                if (url.pathname.startsWith('/api/')) return request.respond({ contentType: 'application/json', body: '{"rowCount":0,"type":"builtin"}' });
                if (/\.(js|css)$/.test(url.pathname)) {
                    return request.respond({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await fs.readFile(path.join(__dirname, '../public', path.basename(url.pathname)), 'utf8') });
                }
            }
            if (url.hostname === 'aftermarket.zf.com') return request.respond({ contentType: 'text/html; charset=utf-8', body: url.pathname.includes('/products/') ? detail : '<html><body></body></html>' });
            return request.respond({ contentType: 'text/plain', body: '' });
        });
        await page.goto('https://aftermarket.zf.com/zh/catalog/results');
        await page.setContent(`<input class="search-box__input">${resultCard('LifeguardFluid 9')}${resultCard('LifeguardFluid 9.1')}${resultCard('LifeguardFluid 90')}${resultCard('LifeguardFluid 9', 'style="display:none"')}${resultCard('LifeguardFluid 9', '', '维修套件')}`);
        const products = await page.evaluate(extractOilProducts, 'zf lifeguardfluid 9');
        assert.equal(products.length, 3);
        assert.equal(products[0].partNumber, 'AA01.500.001');
        assert.equal(products[0].partNumber, 'LifeguardFluid 9');
        assert.deepEqual(await page.evaluate(extractOilProducts, 'LifeguardFluid 8'), []);
        // Highlighting can end before the suffix; the query still matches.
        await page.evaluate(() => {
            document.querySelectorAll('a.v-product-list-item__title')[1].innerHTML = '<div>自动变速器机油 | ZF <span class="highlighted">LifeguardFluid 9</span>.1</div>';
            document.querySelector('a[href*="AA01"]').onclick = event => {
                if (event.isTrusted) event.preventDefault();
            };
        });
        assert.equal((await page.evaluate(extractOilProducts, 'LifeguardFluid 9')).length, 3);
        const details = await readOilDetails(page, products, { timeout: 5000 });
        assert.deepEqual(details[0].oeGroups, [{ brand: 'ALFA ROMEO', numbers }, { brand: 'BMW', numbers: ['0000123456'] }]);
        assert.equal(details.length, 3);
        assert.equal(details[1].partNumber, 'LifeguardFluid%209.1');
        assert.equal(await page.evaluate(extractOilOeSection, 'https://aftermarket.zf.com/zh/catalog/products/WRONG'), null);
        await page.setContent('<h2>对应OE编号</h2><p>没有对应 OE 编号</p>');
        assert.deepEqual(await page.evaluate(extractOilOeSection, products[0].url), { oeGroups: [] });
        await page.setContent('<h2>技术信息</h2>');
        assert.equal(await page.evaluate(extractOilOeSection, products[0].url), null);

        apiResults = [{ oe: 'LifeguardFluid 9', statusCode: 'SEARCH_SUCCESS', products: details }];
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto('https://oil-ui.test/', { waitUntil: 'load' });
        // CDN assets are deliberately disabled in this offline integration test.
        await page.addStyleTag({ content: '.hidden { display:none !important; }' });
        await page.evaluate(() => openProductFamily('transmission'));
        assert.equal(await page.$eval('#futureWorkspace', element => getComputedStyle(element).display), 'none');
        await page.type('#transmissionInput', 'LifeguardFluid 9');
        await page.click('#transmissionOnline');
        await page.waitForSelector('.oil-brand');
        assert.deepEqual(apiBody.oeList, ['LifeguardFluid 9']);
        assert.match(await page.$eval('#transmissionResults', element => element.textContent), /ZF 编号: AA01\.500\.001/);
        assert.equal(await page.$eval('.oil-brand details', element => element.open), false);
        assert.equal(await page.$$eval('.oil-brand:first-of-type > div > .oil-numbers .oil-number', elements => elements.length), 3);
        await page.click('.oil-brand summary');
        assert.equal(await page.$eval('.oil-brand details', element => element.open), true);
        const exported = await page.evaluate(() => {
            let captured;
            downloadExcel = data => { captured = data; };
            document.getElementById('transmissionDownload').click();
            return captured;
        });
        assert.equal(exported.length, 10);
        assert.equal(exported[1][3], numbers[0]);
        await page.evaluate(() => setLanguage('en'));
        assert.match(await page.$eval('#transmissionResults', element => element.textContent), /Show 3 more OE numbers/);
        await page.evaluate(() => showTransmissionHistory({ status: 'completed', results: [{ oe: '<img src=x onerror=alert(1)>', statusCode: 'NO_RESULTS', products: [] }] }, ['LifeguardFluid 8']));
        assert.equal(await page.$('#transmissionResults img'), null);
        assert.match(await page.$eval('#transmissionResults', element => element.textContent), /No oil model contains the search text/);
        await page.click('#transmissionClear');
        assert.equal(await page.$eval('#transmissionResults', element => element.textContent), '');
        assert.deepEqual(pageErrors, []);
    } finally { await browser.close(); }
});
