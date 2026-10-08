// Parsing stays off the UI thread. The worker is terminated after extracting two columns.
self.onmessage = async ({ data: file }) => {
    try {
        importScripts('/runtime-config.js');
        importScripts(globalThis.APP_CONFIG.XLSX_URL);
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', sheets: 0, cellHTML: false, cellStyles: false, cellNF: false, cellText: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!sheet?.['!ref']) throw new Error('第一个工作表为空。');
        const range = XLSX.utils.decode_range(sheet['!ref']);
        if (range.e.r > 1000000) throw new Error('一次最多导入 100 万行数据。');
        const columns = { vin: [], remark_id: [] };
        for (let col = range.s.c; col <= range.e.c; col++) {
            const name = String(sheet[XLSX.utils.encode_cell({ r: 0, c: col })]?.v ?? '').trim().toLowerCase();
            if (name === 'vin' || name === 'remark_id') columns[name].push(col);
        }
        if (columns.vin.length !== 1 || columns.remark_id.length !== 1) throw new Error('首行必须各有一列 vin 和 REMARK_ID，且不能重名。');
        const rows = [];
        for (let r = 1; r <= range.e.r; r++) {
            // The second value is stored as liyang_id by the import endpoint.
            const cells = [columns.vin[0], columns.remark_id[0]].map(c => sheet[XLSX.utils.encode_cell({ r, c })]);
            const pair = cells.map(cell => String(cell?.v ?? '').trim());
            if (!pair[0] && !pair[1]) continue;
            if (cells.some(cell => cell?.t === 'e')) throw new Error(`第 ${r + 1} 行包含 Excel 错误值。`);
            pair[0] = pair[0].toUpperCase();
            // Source templates may contain I/O/Q; preserve letters rather than guessing digits.
            if (!/^[A-Z0-9*]{17}$/.test(pair[0]) || !/[A-Z0-9]/.test(pair[0])) throw new Error(`第 ${r + 1} 行 VIN 无效，应为 17 位 VIN 或含 * 的模板。`);
            if (!pair[1] || pair[1].length > 100) throw new Error(`第 ${r + 1} 行 REMARK_ID 为空或过长。`);
            rows.push(pair);
        }
        if (!rows.length) throw new Error('没有可导入的 VIN 关联数据。');
        self.postMessage({ rows });
    } catch (error) {
        self.postMessage({ error: error.message || '无法读取 Excel 文件。' });
    }
};
