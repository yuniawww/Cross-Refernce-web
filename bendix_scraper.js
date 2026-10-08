const { launchBrowser } = require('./browser');
const { siteUrl } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { navigateToCatalogue } = require('./site_navigation');
const { createCataloguePage } = require('./catalogue_page');

const CATALOGUES = {
    bendix_au: siteUrl('BENDIX_AU_URL', 'https://www.bendix.com.au/catalogue'),
    bendix_my: siteUrl('BENDIX_MY_URL', 'https://www.bendix.com.my/en-my/catalogue')
};
const PART_NUMBER_TAB_SELECTOR = 'button[class*="catalogue-widget__content__toggles__toggle__"]';
const INPUT_SELECTOR = 'input[class*="catalogue-widget-search-box__part-input__"][placeholder="Enter a part number"]';
const SEARCH_BUTTON_SELECTOR = 'button[class*="button--black__"][type="submit"]';
const RESULT_HEADER_SELECTOR = 'a[class*="part-card-header__content__"]';
const RESULT_CRITERIA_SELECTOR = 'ul[class*="part-card-criteria__"]';
const RESULT_COUNT_SELECTOR = 'p[class*="results-count__hits__"]';
const EMPTY_RESULT_PATTERN_SOURCE = String.raw`we couldn['’]t find an exact match`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isNavigationRaceError(error) {
    return /Execution context was destroyed|Cannot find context|context.*destroyed|frame was detached|detached Frame/i.test(error?.message || '');
}

function getSearchErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code?.startsWith('SITE_')) return 'SOURCE_UNAVAILABLE';
    if (/net::|ERR_|Navigation timeout|ECONN|socket|network/i.test(message)) return 'NETWORK_ERROR';
    if (/Waiting for selector|Waiting for function|无法加载.*搜索框|未找到.*搜索输入|search input/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/Timeout|超时/i.test(message)) return 'QUERY_TIMEOUT';
    return 'SEARCH_ERROR';
}

function normalizeBendixPartNumber(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isBendixEmptyResultText(value, expectedPartNumber = '') {
    const text = normalizeBendixPartNumber(value);
    if (!new RegExp(EMPTY_RESULT_PATTERN_SOURCE, 'i').test(text)) return false;
    const expected = normalizeBendixPartNumber(expectedPartNumber);
    return !expected || text.toUpperCase().includes(expected.toUpperCase());
}

function keepFirstBendixProduct(products) {
    return Array.isArray(products) && products.length ? [products[0]] : [];
}

function parseBendixCandidateGroups(values) {
    return (Array.isArray(values) ? values : [values])
        .flatMap(value => String(value || '').split(/\r?\n/))
        .map(line => {
            const candidates = [];
            const seen = new Set();
            for (const value of line.split(/[;；]+/)) {
                const candidate = normalizeBendixPartNumber(value);
                if (!candidate || !/\d/.test(candidate)) continue;
                const key = candidate.toUpperCase();
                if (seen.has(key)) continue;
                seen.add(key);
                candidates.push(candidate);
            }
            return candidates.length ? { input: candidates.join('; '), candidates } : null;
        })
        .filter(Boolean);
}

async function findFirstBendixMatch(candidates, lookup) {
    const attemptedPartNumbers = [];
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        attemptedPartNumbers.push(candidate);
        try {
            const products = await lookup(candidate, index);
            if (products.length) return { matchedPartNumber: candidate, attemptedPartNumbers, products };
        } catch (error) {
            error.attemptedPartNumbers = attemptedPartNumbers;
            error.failedPartNumber = candidate;
            throw error;
        }
    }
    return { matchedPartNumber: '', attemptedPartNumbers, products: [] };
}

function isExpectedCancelledRequest(request) {
    return /ERR_ABORTED/i.test(request.failure()?.errorText || '');
}

