const { launchBrowser } = require('./browser');
const { siteUrl, headless } = require('./config');
const { runBrowserTask } = require('./scraper_abort');
const { getScraperSessionPaths } = require('./scraper_session');
const { navigateToCatalogue } = require('./site_navigation');
const { createCataloguePage } = require('./catalogue_page');
const {
    INPUT_SELECTOR, isNavigationRaceError, findCatalogueFrame, evaluateCatalogue,
    waitForSearchInput, readAccessChallenge, saveZfDiagnostics, clickCatalogueLink
} = require('./zf_page');

const CATALOGUE_URL = siteUrl('ZF_CATALOGUE_URL', 'https://aftermarket.zf.com/cn/catalog/?country=CN');
const RESULT_BRAND_SELECTOR = '.v-product-list-item__brand-name';
const NO_RESULTS_SELECTOR = '.no-search-results, section.no-results';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const delayJitter = (min, max) => delay(min + Math.floor(Math.random() * (max - min + 1)));

function isOptionalThirdPartyUrl(url) {
    return /^https:\/\/(?:js-agent\.newrelic\.com|(?:www\.)?youtube\.com)\//i.test(url);
}

function getSearchErrorCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code?.startsWith('SITE_')) return 'SOURCE_UNAVAILABLE';
    if (/ZF_ACCESS_BLOCKED|\b(403|429)\b|captcha|challenge|访问过于频繁|人机验证/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/net::|ERR_|Navigation timeout|ECONN|socket|network/i.test(message)) return 'NETWORK_ERROR';
    if (/Waiting for selector|无法加载.*搜索框|未找到.*搜索输入|search input/i.test(message)) return 'SOURCE_UNAVAILABLE';
    if (/Timeout|超时/i.test(message)) return 'QUERY_TIMEOUT';
    return 'SEARCH_ERROR';
}

async function setupZfPage(page) {
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    });

    let blockedResponse = null;
    page.on('response', (response) => {
        const url = response.url();
        const status = response.status();
        if (!url.startsWith(new URL(CATALOGUE_URL).origin + '/')) return;
        if (!['document', 'xhr', 'fetch'].includes(response.request().resourceType())) return;
        if (blockedResponse?.url === url && status >= 200 && status < 300) blockedResponse = null;
        if (status !== 403 && status !== 429) return;
        blockedResponse = { status, url, retryAfter: response.headers()['retry-after'] || '' };
        console.warn(`ZF 主站返回疑似访问限制: HTTP ${status} ${url}`);
    });
    page.__getZfBlockedResponse = () => blockedResponse;
    page.__clearZfBlockedResponse = () => { blockedResponse = null; };

    page.on('pageerror', (error) => {
        if (/newrelic|youtube/i.test(error.message || '')) return;
        console.warn(`ZF 页面脚本错误，已忽略: ${error.message}`);
    });
    page.on('requestfailed', (request) => {
        const failure = request.failure();
        const errorText = failure ? failure.errorText : '';
        // Ignore requests intentionally cancelled by Chromium during redirects,
        // telemetry delivery or bot-challenge cleanup. New Relic and YouTube are
        // optional third-party resources and do not determine catalogue readiness.
        if (/ERR_ABORTED/i.test(errorText)) return;
        if (isOptionalThirdPartyUrl(request.url())) {
            return;
        }
        console.warn(`ZF 资源加载失败: ${request.url()} ${errorText}`);
    });

    // 不主动 abort 这些请求：否则 Chromium 会额外打印
    // ERR_BLOCKED_BY_CLIENT.Inspector。它们失败时只忽略日志，不影响 ZF 主站请求。
}

