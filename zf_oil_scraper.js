const { runZf } = require('./zf_scraper');
const { isNavigationRaceError } = require('./zf_page');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseOilQueries(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [values]).flatMap(value => String(value || '').split(/\r?\n/))
        .map(value => value.replace(/\s+/g, ' ').trim()).filter(value => {
            const key = value.toUpperCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        }).map(input => ({ input, candidates: [input] }));
}

// Runs inside the catalogue frame. The first visible result must match the query.
function extractOilProducts(query, returnLink = false, expectedUrl = '') {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const normalize = value => clean(value).normalize('NFKC').replace(/^ZF\s*/i, '').replace(/\s/g, '').toUpperCase();
    const expected = normalize(query);
    if (!expected) return returnLink ? null : [];
    const visibleLinks = [...document.querySelectorAll('a.v-product-list-item__title[href]')].filter(link => {
        const style = getComputedStyle(link);
        const visibleBox = link.getClientRects().length || [...link.querySelectorAll('div, .highlighted')]
            .some(child => child.getClientRects().length);
        return link.isConnected && visibleBox && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const matches = link => {
        const title = clean(link.textContent);
        const parts = title.split(/[|｜]/);
        // DCT/CVT oils have different category labels. Read the entire model,
        // including text outside .highlighted, and allow additional suffixes.
        if (/套件|\bkit\b/i.test(parts[0])) return null;
        const model = clean(parts.at(-1)).replace(/^ZF\s*/i, '');
        return normalize(model).includes(expected) ? { title, model } : null;
    };
    if (!visibleLinks.length || !matches(visibleLinks[0])) return returnLink ? null : [];
    const products = new Map();
    for (const link of visibleLinks) {
        const match = matches(link);
        if (!match) continue;
        const url = new URL(link.href, location.href);
        if (url.origin !== location.origin || !/^\/(?:zh|cn|en)\/catalog\/products\/[^/]+\/?$/.test(url.pathname)) continue;
        if (expectedUrl && url.href !== expectedUrl) continue;
        if (returnLink) return link;
        const details = link.closest('.v-product-list-item')?.querySelector('a.v-product-list-item__details');
        const number = clean([...details?.querySelectorAll('span') || []]
            .map(span => span.textContent).find(text => clean(text).toUpperCase() !== 'ZF')) ||
            decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1));
        products.set(url.href, { partNumber: number, zfNumber: number, model: match.model, brand: 'ZF', title: match.title, url: url.href });
    }
    return returnLink ? null : [...products.values()];
}