function installBendixOverlayGuard() {
    if (window.__bendixOverlayGuard) return window.__bendixOverlayGuard.scan();
    const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalizedText = element => (element.textContent || '').replace(/\s+/g, ' ').trim();
    const guard = { scan: null };
    guard.scan = () => {
        let closed = false;

        // Bendix's fixed cookie banner has no text on its close button and sits
        // above the catalogue at z-index 9999.
        const cookieClose = [...document.querySelectorAll('button[class*="cookie-policy__close__"]')].find(visible);
        if (cookieClose) {
            cookieClose.click();
            closed = true;
        }

        const roots = [...document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popup"]')]
            .filter(visible);
        for (const root of roots) {
            const buttons = [...root.querySelectorAll('button, [role="button"]')].filter(visible);
            const closeButton = buttons.find(button => {
                const label = `${normalizedText(button)} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`.trim();
                const className = typeof button.className === 'string' ? button.className : '';
                return /close|dismiss|not now|no thanks|maybe later|accept all|continue without/i.test(label)
                    || /(?:^|[_-])close(?:[_-]|$)/i.test(className);
            });
            if (closeButton) {
                closeButton.click();
                closed = true;
            }
        }
        return closed;
    };
    window.__bendixOverlayGuard = guard;
    guard.scan();
    setInterval(guard.scan, 250);
    return true;
}

async function setupBendixPage(page, label) {
    page.on('pageerror', (error) => {
        if (/Unexpected identifier ['"]?content/i.test(error.message)) return;
        console.warn(`${label} 页面脚本错误，已忽略: ${error.message}`);
    });
    page.on('requestfailed', (request) => {
        if (isExpectedCancelledRequest(request)) return;
        console.warn(`${label} 资源加载失败: ${request.url()} ${request.failure()?.errorText || ''}`);
    });
    page.on('dialog', (dialog) => {
        console.log(`${label}: 已自动关闭浏览器对话框。`);
        void dialog.dismiss().catch(() => undefined);
    });
    page.on('popup', (popup) => {
        console.log(`${label}: 已自动关闭弹出的页面。`);
        void popup.close()
            .catch(() => undefined)
            .finally(() => page.bringToFront().catch(() => undefined));
    });
    await page.evaluateOnNewDocument(installBendixOverlayGuard);
}

async function dismissBendixOverlays(page, label) {
    const closed = await page.evaluate(installBendixOverlayGuard).catch((error) => {
        if (isNavigationRaceError(error)) return false;
        throw error;
    });
    if (closed) {
        console.log(`${label}: 已关闭遮挡目录的弹窗。`);
        await delay(300);
    }
}

async function findAndClickPartNumberTab(page, label) {
    await dismissBendixOverlays(page, label);
    console.log(`${label}: 等待 Part number 按钮...`);
    await page.waitForFunction((classSelector) => {
        const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const candidates = [
            ...document.querySelectorAll(classSelector),
            ...document.querySelectorAll('button')
        ];
        return candidates.some(button => visible(button) && button.textContent.replace(/\s+/g, ' ').trim() === 'Part number');
    }, { timeout: 30000 }, PART_NUMBER_TAB_SELECTOR);

    const clicked = await page.evaluate((classSelector) => {
        const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const candidates = [
            ...document.querySelectorAll(classSelector),
            ...document.querySelectorAll('button')
        ];
        const button = candidates.find(element => visible(element) && element.textContent.replace(/\s+/g, ' ').trim() === 'Part number');
        if (!button) return false;
        button.scrollIntoView({ block: 'center' });
        button.click();
        return true;
    }, PART_NUMBER_TAB_SELECTOR);
    if (!clicked) throw new Error('未找到 Bendix Part number 按钮');
    console.log(`${label}: 已点击 Part number。`);
}

async function openBendixCatalogue(page, catalogueUrl, label) {
    console.log(`正在打开 ${label} 网站...`);
    await navigateToCatalogue(page, catalogueUrl, label);
    await findAndClickPartNumberTab(page, label);
    await page.waitForSelector(INPUT_SELECTOR, { visible: true, timeout: 15000 });
    console.log(`${label} 网站已成功打开，料号输入框已就绪。`);
}

function extractBendixProducts() {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const headers = [...document.querySelectorAll('a[class*="part-card-header__content__"]')];
    const products = [];
    for (const header of headers) {
        // The competitor number comes only from the product-card header link.
        // Do not use a generic ancestor h4 because a result container can hold
        // several product cards and unrelated headings.
        const partNumber = clean(header.querySelector(':scope > h4')?.textContent || header.querySelector('h4')?.textContent);
        if (!partNumber) continue;

        let card = header.parentElement;
        let list = null;
        while (card && card !== document.body) {
            const cardHeaders = card.querySelectorAll('a[class*="part-card-header__content__"]');
            const candidateList = card.querySelector('ul[class*="part-card-criteria__"]');
            if (candidateList && cardHeaders.length === 1 && cardHeaders[0] === header) {
                list = candidateList;
                break;
            }
            card = card.parentElement;
        }
        const dimensions = {};
        for (const item of list?.querySelectorAll('li') || []) {
            const label = clean(item.querySelector('[class*="__label__"]')?.textContent);
            const value = clean(item.querySelector('[class*="__value__"]')?.textContent);
            if (/^(Width|Height|Thickness)$/i.test(label) && value) dimensions[label.toLowerCase()] = value;
        }
        products.push({
            partNumber,
            width: dimensions.width || '',
            height: dimensions.height || '',
            thickness: dimensions.thickness || '',
            url: header.href || ''
        });
    }
    return [...new Map(products.map(product => [product.partNumber.toUpperCase(), product])).values()];
}

async function prepareResultChangeMonitor(page) {
    return page.evaluate((headerSelector, criteriaSelector) => {
        window.__bendixResultObserver?.disconnect();
        window.__bendixDocumentMarker ||= `${Date.now()}-${Math.random()}`;
        const signature = () => [...document.querySelectorAll(headerSelector)]
            .map(header => `${header.querySelector('h4')?.textContent || ''}|${header.parentElement?.querySelector(criteriaSelector)?.textContent || ''}`)
            .join('\n');
        const initialSignature = signature();
        window.__bendixResultState = { initialSignature, changed: false, cleared: false };
        window.__bendixResultObserver = new MutationObserver(() => {
            const currentSignature = signature();
            if (!currentSignature) window.__bendixResultState.cleared = true;
            if (currentSignature !== initialSignature) window.__bendixResultState.changed = true;
        });
        window.__bendixResultObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        return { initialSignature, initialUrl: location.href, documentMarker: window.__bendixDocumentMarker };
    }, RESULT_HEADER_SELECTOR, RESULT_CRITERIA_SELECTOR);
}

async function typePartNumber(page, partNumber, label) {
    await dismissBendixOverlays(page, label);
    await page.waitForSelector(INPUT_SELECTOR, { visible: true, timeout: 15000 });
    console.log(`${label}: 输入料号 ${partNumber}...`);
    await page.click(INPUT_SELECTOR, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(INPUT_SELECTOR, partNumber, { delay: 60 });
    const enteredValue = await page.$eval(INPUT_SELECTOR, input => input.value);
    if (enteredValue.trim() !== partNumber) {
        throw new Error(`Bendix 料号输入失败：期望 ${partNumber}，实际 ${enteredValue}`);
    }
    console.log(`${label}: 已输入料号 ${partNumber}。`);
}

async function waitForUrlChange(page, initialUrl, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (page.url() !== initialUrl) return true;
        await delay(100);
    }
    return page.url() !== initialUrl;
}

async function clickSearchButton(page, label, initialUrl) {
    await dismissBendixOverlays(page, label);
    const targetSelector = '[data-bendix-search-target="true"]';
    const found = await page.evaluate((inputSelector, buttonSelector) => {
        const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const input = [...document.querySelectorAll(inputSelector)].find(visible);
        const form = input?.closest('form');
        const candidates = [
            ...(form ? form.querySelectorAll(buttonSelector) : []),
            ...(form ? form.querySelectorAll('button[type="submit"]') : []),
            ...document.querySelectorAll(buttonSelector)
        ];
        const button = candidates.find(element => visible(element) && element.textContent.replace(/\s+/g, ' ').trim().startsWith('Search'));
        if (!button) return false;
        button.scrollIntoView({ block: 'center' });
        document.querySelectorAll('[data-bendix-search-target]').forEach(element => element.removeAttribute('data-bendix-search-target'));
        button.setAttribute('data-bendix-search-target', 'true');
        return true;
    }, INPUT_SELECTOR, SEARCH_BUTTON_SELECTOR);
    if (!found) throw new Error('未找到 Bendix Search 按钮');

    // Puppeteer's mouse click is sent outside the page JavaScript context. If
    // the form navigates immediately, destruction of the old context is an
    // expected success condition rather than a failed click.
    try {
        await page.click(targetSelector);
    } catch (error) {
        if (!isNavigationRaceError(error)) throw error;
    }
    if (await waitForUrlChange(page, initialUrl, 4000)) {
        console.log(`${label}: Search 已提交，页面正在跳转...`);
        return;
    }

    console.log(`${label}: 鼠标点击未触发跳转，正在使用页面点击事件重试...`);
    try {
        await page.evaluate((selector) => document.querySelector(selector)?.click(), targetSelector);
    } catch (error) {
        if (!isNavigationRaceError(error)) throw error;
    }
    if (await waitForUrlChange(page, initialUrl, 4000)) {
        console.log(`${label}: Search 已通过页面点击事件提交。`);
        return;
    }

    console.log(`${label}: 页面点击未触发跳转，正在直接提交搜索表单...`);
    try {
        await page.evaluate((selector) => {
            const button = document.querySelector(selector);
            const form = button?.form || button?.closest('form');
            if (!form || !button) return false;
            if (typeof form.requestSubmit === 'function') form.requestSubmit(button);
            else form.submit();
            return true;
        }, targetSelector);
    } catch (error) {
        if (!isNavigationRaceError(error)) throw error;
    }
    if (await waitForUrlChange(page, initialUrl, 5000)) {
        console.log(`${label}: Search 表单已提交，页面正在跳转...`);
        return;
    }

    console.log(`${label}: 表单提交未触发跳转，正在使用 Enter 键重试...`);
    await page.focus(INPUT_SELECTOR);
    await page.keyboard.press('Enter');
    if (await waitForUrlChange(page, initialUrl, 5000)) {
        console.log(`${label}: Search 已通过 Enter 键提交。`);
        return;
    }
    throw new Error('Bendix Search 未触发页面跳转');
}

async function waitForBendixOutcome(page, previousState, partNumber) {
    const deadline = Date.now() + 30000;
    let exactNoMatchSince = 0;
    while (Date.now() < deadline) {
        try {
            const outcome = await page.evaluate((headerSelector, criteriaSelector, resultCountSelector, emptyPattern, searchedPartNumber, oldSignature, oldUrl, oldDocumentMarker) => {
                const headers = [...document.querySelectorAll(headerSelector)];
                const signature = headers
                    .map(header => `${header.querySelector('h4')?.textContent || ''}|${header.parentElement?.querySelector(criteriaSelector)?.textContent || ''}`)
                    .join('\n');
                const routeChanged = location.href !== oldUrl;
                const state = window.__bendixResultState;
                const documentChanged = window.__bendixDocumentMarker !== oldDocumentMarker;
                const resultChanged = documentChanged || signature !== oldSignature || state?.changed || state?.cleared;
                const body = document.body.innerText || '';
                const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
                const expected = normalize(searchedPartNumber).toUpperCase();
                const exactNoMatch = [...document.querySelectorAll(resultCountSelector)]
                    .some(element => {
                        const text = normalize(element.textContent);
                        return new RegExp(emptyPattern, 'i').test(text)
                            && (!expected || text.toUpperCase().includes(expected));
                    });
                const genericEmpty = /no (parts|products|results) (found|match)|0 results|sorry,? no results/i.test(body);
                // The catalogue home page contains recommendation cards. Wait
                // for fresh card content. Malaysia can update results on the
                // same final URL, so a URL difference is not required here.
                // The current-query no-exact-match text also proves that this
                // result view is fresh. If cards are present beside it, they
                // are Bendix's usable fuzzy matches and must win over the text.
                if (headers.length > 0 && (resultChanged || exactNoMatch)) return 'products';
                if (genericEmpty && (routeChanged || resultChanged)) return 'empty';
                // Malaysia can render this message before asynchronously
                // appending a useful fuzzy-match card. Let the caller wait a
                // short grace period before treating it as a final no-result.
                if (exactNoMatch) return 'possible-empty';
                return '';
            }, RESULT_HEADER_SELECTOR, RESULT_CRITERIA_SELECTOR, RESULT_COUNT_SELECTOR, EMPTY_RESULT_PATTERN_SOURCE, partNumber, previousState.initialSignature, previousState.initialUrl, previousState.documentMarker);
            if (outcome === 'products' || outcome === 'empty') {
                await delay(400);
                return outcome;
            }
            if (outcome === 'possible-empty') {
                exactNoMatchSince ||= Date.now();
                if (Date.now() - exactNoMatchSince >= 3000) return 'empty';
            } else {
                exactNoMatchSince = 0;
            }
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
        }
        await delay(250);
    }
    throw new Error('Bendix 搜索结果等待超时');
}

async function extractBendixProductsAfterNavigation(page) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            const products = await page.evaluate(extractBendixProducts);
            // Part-number search can append fuzzy matches after the
            // highest-relevance card. One OE lookup represents one cross
            // reference, so retain the first valid card and its dimensions.
            return keepFirstBendixProduct(products);
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
            await delay(200);
        }
    }
    throw new Error('Bendix 结果页面仍在跳转，无法读取产品信息');
}

