const { launchBrowser, requireInteractiveLogin } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { waitForProductOutcome } = require('./scraper_results');
const { getScraperSessionPaths, readCookies, saveCookies } = require('./scraper_session');

const TORCH_URL = siteUrl('TORCH_URL', 'https://market.dat881.com/intell/dir19/xhjApp');
const PRODUCT_TAB_SELECTOR = 'a#coreTab[href="#LevelIndex_FEBITab"]';
const PRODUCT_INPUT_SELECTOR = '#LevelProductNoInputGroup';
const PRODUCT_QUERY_BUTTON_SELECTOR = '#LevelIndex_ProductNoQBtn';
const RESULT_SELECTOR = 'p[category="火花塞"][productno][onclick*="openProductDetailPage_PRODUCTNO"]';
const LOGIN_REQUIRED_LABEL_SELECTOR = 'label[for="storeContacts"]';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSearchErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/net::|ERR_|Navigation timeout|ECONN|socket|network/i.test(message)) return 'NETWORK_ERROR';
    if (/Waiting for selector|未找到.*输入|搜索框|search input/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/Timeout|超时/i.test(message)) return 'NO_RESULTS';
    return 'SEARCH_ERROR';
}

function createLoginTimeoutError() {
    const error = new Error('LOGIN_TIMEOUT: TORCH 登录等待超时');
    error.code = 'LOGIN_TIMEOUT';
    return error;
}

async function needsTorchLogin(page) {
    return page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.textContent.replace(/\s+/g, '').includes('用户类型');
    }, LOGIN_REQUIRED_LABEL_SELECTOR).catch(() => false);
}


async function waitForTorchLoginIfRequired(page, cookieKey, onLoginRequired) {
    let needsLogin = await needsTorchLogin(page);
    if (!needsLogin) return false;

    requireInteractiveLogin(onLoginRequired);
    console.log('检测到 TORCH 用户登录页面，请在弹出的 浏览器窗口中手动登录。登录成功后程序会自动继续...');
    const startedAt = Date.now();
    while (needsLogin) {
        if (Date.now() - startedAt >= LOGIN_TIMEOUT_MS) throw createLoginTimeoutError();
        await delay(1500);
        needsLogin = await needsTorchLogin(page);
    }
    await saveCookies(page, cookieKey);
    return true;
}

