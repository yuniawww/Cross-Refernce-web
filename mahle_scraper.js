const { attachRemoteLogin, withLoginRetry } = require('./remote_login');
const { waitForProductOutcome } = require('./scraper_results');
const { launchBrowser, requireInteractiveLogin } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { getScraperSessionPaths, readCookies, saveCookies } = require('./scraper_session');

const MAHLE_URL = siteUrl('MAHLE_URL', 'https://market.dat881.com/intell/dir29/maleApp');
const OE_TAB_SELECTOR = '#partsNoTab';
const OE_INPUT_SELECTOR = '#LevelOEInputGroup_OE';
const OE_QUERY_BUTTON_SELECTOR = '#LevelIndex_OEQBtn';
const PRODUCT_LINK_SELECTOR = 'a[productno][onclick*="openProductDetailPage_PARTSNO"]';
const PARTSNO_HOME_BUTTON_SELECTOR = '#product_header_opts_PARTSNO';
const LOGIN_REQUIRED_LABEL_SELECTOR = 'label[for="storeContacts"]';
const LOGGED_IN_SWITCH_USER_SELECTOR = 'a[href="dir29/maleApp/goToClientLogin"]';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function createLoginTimeoutError() {
    const error = new Error('LOGIN_TIMEOUT: MAHLE 登录等待超时');
    error.code = 'LOGIN_TIMEOUT';
    return error;
}

function getSearchErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/net::|ERR_|Navigation timeout|ECONN|socket|network/i.test(message)) return 'NETWORK_ERROR';
    if (/Waiting for selector|未找到.*搜索输入|搜索框|search input/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/Timeout|超时/i.test(message)) return 'NO_RESULTS';
    return 'SEARCH_ERROR';
}

async function getMahlePageState(page) {
    return page.evaluate((loginLabelSelector, switchUserSelector) => {
        const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);

            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const isSearchPage = location.pathname.includes('/intell/dir29/maleApp');
        const hasOeTab = Array.from(document.querySelectorAll('#partsNoTab')).some(isVisible);
        const hasOeSearch = Array.from(document.querySelectorAll('#LevelOEInputGroup_OE')).some(isVisible);
        const hasVisiblePasswordInput = Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible);
        const loginLabel = document.querySelector(loginLabelSelector);
        const switchUserLink = document.querySelector(switchUserSelector);
        const needsLogin = Boolean(loginLabel && isVisible(loginLabel) && loginLabel.textContent.replace(/\s+/g, '').includes('用户类型'));
        const isLoggedIn = Boolean(switchUserLink && isVisible(switchUserLink) && switchUserLink.textContent.replace(/\s+/g, '').includes('切换用户'));
        const isLoginPage = needsLogin || (!isSearchPage && (location.href.includes('login') || hasVisiblePasswordInput));

        return { isSearchPage, hasOeTab, hasOeSearch, isLoginPage, needsLogin, isLoggedIn, url: location.href };
    }, LOGIN_REQUIRED_LABEL_SELECTOR, LOGGED_IN_SWITCH_USER_SELECTOR).catch(() => ({
        isSearchPage: false,
        hasOeTab: false,
        hasOeSearch: false,
        isLoginPage: true,
        needsLogin: false,
        isLoggedIn: false,
        url: ''
    }));
}

async function waitForMahleReady(page, delay, cookieKey, onLoginRequired) {
    const loginWaitStartedAt = Date.now();
    let state = await getMahlePageState(page);

    if (!state.needsLogin && !state.isLoggedIn) {
        await page.goto(MAHLE_URL, { waitUntil: 'networkidle2' });
        state = await getMahlePageState(page);
    }

    if (state.needsLogin || !state.isLoggedIn) {
        await requireInteractiveLogin(onLoginRequired, page);
        state = await getMahlePageState(page);
        console.log("检测到 MAHLE 用户类型登录页面，请通过前端远程浏览器入口完成登录。检测到“切换用户”后程序会自动继续...");
    }

    while (state.needsLogin || !state.isLoggedIn) {
        if (Date.now() - loginWaitStartedAt >= LOGIN_TIMEOUT_MS) throw createLoginTimeoutError();
        await delay(1500);
        state = await getMahlePageState(page);
    }

    console.log("已检测到可见的 MAHLE“切换用户”链接，且登录标签已消失，确认登录成功。");
    await page.waitForSelector(OE_TAB_SELECTOR, { visible: true, timeout: 30000 });

    if (state.needsLogin) {
        throw new Error('MAHLE 仍处于登录页面，已阻止输入OE号');
    }

    if (state.isLoggedIn) {
        await saveCookies(page, cookieKey);
    }
}

