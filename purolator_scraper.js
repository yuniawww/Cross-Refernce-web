const { attachRemoteLogin, withLoginRetry } = require('./remote_login');
const { waitForProductOutcome } = require('./scraper_results');
const { launchBrowser, requireInteractiveLogin } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { getScraperSessionPaths, readCookies, saveCookies } = require('./scraper_session');

const PUROLATOR_URL = siteUrl('PUROLATOR_URL', 'https://purolator.51cjml.com');

// 根据代码2提取的页面元素 Selector
const OE_TAB_SELECTOR = '.searchTab_byOe';
const OE_SEARCH_SELECTOR = '.searchKey_byOe.searchKey #oemData.homeSearch[data-click="buttonOem"], #oemData[data-keydown="keydown2"]';
const PRODUCT_NAME_SELECTOR = '.productName2';
const PRODUCT_PARAMETER_BOX_SELECTOR = '.be-parameterBox';
const LOGIN_BUTTON_SELECTOR = '.action_login';
const LOGOUT_BUTTON_SELECTOR = '.action_loginOut';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// 延迟辅助函数
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLoginTimeoutError() {
    const error = new Error('LOGIN_TIMEOUT: Purolator 登录等待超时');
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
    console.log('检测到 Purolator 微信验证，请通过前端远程浏览器入口完成登录...');

    while (verificationVisible) {
        await delay(1000);
        verificationVisible = await hasWechatVerification(page);
    }

    console.log('Purolator 微信验证已消失，继续搜索。');
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

async function openPurolatorHome(page) {
    console.log('正在打开 Purolator 网站...');
    await page.goto(PUROLATOR_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(2000);
    await waitForWechatVerification(page);
    console.log('Purolator 网站已成功打开。');
}

// 1. 获取当前页面状态（包含登录态判断逻辑）
async function getPurolatorPageState(page) {
    return page.evaluate((oeTabSel, loginSel, logoutSel) => {
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
        
        const isSearchPage = location.href.includes('purolator.51cjml.com');
        const hasOeTab = docs.some((doc) => Boolean(doc.querySelector(oeTabSel)));
        const hasOeSearch = docs.some((doc) => Boolean(
            doc.querySelector('.searchKey_byOe.searchKey #oemData.homeSearch[data-click="buttonOem"]') ||
            doc.querySelector('#oemData[data-keydown="keydown2"]')
        ));
        const isLoggedIn = docs.some((doc) => Array.from(doc.querySelectorAll(logoutSel)).some(isVisible));
        const canOpenLogin = docs.some((doc) => Array.from(doc.querySelectorAll(loginSel)).some(isVisible));

        return { isSearchPage, hasOeTab, hasOeSearch, isLoggedIn, canOpenLogin, url: location.href };
    }, OE_TAB_SELECTOR, LOGIN_BUTTON_SELECTOR, LOGOUT_BUTTON_SELECTOR).catch(() => ({ isSearchPage: false, hasOeTab: false, hasOeSearch: false, isLoggedIn: false, canOpenLogin: false, url: '' }));
}

// 2. 等待页面就绪（拦截登录逻辑）
async function waitForPurolatorReady(page, cookieKey, onLoginRequired, onLoginResolved) {
    let loginWaitStartedAt = Date.now();
    if (await waitForWechatVerification(page)) loginWaitStartedAt = Date.now();
    let state = await getPurolatorPageState(page);
    if (state.isLoggedIn && state.hasOeSearch) {
        onLoginResolved?.();
        return;
    }

    if (!state.isSearchPage) {
        await openPurolatorHome(page);
        state = await getPurolatorPageState(page);
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
    state = await getPurolatorPageState(page);
    console.log("检测到 Purolator 未登录，请通过前端远程浏览器入口完成登录。登录成功后程序会自动继续...");

    while (!state.isLoggedIn) {
        const verificationWasVisible = await waitForWechatVerification(page);
        if (verificationWasVisible) loginWaitStartedAt = Date.now();
        if (Date.now() - loginWaitStartedAt >= LOGIN_TIMEOUT_MS) throw createLoginTimeoutError();
        await delay(1500);
        state = await getPurolatorPageState(page);
    }

    console.log("已检测到 Purolator 登录状态，开始执行查询。");
    onLoginResolved?.();
    await waitForSelectorInDocuments(page, OE_SEARCH_SELECTOR, 30000);
    // 登录成功后保存 Cookie
    await saveCookies(page, cookieKey);
}

// 3. 选择按 OE 号搜索标签
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
        if (tab && !tab.classList.contains('searchActiveTab')) {
            tab.click();
        }
    }, OE_TAB_SELECTOR);

    await delay(1000);
    await waitForSelectorInDocuments(page, OE_SEARCH_SELECTOR, 30000);
}

