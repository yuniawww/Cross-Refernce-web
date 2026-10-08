const { attachRemoteLogin, withLoginRetry } = require('./remote_login');
const { waitForProductOutcome } = require('./scraper_results');
const { launchBrowser, requireInteractiveLogin } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { getScraperSessionPaths, readCookies, saveCookies } = require('./scraper_session');

const TORA_URL = siteUrl('TORA_URL', 'https://baowang.51cjml.com');

const OE_TAB_SELECTOR = '.searchTab_byOe';
const OE_SEARCH_SELECTOR = '.searchKey_byOe.searchKey #oemData.homeSearch[data-click="buttonOem"], #oemData[data-keydown="keydown2"]';
const PRODUCT_NAME_SELECTOR = '.productName2';
const LOGIN_BUTTON_SELECTOR = '.action_login';
const LOGOUT_BUTTON_SELECTOR = '.action_loginOut';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLoginTimeoutError() {
    const error = new Error('LOGIN_TIMEOUT: Tora 登录等待超时');
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

async function hasWechatVerification(page) {
    return page.evaluate(() => {
        const docs = [document];
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                if (iframe.contentDocument) docs.push(iframe.contentDocument);
            } catch (e) {
                // 忽略跨域 iframe
            }
        });

        return docs.some((doc) => Array.from(doc.querySelectorAll('p')).some((element) => {
            const text = element.textContent.replace(/\s+/g, '').trim();
            const inlineStyle = (element.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
            const hasExpectedStyle = inlineStyle.includes('text-align:center') && inlineStyle.includes('font-size:20px');
            return text === '微信验证' && hasExpectedStyle;
        }));
    }).catch(() => false);
}

async function waitForWechatVerification(page, onLoginRequired) {
    let verificationVisible = await page.__remoteLogin?.intercepted() || await hasWechatVerification(page);
    if (!verificationVisible) return false;

    await requireInteractiveLogin(onLoginRequired || page.__onLoginRequired, page);
    console.log('检测到 Tora 微信验证，请通过前端远程浏览器入口完成登录...');

    while (verificationVisible) {
        await delay(1000);
        verificationVisible = await hasWechatVerification(page);
    }

    console.log('Tora 微信验证已消失，继续搜索。');
    await delay(500);
    return true;
}

async function waitForSelectorInDocuments(page, selector, timeout = 30000) {
    let activeWaitTime = 0;

    while (activeWaitTime < timeout) {
        await waitForWechatVerification(page);
        const checkStartedAt = Date.now();
        const found = await page.evaluate((targetSelector) => {
            const docs = [document];
            document.querySelectorAll('iframe').forEach((iframe) => {
                try {
                    if (iframe.contentDocument) docs.push(iframe.contentDocument);
                } catch (e) {
                    // 忽略跨域 iframe
                }
            });

            return docs.some((doc) => Boolean(doc.querySelector(targetSelector)));
        }, selector).catch(() => false);

        if (found) return true;
        await delay(500);
        activeWaitTime += Date.now() - checkStartedAt;
    }

    throw new Error(`Waiting for selector \`${selector}\` failed`);
}

async function openToraHome(page) {
    console.log('正在打开 Tora 网站...');
    await page.goto(TORA_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForWechatVerification(page);
    console.log('Tora 网站已成功打开。');
}

async function getToraPageState(page) {
    return page.evaluate((searchSelector, loginSel, logoutSel) => {
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const docs = [document];
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                if (iframe.contentDocument) docs.push(iframe.contentDocument);
            } catch (e) {
                // 忽略跨域 iframe
            }
        });

        const isSearchPage = location.href.includes('baowang.51cjml.com');
        const hasOeSearch = docs.some((doc) => Boolean(doc.querySelector(searchSelector)));
        const isLoggedIn = docs.some((doc) => Array.from(doc.querySelectorAll(logoutSel)).some(isVisible));
        const canOpenLogin = docs.some((doc) => Array.from(doc.querySelectorAll(loginSel)).some(isVisible));

        return { isSearchPage, hasOeSearch, isLoggedIn, canOpenLogin, url: location.href };
    }, OE_SEARCH_SELECTOR, LOGIN_BUTTON_SELECTOR, LOGOUT_BUTTON_SELECTOR).catch(() => ({
        isSearchPage: false,
        hasOeSearch: false,
        isLoggedIn: false,
        canOpenLogin: false,
        url: ''
    }));
}