async function selectOeSearchTab(page) {
    await page.waitForSelector(OE_TAB_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(OE_TAB_SELECTOR);
    await page.waitForSelector(OE_INPUT_SELECTOR, { visible: true, timeout: 30000 });
}

async function submitOeSearch(page, oe, delay, cookieKey, onLoginRequired) {
    await waitForMahleReady(page, delay, cookieKey, onLoginRequired);
    await selectOeSearchTab(page);

    const state = await getMahlePageState(page);
    if (state.needsLogin || !state.isLoggedIn) {
        throw new Error('未检测到有效的 MAHLE 登录成功状态，已阻止输入OE号');
    }

    const beforeText = await page.evaluate(() => document.body.innerText);
    const oeInput = await page.waitForSelector(OE_INPUT_SELECTOR, { visible: true, timeout: 30000 });
    await oeInput.evaluate((input) => {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await oeInput.type(oe, { delay: 30 });
    await page.waitForSelector(OE_QUERY_BUTTON_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(OE_QUERY_BUTTON_SELECTOR);
    return beforeText;
}

async function getMahleProductNumbers(page) {
    return page.evaluate((productLinkSelector) => {
        const normalize = (text) => text.replace(/\s+/g, ' ').trim();
        const productNumbers = Array.from(document.querySelectorAll(productLinkSelector))
            .map((link) => normalize(link.getAttribute('productno') || link.innerText || link.textContent || ''))
            .filter(Boolean);

        return Array.from(new Set(productNumbers));
    }, PRODUCT_LINK_SELECTOR);
}

async function goBackToMahleHome(page) {
    const hasHomeButton = await page.waitForSelector(PARTSNO_HOME_BUTTON_SELECTOR, { visible: true, timeout: 3000 }).catch(() => null);
    if (hasHomeButton) {
        await page.click(PARTSNO_HOME_BUTTON_SELECTOR);
    } else {
        await page.goto(MAHLE_URL, { waitUntil: 'networkidle2' });
    }

    await page.waitForSelector(OE_TAB_SELECTOR, { visible: true, timeout: 10000 }).catch(async () => {
        await page.goto(MAHLE_URL, { waitUntil: 'networkidle2' });
        await page.waitForSelector(OE_TAB_SELECTOR, { visible: true, timeout: 30000 });
    });
    await selectOeSearchTab(page);
}

async function runMahle(oeList, { signal, sessionId, onLoginRequired } = {}) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const { profileDirectory, cookieKey } = getScraperSessionPaths(__dirname, 'mahle', sessionId);
    const browser = await launchBrowser({
        userDataDir: profileDirectory
    });

    return runBrowserTask(browser, signal, async () => {
        const page = await browser.newPage();
        attachRemoteLogin(page, { brand: 'mahle', entryUrl: MAHLE_URL, cookieKey,
            isAuthenticated: async target => { const state = await getMahlePageState(target); return state.isLoggedIn && !state.needsLogin; } });

        // 加载历史 Cookie 以免密登录
        const cookies = await readCookies(cookieKey);
        if (cookies.length) await page.setCookie(...cookies);

        await page.goto(MAHLE_URL, { waitUntil: 'networkidle2' });

        // 检查是否在登录页，如果是，暂停让用户手动登录，然后保存 Cookie
        await waitForMahleReady(page, delay, cookieKey, onLoginRequired);
        await selectOeSearchTab(page);

        const results = [];

        for (let i = 0; i < oeList.length; i++) {
            const oe = oeList[i];
            console.log(`\n[%d/%d] 正在查询 MAHLE: %s`, i + 1, oeList.length, oe);

            try {
                const row = await withLoginRetry(page, async () => {
                    const beforeText = await submitOeSearch(page, oe, delay, cookieKey, onLoginRequired);

                    await Promise.race([
                        page.waitForFunction((oldText) => document.body.innerText !== oldText, { timeout: 10000 }, beforeText),
                        delay(3000)
                    ]).catch(() => {});

                    const outcome = await waitForProductOutcome(page, 'mahle', PRODUCT_LINK_SELECTOR, 10000);
                    const mahleNumbers = outcome === 'empty' ? [] : await getMahleProductNumbers(page);

                    return {
                        oe,
                        mahleNumbers,
                        status: mahleNumbers.length ? '查询成功' : '未找到 MAHLE 号码',
                        statusCode: mahleNumbers.length ? 'SEARCH_SUCCESS' : 'NO_RESULTS'
                    };
                });
                results.push(row);
            } catch (err) {
                if (err.code?.startsWith('LOGIN_') || err.code === 'JOB_ABORTED') throw err;
                console.error(`处理 [${oe}] 时发生错误: ${err.message}`);
                results.push({ oe, mahleNumbers: [], status: '运行错误: ' + err.message, statusCode: getSearchErrorCode(err) });
            } finally {
                if (i < oeList.length - 1) {
                    await goBackToMahleHome(page).catch((err) => {
                        console.error(`返回 MAHLE 首页失败: ${err.message}`);
                    });
                }
            }
        }

        await saveCookies(page, cookieKey);

        return results;
    });
}

module.exports = runMahle;
