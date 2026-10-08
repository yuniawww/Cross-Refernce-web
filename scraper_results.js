const EMPTY_RESULTS = {
    mahle: { selector: 'div.alert.alert-warning[role="alert"]', text: '未查询到产品信息' },
    mann: { selector: 'h2.cmp-title__text', text: '对不起，没有找到结果' },
    ngk: { selector: '.alert, [role="alert"], .result_table_tr, td, p, span, label, h1, h2, h3, h4, h5, h6', text: '新品开发中', contains: true },
    purolator: { selector: 'span', text: '暂无适配的产品信息！' },
    tora: { selector: 'span', text: '暂无适配的产品信息！' },
    torch: { selector: 'div.alert.alert-warning.col-xs-12[role="alert"]', text: '未查询到产品信息' }
};

// 同时等待产品和明确的空结果提示；空结果优先，避免读取残留产品。
async function waitForProductOutcome(page, brand, productSelector, timeout, beforePoll = async () => {}, previousSignature = null, documentToken = null) {
    let elapsed = 0;
    while (elapsed < timeout) {
        await page.__remoteLogin?.checkpoint();
        await beforePoll();
        const startedAt = Date.now();
        let hasProducts = false;
        for (const frame of page.frames()) {
            const state = await frame.evaluate((empty, selector, needsFreshResult, oldSignature, initialDocumentToken) => {
                const visible = (element) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                };
                // A full document navigation destroys the observer installed on the search page.
                // A new document is fresh; on the same document still require a result mutation.
                if (needsFreshResult && window.__mannResultChanged !== true &&
                    (initialDocumentToken === null || window.__mannSearchDocumentId === initialDocumentToken)) return 'waiting';
                const expectedText = empty.text.replace(/\s+/g, '');
                const noResults = Array.from(document.querySelectorAll(empty.selector)).some((element) => {
                    if (!visible(element)) return false;
                    const elementText = element.textContent.replace(/\s+/g, '');
                    return empty.contains ? elementText.includes(expectedText) : elementText === expectedText;
                });
                if (noResults) return 'empty';
                const products = Array.from(document.querySelectorAll(selector)).filter(visible);
                if (!products.length) return 'waiting';
                const signature = products.map((product) => `${product.getAttribute('productno') || ''}|${product.innerText}`).join('\n');
                if (oldSignature !== null && signature === oldSignature) return 'waiting';
                return 'products';
            }, EMPTY_RESULTS[brand], productSelector, brand === 'mann', previousSignature, documentToken).catch((error) => {
                if (/context.*destroyed|detached|Cannot find context/i.test(error.message)) return 'waiting';
                throw error;
            });
            if (state === 'empty') return 'empty';
            if (state === 'products') hasProducts = true;
        }
        if (hasProducts) return 'products';
        elapsed += Date.now() - startedAt;
        await new Promise((resolve) => setTimeout(resolve, 250));
        elapsed += 250;
    }
    return 'timeout';
}

module.exports = { waitForProductOutcome };