async function assertZfAccessAllowed(page) {
    const blockedResponse = page.__getZfBlockedResponse?.();
    if (blockedResponse?.status === 429) {
        throw new Error(`ZF_ACCESS_BLOCKED: HTTP 429，暂停本批查询。Retry-After=${blockedResponse.retryAfter || '未提供'}`);
    }

    const challenge = await readAccessChallenge(page);
    if (challenge) {
        if (headless) throw new Error('ZF_ACCESS_BLOCKED: 目标网站要求交互验证，请稍后重试');
        console.warn('ZF 显示访问验证，查询暂停。请在当前浏览器窗口完成验证，程序最多等待 2 分钟。');
        await page.bringToFront();
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            if (page.isClosed()) throw new Error('ZF browser closed');
            await delay(1000);
            if (page.__getZfBlockedResponse?.()?.status === 429) {
                throw new Error('ZF_ACCESS_BLOCKED: HTTP 429，暂停本批查询');
            }
            if (!(await readAccessChallenge(page)) && await findCatalogueFrame(page)) {
                page.__clearZfBlockedResponse?.();
                console.log('ZF 验证页面已消失，继续查询。');
                return;
            }
        }
        throw new Error(`ZF_ACCESS_BLOCKED: 验证等待超时，${challenge}`);
    }
    if (blockedResponse) throw new Error(`ZF_ACCESS_BLOCKED: HTTP ${blockedResponse.status} ${blockedResponse.url}`);
}

async function openZfCatalogue(page) {
    console.log('正在打开 ZF China 网站...');
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await navigateToCatalogue(page, CATALOGUE_URL, 'ZF');
            await assertZfAccessAllowed(page);
            const { input } = await waitForSearchInput(page, { assertAccess: assertZfAccessAllowed });
            await input.dispose();
            console.log('ZF China 网站已成功打开。');
            return;
        } catch (error) {
            lastError = error;
            if (/ZF_ACCESS_BLOCKED/.test(error.message || '') || ['SITE_ACCESS_DENIED', 'SITE_RATE_LIMITED'].includes(error.code) || attempt === 3) {
                await saveZfDiagnostics(page, 'open', error);
                throw error;
            }
            console.warn(`ZF 页面打开失败，第 ${attempt} 次重试: ${error.message}`);
            await delayJitter(3000 * attempt, 5000 * attempt);
        }
    }
    throw lastError;
}

async function createZfPage(browser) {
    const page = await createCataloguePage(browser);
    await setupZfPage(page);
    await openZfCatalogue(page);
    return page;
}

async function returnToZfCatalogue(page) {
    await assertZfAccessAllowed(page);
    await clickCatalogueLink(page);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const { frame, input } = await waitForSearchInput(page, {
            timeout: Math.max(1, deadline - Date.now()), assertAccess: assertZfAccessAllowed
        });
        try {
            const state = await frame.evaluate(readZfSearchState, INPUT_SELECTOR, RESULT_BRAND_SELECTOR, NO_RESULTS_SELECTOR);
            if (!state.inputValue && !state.resultCount && !state.noResults && !state.loading) {
                console.log('已点击“我们的目录”，继续使用当前页面。');
                return;
            }
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
        } finally {
            await input.dispose().catch(() => undefined);
        }
        await delay(250);
    }
    throw new Error('ZF_ELEMENT_TIMEOUT: 点击目录后，旧结果未清除或搜索框尚未就绪');
}

