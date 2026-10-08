(() => {
    const el = id => document.getElementById(id);
    const input = el('transmissionInput');
    const safe = value => escapeHtml(String(value ?? ''));
    let results = [];
    let busy = false;
    let status = ['输入油品型号，点击 Online 开始查询。', 'Enter an oil model and click Online to search.'];
    const queries = () => [...new Map(input.value.split(/\r?\n/).map(value => value.replace(/\s+/g, ' ').trim())
        .filter(Boolean).map(value => [value.toUpperCase(), value])).values()];
    function setStatus(zh, en) {
        status = [zh, en];
        setLocalizedText('transmissionStatus', zh, en);
    }
    function setProgress(message, translations) {
        if (!translations) return setStatus(message, message);
        setStatus(translations.zh.replaceAll('ZF Transmission Oil', 'ZF 变速箱油'), translations.en);
    }
    function updateCount() {
        const count = queries().length;
        el('transmissionCount').textContent = `${count} / 50`;
        input.setAttribute('aria-invalid', String(count > 50));
    }
    function statusText(code) {
        const labels = {
            SEARCH_SUCCESS: ['查询成功', 'Found'], NO_RESULTS: ['未找到包含搜索内容的油品型号', 'No oil model contains the search text'],
            QUERY_TIMEOUT: ['查询超时，请重试', 'Search timed out; please retry'],
            SOURCE_UNAVAILABLE: ['ZF 目录暂不可用，请稍后重试', 'ZF catalogue unavailable; please retry later'],
            NETWORK_ERROR: ['网络连接失败，请重试', 'Network error; please retry']
        };
        return uiText(...(labels[code] || ['查询失败，请重试', 'Search failed; please retry']));
    }
    const chips = numbers => `<div class="oil-numbers">${numbers.map(number => `<span class="oil-number">${safe(number)}</span>`).join('')}</div>`;
    function sourceLink(url) {
        try {
            const parsed = new URL(url);
            return parsed.origin === globalThis.APP_CONFIG?.ZF_ORIGIN ? parsed.href : '';
        } catch { return ''; }
    }
    function render() {
        el('transmissionDownload').classList.toggle('hidden', !results.length);
        el('transmissionResults').innerHTML = results.map(row => `<article class="oil-result">
            <div class="oil-result-header"><h3>${safe(row.oe)}</h3><span class="text-sm text-gray-500">${safe(statusText(row.statusCode))}</span></div>
            ${(row.products || []).map(product => {
                const groups = product.oeGroups || [];
                const count = groups.reduce((sum, group) => sum + group.numbers.length, 0);
                const url = sourceLink(product.url);
                const productLabel = uiText(product.title || product.partNumber, `ZF transmission oil · ${product.partNumber}`);
                return `<p class="font-semibold">${safe(productLabel)}</p>
                    ${product.zfNumber ? `<p class="text-sm text-gray-700">${safe(uiText('ZF 编号', 'ZF part number'))}: <strong>${safe(product.zfNumber)}</strong></p>` : ''}
                    <div class="oil-summary">${safe(uiText(`对应 OE 编号 · ${groups.length} 个品牌 · ${count} 个编号`, `Corresponding OE numbers · ${groups.length} brands · ${count} numbers`))}
                    ${url ? ` · <a href="${safe(url)}" target="_blank" rel="noopener noreferrer">${safe(uiText('查看 ZF 产品 ↗', 'View ZF product ↗'))}</a>` : ''}</div>
                    ${groups.length ? groups.map(group => `<section class="oil-brand"><h4>${safe(group.brand)} <span class="text-gray-400">(${group.numbers.length})</span></h4><div>
                        ${chips(group.numbers.slice(0, 3))}
                        ${group.numbers.length > 3 ? `<details><summary><span class="oil-more">${safe(uiText(`展开其余 ${group.numbers.length - 3} 个 OE 号`, `Show ${group.numbers.length - 3} more OE numbers`))}</span><span class="oil-less">${safe(uiText('收起', 'Show less'))}</span></summary>${chips(group.numbers.slice(3))}</details>` : ''}
                    </div></section>`).join('') : `<p class="text-sm text-gray-500">${safe(uiText('暂无对应 OE 编号信息。', 'OE number information is unavailable.'))}</p>`}`;
            }).join('')}</article>`).join('');
    }
    function setBusy(value) {
        busy = value;
        for (const id of ['transmissionInput', 'transmissionOnline', 'transmissionClear']) el(id).disabled = value;
        el('transmissionOnline').setAttribute('aria-busy', String(value));
    }
    input.addEventListener('input', updateCount);
    el('transmissionSearchForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        const list = queries();
        if (!list.length) return setStatus('请至少输入一个油品型号。', 'Enter at least one oil model.');
        if (list.length > 50) return setStatus('每批最多查询 50 个型号。', 'Search up to 50 models per batch.');
        setBusy(true);
        results = [];
        render();
        setStatus('正在查询 ZF 油品与对应 OE 编号…', 'Searching ZF oils and corresponding OE numbers…');
        try {
            const response = await runSearchJob('/api/search/zf_oil_cn', list, 'ZF Transmission Oil', setProgress);
            results = response.results;
            render();
            const found = results.filter(row => row.products?.length).length;
            setStatus(`查询完成：${found}/${list.length} 个型号匹配成功。`, `Complete: ${found} of ${list.length} models matched.`);
        } catch (error) {
            const zhError = error.searchError?.messageZh || '请稍后重试。';
            const enError = error.searchError?.messageEn || 'Please try again.';
            setStatus(`查询失败：${zhError}`, `Search failed: ${enError}`);
        } finally { setBusy(false); }
    });
    el('transmissionClear').addEventListener('click', () => {
        if (busy) return;
        input.value = '';
        results = [];
        updateCount();
        render();
        setStatus('已清空输入和查询结果。', 'Inputs and results cleared.');
        input.focus();
    });
    el('transmissionDownload').addEventListener('click', () => {
        const data = [[uiText('查询型号', 'Search model'), uiText('产品', 'Product'), uiText('品牌', 'Brand'), 'OE', uiText('状态', 'Status'), uiText('来源', 'Source')]];
        results.forEach(row => {
            if (!row.products?.length) data.push([row.oe, '', '', '', statusText(row.statusCode), '']);
            for (const product of row.products || []) {
                if (!product.oeGroups?.length) data.push([row.oe, product.partNumber, '', '', uiText('未列出 OE 编号', 'No OE numbers listed'), product.url]);
                for (const group of product.oeGroups || []) for (const number of group.numbers) {
                    data.push([row.oe, product.partNumber, group.brand, number, statusText(row.statusCode), product.url]);
                }
            }
        });
        downloadExcel(data, `Transmission_Oil_OE_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
    window.refreshTransmissionLanguage = () => { setLocalizedText('transmissionStatus', ...status); render(); };
    window.showTransmissionHistory = (record, inputs) => {
        input.value = inputs.join('\n');
        results = record.status === 'completed' && Array.isArray(record.results) ? record.results : [];
        updateCount();
        render();
        if (record.status === 'completed') setStatus('已载入变速箱油历史查询。', 'Transmission oil search history loaded.');
        else setStatus(`历史查询失败：${record.error?.messageZh || ''}`, `Historical search failed: ${record.error?.messageEn || ''}`);
    };
    updateCount();
    setStatus(...status);
})();