// Restrict extraction to the section headed 对应OE编号, stopping at the next section.
function extractOilOeSection(expectedUrl) {
    if (location.pathname !== new URL(expectedUrl).pathname) return null;
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const heading = [...document.querySelectorAll('h2')].find(element =>
        /^(对应\s*OE\s*编号|OE\s*(?:numbers|references))$/i.test(clean(element.textContent)) &&
        element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    if (!heading) return null;
    if ([...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .v-skeleton-loader')]
        .some(element => element.getClientRects().length)) return null;
    const end = [...document.querySelectorAll('h1, h2')].find(element =>
        heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const range = document.createRange();
    range.setStartAfter(heading);
    if (end) range.setEndBefore(end);
    else range.setEndAfter(document.body.lastChild);
    const section = range.cloneContents();
    const table = section.querySelector('table.v-table');
    const sectionText = clean(section.textContent);
    if (!table && !/暂无|没有|无对应|no (?:OE|references|numbers)/i.test(sectionText)) return null;
    const groups = new Map();
    for (const row of section.querySelectorAll('table.v-table tr')) {
        const brand = clean(row.querySelector('th')?.textContent);
        const numbers = [...row.querySelectorAll('td .v-table__cell-data')]
            .map(cell => clean(cell.querySelector('span')?.textContent || cell.textContent)).filter(Boolean);
        if (!brand || !numbers.length) continue;
        if (!groups.has(brand)) groups.set(brand, new Set());
        numbers.forEach(number => groups.get(brand).add(number));
    }
    return { oeGroups: [...groups].map(([brand, numbers]) => ({ brand, numbers: [...numbers] })) };
}

async function clickOilProduct(page, product, { assertAccess = async () => {}, timeout = 15000 } = {}) {
    let deadline = Date.now() + timeout;
    let attempts = 0;
    let lastClick = 0;
    let lastAccessCheck = 0;
    const expectedPath = new URL(product.url).pathname;
    while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('ZF browser closed');
        if (Date.now() - lastAccessCheck >= 1500) {
            const started = Date.now();
            await assertAccess(page);
            deadline += Date.now() - started;
            lastAccessCheck = Date.now();
        }
        for (const frame of page.frames()) {
            let handle;
            try {
                if (await frame.evaluate(path => location.pathname === path, expectedPath)) {
                    console.log(`ZF 变速箱油: 已进入 ${product.partNumber} 产品详情`);
                    return;
                }
                if (attempts >= 3 || Date.now() - lastClick < 2000) continue;
                // Reacquire the exact title in every frame; a search-box frame can
                // remain present while the results live in a replacement iframe.
                handle = await frame.evaluateHandle(extractOilProducts, product.model, true, product.url);
                const link = handle.asElement();
                if (!link) continue;
                attempts++;
                lastClick = Date.now();
                    console.log(`ZF 变速箱油: 点击 ${product.title} (${attempts}/3)`);
                if (attempts === 1) {
                    try { await link.click(); }
                    catch (error) {
                        if (!/not clickable|not an Element/i.test(error.message)) throw error;
                        await link.evaluate(element => element.click());
                    }
                } else {
                    // The first pointer click can be intercepted by a layout
                    // shift. Activate the newly matched anchor's own handler.
                    await link.evaluate(element => element.click());
                }
            } catch (error) {
                if (!isNavigationRaceError(error)) throw error;
            } finally {
                await handle?.dispose().catch(() => undefined);
            }
        }
        await delay(200);
    }
    throw new Error(`ZF 变速箱油产品点击后未跳转，超时: ${product.partNumber}`);
}

async function readOilDetails(page, products, { assertAccess = async () => {}, timeout = 45000 } = {}) {
    // Open the first product whose model contains the requested search text.
    const product = products[0];
    await clickOilProduct(page, product, { assertAccess, timeout: Math.min(timeout, 15000) });
    let deadline = Date.now() + Math.min(timeout, 15000);
    let signature = '';
    let stableSince = 0;
    let lastAccessCheck = 0;
    while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('ZF browser closed');
        if (Date.now() - lastAccessCheck >= 1500) {
            const started = Date.now();
            await assertAccess(page);
            deadline += Date.now() - started;
            lastAccessCheck = Date.now();
        }
        let section = null;
        // A detail page can lack the catalogue search box; inspect all frames directly.
        for (const detailFrame of page.frames()) {
            try {
                section = await detailFrame.evaluate(extractOilOeSection, product.url);
                if (section) break;
            } catch (error) {
                if (!isNavigationRaceError(error)) throw error;
            }
        }
        const nextSignature = section ? JSON.stringify(section) : '';
        if (nextSignature && signature === nextSignature && Date.now() - stableSince >= 1000) {
            return [{ ...product, ...section }, ...products.slice(1).map(other => ({ ...other, oeGroups: [] }))];
        }
        if (signature !== nextSignature) {
            signature = nextSignature;
            stableSince = Date.now();
        }
        await delay(200);
    }
    // The ZF product number is already confirmed on the result card. A detail
    // page without a readable OE section must not turn that match into a miss.
    return products.map(item => ({ ...item, oeGroups: [] }));
}

function runZfOil(queries, options) {
    return runZf(queries, options, {
        profile: 'zf-oil', parseGroups: parseOilQueries,
        extractProducts: extractOilProducts, readDetails: readOilDetails
    });
}

module.exports = { runZfOil, parseOilQueries, extractOilProducts, extractOilOeSection, clickOilProduct, readOilDetails };