async function selectProductSearchTab(page) {
    await page.waitForSelector(PRODUCT_TAB_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(PRODUCT_TAB_SELECTOR);
    await page.waitForSelector(PRODUCT_INPUT_SELECTOR, { visible: true, timeout: 30000 });
}

async function openTorchSearch(page, cookieKey, onLoginRequired) {
    await page.goto(TORCH_URL, { waitUntil: 'networkidle2' });
    await waitForTorchLoginIfRequired(page, cookieKey, onLoginRequired);
    await selectProductSearchTab(page);
}

async function submitProductSearch(page, productNumber, cookieKey, onLoginRequired) {
    await waitForTorchLoginIfRequired(page, cookieKey, onLoginRequired);
    await selectProductSearchTab(page);
    const previousSignature = await page.evaluate((selector) => (
        Array.from(document.querySelectorAll(selector)).map((item) => `${item.getAttribute('productno')}|${item.innerText}`).join('\n')
    ), RESULT_SELECTOR);
    const input = await page.waitForSelector(PRODUCT_INPUT_SELECTOR, { visible: true, timeout: 30000 });
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await input.type(productNumber, { delay: 30 });
    await page.waitForSelector(PRODUCT_QUERY_BUTTON_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(PRODUCT_QUERY_BUTTON_SELECTOR);

    return waitForProductOutcome(page, 'torch', RESULT_SELECTOR, 15000, async () => {}, previousSignature);
}

async function getResultItems(page) {
    return page.evaluate((selector) => Array.from(document.querySelectorAll(selector)).map((item, index) => ({
        index,
        productNo: (item.getAttribute('productno') || item.querySelector('.productNo')?.textContent || '').replace(/\s+/g, ' ').trim(),
        brand: (item.querySelector('.productBrand')?.textContent || '').replace(/\s+/g, ' ').trim()
    })), RESULT_SELECTOR);
}

async function waitForVisibleDetail(page) {
    await page.waitForFunction(() => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        return Array.from(document.querySelectorAll('.modal, .layui-layer, [role="dialog"], .ui-dialog, .popup'))
            .some((element) => visible(element) && element.innerText.trim().length > 0);
    }, { timeout: 10000 });
}

async function extractVisibleDetail(page, fallback) {
    return page.evaluate((fallbackProduct) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').replace(/^[：:]+|[：:]+$/g, '').trim();
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const root = Array.from(document.querySelectorAll('.modal, .layui-layer, [role="dialog"], .ui-dialog, .popup'))
            .filter((element) => visible(element) && normalize(element.innerText))
            .sort((a, b) => b.innerText.length - a.innerText.length)[0];
        if (!root) return null;

        const vehicleSectionPattern = /适用车型|适配车型|应用车型|适用车辆|车辆适配|车型信息|适用车系/i;
        const vehicleFieldPattern = /^(适用|适配|应用)?(车型|车系|车辆|汽车车型|发动机|排量|年款|生产年份|主机厂)$/i;
        const isVehicleTable = (table) => {
            if (!table) return false;
            const semanticName = `${table.id || ''} ${table.className || ''}`;
            if (/vehicle|fitment|application|car[-_]?model/i.test(semanticName)) return true;
            const headingText = [
                table.querySelector('caption')?.innerText,
                table.querySelector('thead')?.innerText,
                table.previousElementSibling?.matches('h1, h2, h3, h4, h5, h6, .title, [class*="title"]')
                    ? table.previousElementSibling.innerText
                    : ''
            ].map(normalize).join(' ');
            if (vehicleSectionPattern.test(headingText)) return true;
            const firstRows = Array.from(table.querySelectorAll('tr')).slice(0, 2);
            const headerCells = firstRows.flatMap((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => normalize(cell.innerText)));
            const vehicleColumns = headerCells.filter((text) => /^(品牌|厂牌|车系|车型|年款|发动机|排量|生产年份)$/i.test(text));
            return new Set(vehicleColumns).size >= 2;
        };

        const pairs = [];
        const addPair = (label, value) => {
            const cleanLabel = normalize(label);
            const cleanValue = normalize(value);
            if (!cleanLabel || !cleanValue || cleanLabel === cleanValue || cleanLabel.length > 80) return;
            pairs.push({ label: cleanLabel, value: cleanValue });
        };
        root.querySelectorAll('tr').forEach((row) => {
            if (isVehicleTable(row.closest('table'))) return;
            const cells = Array.from(row.querySelectorAll(':scope > th, :scope > td')).map((cell) => normalize(cell.innerText)).filter(Boolean);
            for (let index = 0; index + 1 < cells.length; index += 2) {
                if (!vehicleSectionPattern.test(cells[index]) && !vehicleFieldPattern.test(cells[index])) addPair(cells[index], cells[index + 1]);
            }
        });
        root.querySelectorAll('dt').forEach((term) => {
            const label = normalize(term.innerText);
            if (!vehicleSectionPattern.test(label) && !vehicleFieldPattern.test(label)) addPair(label, term.nextElementSibling?.innerText);
        });
        root.querySelectorAll('.form-group, .detail-item, .parameter-item, li').forEach((item) => {
            const label = item.querySelector('label, .label, .name, [class*="label"], [class*="name"]');
            const value = item.querySelector('.value, [class*="value"], input, select, textarea');
            const cleanLabel = normalize(label?.innerText);
            if (label && value && !vehicleSectionPattern.test(cleanLabel) && !vehicleFieldPattern.test(cleanLabel)) addPair(cleanLabel, value.value || value.innerText);
        });

        const unique = [];
        const seen = new Set();
        pairs.forEach((pair) => {
            const key = `${pair.label}\u0000${pair.value}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(pair);
            }
        });
        const normalizedLabel = (label) => normalize(label).replace(/[\s:：/]/g, '').toLowerCase();
        const findValue = (...labels) => {
            const accepted = new Set(labels.map(normalizedLabel));
            return unique.find((pair) => accepted.has(normalizedLabel(pair.label)))?.value || '';
        };
        const promotedLabels = new Set(['编号', '产品编号', '电极材料', '电极材质'].map(normalizedLabel));
        return {
            productNo: fallbackProduct.productNo,
            brand: fallbackProduct.brand,
            number: findValue('编号', '产品编号') || fallbackProduct.productNo,
            electrodeMaterial: findValue('电极材料', '电极材质'),
            parameters: unique.filter((pair) => (
                !promotedLabels.has(normalizedLabel(pair.label))
                && !vehicleSectionPattern.test(pair.label)
                && !vehicleFieldPattern.test(pair.label)
            ))
        };
    }, fallback);
}

async function closeVisibleDetail(page) {
    const closed = await page.evaluate(() => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const root = Array.from(document.querySelectorAll('.modal, .layui-layer, [role="dialog"], .ui-dialog, .popup')).filter(visible)
            .sort((a, b) => b.innerText.length - a.innerText.length)[0];
        if (!root) return true;
        const closeButton = root.querySelector('[data-dismiss="modal"], [data-bs-dismiss="modal"], .layui-layer-close, .ui-dialog-titlebar-close, .close, button[aria-label="Close"]')
            || Array.from(root.querySelectorAll('button, a')).find((element) => /^(关闭|取消|×)$/i.test(element.textContent.trim()));
        if (!closeButton) return false;
        closeButton.click();
        return true;
    });
    if (!closed) await page.keyboard.press('Escape');
    await delay(300);
}

async function collectProducts(page) {
    const resultItems = await getResultItems(page);
    const products = [];
    for (const resultItem of resultItems) {
        try {
            await page.evaluate((selector, index) => {
                const item = document.querySelectorAll(selector)[index];
                if (item) item.click();
            }, RESULT_SELECTOR, resultItem.index);
            await waitForVisibleDetail(page);
            const product = await extractVisibleDetail(page, resultItem);
            if (product) products.push(product);
        } finally {
            await closeVisibleDetail(page).catch(() => {});
        }
    }
    return products;
}

async function runTorch(productNumbers, { signal, sessionId, onLoginRequired } = {}) {
    const { profileDirectory, cookieKey } = getScraperSessionPaths(__dirname, 'torch', sessionId);
    const browser = await launchBrowser({
        userDataDir: profileDirectory
    });

    return runBrowserTask(browser, signal, async () => {
        const page = await browser.newPage();
        const cookies = await readCookies(cookieKey);
        if (cookies.length) await page.setCookie(...cookies);
        await openTorchSearch(page, cookieKey, onLoginRequired);

        const results = [];
        for (let index = 0; index < productNumbers.length; index++) {
            const query = productNumbers[index];
            console.log(`\n[%d/%d] 正在查询 TORCH: %s`, index + 1, productNumbers.length, query);
            try {
                const outcome = await submitProductSearch(page, query, cookieKey, onLoginRequired);
                const products = outcome === 'products' ? await collectProducts(page) : [];
                results.push({
                    query,
                    products,
                    status: products.length ? '查询成功' : '未找到 TORCH 产品',
                    statusCode: products.length ? 'SEARCH_SUCCESS' : 'NO_RESULTS'
                });
            } catch (error) {
                if (error.code === 'LOGIN_TIMEOUT') throw error;
                console.error(`处理 TORCH [${query}] 时发生错误: ${error.message}`);
                results.push({ query, products: [], status: `运行错误: ${error.message}`, statusCode: getSearchErrorCode(error) });
            } finally {
                if (index < productNumbers.length - 1) {
                    await openTorchSearch(page, cookieKey, onLoginRequired).catch((error) => console.error(`返回 TORCH 查询首页失败: ${error.message}`));
                }
            }
        }
        await saveCookies(page, cookieKey);
        return results;
    });
}

module.exports = runTorch;
