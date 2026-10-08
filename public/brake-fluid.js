(() => {
    const el = id => document.getElementById(id);
    let result = null;
    let requestVersion = 0;
    let certificate = '';
    let importing = false;
    let sourceState = null;
    let certificateData = null;
    const text = (zh, en) => uiText(zh, en);
    const message = (id, zh, en) => setLocalizedText(id, zh, en);
    const locale = () => text('zh-CN', 'en-GB');
    function englishError(value) {
        const translations = {
            '第一个工作表为空。': 'The first worksheet is empty.',
            '一次最多导入 100 万行数据。': 'Import up to 1,000,000 rows at a time.',
            '一次最多导入 100 万行 VIN 关联数据。': 'Import up to 1,000,000 VIN mappings at a time.',
            '首行必须各有一列 vin 和 REMARK_ID，且不能重名。': 'The header row must contain exactly one vin column and one REMARK_ID column.',
            '没有可导入的 VIN 关联数据。': 'No VIN mappings were found to import.',
            'Excel 中没有可导入的 VIN 关联数据。': 'No VIN mappings were found in the Excel file.',
            '无法读取 Excel 文件。': 'Unable to read the Excel file.',
            'Excel 解析失败，请检查文件及网络连接。': 'Unable to parse Excel. Check the file and your network connection.',
            '关联数据超过上传限制，请减少行数后重试。': 'The mappings exceed the upload limit. Reduce the number of rows and retry.',
            '服务器响应异常，请刷新页面确认当前数据源。': 'Unexpected server response. Refresh the page to check the current data source.',
            '导入失败。': 'Import failed.',
            '导入失败，原 VIN 关联数据已保留，请稍后重试。': 'Import failed. Existing VIN mappings were retained. Please retry later.',
            '制动液数据库暂时不可用，请检查 brakeoil.db 后重试。': 'The brake fluid database is unavailable. Check brakeoil.db and retry.',
            '请输入完整的 17 位 VIN 码（仅限英文字母和数字，不含 *）。': 'Enter a complete 17-character VIN (letters and digits only, without *).',
            '查询失败，请重试。': 'Lookup failed. Please retry.'
        };
        if (translations[value]) return translations[value];
        const row = /^第 (\d+) 行(.*)$/.exec(value);
        if (row) {
            const reasons = {
                '包含 Excel 错误值。': 'contains an Excel error value.',
                ' VIN 无效，应为 17 位 VIN 或含 * 的模板。': 'must contain a valid 17-character VIN or a template using *.',
                ' liyang 为空或过长。': 'has an empty or overly long liyang value.',
                ' REMARK_ID 为空或过长。': 'has an empty or overly long REMARK_ID value.',
                '格式错误，必须仅包含 vin 和 liyang 两列。': 'must contain only the vin and liyang columns.'
            };
            if (reasons[row[2]]) return `Row ${row[1]} ${reasons[row[2]]}`;
        }
        return /[\u3400-\u9fff]/.test(value) ? 'Unable to process the data. Check the file and try again.' : value;
    }
    el('brakeChooseFile').addEventListener('click', () => el('brakeImportFile').click());
    el('brakeCopyPath').addEventListener('click', async () => {
        const input = el('brakeDefaultPath');
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(input.value);
            message('brakePathStatus', '路径已复制。点击“选择文件”，在文件窗口的地址栏中粘贴路径。', 'Path copied. Click “Choose file” and paste the path into the file dialog address bar.');
        } catch {
            input.focus();
            input.select();
            message('brakePathStatus', '路径已选中，请按 Ctrl+C（Mac：⌘C）复制，然后在文件窗口中粘贴。', 'Path selected. Press Ctrl+C (Mac: ⌘C) to copy, then paste it into the file dialog.');
        }
    });
    el('brakeImportFile').addEventListener('change', () => {
        const name = el('brakeImportFile').files[0]?.name;
        message('brakeFileName', name || '尚未选择文件', name || 'No file selected');
    });
    function showSource(source) {
        sourceState = source;
        const count = source.rowCount.toLocaleString(locale());
        message('brakeSource', source.type === 'imported'
            ? `当前内置数据：${source.filename} · ${count} 条关联 · 导入于 ${new Date(source.importedAt).toLocaleString('zh-CN')}`
            : `当前内置数据：原始 VIN 关联表 · ${count} 条关联`, source.type === 'imported'
            ? `Current mappings: ${source.filename} · ${count} records · Imported ${new Date(source.importedAt).toLocaleString('en-GB')}`
            : `Current mappings: built-in VIN mapping table · ${count} records`);
    }
    fetch('/api/brake-fluid/source').then(async response => {
        if (!response.ok) throw new Error();
        const source = await response.json();
        if (!importing) showSource(source);
    }).catch(() => { message('brakeSource', '暂时无法读取数据源信息。', 'The data source information is currently unavailable.'); });
    function readMapping(file) {
        return new Promise((resolve, reject) => {
            const worker = new Worker('/brake-import-worker.js');
            worker.onmessage = ({ data }) => {
                worker.terminate();
                data.error ? reject(new Error(data.error)) : resolve(data.rows);
            };
            worker.onerror = () => {
                worker.terminate();
                reject(new Error('Excel 解析失败，请检查文件及网络连接。'));
            };
            worker.postMessage(file);
        });
    }
    el('brakeImportForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (importing) return;
        const file = el('brakeImportFile').files[0];
        if (!file) { message('brakeImportStatus', '请先选择 Excel 文件。', 'Choose an Excel file first.'); return; }
        if (!/\.(xlsx|xls)$/i.test(file.name) || file.size > 100 * 1024 * 1024) {
            message('brakeImportStatus', '请选择不超过 100 MB 的 .xlsx 或 .xls 文件。', 'Choose an .xlsx or .xls file no larger than 100 MB.');
            return;
        }
        importing = true;
        requestVersion++;
        result = null;
        updateSelection();
        el('brakeMatchArea').classList.add('hidden');
        el('brakeLookupButton').disabled = true;
        el('brakeImportButton').disabled = true;
        el('brakeImportFile').disabled = true;
        el('brakeChooseFile').disabled = true;
        message('brakeImportStatus', '正在提取 vin 和 REMARK_ID 两列并校验…', 'Extracting and validating the vin and REMARK_ID columns…');
        try {
            let rows = await readMapping(file);
            message('brakeImportStatus', `正在保存 ${rows.length.toLocaleString()} 行关联数据…`, `Saving ${rows.length.toLocaleString()} mapping rows…`);
            const body = JSON.stringify({ rows, filename: file.name });
            rows = null;
            const response = await fetch('/api/brake-fluid/import', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body
            });
            if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error(response.status === 413 ? '关联数据超过上传限制，请减少行数后重试。' : '服务器响应异常，请刷新页面确认当前数据源。');
            const source = await response.json();
            if (!response.ok) throw new Error(source.error || '导入失败。');
            showSource(source);
            message('brakeImportStatus', `导入成功，已替换并保存 ${source.rowCount.toLocaleString()} 条关联，去重 ${source.duplicates.toLocaleString()} 条。其他列未保存。`, `Import complete: ${source.rowCount.toLocaleString()} mappings saved, ${source.duplicates.toLocaleString()} duplicates removed. Other columns were discarded.`);
            el('brakeImportFile').value = '';
            message('brakeFileName', '尚未选择文件', 'No file selected');
            message('brakeStatus', 'VIN 关联数据已更新，请重新查询。', 'VIN mappings have been updated. Please run the lookup again.');
        } catch (error) {
            message('brakeImportStatus', `导入未完成：${error.message}`, `Import not completed: ${englishError(error.message)}`);
        } finally {
            importing = false;
            el('brakeLookupButton').disabled = false;
            el('brakeImportButton').disabled = false;
            el('brakeImportFile').disabled = false;
            el('brakeChooseFile').disabled = false;
        }
    });
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    function invalidateCertificate() {
        certificate = '';
        certificateData = null;
        el('brakeCertificateArea').classList.add('hidden');
    }
    function updateSelection() {
        invalidateCertificate();
        el('brakeGenerate').disabled = !result?.matches[el('brakeMatch').value]?.complete;
    }
    el('brakeVin').addEventListener('input', () => {
        requestVersion++;
        result = null;
        el('brakeLookupButton').disabled = importing;
        el('brakeMatchArea').classList.add('hidden');
        message('brakeStatus', 'VIN 已修改，请重新查询。', 'VIN changed. Please run the lookup again.');
        updateSelection();
    });
    el('brakeMatch').addEventListener('change', updateSelection);
    ['brakeProduct', 'brakeDot', 'brakeHzy'].forEach(id => el(id).addEventListener('input', invalidateCertificate));
    el('brakeLookupForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (importing) return;
        const version = ++requestVersion;
        result = null;
        updateSelection();
        el('brakeMatchArea').classList.add('hidden');
        const vin = el('brakeVin').value.trim().toUpperCase();
        el('brakeVin').value = vin;
        if (!/^[A-Z0-9]{17}$/.test(vin)) {
            message('brakeStatus', '请输入完整的 17 位 VIN 码（仅限英文字母和数字，不含 *）。', 'Enter a complete 17-character VIN (letters and digits only, without *).');
            return;
        }
        el('brakeLookupButton').disabled = true;
        message('brakeStatus', '正在查询车型及原厂规格…', 'Looking up the vehicle and original specifications…');
        try {
            const response = await fetch('/api/brake-fluid/lookup', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin })
            });
            const data = await response.json();
            if (version !== requestVersion) return;
            if (!response.ok) throw new Error(data.error || '查询失败，请重试。');
            result = data;
            renderMatches(false);
            el('brakeMatchArea').classList.toggle('hidden', !data.matches.length);
            message('brakeStatus', data.matches.length
                ? `查询到 ${data.matches.length} 条记录。${data.matches.some(row => row.complete) ? '请确认记录并填写产品信息。' : '原厂资料不完整，暂无法出具适配证明。'}`
                : '未查询到匹配记录，请核对 VIN 码。', data.matches.length
                ? `Found ${data.matches.length} records. ${data.matches.some(row => row.complete) ? 'Confirm the record and enter the product details.' : 'Original information is incomplete; a certificate cannot be generated.'}`
                : 'No matching records found. Please check the VIN.');
            updateSelection();
        } catch (error) {
            if (version === requestVersion) message('brakeStatus', `查询失败：${error.message}`, `Lookup failed: ${englishError(error.message)}`);
        } finally {
            if (version === requestVersion) el('brakeLookupButton').disabled = false;
        }
    });
    el('brakeCertificateForm').addEventListener('submit', event => {
        event.preventDefault();
        const row = result?.matches[el('brakeMatch').value];
        if (!row?.complete) return;
        const product = el('brakeProduct').value.trim();
        const dot = el('brakeDot').value.trim();
        const hzy = el('brakeHzy').value.trim().replace(/^HZY\s*/i, '');
        if (!product || !dot || !hzy) {
            message('brakeStatus', '请完整填写博世产品名称、DOT 规格及 HZY 等级。', 'Enter the Bosch product name, DOT specification and HZY grade.');
            return;
        }
        certificateData = { row, vin: result.vin, product, dot, hzy, date: new Date() };
        renderCertificate();
        el('brakeCertificateArea').classList.remove('hidden');
    });
    function renderMatches(preserve = true) {
        if (!result) return;
        const selected = el('brakeMatch').value;
        const options = result.matches.map((row, index) => new Option(
            `${row.brand || text('品牌缺失', 'Brand missing')} · ${row.model || text('车型缺失', 'Model missing')} · ${row.originalSpec || text('原厂规格缺失', 'Original specification missing')} (${text('力洋ID', 'Liyang ID')}: ${row.liyangId})`, index
        ));
        el('brakeMatch').replaceChildren(new Option(text('请选择车型及原厂规格', 'Select a vehicle and original specification'), ''), ...options);
        el('brakeMatch').value = preserve ? selected : result.matches.length === 1 ? '0' : '';
    }
    function renderCertificate() {
        if (!certificateData) return;
        const { row, vin, product, dot, hzy, date } = certificateData;
        const statement = text(
            `经查${row.brand}${row.model}适配${row.originalSpec}规格制动液，博世${product}符合${dot}（国标HZY${hzy}）规格要求，可以适配该车型。`,
            `The ${row.brand} ${row.model} requires brake fluid meeting the ${row.originalSpec} specification. Bosch ${product} meets the ${dot} (Chinese national standard HZY${hzy}) requirements and is suitable for this vehicle.`
        );
        certificate = `<h1>${text('制动液适配证明', 'Brake Fluid Fitment Certificate')}</h1><p>VIN: ${escape(vin)}</p><p>${text('品牌 / 车型', 'Brand / Model')}: ${escape(row.brand)} / ${escape(row.model)}</p><p>${text('力洋ID', 'Liyang ID')}: ${escape(row.liyangId)}</p><p>${text('原厂规格', 'Original specification')}: ${escape(row.originalSpec)}</p><p class="statement">${escape(statement)}</p><p>${text('出具日期', 'Date issued')}: ${escape(date.toLocaleDateString(locale()))}</p><p class="signature">${text('出具单位（盖章）', 'Issuing organization (stamp)')}: ________________<br>${text('经办人', 'Prepared by')}: ________________</p>`;
        el('brakeCertificate').innerHTML = certificate;
    }
    window.refreshBrakeLanguage = () => {
        const placeholders = {
            brakeVin: ['请输入完整的 17 位 VIN 码', 'Enter the complete 17-character VIN'],
            brakeProduct: ['例如：DOT4 Plus', 'Example: DOT4 Plus'],
            brakeDot: ['例如：DOT4', 'Example: DOT4'],
            brakeHzy: ['填写 HZY 后的等级', 'Enter the grade after HZY']
        };
        Object.entries(placeholders).forEach(([id, labels]) => { el(id).placeholder = text(...labels); });
        if (sourceState) showSource(sourceState);
        renderMatches();
        renderCertificate();
    };
    window.refreshBrakeLanguage();
    const documentHtml = () => `<!doctype html><html lang="${locale()}"><head><meta charset="utf-8"><title>${text('制动液适配证明', 'Brake Fluid Fitment Certificate')}</title><style>@page{size:A4;margin:24mm}body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#222;max-width:760px;margin:40px auto;line-height:1.9;padding:20px}h1{text-align:center;font-size:26px;margin-bottom:40px}p{overflow-wrap:anywhere}.statement{margin:40px 0;font-size:18px}.signature{margin-top:70px;line-height:3}@media print{body{margin:0;padding:0}}</style></head><body>${certificate}</body></html>`;
    el('brakeDownload').addEventListener('click', () => {
        if (!certificate) return;
        const url = URL.createObjectURL(new Blob([documentHtml()], { type: 'text/html;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${text('制动液适配证明', 'Brake-Fluid-Fitment-Certificate')}-${result.vin}.html`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    el('brakePrint').addEventListener('click', () => {
        if (!certificate) return;
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
        frame.title = text('打印适配证明', 'Print fitment certificate');
        frame.onload = () => {
            frame.contentWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
            frame.contentWindow.focus();
            frame.contentWindow.print();
        };
        frame.srcdoc = documentHtml();
        document.body.append(frame);
    });
})();
