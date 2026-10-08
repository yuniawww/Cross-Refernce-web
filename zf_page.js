const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpDirectory } = require('./config');

const INPUT_SELECTOR = 'input.search-box__input, .search-box input, input[role="searchbox"], input[type="search"]';
const RESULT_SELECTOR = '.v-product-list-item, .v-product-list-item__title, .v-product-list-item__brand-name, .no-search-results, section.no-results';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isNavigationRaceError(error) {
    return /Execution context was destroyed|Cannot find context|context.*destroyed|frame was detached|detached Frame|Node is detached/i.test(error?.message || '');
}

// 在每个 frame 内执行；优先目录专用搜索框，避免选到页头的全站搜索。
function findSearchInput(selector, existsOnly = false) {
    // ZF serves the input in its initial HTML before Nuxt attaches event handlers.
    // Typing too early is lost when hydration replaces the input's value.
    const appRoot = document.querySelector('#__nuxt');
    if (appRoot && !appRoot.__vue_app__) return existsOnly ? false : null;
    const inputs = [...document.querySelectorAll(selector)].filter(input => {
        const style = getComputedStyle(input);
        return input.isConnected && input.getClientRects().length && !input.disabled && !input.readOnly &&
            style.visibility !== 'hidden' && style.display !== 'none';
    });
    const input = inputs.find(input => input.matches('.search-box__input') || input.closest('.search-box')) ||
        inputs.find(input => /零件|料号|编号|part|article|number/i.test(
            `${input.placeholder} ${input.getAttribute('aria-label') || ''}`
        )) || null;
    return existsOnly ? Boolean(input) : input;
}

async function findCatalogueFrame(page, preferResults = true) {
    const frames = page.frames();
    // 目录可能嵌在 iframe；不能只读取外层页面。
    const previous = page.__zfCatalogueFrame;
    const ordered = previous && frames.includes(previous)
        ? [previous, ...frames.filter(frame => frame !== previous)] : frames;
    // Prefer rendered results across all frames before accepting a search box.
    // The outer search box can survive while the results iframe is replaced.
    for (const resultsFirst of preferResults ? [true, false] : [false, true]) {
        for (const frame of ordered) {
            try {
                const found = resultsFirst
                    ? await frame.evaluate(selector => [...document.querySelectorAll(selector)]
                        .some(element => (element.getClientRects().length || [...element.children].some(child => child.getClientRects().length)) &&
                            getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'), RESULT_SELECTOR)
                    : await frame.evaluate(findSearchInput, INPUT_SELECTOR, true);
                if (found) {
                    page.__zfCatalogueFrame = frame;
                    return frame;
                }
            } catch (error) {
                if (!isNavigationRaceError(error)) throw error;
            }
        }
    }
    return null;
}

async function evaluateCatalogue(page, fn, ...args) {
    // 单元测试的页面桩没有 frames；真实页面始终重新检查 frame 是否仍然有效。
    const context = typeof page.frames === 'function' ? await findCatalogueFrame(page) : page;
    if (!context) throw new Error('ZF_ELEMENT_NOT_READY: 未找到目录搜索输入框或结果，页面可能仍在加载');
    return context.evaluate(fn, ...args);
}

async function waitForSearchInput(page, { timeout = 45000, assertAccess = async () => {} } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('ZF browser closed');
        await assertAccess(page);
        try {
            const frame = await findCatalogueFrame(page, false);
            if (frame) {
                const handle = await frame.evaluateHandle(findSearchInput, INPUT_SELECTOR);
                const input = handle.asElement();
                if (input) return { frame, input };
                await handle.dispose();
            }
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
        }
        await delay(250);
    }
    throw new Error('ZF_ELEMENT_TIMEOUT: 未找到可用的 ZF 搜索输入框');
}

async function readAccessChallenge(page) {
    for (const frame of page.frames()) {
        try {
            const challenge = await frame.evaluate(() => {
                const title = document.title || '';
                const body = (document.body?.innerText || '').trim();
                const pattern = /verify you are human|checking your browser|access denied|too many requests|人机验证|访问过于频繁|请完成.{0,8}验证|验证您是人类/i;
                // 避免隐私说明中的 captcha 字样触发误报。
                return pattern.test(title) || (body.length < 4000 && pattern.test(body))
                    ? `${title} ${body}`.replace(/\s+/g, ' ').slice(0, 240) : '';
            });
            if (challenge) return challenge;
        } catch (error) {
            if (!isNavigationRaceError(error)) throw error;
        }
    }
    return '';
}

async function clickCatalogueLink(page) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('ZF browser closed');
        for (const frame of page.frames()) {
            let handle;
            try {
                handle = await frame.evaluateHandle(() => [...document.querySelectorAll('a[href]')].find(link => {
                    const style = getComputedStyle(link);
                    const url = new URL(link.href);
                    return url.origin === location.origin && /\/(?:zh|cn)\/catalog\/?$/.test(url.pathname) &&
                        link.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' &&
                        (link.classList.contains('main-navigation__link') || /我们的目录/.test(link.textContent));
                }) || null);
                const link = handle.asElement();
                if (!link) continue;
                await link.click();
                return;
            } catch (error) {
                if (!isNavigationRaceError(error)) throw error;
                // 跳转销毁了旧节点，下轮重新查找，不能复用旧句柄。
            } finally {
                await handle?.dispose().catch(() => undefined);
            }
        }
        await delay(250);
    }
    throw new Error('ZF_ELEMENT_TIMEOUT: 未找到可点击的“我们的目录”链接');
}

async function saveZfDiagnostics(page, stage, error) {
    if (page.isClosed()) return;
    const directory = path.join(tmpDirectory, 'diagnostics', 'zf');
    const stem = `${Date.now()}-${process.pid}-${stage.replace(/[^a-z0-9-]/gi, '-')}`;
    try {
        await fs.mkdir(directory, { recursive: true });
        const frames = [];
        for (const frame of page.frames()) {
            frames.push(await frame.evaluate(() => ({
                url: location.origin + location.pathname,
                title: document.title,
                readyState: document.readyState,
                inputs: [...document.querySelectorAll('input')].map(input => ({
                    type: input.type, role: input.getAttribute('role'), className: input.className,
                    placeholder: input.placeholder, visible: Boolean(input.getClientRects().length),
                    disabled: input.disabled
                })),
                catalogLinks: [...document.querySelectorAll('a[href]')]
                    .filter(link => /\/catalog\/?(?:[?#]|$)/.test(link.getAttribute('href')))
                    .map(link => ({ href: link.getAttribute('href'), text: link.textContent.trim(), visible: Boolean(link.getClientRects().length) }))
            })).catch(frameError => ({ error: frameError.message })));
        }
        await fs.writeFile(path.join(directory, `${stem}.json`), JSON.stringify({
            stage, error: error.message, blockedResponse: page.__getZfBlockedResponse?.(), frames
        }, null, 2));
        await page.screenshot({ path: path.join(directory, `${stem}.png`) });
        console.warn(`ZF 页面诊断已保存: ${path.join(directory, stem)}.{json,png}`);
    } catch (diagnosticError) {
        console.warn(`ZF 保存页面诊断失败: ${diagnosticError.message}`);
    }
}

module.exports = {
    INPUT_SELECTOR, isNavigationRaceError, findSearchInput, findCatalogueFrame,
    evaluateCatalogue, waitForSearchInput, readAccessChallenge, saveZfDiagnostics, clickCatalogueLink
};