// 4. 提交 OE 查询
async function submitOeSearch(page, oe) {
    await waitForWechatVerification(page);
    await selectOeSearchTab(page);
    await waitForWechatVerification(page);

    const submitted = await page.evaluate((searchSelector, productSelector, parameterBoxSelector, keyword) => {
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
        if (!target) throw new Error(`未在子窗口找到 OE 搜索输入/按钮 ${searchSelector}`);

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
        doc.querySelectorAll(parameterBoxSelector).forEach((el) => el.remove());
        fireRealClick(searchBtn);
        return true;
    }, OE_SEARCH_SELECTOR, PRODUCT_NAME_SELECTOR, PRODUCT_PARAMETER_BOX_SELECTOR, oe);

    if (!submitted) {
        throw new Error("提交 Purolator 查询失败");
    }
}

// 5. 抓取产品名称和所有动态参数
async function getPurolatorProducts(page) {
    await waitForWechatVerification(page);
    const outcome = await waitForProductOutcome(page, 'purolator', PRODUCT_NAME_SELECTOR, 15000, () => waitForWechatVerification(page));
    if (outcome === 'empty') return [];
    const parametersOutcome = await waitForProductOutcome(page, 'purolator', PRODUCT_PARAMETER_BOX_SELECTOR, 5000, () => waitForWechatVerification(page));
    if (parametersOutcome === 'empty') return [];
    await waitForWechatVerification(page);
    
    return page.evaluate((nameSelector, parameterBoxSelector) => {
        const docs = [document];
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                if (iframe.contentDocument) docs.push(iframe.contentDocument);
            } catch (e) {
                // 忽略跨域 iframe
            }
        });

        const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
        const products = [];

        docs.forEach((doc) => {
            const nameElements = Array.from(doc.querySelectorAll(nameSelector));
            const fallbackNames = nameElements.map((element) => normalize(element.textContent));
            const parameterBoxes = Array.from(doc.querySelectorAll(parameterBoxSelector));
            const usedNames = new Set();

            parameterBoxes.forEach((box, boxIndex) => {
                let productNameElement = null;
                let parent = box.parentElement;

                while (parent && parent !== doc.body) {
                    const containedNames = Array.from(parent.querySelectorAll(nameSelector));
                    if (containedNames.length === 1) {
                        productNameElement = containedNames[0];
                        break;
                    }
                    if (containedNames.length > 1) break;
                    parent = parent.parentElement;
                }

                const productName = normalize(productNameElement ? productNameElement.textContent : fallbackNames[boxIndex] || '');
                if (productName) usedNames.add(productName);

                const parameters = Array.from(box.querySelectorAll('span')).map((span, parameterIndex) => {
                    const titleText = normalize(span.getAttribute('title'));
                    const fullText = titleText || normalize(span.textContent);
                    const separatorIndex = fullText.search(/[：:]/);
                    const boldValue = normalize(span.querySelector('b')?.textContent);
                    const label = separatorIndex >= 0
                        ? normalize(fullText.slice(0, separatorIndex))
                        : `参数${parameterIndex + 1}`;
                    const value = separatorIndex >= 0
                        ? normalize(fullText.slice(separatorIndex + 1)) || boldValue
                        : boldValue || fullText;

                    return { label, value };
                }).filter((parameter) => parameter.label || parameter.value);

                products.push({ productName: productName || '-', parameters });
            });

            fallbackNames.forEach((productName) => {
                if (productName && !usedNames.has(productName)) {
                    products.push({ productName, parameters: [] });
                }
            });
        });

        const uniqueProducts = new Map();
        products.forEach((product) => {
            const key = normalize(product.productName).toUpperCase();
            if (!uniqueProducts.has(key)) {
                uniqueProducts.set(key, { productName: product.productName, parameters: [] });
            }

            const target = uniqueProducts.get(key);
            const parameterKeys = new Set(target.parameters.map((parameter) => `${parameter.label}\u0000${parameter.value}`));
            product.parameters.forEach((parameter) => {
                const parameterKey = `${parameter.label}\u0000${parameter.value}`;
                if (!parameterKeys.has(parameterKey)) {
                    target.parameters.push(parameter);
                    parameterKeys.add(parameterKey);
                }
            });
        });

        return Array.from(uniqueProducts.values());
    }, PRODUCT_NAME_SELECTOR, PRODUCT_PARAMETER_BOX_SELECTOR);
}

