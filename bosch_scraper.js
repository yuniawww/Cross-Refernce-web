const { launchBrowser } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { getScraperSessionPaths } = require('./scraper_session');

const BOSCH_URL = siteUrl('BOSCH_URL', 'https://boschaftermarket.com.cn/Dealerportal/gb/cn/parts');
const SEARCH_INPUT_SELECTOR = 'input[placeholder="请输入博世号/原厂信息"]';
const PRODUCT_NUMBER_SELECTOR = 'td.ant-table-cell a';
const BOSCH_SITE_ERROR_TEXT = 'this is a message of 0: unknown error';

function createBoschSiteConnectionError() {
    const error = new Error('BOSCH_SITE_CONNECTION_ERROR: This is a message of 0: Unknown Error');
    error.code = 'SITE_CONNECTION_ERROR';
    return error;
}

// 在页面和 iframe 中持续监测；递归检查开放的 Shadow DOM（Cookie 组件常用）。
function installBoschCookieMonitor() {
    if (window.__boschCookieMonitor) return window.__boschCookieMonitor.scan();
    const monitor = { lastClick: 0, scan: null };
    monitor.scan = () => {
        const roots = [document];
        for (let i = 0; i < roots.length; i++) {
            roots[i].querySelectorAll('*').forEach((element) => {
                if (element.shadowRoot) roots.push(element.shadowRoot);
            });
        }
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const normalize = (element) => element.textContent.replace(/\s+/g, ' ').trim();
        const headline = roots.flatMap((root) => Array.from(root.querySelectorAll('span[slot="headline"]#title')))
            .find((element) => visible(element) && normalize(element) === 'Use of cookies and similar technologies');
        if (!headline) return false;
        const label = roots.flatMap((root) => Array.from(root.querySelectorAll('.a-button__label')))
            .find((element) => visible(element) && normalize(element) === 'Accept all');
        if (label && Date.now() - monitor.lastClick >= 1000) {
            const button = label.closest('button, [role="button"], a') || label;
            if (!button.disabled && button.getAttribute('aria-disabled') !== 'true') {
                monitor.lastClick = Date.now();
                button.click();
            }
        }
        // 即使已经点击，也等下一轮确认标题消失后才恢复搜索。
        return true;
    };
    window.__boschCookieMonitor = monitor;
    setInterval(monitor.scan, 150);
    return monitor.scan();
}

async function waitForBoschCookies(page) {
    const startedAt = Date.now();
    let announced = false;
    while (!page.isClosed()) {
        let blocked = false;
        for (const frame of page.frames()) {
            try {
                if (await frame.evaluate(installBoschCookieMonitor)) blocked = true;
            } catch (error) {
                // 页面导航或 iframe 移除时，下一轮检查新文档。
                if (!/context.*destroyed|detached|Cannot find context/i.test(error.message)) throw error;
                blocked = true;
            }
        }
        if (!blocked) return;
        if (!announced) {
            console.log('Bosch Cookie 弹窗已出现，暂停搜索并点击 Accept all，等待弹窗关闭。');
            announced = true;
        }
        if (Date.now() - startedAt >= 60000) throw new Error('Bosch Cookie 弹窗关闭超时');
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Bosch browser page closed');
}

async function assertNoBoschSiteError(page) {
    for (const frame of page.frames()) {
        try {
            const hasSiteError = await frame.evaluate((errorText) => {
                const visibleText = String(document.body?.innerText || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();
                return visibleText.includes(errorText);
            }, BOSCH_SITE_ERROR_TEXT);
            if (hasSiteError) throw createBoschSiteConnectionError();
        } catch (error) {
            if (error?.code === 'SITE_CONNECTION_ERROR') throw error;
            if (!/context.*destroyed|detached|Cannot find context/i.test(error.message)) throw error;
        }
    }
}

// Cookie 处理时间不计入搜索元素/结果的等待时间。
async function waitForBoschValue(page, predicate, timeout, ...args) {
    let elapsed = 0;
    while (elapsed < timeout) {
        await waitForBoschCookies(page);
        await assertNoBoschSiteError(page);
        const startedAt = Date.now();
        const value = await page.evaluate(predicate, ...args);
        elapsed += Date.now() - startedAt;
        await waitForBoschCookies(page);
        await assertNoBoschSiteError(page);
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 150));
        elapsed += 150;
    }
    throw new Error(`Bosch 查询等待超时 (${timeout}ms)`);
}

function getSearchErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/net::|ERR_|Navigation timeout|ECONN|socket|network/i.test(message)) return 'NETWORK_ERROR';
    if (/Waiting for selector|搜索框|搜索页面/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/Timeout|超时/i.test(message)) return 'QUERY_TIMEOUT';
    return 'SEARCH_ERROR';
}

async function openProductSearch(page) {
    // 网站导航独立于单个 OE 查询；导航失败直接交给任务层显示网站连接错误。
    console.log('正在打开 Bosch 网站，页面加载时间不计入 OE 查询时间...');
    await page.goto(BOSCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForBoschValue(page, () => {
        return Array.from(document.querySelectorAll('[role="tab"]')).some((element) => (
            element.textContent.replace(/\s+/g, '') === '产品搜索' &&
            element.getBoundingClientRect().width > 0 &&
            element.getAttribute('aria-disabled') !== 'true'
        )) || false;
    }, 30000).catch((error) => {
        throw new Error(`Bosch 搜索页面未找到产品搜索标签: ${error.message}`);
    });
    await waitForBoschCookies(page);
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('[role="tab"]')).find((element) => (
            element.textContent.replace(/\s+/g, '') === '产品搜索' &&
            element.getBoundingClientRect().width > 0 &&
            element.getAttribute('aria-disabled') !== 'true'
        )).click();
    });
    await waitForBoschValue(page, (selector) => {
        const input = document.querySelector(selector);
        return Boolean(input && input.getBoundingClientRect().width > 0 && getComputedStyle(input).visibility !== 'hidden');
    }, 30000, SEARCH_INPUT_SELECTOR);
    await assertNoBoschSiteError(page);
    console.log('Bosch 网站已打开，产品搜索框已就绪。');
}