async function waitForToraReady(page, cookieKey, onLoginRequired, onLoginResolved) {
    let loginWaitStartedAt = Date.now();
    if (await waitForWechatVerification(page)) loginWaitStartedAt = Date.now();
    let state = await getToraPageState(page);
    if (state.isLoggedIn && state.hasOeSearch) {
        onLoginResolved?.();
        return;
    }

    const hasUsablePage = () => state.isSearchPage && (state.hasOeSearch || state.isLoggedIn || state.canOpenLogin);
    if (!hasUsablePage()) {
        await openToraHome(page);
        state = await getToraPageState(page);
    }

    if (!hasUsablePage()) {
        throw new Error('Tora 搜索页面未能正常加载：页面未显示搜索框或登录入口');
    }

    if (state.isLoggedIn) {
        onLoginResolved?.();
        await waitForSelectorInDocuments(page, OE_SEARCH_SELECTOR, 30000);
        return;
    }

    if (state.canOpenLogin) {
        await page.evaluate((loginSel) => {
            const docs = [document];
            document.querySelectorAll('iframe').forEach((iframe) => {
                try {
                    if (iframe.contentDocument) docs.push(iframe.contentDocument);
                } catch (e) {
                    // 忽略跨域 iframe
                }
            });
            const loginBtn = docs.flatMap((doc) => Array.from(doc.querySelectorAll(loginSel)))
                .find((el) => {
                    const rect = el.getBoundingClientRect();
                    const style = el.ownerDocument.defaultView.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                });

            if (loginBtn) loginBtn.click();
        }, LOGIN_BUTTON_SELECTOR);
    }

    await requireInteractiveLogin(onLoginRequired, page);
    state = await getToraPageState(page);
    console.log("检测到 Tora 未登录，请通过前端远程浏览器入口完成登录。登录成功后程序会自动继续...");

    while (!state.isLoggedIn) {
        const verificationWasVisible = await waitForWechatVerification(page);
        if (verificationWasVisible) loginWaitStartedAt = Date.now();
        if (Date.now() - loginWaitStartedAt >= LOGIN_TIMEOUT_MS) throw createLoginTimeoutError();
        await delay(1500);
        state = await getToraPageState(page);
    }

    console.log("已检测到 Tora 登录状态，开始执行查询。");
    onLoginResolved?.();
    await waitForSelectorInDocuments(page, OE_SEARCH_SELECTOR, 30000);
    await saveCookies(page, cookieKey);
}

async function selectOeSearchTab(page) {
    await waitForWechatVerification(page);
    const hasResultSearch = await waitForSelectorInDocuments(page, '#oemData[data-keydown="keydown2"]', 1000)
        .then(() => true)
        .catch(() => false);
    if (hasResultSearch) return;

    await waitForSelectorInDocuments(page, OE_TAB_SELECTOR, 30000);
    await page.evaluate((tabSelector) => {
        const docs = [document];
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                if (iframe.contentDocument) docs.push(iframe.contentDocument);
            } catch (e) {
                // 忽略跨域 iframe
            }
        });

        const tab = docs.map((doc) => doc.querySelector(tabSelector)).find(Boolean);
        if (tab) tab.click();
    }, OE_TAB_SELECTOR);

    await delay(1000);
    await waitForSelectorInDocuments(page, OE_SEARCH_SELECTOR, 30000);
}

async function submitOeSearch(page, oe) {
    await waitForWechatVerification(page);
    await selectOeSearchTab(page);
    await waitForWechatVerification(page);

    const submitted = await page.evaluate((searchSelector, productSelector, keyword) => {
        const docs = [document];
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                if (iframe.contentDocument) docs.push(iframe.contentDocument);
            } catch (e) {
                // 忽略跨域 iframe
            }
        });

        const searchTargets = docs.map((doc) => {
            const homeContainer = doc.querySelector('.searchKey_byOe.searchKey');
            const homeInput = homeContainer && homeContainer.querySelector('#oemData.homeSearch[data-click="buttonOem"]');
            const homeButton = homeContainer && homeContainer.querySelector('#buttonOem.homeSeachBtn[data-type="1"]');
            const resultInput = doc.querySelector('#oemData[data-keydown="keydown2"]');
            const resultButton = doc.querySelector('#keydown2.action-goSearch[data-type="1"]');

            if (homeInput && homeButton) return { doc, inputEl: homeInput, searchBtn: homeButton };
            if (resultInput && resultButton) return { doc, inputEl: resultInput, searchBtn: resultButton };
            return null;
        }).filter(Boolean);

        const target = searchTargets[0];
        if (!target) throw new Error(`未找到 Tora OE 搜索输入/按钮 ${searchSelector}`);

        const { doc, inputEl, searchBtn } = target;
        const win = doc.defaultView || window;

        const fireRealClick = (el) => {
            el.scrollIntoView({ block: 'center', inline: 'center' });
            ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((type) => {
                el.dispatchEvent(new win.MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: win
                }));
            });
        };

        win.scrollTo(0, 0);
        doc.documentElement.scrollLeft = 0;
        doc.body.scrollLeft = 0;

        inputEl.focus();
        inputEl.value = '';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.value = keyword;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

        doc.querySelectorAll(productSelector).forEach((el) => el.remove());
        fireRealClick(searchBtn);
        return true;
    }, OE_SEARCH_SELECTOR, PRODUCT_NAME_SELECTOR, oe);

    if (!submitted) throw new Error("提交 Tora 查询失败");
}

