(() => {
    const form = document.getElementById('brakePadsSearchForm');
    const input = document.getElementById('brakePadsInput');
    const sourceButtons = [...form.querySelectorAll('[data-brake-pads-source]')];
    const clear = document.getElementById('brakePadsClear');
    const output = document.getElementById('brakePadsResults');
    const download = document.getElementById('brakePadsDownload');
    const labels = { au: 'Bendix Australia', my: 'Bendix Malaysia', zf: 'ZF China · TRW' };
    const apiBrands = { au: 'bendix_au', my: 'bendix_my', zf: 'zf_trw_cn' };
    const regions = Object.keys(labels);
    const results = { au: null, my: null, zf: null };
    let status = ['输入料号后，可依次查询三个目录。', 'Enter part numbers, then search the three catalogues in turn.'];
    let busy = false;
    let runningRegion = null;
    let activeQueryKey = null;

    const display = (zh, en) => uiText(zh, en);
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const safe = value => escapeHtml(value);
    function showStatus() {
        setLocalizedText('brakePadsStatus', ...status);
    }
    function setStatus(zh, en) {
        status = [zh, en];
        showStatus();
    }

    function updateControls() {
        sourceButtons.forEach(button => {
            const region = button.dataset.brakePadsSource;
            button.disabled = busy;
            button.setAttribute('aria-busy', String(region === runningRegion));
        });
        input.disabled = busy;
        clear.disabled = busy;
    }

    function updateCount() {
        const count = parsePartNumberGroups(input.value)
            .reduce((total, group) => total + group.candidates.length, 0);
        const counter = document.getElementById('brakePadsCount');
        counter.textContent = `${count} / 50`;
        counter.classList.toggle('brake-pad-count-over', count > 50);
        input.setAttribute('aria-invalid', String(count > 50));
    }
    function queryKey(value) {
        return JSON.stringify([...new Set(parsePartNumberGroups(value).map(group => group.value.toUpperCase()))]);
    }
    function clearResults() {
        regions.forEach(region => { results[region] = null; });
        render();
    }
    input.addEventListener('input', () => {
        updateCount();
        if (activeQueryKey !== null && queryKey(input.value) !== activeQueryKey) {
            activeQueryKey = null;
            clearResults();
            setStatus('料号已修改，请重新查询。', 'Part numbers changed. Run a new search.');
        }
    });
    clear.addEventListener('click', () => {
        if (busy) return;
        input.value = '';
        activeQueryKey = null;
        clearResults();
        updateCount();
        setStatus('已清空输入和所有目录的查询结果。', 'Cleared the input and results from all catalogues.');
        input.focus();
    });

    function selectBrakeTab(kind) {
        for (const name of ['Pads', 'Fluid']) {
            const selected = name.toLowerCase() === kind;
            const tab = document.getElementById(`brake${name}Tab`);
            document.getElementById(`brake${name}Panel`).classList.toggle('hidden', !selected);
            tab.setAttribute('aria-selected', String(selected));
            tab.className = selected
                ? 'btn-primary text-white px-5 py-3 font-semibold'
                : 'bg-white border border-gray-300 text-gray-700 px-5 py-3 font-semibold';
        }
    }
    document.getElementById('brakePadsTab').addEventListener('click', () => selectBrakeTab('pads'));
    document.getElementById('brakeFluidTab').addEventListener('click', () => selectBrakeTab('fluid'));

    function rowsFor(region) {
        const grouped = new Map();
        for (const row of results[region] || []) {
            const searchedInput = row.oe || row.searchedPartNumber || row.matchedPartNumber || '';
            const key = clean(searchedInput).toUpperCase();
            if (!grouped.has(key)) grouped.set(key, {
                region, input: searchedInput, statusCode: row.statusCode, products: [], productNumbers: new Set()
            });
            const group = grouped.get(key);
            for (const product of row.products || []) {
                const number = clean(product.partNumber);
                if (!number || group.productNumbers.has(number.toUpperCase())) continue;
                group.productNumbers.add(number.toUpperCase());
                group.products.push(product);
            }
            if (group.products.length) group.statusCode = 'SEARCH_SUCCESS';
        }
        return [...grouped.values()];
    }

    function parsePartNumberGroups(value) {
        return String(value || '').split(/\r?\n/).map(line => {
            const candidates = [];
            const seen = new Set();
            line.split(/[;；=＝]+/).forEach(item => {
                const candidate = clean(item.replace(/\s*[（(]\s*新号\s*[）)]\s*/g, ' '));
                if (!candidate || !/\d/.test(candidate)) return;
                const key = candidate.toUpperCase();
                if (seen.has(key)) return;
                seen.add(key);
                candidates.push(candidate);
            });
            return candidates.length ? { value: candidates.join('; '), candidates } : null;
        }).filter(Boolean);
    }

    function statusFor(code) {
        if (code === 'SEARCH_SUCCESS') return display('查询成功', 'Found');
        if (code === 'NO_RESULTS') return display('未查到', 'Not found');
        if (code === 'QUERY_TIMEOUT') return display('查询超时', 'Timed out');
        return display('查询失败', 'Search failed');
    }

    function summaryRows() {
        const byInput = new Map();
        for (const region of regions) {
            for (const row of rowsFor(region)) {
                const key = clean(row.input).toUpperCase();
                if (!byInput.has(key)) byInput.set(key, { input: row.input, sources: {} });
                byInput.get(key).sources[region] = row;
            }
        }
        return [...byInput.values()];
    }

    function productText(region, product) {
        const number = clean(product.partNumber);
        if (region === 'zf') return number;
        const dimensions = [['W', product.width], ['H', product.height], ['T', product.thickness]]
            .filter(([, value]) => clean(value))
            .map(([label, value]) => `${label}: ${clean(value)}`);
        return dimensions.length ? `${number} (${dimensions.join(', ')})` : number;
    }

    function sourceCellText(region, row) {
        if (!row) return '';
        return row.products.length
            ? row.products.map(product => productText(region, product)).join('\n')
            : statusFor(row.statusCode);
    }

    function sourceCellHtml(region, row) {
        if (!row) return '<span class="text-gray-400">—</span>';
        if (!row.products.length) return `<span class="text-gray-500">${safe(statusFor(row.statusCode))}</span>`;
        return row.products.map(product => {
            const number = clean(product.partNumber);
            const detail = productText(region, product).slice(number.length).trim();
            return `<div class="py-1 first:pt-0 last:pb-0"><span class="font-semibold text-gray-900">${safe(number)}</span>${detail ? `<span class="block text-xs text-gray-500 mt-0.5">${safe(detail)}</span>` : ''}</div>`;
        }).join('');
    }

    function render() {
        const rows = summaryRows();
        const searchedRegions = regions.filter(region => results[region] !== null);
        document.getElementById('brakePadsResultsSection').classList.toggle('hidden', !rows.length);
        download.classList.toggle('hidden', !rows.length);
        setLocalizedText('brakePadsResultsTitle', '竞品料号汇总', 'Competitor number summary');
        setLocalizedText('brakePadsResultsCount', `共 ${rows.length} 个 OE · ${searchedRegions.length} 个目录`, `${rows.length} OE numbers · ${searchedRegions.length} catalogues`);
        if (!rows.length) { output.innerHTML = ''; return; }
        const headings = [display('查询 OE 号', 'Search OE number'), ...searchedRegions.map(region => labels[region])];
        output.innerHTML = `<table class="w-full text-sm" style="min-width:${180 + searchedRegions.length * 210}px"><thead><tr>${headings.map(label => `<th class="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">${safe(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => {
            return `<tr class="border-t border-gray-200 hover:bg-gray-50"><td class="px-4 py-3 align-top font-mono font-semibold text-gray-700 whitespace-nowrap">${safe(row.input)}</td>${searchedRegions.map(region => `<td class="px-4 py-3 align-top min-w-[190px]">${sourceCellHtml(region, row.sources[region])}</td>`).join('')}</tr>`;
        }).join('')}</tbody></table>`;
    }
    window.refreshBrakePadsLanguage = () => { showStatus(); render(); };
    window.showBrakePadsHistory = (record, inputs) => {
        const region = Object.keys(apiBrands).find(key => apiBrands[key] === record.brand);
        if (!region) return;
        selectBrakeTab('pads');
        input.value = inputs.join('\n');
        updateCount();
        clearResults();
        activeQueryKey = queryKey(input.value);
        results[region] = record.status === 'completed' ? (Array.isArray(record.results) ? record.results : []) : null;
        render();
        if (record.status === 'completed') {
            setStatus(`已载入 ${labels[region]} 历史查询。`, `Loaded ${labels[region]} search history.`);
        } else {
            setStatus(`${labels[region]} 历史查询失败：${record.error?.messageZh || ''}`, `${labels[region]} historical search failed: ${record.error?.messageEn || ''}`);
        }
    };

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        const region = event.submitter?.dataset.brakePadsSource || 'au';
        if (!regions.includes(region)) return;
        const parsedGroups = parsePartNumberGroups(input.value);
        const candidateCount = parsedGroups.reduce((total, group) => total + group.candidates.length, 0);
        const partNumbers = [...new Set(parsedGroups.map(group => group.value))];
        if (!partNumbers.length) {
            setStatus('请至少输入一个料号。', 'Enter at least one part number.');
            return;
        }
        if (candidateCount > 50) {
            setStatus('每批最多查询 50 个料号。', 'Search up to 50 part numbers per batch.');
            return;
        }
        const nextQueryKey = queryKey(input.value);
        if (activeQueryKey !== nextQueryKey) clearResults();
        activeQueryKey = nextQueryKey;
        results[region] = null;
        render();
        busy = true;
        runningRegion = region;
        updateControls();
        setStatus(`正在查询 ${labels[region]}…`, `Searching ${labels[region]}…`);
        try {
            const response = await runSearchJob(`/api/search/${apiBrands[region]}`, partNumbers, labels[region], message => {
                setStatus(message, message);
            });
            results[region] = response.results;
            render();
            const found = response.results.filter(row => row.products?.length).length;
            setStatus(`${labels[region]} 查询完成：${found}/${partNumbers.length} 个输入料号查到产品。`, `${labels[region]} complete: products found for ${found} of ${partNumbers.length} input numbers.`);
        } catch (error) {
            setStatus(`${labels[region]} 查询失败：${readableSearchError(error)}`, `${labels[region]} search failed: ${readableSearchError(error)}`);
        } finally {
            busy = false;
            runningRegion = null;
            updateControls();
        }
    });

    download.addEventListener('click', () => {
        const rows = summaryRows();
        if (!rows.length) return;
        const searchedRegions = regions.filter(region => results[region] !== null);
        const data = [[display('查询 OE 号', 'Search OE number'), ...searchedRegions.map(region => labels[region])], ...rows.map(row => [
            row.input, ...searchedRegions.map(region => sourceCellText(region, row.sources[region]))
        ])];
        downloadExcel(data, `Brake_Pads_Combined_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
    updateCount();
    updateControls();
    showStatus();
    render();
})();