async function searchOne(page, partNumber) {
    if (!page.url().startsWith(page.__catalogueOrigin) || !(await page.$(INPUT_SELECTOR))) {
        await openBendixCatalogue(page, page.__catalogueUrl, page.__catalogueLabel);
    }
    const previousState = await prepareResultChangeMonitor(page);
    await typePartNumber(page, partNumber, page.__catalogueLabel);
    await delay(300);
    await clickSearchButton(page, page.__catalogueLabel, previousState.initialUrl);
    const outcome = await waitForBendixOutcome(page, previousState, partNumber);
    // A no-match page may contain unrelated recommendation cards. Returning
    // here prevents those cards from stopping the ordered candidate search.
    const products = outcome === 'empty' ? [] : await extractBendixProductsAfterNavigation(page);
    await page.evaluate(() => window.__bendixResultObserver?.disconnect()).catch(() => undefined);
    return products;
}

function createBendixRunner(region) {
    const catalogueUrl = CATALOGUES[region];
    if (!catalogueUrl) throw new Error(`Unknown Bendix catalogue: ${region}`);
    const label = region === 'bendix_au' ? 'Bendix Australia' : 'Bendix Malaysia';
    return async function runBendix(partNumbers, { signal } = {}) {
        const groups = parseBendixCandidateGroups(partNumbers);
        if (!groups.length) return [];
        const browser = await launchBrowser({
            defaultViewport: null,
            args: ['--disable-http2', '--start-maximized', '--window-size=1600,1000']
        });
        return runBrowserTask(browser, signal, async () => {
            const page = await createCataloguePage(browser);
            page.__catalogueUrl = catalogueUrl;
            page.__catalogueOrigin = new URL(catalogueUrl).origin;
            page.__catalogueLabel = label;
            await setupBendixPage(page, label);
            await openBendixCatalogue(page, catalogueUrl, label);
            const results = [];
            console.log(`开始执行 ${label} 抓取任务，共 ${groups.length} 行、${groups.reduce((total, group) => total + group.candidates.length, 0)} 个候选料号...`);
            for (let index = 0; index < groups.length; index++) {
                const group = groups[index];
                if (signal?.aborted) break;
                console.log(`\n[%d/%d] 正在处理 ${label} 候选组: %s`, index + 1, groups.length, group.input);
                try {
                    const match = await findFirstBendixMatch(group.candidates, async (candidate, candidateIndex) => {
                        console.log(`${label}: 查询候选料号 ${candidate}（${candidateIndex + 1}/${group.candidates.length}）...`);
                        const products = await searchOne(page, candidate);
                        if (products.length) {
                            console.log(`${label}: ${candidate} 查询成功，找到 ${products.map(product => product.partNumber).join(', ')}`);
                        } else if (candidateIndex + 1 < group.candidates.length) {
                            console.log(`${label}: ${candidate} 未找到结果，继续查询同一行的下一个料号。`);
                            await delay(600);
                        } else {
                            console.log(`${label}: 该行所有候选料号均未找到结果。`);
                        }
                        return products;
                    });
                    results.push({
                        oe: group.input,
                        candidates: group.candidates,
                        attemptedPartNumbers: match.attemptedPartNumbers,
                        matchedPartNumber: match.matchedPartNumber,
                        products: match.products,
                        statusCode: match.products.length ? 'SEARCH_SUCCESS' : 'NO_RESULTS'
                    });
                    await delay(1000);
                } catch (error) {
                    if (signal?.aborted) throw error;
                    console.warn(`${label} ${error.failedPartNumber || group.input}: ${error.message}`);
                    results.push({
                        oe: group.input,
                        candidates: group.candidates,
                        attemptedPartNumbers: error.attemptedPartNumbers || [],
                        matchedPartNumber: '',
                        products: [],
                        statusCode: getSearchErrorCode(error)
                    });
                }
            }
            return results;
        });
    };
}

module.exports = {
    createBendixRunner,
    extractBendixProducts,
    findFirstBendixMatch,
    isBendixEmptyResultText,
    keepFirstBendixProduct,
    parseBendixCandidateGroups
};
