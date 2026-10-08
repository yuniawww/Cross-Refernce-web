const { waitForProductOutcome } = require('./scraper_results');
const { launchBrowser } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { navigateToCatalogue } = require('./site_navigation');
const { randomUUID } = require('node:crypto');
const { createCataloguePage } = require('./catalogue_page');

function getSearchErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code?.startsWith('SITE_')) return 'SOURCE_UNAVAILABLE';
    if (/net::|ERR_|Navigation timeout|ECONN|socket|network/i.test(message)) return 'NETWORK_ERROR';
    if (/Waiting for selector|无法加载.*搜索框|未找到.*搜索输入|search input/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/Timeout|超时/i.test(message)) return 'QUERY_TIMEOUT';
    return 'SEARCH_ERROR';
}

async function setupMannPage(page) {
    page.on('pageerror', (err) => {
        console.warn(`曼牌页面脚本错误，已忽略: ${err.message}`);
    });
    page.on('requestfailed', (request) => {
        const failure = request.failure();
        console.warn(`曼牌资源加载失败，已忽略: ${request.url()} ${failure ? failure.errorText : ''}`);
    });

    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const url = request.url();
        if (/onetrust|otSDKStub|cookielaw/i.test(url)) {
            request.abort();
            return;
        }

        request.continue();
    });
}

async function openMannCatalog(page, searchUrl, inputSelector) {
    console.log('正在打开 MANN-FILTER 网站...');
    await navigateToCatalogue(page, searchUrl, 'MANN-FILTER');
    await page.waitForSelector(inputSelector, { visible: true, timeout: 15000 });
    console.log('MANN-FILTER 网站已成功打开。');
}

async function runMann(oeList, { signal } = {}) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const searchUrl = siteUrl('MANN_URL', 'https://www.mann-filter.com/cn-zh/catalog.html');
    const inputSelector = '#autocomplete-smart';
    const searchBtnSelector = '.cmp-catalog__search-button-group button.cmp-button--primary';
    const mannNumberSelector = 'div.cmp-text--standard.cmp-text--no-margin.cmp-table-data__cell-value.cmp-text > p.cmp-text__paragraph';

    const browser = await launchBrowser({
        args: ['--disable-http2']
    });

    return runBrowserTask(browser, signal, async () => {
        const page = await createCataloguePage(browser);
        await setupMannPage(page);

        await openMannCatalog(page, searchUrl, inputSelector);

        const results = [];

        console.log(`🚀 开始执行曼牌抓取任务，共 ${oeList.length} 个型号...`);

        for (let i = 0; i < oeList.length; i++) {
            const keyword = oeList[i];
            console.log(`\n[%d/%d] 正在处理: %s`, i + 1, oeList.length, keyword);

            try {
                const previousResultText = await page.evaluate((selector) => {
                    return Array.from(document.querySelectorAll(selector))
                        .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
                        .filter(Boolean)
                        .join('|');
                }, mannNumberSelector);

                const documentToken = randomUUID();
                await page.evaluate((selector, initialText, token) => {
                    if (window.__mannResultObserver) window.__mannResultObserver.disconnect();
                    window.__mannSearchDocumentId = token;
                    window.__mannResultChanged = false;
                    window.__mannResultObserver = new MutationObserver(() => {
                        const currentText = Array.from(document.querySelectorAll(selector))
                            .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
                            .filter(Boolean)
                            .join('|');
                        if (currentText !== initialText) window.__mannResultChanged = true;
                    });
                    window.__mannResultObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
                }, mannNumberSelector, previousResultText, documentToken);

                await page.evaluate((selector, value) => {
                    const input = document.querySelector(selector);
                    if (!input) return false;

                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeInputValueSetter.call(input, '');
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    nativeInputValueSetter.call(input, value);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }, inputSelector, keyword);
                await delay(600);

                await page.evaluate((selector) => {
                    const searchBtn = document.querySelector(selector);
                    if (!searchBtn) return false;

                    searchBtn.removeAttribute('disabled');
                    searchBtn.click();
                    return true;
                }, searchBtnSelector);

                console.log("⏳ 等待新搜索结果...");

                const outcome = await waitForProductOutcome(page, 'mann', mannNumberSelector, 30000, undefined, null, documentToken);
                if (outcome === 'timeout') throw new Error('QUERY_TIMEOUT: MANN 查询超时，尚未收到产品或明确的无结果提示');
                const mannProducts = outcome === 'products' ? await extractMannProducts(page, mannNumberSelector) : [];
                await page.evaluate(() => window.__mannResultObserver?.disconnect());
                const mannNumbers = mannProducts.map((product) => product.number);

                if (mannNumbers.length === 0) {
                    console.warn(`⚠️ 未找到 [${keyword}] 的对应 MANN 号码。`);
                    results.push({ keyword, title: '', mannNumbers: [], mannProducts: [], status: '无搜索结果', statusCode: 'NO_RESULTS' });
                    continue;
                }

                console.log(`✅ 成功获取 MANN 号码: ${mannNumbers.join(', ')}`);
                results.push({ keyword, title: mannNumbers.join(', '), mannNumbers, mannProducts, status: '查询成功', statusCode: 'SEARCH_SUCCESS' });

                await delay(1000);
            } catch (err) {
                console.error(`❌ 处理 [${keyword}] 时发生错误: ${err.message}`);
                results.push({ keyword, title: '', mannNumbers: [], mannProducts: [], status: '运行错误: ' + err.message, statusCode: getSearchErrorCode(err) });
            }
        }

        return results;
    });
}

async function extractMannProducts(page, selector) {
    await page.waitForSelector(selector, { visible: true, timeout: 15000 }).catch(() => null);

    return page.evaluate((mannSelector) => {
        if (window.__mannResultObserver) window.__mannResultObserver.disconnect();
        const products = Array.from(document.querySelectorAll(mannSelector)).map((element) => {
            const number = element.textContent.replace(/\s+/g, ' ').trim();
            const link = element.closest('a[href]');
            const href = link ? link.getAttribute('href') || '' : '';
            const url = href ? new URL(href, location.origin).href : '';
            return { number, href, url };
        }).filter((product) => /^[A-Z]{1,3}\s*\d/i.test(product.number));

        return Array.from(products.reduce((productMap, product) => {
            if (!productMap.has(product.number)) productMap.set(product.number, product);
            return productMap;
        }, new Map()).values());
    }, selector).catch(() => []);
}

module.exports = runMann;