async function searchBoschNumbers(page, oe) {
    await waitForBoschCookies(page);
    await assertNoBoschSiteError(page);
    // 显式清空并通知 Angular 更新绑定值，避免连续查询时拼接旧料号。
    await page.$eval(SEARCH_INPUT_SELECTOR, (input) => {
        input.focus();
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setValue.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForBoschValue(page, (selector) => (
        document.querySelector(selector)?.value === ''
    ), 5000, SEARCH_INPUT_SELECTOR);
    for (const character of oe) {
        await waitForBoschCookies(page);
        await assertNoBoschSiteError(page);
        await page.type(SEARCH_INPUT_SELECTOR, character);
    }
    await waitForBoschCookies(page);
    await assertNoBoschSiteError(page);
    await page.focus(SEARCH_INPUT_SELECTOR);
    // 只观察结果区域，不等待整站网络空闲；后台统计/轮询请求不应阻塞取号。
    await page.evaluate(() => {
        window.__boschResultObserver?.disconnect();
        const state = { changed: false, lastChange: Date.now() };
        window.__boschResultState = state;
        const selector = 'td.ant-table-cell, .ant-empty-description, .ant-table-placeholder, .ant-spin';
        const relevant = (node) => {
            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            return Boolean(element && (element.closest(selector) || element.querySelector(selector)));
        };
        window.__boschResultObserver = new MutationObserver((mutations) => {
            if (mutations.some((mutation) => (
                // 检查目标的祖先，以及新增/移除子树，避免 body 上的无关变化重置等待时间。
                mutation.target.parentElement?.closest(selector) ||
                (mutation.target.nodeType === Node.ELEMENT_NODE && mutation.target.matches(selector)) ||
                [...mutation.addedNodes, ...mutation.removedNodes].some(relevant)
            ))) {
                state.changed = true;
                state.lastChange = Date.now();
            }
        });
        window.__boschResultObserver.observe(document.body, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['class', 'style', 'hidden']
        });
    });

    try {
      await page.keyboard.press('Enter');
      const result = await waitForBoschValue(page, (selector) => {
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const state = window.__boschResultState;
        if (!state?.changed || Date.now() - state.lastChange < 400) return false;
        const input = Array.from(document.querySelectorAll('input[placeholder="请输入博世号/原厂信息"]')).find(visible);
        const panel = input?.closest('[role="tabpanel"]') || document;
        if (Array.from(panel.querySelectorAll('.ant-spin-spinning')).some(visible)) return false;

        // 搜索完成后显示“暂无数据”，直接判定无结果，避免读取残留料号。
        const noData = Array.from(panel.querySelectorAll('p.ant-empty-description'))
            .some((element) => visible(element) && element.textContent.replace(/\s+/g, '') === '暂无数据');
        if (noData) return { productNames: [] };

        const products = Array.from(panel.querySelectorAll(selector))
            .filter(visible)
            .map((element) => ({
                number: element.textContent.replace(/\s+/g, '').trim(),
                inSale: Array.from(element.closest('tr')?.querySelectorAll('nz-tag.ant-tag.in-sale') || [])
                    .some((tag) => visible(tag) && tag.textContent.replace(/\s+/g, '') === '在售')
            }))
            .filter(({ number }) => /^[A-Z0-9.-]+$/i.test(number) && /\d/.test(number));
        const numbers = [...new Set(products.map(({ number }) => number))];
        if (numbers.length) {
            const selected = numbers.length > 1 ? products.filter((product) => product.inSale) : products;
            // 有结果但多个料号均不在售时返回空列表，不继续等到超时。
            return { productNames: [...new Set(selected.map(({ number }) => number))] };
        }

        const empty = Array.from(panel.querySelectorAll('.ant-empty-description, .ant-table-placeholder'))
            .some((element) => visible(element) && /暂无|没有|无数据|无匹配|未找到|no data|no result/i.test(element.textContent));
        return empty ? { productNames: [] } : false;
      }, 30000, PRODUCT_NUMBER_SELECTOR);
      return result.productNames;
    } finally {
        if (!page.isClosed()) {
            await page.evaluate(() => {
                window.__boschResultObserver?.disconnect();
                delete window.__boschResultObserver;
                delete window.__boschResultState;
            }).catch(() => undefined);
        }
    }
}

async function runBosch(oeList, { signal, sessionId } = {}) {
    const { profileDirectory } = getScraperSessionPaths(__dirname, 'bosch', sessionId);
    const browser = await launchBrowser({
        userDataDir: profileDirectory,
        args: ['--start-maximized']
    });

    return runBrowserTask(browser, signal, async () => {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(installBoschCookieMonitor);
        await page.setViewport({ width: 1600, height: 1000 });
        const results = [];

        // 先完成网站导航及搜索页初始化，之后才开始逐个 OE 的查询计时。
        await openProductSearch(page);

        for (const [index, oe] of oeList.entries()) {
            if (signal?.aborted) break;
            console.log(`\n[${index + 1}/${oeList.length}] 正在查询 Bosch: ${oe}`);
            try {
                const productNames = await searchBoschNumbers(page, oe);
                results.push({
                    oe,
                    productNames,
                    status: productNames.length ? '查询成功' : '未找到对应结果',
                    statusCode: productNames.length ? 'SEARCH_SUCCESS' : 'NO_RESULTS'
                });
            } catch (error) {
                if (signal?.aborted || error?.code === 'SITE_CONNECTION_ERROR') throw error;
                console.warn(`Bosch 查询失败 [${oe}]: ${error.message}`);
                results.push({
                    oe,
                    productNames: [],
                    status: `查询失败(${error.message})`,
                    statusCode: getSearchErrorCode(error)
                });
            }
        }
        return results;
    });
}

module.exports = runBosch;
