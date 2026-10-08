const { attachRemoteLogin, withLoginRetry } = require('./remote_login');
const { launchBrowser, requireInteractiveLogin } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { waitForProductOutcome } = require('./scraper_results');
const { getScraperSessionPaths, readCookies, saveCookies } = require('./scraper_session');

const NGK_URL = siteUrl('NGK_URL', 'https://market.dat881.com/intell/ngk/ngkApp');
const LOGIN_REQUIRED_LABEL_SELECTOR = 'label[for="storeContacts"]';
const LOGGED_IN_SWITCH_USER_SELECTOR = 'a[href="ngk/ngkApp/goToClientLogin"], a[href$="/ngk/ngkApp/goToClientLogin"]';
const PRODUCT_INPUT_SELECTOR = '#NGKProductNoInputGroup_productNo';
const PRODUCT_QUERY_BUTTON_SELECTOR = '#NGKIndex_ProductBtn';
const RESULT_ROW_SELECTOR = 'tr.result_table_tr[productno]';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLoginTimeoutError() {
    const error = new Error('LOGIN_TIMEOUT: NGK 登录等待超时');
    error.code = 'LOGIN_TIMEOUT';
    return error;
}

function getSearchErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/net::|ERR_|Navigation timeout|ECONN|socket|network/i.test(message)) return 'NETWORK_ERROR';
    if (/Waiting for selector|未找到.*输入|搜索框|search input/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/Timeout|超时/i.test(message)) return 'NO_RESULTS';
    return 'SEARCH_ERROR';
}

async function getNgkPageState(page) {
    return page.evaluate((loginSelector, loggedInSelector, inputSelector) => {
        const isVisible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const loginLabel = document.querySelector(loginSelector);
        const switchUserLink = document.querySelector(loggedInSelector);
        const productInput = document.querySelector(inputSelector);
        const needsLogin = isVisible(loginLabel) && loginLabel.textContent.replace(/\s+/g, '').includes('用户类型');
        const isLoggedIn = isVisible(switchUserLink) && switchUserLink.textContent.replace(/\s+/g, '').includes('切换用户');
        return { needsLogin, isLoggedIn, hasProductInput: isVisible(productInput), url: location.href };
    }, LOGIN_REQUIRED_LABEL_SELECTOR, LOGGED_IN_SWITCH_USER_SELECTOR, PRODUCT_INPUT_SELECTOR).catch(() => ({
        needsLogin: true,
        isLoggedIn: false,
        hasProductInput: false,
        url: ''
    }));
}


async function selectProductSearchTab(page) {
    const clicked = await page.evaluate(() => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const tabLabel = Array.from(document.querySelectorAll('span')).find((element) => (
            visible(element) && element.textContent.replace(/\s+/g, '') === '型号/库存号'
        ));
        if (!tabLabel) return false;
        const target = tabLabel.closest('button, a, li, [role="tab"]') || tabLabel;
        target.click();
        return true;
    });
    if (!clicked) throw new Error('未找到 NGK“型号/库存号”查询标签');
    await page.waitForSelector(PRODUCT_INPUT_SELECTOR, { visible: true, timeout: 30000 });
}

async function waitForNgkReady(page, cookieKey, onLoginRequired) {
    const startedAt = Date.now();
    let state = await getNgkPageState(page);

    if (state.needsLogin || !state.isLoggedIn) {
        await requireInteractiveLogin(onLoginRequired, page);
        state = await getNgkPageState(page);
        console.log('检测到 NGK 用户登录页面，请通过前端远程浏览器入口完成登录。检测到“切换用户”后程序会自动继续...');
    }
    while (state.needsLogin || !state.isLoggedIn) {
        if (Date.now() - startedAt >= LOGIN_TIMEOUT_MS) throw createLoginTimeoutError();
        await delay(1500);
        state = await getNgkPageState(page);
    }

    console.log('已检测到 NGK“切换用户”链接，确认登录成功。');
    await saveCookies(page, cookieKey);
    await selectProductSearchTab(page);
}