async function getToraProductNames(page) {
    await waitForWechatVerification(page);
    const outcome = await waitForProductOutcome(page, 'tora', PRODUCT_NAME_SELECTOR, 15000, () => waitForWechatVerification(page));
    if (outcome === 'empty') return [];
    await waitForWechatVerification(page);

    return page.evaluate((selector) => {
        const docs = [document];
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                if (iframe.contentDocument) docs.push(iframe.contentDocument);
            } catch (e) {
                // 忽略跨域 iframe
            }
        });

        const els = docs.flatMap((doc) => Array.from(doc.querySelectorAll(selector)));
        return Array.from(new Set(els.map((el) => el.innerText.trim()).filter(Boolean)));
    }, PRODUCT_NAME_SELECTOR);
}

async function runTora(oeList, { signal, sessionId, onLoginRequired, onLoginResolved } = {}) {
    const { profileDirectory, cookieKey } = getScraperSessionPaths(__dirname, 'tora', sessionId);
    const browser = await launchBrowser({
        userDataDir: profileDirectory,
        args: ['--start-maximized']
    });

    return runBrowserTask(browser, signal, async () => {
      try {
        const page = await browser.newPage();
        attachRemoteLogin(page, { brand: 'tora', entryUrl: TORA_URL, cookieKey,
            isAuthenticated: async target => { const state = await getToraPageState(target); return state.isLoggedIn && !state.needsLogin; } });
        page.__onLoginRequired = onLoginRequired;
        await page.setViewport({ width: 1600, height: 1000 });

        const cookies = await readCookies(cookieKey);
        if (cookies.length) await page.setCookie(...cookies);

        await openToraHome(page);
        await waitForToraReady(page, cookieKey, onLoginRequired, onLoginResolved);

        const results = [];

        for (let i = 0; i < oeList.length; i++) {
            const oe = oeList[i];
            let productNames = [];
            console.log(`\n[%d/%d] 正在查询 Tora: %s`, i + 1, oeList.length, oe);

            try {
                const row = await withLoginRetry(page, async () => {
                    await waitForToraReady(page, cookieKey, onLoginRequired, onLoginResolved);
                    await submitOeSearch(page, oe);
                    await waitForWechatVerification(page);
                    await delay(3000);
                    await waitForWechatVerification(page);

                    productNames = await getToraProductNames(page);
                    if (productNames.length === 0) {
                        console.warn(` -> 未找到 [${oe}] 的对应 Tora 料号。`);
                        return { oe, productNames: [], status: '未找到对应结果', statusCode: 'NO_RESULTS' };
                    }

                    console.log(` -> 抓取成功: [${productNames.join(', ')}]`);
                    return { oe, productNames, status: '查询成功', statusCode: 'SEARCH_SUCCESS' };
                });
                results.push(row);
            } catch (err) {
                if (err.code?.startsWith('LOGIN_') || err.code === 'JOB_ABORTED') throw err;
                console.warn(` -> [失败] ${oe}: ${err.message}`);
                results.push({
                    oe,
                    productNames: [],
                    status: `查询失败(${err.message})`,
                    statusCode: getSearchErrorCode(err)
                });
                await delay(2000);
            }
        }

        await saveCookies(page, cookieKey);

        console.log("\n================ Tora 最终查询结果 ================");
        console.table(results);

        return results;
    } catch (err) {
        console.error(`Tora 查询发生致命错误: ${err.message}`);
        throw err;
      }
    });
}

module.exports = runTora;
