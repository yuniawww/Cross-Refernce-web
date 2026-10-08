const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../browser');
const { getSearchErrorCode, fillZfSearchInput, submitZfSearch } = require('../zf_scraper');
const {
    findCatalogueFrame, waitForSearchInput, evaluateCatalogue, clickCatalogueLink, readAccessChallenge, findSearchInput
} = require('../zf_page');

test('ZF timeouts and unreadable elements are not reported as no results', () => {
    assert.equal(getSearchErrorCode(new Error('等待 ZF 新搜索结果超时')), 'QUERY_TIMEOUT');
    assert.equal(getSearchErrorCode(new Error('ZF_ELEMENT_TIMEOUT: 未找到可用的 ZF 搜索输入框')), 'SOURCE_UNAVAILABLE');
    assert.equal(getSearchErrorCode(new Error('ZF_ACCESS_BLOCKED: HTTP 429')), 'SOURCE_UNAVAILABLE');
});

test('ZF reacquires the catalogue frame after an iframe is replaced', async () => {
    const oldFrame = {};
    const main = { evaluate: async () => false };
    const next = { evaluate: async () => true };
    const page = { __zfCatalogueFrame: oldFrame, frames: () => [main, next] };
    assert.equal(await findCatalogueFrame(page), next);
    assert.equal(page.__zfCatalogueFrame, next);
});

test('ZF does not fall back to the main page when the catalogue is missing', async () => {
    const page = { frames: () => [{ evaluate: async () => false }] };
    await assert.rejects(evaluateCatalogue(page, () => []), /ZF_ELEMENT_NOT_READY/);
});

test('ZF prioritizes a results iframe over a cached outer search box', async () => {
    const searchFrame = { evaluate: async fn => fn.name === 'findSearchInput' };
    const resultFrame = { evaluate: async (fn, selector) => fn.name !== 'findSearchInput' && selector.includes('.v-product-list-item__title') };
    const page = { __zfCatalogueFrame: searchFrame, frames: () => [searchFrame, resultFrame] };
    assert.equal(await findCatalogueFrame(page), resultFrame);
    assert.equal(await findCatalogueFrame(page, false), searchFrame);
});

test('ZF retries with the replacement search input when the site truncates a query', async () => {
    let visible = { value: '', select() {} };
    let insertions = 0;
    const handles = [];
    const makeHandle = element => {
        const handle = {
            click: async () => {}, evaluate: async fn => fn(element),
            dispose: async () => { handle.disposed = true; }
        };
        handles.push(handle);
        return handle;
    };
    const frame = {
        evaluate: async () => true,
        evaluateHandle: async () => ({ asElement: () => makeHandle(visible) })
    };
    const page = {
        isClosed: () => false, frames: () => [frame],
        keyboard: { insertText: async text => {
            insertions++;
            visible = { value: insertions === 1 ? 'd 6' : text, select() {} };
        } }
    };
    const first = makeHandle(visible);
    const replacement = await fillZfSearchInput(page, first, 'LifeguardFluid 6');
    assert.equal(insertions, 2);
    assert.equal(await replacement.input.evaluate(element => element.value), 'LifeguardFluid 6');
    assert.equal(first.disposed, true);
    await replacement.input.dispose();
});

test('ZF browser: iframe search, changing nodes, and catalogue link reuse', {
    skip: process.env.ZF_BROWSER_TEST !== '1'
}, async () => {
    const browser = await launchBrowser({
        headless: true,
        args: ['--no-first-run', '--no-default-browser-check']
    });
    try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', request => {
            void request.respond({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' });
        });
        await page.goto('https://zf-fixture.test/zh/catalog/results');
        await page.setContent(`
            <input type="search" placeholder="全站搜索">
            <a aria-current="true" href="/zh/catalog/" class="main-navigation__link">
                <div class="main-navigation__text-wrapper"><div class="main-navigation__text">我们的目录</div></div>
            </a>
            <iframe></iframe>
        `);
        const frame = page.frames().find(item => item !== page.mainFrame());
        await frame.setContent(`
            <div class="search-box" style="display:none"><input class="search-box__input"></div>
            <div class="search-box"><input class="search-box__input" value="A0004207103"></div>
        `);
        const first = await waitForSearchInput(page, { timeout: 1000 });
        assert.equal(first.frame, frame);
        assert.equal(await first.input.evaluate(input => input.value), 'A0004207103');
        await first.input.dispose();

        await frame.evaluate(() => {
            document.querySelectorAll('.search-box')[1].innerHTML = '<input type="search" placeholder="零件编号">';
        });
        const replacement = await waitForSearchInput(page, { timeout: 1000 });
        assert.equal(await replacement.input.evaluate(input => input.placeholder), '零件编号');
        await replacement.input.dispose();

        await page.evaluate(() => {
            window.catalogueClicks = 0;
            document.querySelector('a').addEventListener('click', event => {
                event.preventDefault();
                window.catalogueClicks++;
                history.pushState({}, '', '/zh/catalog/');
            });
        });
        const pageCount = (await browser.pages()).length;
        await clickCatalogueLink(page);
        assert.equal((await browser.pages()).length, pageCount);
        assert.equal(await page.evaluate(() => window.catalogueClicks), 1);
        assert.equal(new URL(page.url()).pathname, '/zh/catalog/');

        await page.setContent('<p>Our privacy policy explains how captcha data is used.</p>');
        assert.equal(await readAccessChallenge(page), '');
        await page.setContent('<title>Verify you are human</title><p>Please complete verification.</p>');
        assert.match(await readAccessChallenge(page), /Verify you are human/);

        await page.setContent('<div id="__nuxt"><div class="search-box"><input class="search-box__input"></div></div>');
        assert.equal(await page.evaluate(findSearchInput, '.search-box__input', true), false);
        await page.evaluate(() => {
            setTimeout(() => {
                document.querySelector('#__nuxt').__vue_app__ = {};
                document.querySelector('input').value = 'hydrated';
            }, 100);
        });
        const hydrated = await waitForSearchInput(page, { timeout: 2000 });
        assert.equal(await hydrated.input.evaluate(input => input.value), 'hydrated');
        await hydrated.input.dispose();

        await page.setContent('<form class="search-box"><input class="search-box__input"><button type="submit">Search</button></form>');
        await page.evaluate(() => {
            window.inputEvents = [];
            window.submitted = [];
            const input = document.querySelector('input');
            input.addEventListener('input', event => window.inputEvents.push(event.isTrusted));
            document.querySelector('form').addEventListener('submit', event => {
                event.preventDefault();
                window.submitted.push(input.value);
            });
        });
        const searchInput = await page.$('.search-box__input');
        await fillZfSearchInput(page, searchInput, 'GDB1330');
        await submitZfSearch(searchInput);
        assert.deepEqual(await page.evaluate(() => window.submitted), ['GDB1330']);
        assert.ok(await page.evaluate(() => window.inputEvents.length > 0 && window.inputEvents.every(Boolean)));
        await searchInput.dispose();
    } finally {
        await browser.close();
    }
});