// ================= 主运行流程 =================
async function runPurolator(oeList, { signal, sessionId, onLoginRequired, onLoginResolved } = {}) {
    const { profileDirectory, cookieKey } = getScraperSessionPaths(__dirname, 'purolator', sessionId);
    const browser = await launchBrowser({
        userDataDir: profileDirectory,
        args: ['--start-maximized']
    });

    return runBrowserTask(browser, signal, async () => {
      try {
        const page = await browser.newPage();
        attachRemoteLogin(page, { brand: 'purolator', entryUrl: PUROLATOR_URL, cookieKey,
            isAuthenticated: async target => { const state = await getPurolatorPageState(target); return state.isLoggedIn && !state.needsLogin; } });
        page.__onLoginRequired = onLoginRequired;
        await page.setViewport({ width: 1600, height: 1000 });

        // 加载历史 Cookie 以免密登录
        const cookies = await readCookies(cookieKey);
        if (cookies.length) await page.setCookie(...cookies);

        await openPurolatorHome(page);

        // 检查是否在登录页，暂停让用户手动登录
        await waitForPurolatorReady(page, cookieKey, onLoginRequired, onLoginResolved);
        
        const results = [];

        // 遍历所有待查 OE 号
        for (let i = 0; i < oeList.length; i++) {
            const oe = oeList[i];
            let productNames = [];
            let products = [];
            console.log(`\n[%d/%d] 正在查询 Purolator: %s`, i + 1, oeList.length, oe);

            try {
                const row = await withLoginRetry(page, async () => {
                    await waitForPurolatorReady(page, cookieKey, onLoginRequired, onLoginResolved);
                    
                    // 提交搜索
                    await submitOeSearch(page, oe);

                    await waitForWechatVerification(page);
                    
                    // 给页面充分的时间开始刷新/请求 (对应代码2的 sleep(3000))
                    await delay(3000);
                    await waitForWechatVerification(page);

                    // 获取型号及参数框内的全部动态参数
                    products = await getPurolatorProducts(page);
                    productNames = [...new Set(products.map((product) => product.productName).filter((name) => name && name !== '-'))];

                    if (productNames.length === 0) {
                        console.warn(` -> 未找到 [${oe}] 的对应 Purolator 料号。`);
                        return { oe, productNames: [], products: [], status: '未找到对应结果', statusCode: 'NO_RESULTS' };
                    }

                    console.log(` -> 抓取成功: [${productNames.join(', ')}]`);
                    
                    return {
                        oe,
                        productNames,
                        products,
                        status: '查询成功',
                        statusCode: 'SEARCH_SUCCESS'
                    };
                });
                results.push(row);
            } catch (err) {
                if (err.code?.startsWith('LOGIN_') || err.code === 'JOB_ABORTED') throw err;
                console.warn(` -> [失败] ${oe}: ${err.message}`);
                results.push({ 
                    oe, 
                    productNames: [],
                    products: [],
                    status: `查询失败(${err.message})`,
                    statusCode: getSearchErrorCode(err)
                });
                await delay(2000); // 失败后缓冲
            }
        }

        // 保存最终Cookie
        await saveCookies(page, cookieKey);

        // 最终直接将结果打印在终端上，不输出 CSV
        console.log("\n================ 最终查询结果 ================");
        console.table(results);
        
        return results;
    } catch (err) {
        console.error(`Purolator 查询发生致命错误: ${err.message}`);
        await delay(10000);
        throw err;
      }
    });
}


module.exports = runPurolator;