async function submitProductSearch(page, productNumber, cookieKey, onLoginRequired) {
    const state = await getNgkPageState(page);
    if (state.needsLogin || !state.isLoggedIn) await waitForNgkReady(page, cookieKey, onLoginRequired);
    await selectProductSearchTab(page);

    const previousSignature = await page.evaluate((selector) => (
        Array.from(document.querySelectorAll(selector)).map((row) => `${row.getAttribute('productno')}|${row.innerText}`).join('\n')
    ), RESULT_ROW_SELECTOR);
    const input = await page.waitForSelector(PRODUCT_INPUT_SELECTOR, { visible: true, timeout: 30000 });
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await input.type(productNumber, { delay: 30 });
    await page.waitForSelector(PRODUCT_QUERY_BUTTON_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(PRODUCT_QUERY_BUTTON_SELECTOR);

    return waitForProductOutcome(page, 'ngk', RESULT_ROW_SELECTOR, 15000, async () => {}, previousSignature);
}

async function getResultRows(page) {
    return page.evaluate((selector) => Array.from(document.querySelectorAll(selector)).map((row, index) => ({
        index,
        productNo: (row.getAttribute('productno') || '').trim(),
        model: (row.querySelector('.fiftytd b, .fiftytd')?.textContent || '').replace(/\s+/g, ' ').trim()
    })), RESULT_ROW_SELECTOR);
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
        const candidates = Array.from(document.querySelectorAll('.modal, .layui-layer, [role="dialog"], .ui-dialog, .popup'))
            .filter((element) => visible(element) && normalize(element.innerText));
        const root = candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0];
        if (!root) return null;

        const pairs = [];
        const addPair = (label, value) => {
            const cleanLabel = normalize(label);
            const cleanValue = normalize(value);
            if (!cleanLabel || !cleanValue || cleanLabel === cleanValue || cleanLabel.length > 80) return;
            pairs.push({ label: cleanLabel, value: cleanValue });
        };

        root.querySelectorAll('tr').forEach((row) => {
            const cells = Array.from(row.querySelectorAll(':scope > th, :scope > td')).map((cell) => normalize(cell.innerText)).filter(Boolean);
            for (let index = 0; index + 1 < cells.length; index += 2) addPair(cells[index], cells[index + 1]);
        });
        root.querySelectorAll('dt').forEach((term) => addPair(term.innerText, term.nextElementSibling?.innerText));
        root.querySelectorAll('.form-group, .detail-item, .parameter-item, li').forEach((item) => {
            const label = item.querySelector('label, .label, .name, [class*="label"], [class*="name"]');
            const value = item.querySelector('.value, [class*="value"], input, select, textarea');
            if (label && value) addPair(label.innerText, value.value || value.innerText);
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
        const promotedLabels = new Set(['型号', '产品型号', '编号', '库存编号', '库存号', '中心电极材质', '中心电极材料', '外侧电极材质', '外侧电极材料'].map(normalizedLabel));

        return {
            model: findValue('型号', '产品型号') || fallbackProduct.model,
            number: findValue('编号', '库存编号', '库存号') || fallbackProduct.productNo,
            centerElectrodeMaterial: findValue('中心电极材质', '中心电极材料'),
            groundElectrodeMaterial: findValue('外侧电极材质', '外侧电极材料'),
            parameters: unique.filter((pair) => !promotedLabels.has(normalizedLabel(pair.label)))
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
        const roots = Array.from(document.querySelectorAll('.modal, .layui-layer, [role="dialog"], .ui-dialog, .popup')).filter(visible);
        const root = roots.sort((a, b) => b.innerText.length - a.innerText.length)[0];
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
    const resultRows = await getResultRows(page);
    const products = [];
    for (const resultRow of resultRows) {
        try {
            await page.evaluate((selector, index) => {
                const row = document.querySelectorAll(selector)[index];
                if (row) row.click();
            }, RESULT_ROW_SELECTOR, resultRow.index);
            await waitForVisibleDetail(page);
            const product = await extractVisibleDetail(page, resultRow);
            if (product) products.push(product);
        } finally {
            await closeVisibleDetail(page).catch(() => {});
        }
    }
    return products;
}

async function returnToNgkSearch(page, cookieKey, onLoginRequired) {
    await page.goto(NGK_URL, { waitUntil: 'networkidle2' });
    await waitForNgkReady(page, cookieKey, onLoginRequired);
}

async function runNgk(productNumbers, { signal, sessionId, onLoginRequired } = {}) {
    const { profileDirectory, cookieKey } = getScraperSessionPaths(__dirname, 'ngk', sessionId);
    const browser = await launchBrowser({
        userDataDir: profileDirectory
    });

    return runBrowserTask(browser, signal, async () => {
        const page = await browser.newPage();
        attachRemoteLogin(page, { brand: 'ngk', entryUrl: NGK_URL, cookieKey,
            isAuthenticated: async target => { const state = await getNgkPageState(target); return state.isLoggedIn && !state.needsLogin; } });
        const cookies = await readCookies(cookieKey);
        if (cookies.length) await page.setCookie(...cookies);
        await page.goto(NGK_URL, { waitUntil: 'networkidle2' });
        await waitForNgkReady(page, cookieKey, onLoginRequired);

        const results = [];
        for (let index = 0; index < productNumbers.length; index++) {
            const query = productNumbers[index];
            console.log(`\n[%d/%d] 正在查询 NGK: %s`, index + 1, productNumbers.length, query);
            try {
                const row = await withLoginRetry(page, async () => {
                    const outcome = await submitProductSearch(page, query, cookieKey, onLoginRequired);
                    const products = outcome === 'products' ? await collectProducts(page) : [];
                    return {
                        query,
                        products,
                        status: products.length ? '查询成功' : '未找到 NGK 产品',
                        statusCode: products.length ? 'SEARCH_SUCCESS' : 'NO_RESULTS'
                    };
                });
                results.push(row);
            } catch (error) {
                if (error.code?.startsWith('LOGIN_') || error.code === 'JOB_ABORTED') throw error;
                console.error(`处理 NGK [${query}] 时发生错误: ${error.message}`);
                results.push({ query, products: [], status: `运行错误: ${error.message}`, statusCode: getSearchErrorCode(error) });
            } finally {
                if (index < productNumbers.length - 1) {
                    await returnToNgkSearch(page, cookieKey, onLoginRequired).catch((error) => {
                        console.error(`返回 NGK 查询首页失败: ${error.message}`);
                    });
                }
            }
        }
        await saveCookies(page, cookieKey);
        return results;
    });
}

module.exports = runNgk;
