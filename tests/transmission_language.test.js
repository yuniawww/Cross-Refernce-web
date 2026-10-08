const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('Transmission Oil follows the page language for static copy, progress, results and errors', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../OE号智能匹配工具 (1).html'), 'utf8');
    for (const id of ['transmissionOnline', 'transmissionHelp', 'transmissionDownload']) {
        assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?data-text-zh="[^"]+" data-text-en="[^"]+"`));
    }
    assert.match(html, /'Transmission Oil': '变速箱油'/);
    assert.match(html, /'zf_oil_cn'\]\.includes\(record\.brand\)/);

    const elements = new Map();
    const callbacks = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', textContent: '', innerHTML: '', dataset: {}, disabled: false,
            classList: { toggle() {} }, setAttribute() {}, focus() {},
            addEventListener(type, callback) { callbacks.set(`${id}:${type}`, callback); }
        });
        return elements.get(id);
    };
    let language = 'zh';
    let resolveSearch;
    let searchImpl = (_url, _list, _label, progress) => {
        progress('ZF Transmission Oil 正在后台查询，请耐心等待...', {
            zh: 'ZF Transmission Oil 正在后台查询，请耐心等待...',
            en: 'ZF Transmission Oil is searching in the background. Please wait...'
        });
        return new Promise(resolve => { resolveSearch = resolve; });
    };
    const context = {
        document: { getElementById: element }, window: {}, URL, APP_CONFIG: { ZF_ORIGIN: 'https://aftermarket.zf.com' },
        uiText: (zh, en) => language === 'en' ? en : zh,
        setLocalizedText: (id, zh, en) => { element(id).textContent = language === 'en' ? en : zh; },
        escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
        runSearchJob: (...args) => searchImpl(...args), downloadExcel() {}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/transmission-oil.js'), 'utf8'), context);
    element('transmissionInput').value = 'LifeguardFluid 7.1 MB';
    const submit = callbacks.get('transmissionSearchForm:submit');
    const pending = submit({ preventDefault() {} });
    assert.match(element('transmissionStatus').textContent, /ZF 变速箱油 正在后台查询/);

    language = 'en';
    context.window.refreshTransmissionLanguage();
    assert.match(element('transmissionStatus').textContent, /ZF Transmission Oil is searching/);
    resolveSearch({ results: [{ oe: 'LifeguardFluid 7.1 MB', statusCode: 'SEARCH_SUCCESS', products: [{
        title: '自动变速器机油 | ZF LifeguardFluid 7.1 MB ATF',
        partNumber: 'LifeguardFluid 7.1 MB ATF', url: 'https://aftermarket.zf.com/zh/catalog/products/AA01.500.001',
        oeGroups: [{ brand: 'ALFA ROMEO', numbers: ['A1', 'A2', 'A3', 'A4'] }]
    }] }] });
    await pending;
    assert.match(element('transmissionResults').innerHTML, /ZF transmission oil · LifeguardFluid 7\.1 MB ATF/);
    assert.match(element('transmissionResults').innerHTML, /Show 1 more OE numbers/);
    assert.match(element('transmissionStatus').textContent, /Complete: 1 of 1 models matched/);

    language = 'zh';
    context.window.refreshTransmissionLanguage();
    assert.match(element('transmissionResults').innerHTML, /自动变速器机油 \| ZF LifeguardFluid 7\.1 MB ATF/);
    assert.match(element('transmissionResults').innerHTML, /展开其余 1 个 OE 号/);
    assert.match(element('transmissionStatus').textContent, /查询完成：1\/1/);

    searchImpl = async () => { const error = new Error('failed'); error.searchError = { messageZh: '目录不可用', messageEn: 'Catalogue unavailable' }; throw error; };
    await submit({ preventDefault() {} });
    assert.equal(element('transmissionStatus').textContent, '查询失败：目录不可用');
    language = 'en';
    context.window.refreshTransmissionLanguage();
    assert.equal(element('transmissionStatus').textContent, 'Search failed: Catalogue unavailable');
});