function extractTrwProducts(inputNumber) {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizeNumber = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const expectedNumber = normalizeNumber(inputNumber);
    if (!expectedNumber) return [];
    const isVisible = element => {
        if (!element || !element.isConnected || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const isPartNumber = value => /^(?=.*\d)[A-Z0-9][A-Z0-9.-]{3,}$/i.test(value);
    const products = [];
    for (const brand of document.querySelectorAll('.v-product-list-item__brand-name')) {
        // ZF 会在页面更新期间保留旧的/隐藏的结果节点，不能把它们当成当前结果。
        if (!isVisible(brand)) continue;
        if (clean(brand.textContent).toUpperCase() !== 'TRW') continue;
        const itemRoot = brand.closest('.v-product-list-item') ||
            brand.closest('a.v-product-list-item__details')?.parentElement;
        if (!itemRoot || !isVisible(itemRoot)) continue;
        const foundViaValues = [...itemRoot.querySelectorAll('[data-test="found-via__value"]')];
        const cardNumber = normalizeNumber(itemRoot.innerText || itemRoot.textContent);
        // 新版页面有时不渲染 data-test 属性，但卡片本身已经是本次搜索结果。
        // 有明确 found-via 时仍严格校验；没有该节点时使用卡片内容/当前可见卡片兜底。
        const foundViaMatches = foundViaValues.length
            ? foundViaValues.some(value => normalizeNumber(value.textContent) === expectedNumber)
            : cardNumber.includes(expectedNumber);
        if (!foundViaMatches) continue;
        let container = brand.parentElement;
        let partNumber = '';
        for (let level = 0; container && level < 4 && !partNumber; level++) {
            const spans = [...container.querySelectorAll('span')];
            const brandIndex = spans.indexOf(brand);
            if (brandIndex >= 0) {
                partNumber = spans.slice(brandIndex + 1)
                    .map(span => clean(span.textContent))
                    .find(value => value !== 'TRW' && isPartNumber(value)) || '';
            }
            if (container === itemRoot) break;
            container = container.parentElement;
        }
        if (!partNumber) {
            partNumber = [...itemRoot.querySelectorAll('span, a, [data-test]')]
                .map(element => clean(element.textContent))
                .find(value => value !== 'TRW' && normalizeNumber(value) !== expectedNumber && isPartNumber(value)) || '';
        }
        if (partNumber) products.push({ partNumber, brand: 'TRW' });
    }
    return [...new Map(products.map(product => [product.partNumber.toUpperCase(), product])).values()];
}

function readZfSearchState(inputSelector, brandSelector, noResultsSelector) {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = element => {
        if (!element || !element.isConnected || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const input = [...document.querySelectorAll(inputSelector)].find(isVisible) || null;
    const resultItems = [...document.querySelectorAll(brandSelector)]
        .filter(isVisible)
        .map(brand => brand.closest('.v-product-list-item') || brand)
        .filter((item, index, items) => isVisible(item) && items.indexOf(item) === index)
        .map(item => clean(item.innerText || item.textContent));
    // 某些版本虽然已显示产品卡片，但品牌节点的 class 结构不同；
    // 产品卡片本身也可作为“结果已出现”的信号。
    const productCards = [...document.querySelectorAll(
        '.v-product-list-item, [class*="product-list-item"], [data-testid*="product"]'
    )].filter(isVisible);
    const cardText = productCards
        .map(item => clean(item.innerText || item.textContent))
        .filter(Boolean)
        .join('\n---ZF-CARD---\n');
    const bodyText = document.body?.innerText || '';
    // ZF 当前的空结果页使用 `.no-search-results`，标题文字只是“没有结果”。
    // 优先看可见的结构化容器，文本规则仅用于兼容站点改版。
    const noResults = [...document.querySelectorAll(noResultsSelector)].some(isVisible) ||
        /未找到|无搜索结果|没有(?:搜索)?结果|没有搜索到|no (results|products|parts) (found|match)|0 (results|products)/i.test(bodyText);
    const loading = [...document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], .v-progress-circular, .v-skeleton-loader'
    )].some(isVisible);

    return {
        url: location.href,
        inputValue: input?.value || '',
        resultCount: Math.max(resultItems.length, productCards.length),
        resultSignature: [resultItems.join('\n---ZF-RESULT---\n'), cardText]
            .filter(Boolean).join('\n---ZF-RESULT-SET---\n'),
        noResults,
        loading
    };
}

function trackZfSearchRequests(page) {
    const pending = new Set();
    let started = 0;
    let lastActivity = 0;
    const isRelevant = request => ['document', 'xhr', 'fetch'].includes(request.resourceType()) &&
        request.url().startsWith(new URL(CATALOGUE_URL).origin + '/');
    const onRequest = request => {
        if (!isRelevant(request)) return;
        pending.add(request);
        started++;
        lastActivity = Date.now();
    };
    const onRequestDone = request => {
        if (!pending.delete(request)) return;
        lastActivity = Date.now();
    };

    page.on('request', onRequest);
    page.on('requestfinished', onRequestDone);
    page.on('requestfailed', onRequestDone);

    return {
        getState: () => ({ started, pending: pending.size, lastActivity }),
        dispose: () => {
            page.off('request', onRequest);
            page.off('requestfinished', onRequestDone);
            page.off('requestfailed', onRequestDone);
        }
    };
}

async function waitForZfSearchOutcome(page, previousState, previousInput, requestTracker, inputNumber, extractProducts = extractTrwProducts) {
    let deadline = Date.now() + 45000;
    let lastAccessCheck = 0;
    let inputRefreshed = false;
    let navigationChanged = false;
    let resultChanged = false;
    let loadingSeen = false;
    let stableSignature = '';
    let stableSince = 0;
    let matchedSignature = '';
    let matchedSince = 0;
    let emptySince = 0;
    let lastState = null;

    while (Date.now() < deadline) {
        if (typeof page.frames === 'function' && Date.now() - lastAccessCheck >= 1500) {
            const checkStarted = Date.now();
            await assertZfAccessAllowed(page);
            deadline += Date.now() - checkStarted;
            lastAccessCheck = Date.now();
        }
        let state;
        try {
            state = await evaluateCatalogue(page,
                readZfSearchState,
                INPUT_SELECTOR,
                RESULT_BRAND_SELECTOR,
                NO_RESULTS_SELECTOR
            );
            lastState = state;
            navigationChanged ||= state.url !== previousState.url;
            if (!inputRefreshed) {
                inputRefreshed = navigationChanged || await evaluateCatalogue(page,
                    (selector, oldInput) => {
                        const visible = element => {
                            if (!element || !element.isConnected || !element.getClientRects().length) return false;
                            const style = getComputedStyle(element);
                            return style.visibility !== 'hidden' && style.display !== 'none';
                        };
                        const currentInput = [...document.querySelectorAll(selector)].find(visible) || null;
                        return !oldInput?.isConnected || currentInput !== oldInput || currentInput?.value === '';
                    },
                    INPUT_SELECTOR,
                    previousInput
                );
            }
        } catch (error) {
            const oldHandleBecameInvalid = /JSHandles can be evaluated only|Argument should belong to the same JavaScript world/i.test(error?.message || '');
            if (!isNavigationRaceError(error) && !oldHandleBecameInvalid && !/ZF_ELEMENT_NOT_READY/.test(error.message)) throw error;
            // 页面跳转会销毁旧输入框的执行上下文，这本身就是输入框已刷新的信号。
            inputRefreshed = true;
            await delay(150);
            continue;
        }

        resultChanged ||= state.resultSignature !== previousState.resultSignature ||
            state.noResults !== previousState.noResults;
        loadingSeen ||= state.loading;

        // 输入时站点可能已经自动搜索，点击按钮后页面便不再变化。
        // 只要当前可见卡片的“通过找到”对应本次编号，就可直接确认结果。
        const matchedProducts = await evaluateCatalogue(page, extractProducts, inputNumber)
            .catch(error => {
                if (isNavigationRaceError(error) || /ZF_ELEMENT_NOT_READY/.test(error.message)) return [];
                throw error;
            });
        if (matchedProducts.length && !state.loading && requestTracker.getState().pending === 0) {
            const signature = matchedProducts.map(product => product.partNumber).join('|');
            if (signature !== matchedSignature) {
                matchedSignature = signature;
                matchedSince = Date.now();
            } else if (Date.now() - matchedSince >= 600) {
                return state;
            }
            await delay(150);
            continue;
        }
        matchedSignature = '';
        matchedSince = 0;

        const requestState = requestTracker.getState();
        const requestsSettled = requestState.started > 0 &&
            requestState.pending === 0 &&
            Date.now() - requestState.lastActivity >= 500;
        const noResultsJustAppeared = state.noResults && !previousState.noResults;
        const repeatedNoResultsConfirmed = state.noResults && previousState.noResults && requestsSettled;

        // 有些搜索从缓存或新 frame 呈现空结果，页面请求不会进入当前追踪器。
        // 仅接受新出现/导航后的空结果；上一轮残留的空结果仍需本轮请求确认。
        const freshNoResults = noResultsJustAppeared || (state.noResults && navigationChanged) || repeatedNoResultsConfirmed;
        const requestsQuiet = requestState.started === 0 || requestsSettled;
        if (freshNoResults && !state.loading && requestsQuiet) {
            emptySince ||= Date.now();
            if (Date.now() - emptySince >= 600) return state;
        } else {
            emptySince = 0;
        }

        // 输入框被组件清空只代表它重新渲染了，不能证明搜索真的开始了。
        // 必须看到 URL 或结果变化；否则旧结果会被误当成本次查询结果。
        const searchAccepted = navigationChanged || resultChanged;
        const freshOutcome = resultChanged ||
            (inputRefreshed && requestsSettled && loadingSeen) ||
            (navigationChanged && requestsSettled);
        const hasOutcome = state.resultCount > 0 || state.noResults;
        const outcomeSignature = `${state.resultSignature}|noResults:${state.noResults}`;

        if (searchAccepted && freshOutcome && hasOutcome && !state.loading && requestState.pending === 0) {
            if (outcomeSignature !== stableSignature) {
                stableSignature = outcomeSignature;
                stableSince = Date.now();
            } else if (Date.now() - stableSince >= 600) {
                return state;
            }
        } else {
            stableSignature = '';
            stableSince = 0;
        }

        await delay(150);
    }

    if (!inputRefreshed && !resultChanged) {
        throw new Error('ZF 搜索提交后输入框未刷新，搜索可能未被接收');
    }
    throw new Error(`等待 ZF 新搜索结果超时 (url=${lastState?.url || page.url()}, visibleResults=${lastState?.resultCount || 0}, noResults=${Boolean(lastState?.noResults)})`);
}

async function fillZfSearchInput(page, input, value) {
    const text = String(value).trim();
    let current = input;
    for (let attempt = 0; attempt < 3; attempt++) {
        // ZF replaces the search input during typing. Insert the whole query in
        // one trusted keyboard event, then inspect the current visible input.
        try {
            await current.click();
            await current.evaluate(element => element.select());
            await page.keyboard.insertText(text);
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
            await current.dispose().catch(() => undefined);
            current = (await waitForSearchInput(page, { timeout: 5000 })).input;
            continue;
        }
        await delay(500);
        const replacement = await waitForSearchInput(page, { timeout: 5000 });
        const entered = await replacement.input.evaluate(element => element.value);
        if (replacement.input !== current) await current.dispose().catch(() => undefined);
        current = replacement.input;
        if (entered === text) return replacement;
        await delay(250);
    }
    throw new Error(`ZF 搜索框未保留完整料号: ${text}`);
}

async function submitZfSearch(input) {
    // Submit from the focused input so blur/re-render cannot clear the query
    // between typing and a separate mouse click.
    await input.press('Enter');
}

async function searchOne(page, inputNumber, extractProducts = extractTrwProducts) {
    // 元素暂时消失时等待 SPA/iframe 恢复，不重新导航或新建标签页。
    let { frame, input } = await waitForSearchInput(page, { assertAccess: assertZfAccessAllowed });
    const requestTracker = trackZfSearchRequests(page);
    try {
        // 必须在输入前记录旧结果：网站可能在逐键输入时已自动提交搜索。
        const previousState = await frame.evaluate(
            readZfSearchState, INPUT_SELECTOR, RESULT_BRAND_SELECTOR, NO_RESULTS_SELECTOR
        );
        try {
            ({ frame, input } = await fillZfSearchInput(page, input, inputNumber));
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
            await input.dispose().catch(() => undefined);
            ({ frame, input } = await waitForSearchInput(page, { assertAccess: assertZfAccessAllowed }));
            ({ frame, input } = await fillZfSearchInput(page, input, inputNumber));
        }
        try {
            await submitZfSearch(input);
            console.log('已通过 Enter 提交 ZF 搜索。');
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
        }
        console.log('等待 ZF 新搜索结果...');
        await waitForZfSearchOutcome(page, previousState, input, requestTracker, inputNumber, extractProducts);
        await assertZfAccessAllowed(page);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            try {
                return await evaluateCatalogue(page, extractProducts, inputNumber);
            } catch (error) {
                if (!isNavigationRaceError(error) && !/ZF_ELEMENT_NOT_READY/.test(error.message)) throw error;
                await delay(200);
            }
        }
        throw new Error('ZF 结果页面仍在跳转，无法读取产品信息');
    } finally {
        requestTracker.dispose();
        await input.dispose().catch(() => undefined);
    }
}

function parseZfCandidateGroups(values) {
    return (Array.isArray(values) ? values : [values])
        .flatMap(value => String(value || '').split(/\r?\n/))
        .map(line => {
            const candidates = [];
            const seen = new Set();
            for (const item of line.split(/[;；=＝]+/)) {
                const candidate = item.replace(/\s*[（(]\s*新号\s*[）)]\s*/g, ' ').replace(/\s+/g, ' ').trim();
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

async function findFirstZfMatch(candidates, lookup) {
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

async function runZf(partNumbers, { signal, sessionId } = {}, strategy = {}) {
    const groups = (strategy.parseGroups || parseZfCandidateGroups)(partNumbers);
    if (!groups.length) return [];
    const { profileDirectory } = getScraperSessionPaths(__dirname, strategy.profile || 'zf', sessionId);
    const browser = await launchBrowser({
        userDataDir: profileDirectory,
        defaultViewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--disable-blink-features=AutomationControlled',
            '--lang=zh-CN',
            '--start-maximized',
            '--window-size=1600,1000'
        ]
    });
    return runBrowserTask(browser, signal, async () => {
        const page = await createZfPage(browser);
        const results = [];
        let needsCatalogue = false;
        let accessError = null;
        console.log(`开始执行 ZF/TRW 抓取任务，共 ${groups.length} 行候选料号...`);
        for (let index = 0; index < groups.length; index++) {
            const group = groups[index];
            if (signal?.aborted) break;
            if (accessError) {
                results.push({
                    oe: group.input, candidates: group.candidates, attemptedPartNumbers: [],
                    matchedPartNumber: '', products: [], statusCode: 'SOURCE_UNAVAILABLE'
                });
                continue;
            }
            console.log(`\n[%d/%d] 正在查询 ZF/TRW: %s`, index + 1, groups.length, group.input);
            try {
                const match = await findFirstZfMatch(group.candidates, async (candidate, candidateIndex) => {
                    console.log(`ZF/TRW: 查询候选料号 ${candidate}`);
                    try {
                        if (accessError) throw accessError;
                        if (needsCatalogue) await returnToZfCatalogue(page);
                        needsCatalogue = true;
                        let products = await searchOne(page, candidate, strategy.extractProducts);
                        if (products.length && strategy.readDetails) {
                            products = await strategy.readDetails(page, products, { assertAccess: assertZfAccessAllowed });
                        }
                        try {
                            await returnToZfCatalogue(page);
                            needsCatalogue = false;
                        } catch (resetError) {
                            if (signal?.aborted) throw resetError;
                            await saveZfDiagnostics(page, 'return-catalogue', resetError);
                            if (/ZF_ACCESS_BLOCKED/.test(resetError.message)) accessError = resetError;
                            console.warn(`ZF 查询后返回目录页失败: ${resetError.message}`);
                        }
                        if (!products.length && candidateIndex + 1 < group.candidates.length) {
                            await delayJitter(1800, 3200);
                        }
                        return products;
                    } catch (error) {
                        if (!signal?.aborted) await saveZfDiagnostics(page, 'search', error);
                        throw error;
                    }
                });
                results.push({
                    oe: group.input,
                    candidates: group.candidates,
                    attemptedPartNumbers: match.attemptedPartNumbers,
                    matchedPartNumber: match.matchedPartNumber,
                    products: match.products,
                    statusCode: match.products.length ? 'SEARCH_SUCCESS' : 'NO_RESULTS'
                });
                // 查询之间留出抖动，避免连续请求触发站点限流；会话 profile
                // 会保留站点 cookie，后续查询仍在同一真实浏览器上下文中进行。
                if (!accessError && index + 1 < groups.length) await delayJitter(2500, 4500);
            } catch (error) {
                if (signal?.aborted) throw error;
                console.warn(`ZF TRW ${error.failedPartNumber || group.input}: ${error.message}`);
                if (/ZF_ACCESS_BLOCKED/.test(error.message)) accessError = error;
                results.push({
                    oe: group.input,
                    candidates: group.candidates,
                    attemptedPartNumbers: error.attemptedPartNumbers || [],
                    matchedPartNumber: '',
                    products: [],
                    statusCode: getSearchErrorCode(error)
                });
                if (!accessError && index + 1 < groups.length) await delayJitter(5000, 8000);
            }
        }
        return results;
    });
}

module.exports = { runZf, extractTrwProducts, parseZfCandidateGroups, findFirstZfMatch, waitForZfSearchOutcome, getSearchErrorCode, fillZfSearchInput, submitZfSearch };
