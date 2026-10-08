const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

test('brake pad results follow the current input and preserve other catalogues for the same input', async () => {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            value: '', innerHTML: '', textContent: '', dataset: {}, listeners: {},
            classList: { toggle() {}, add() {} },
            setAttribute() {}, focus() {},
            addEventListener(type, listener) { this.listeners[type] = listener; },
            querySelectorAll() { return []; }
        });
        return elements.get(id);
    }
    const buttons = ['au', 'my', 'zf'].map(region => ({ dataset: { brakePadsSource: region }, setAttribute() {} }));
    element('brakePadsSearchForm').querySelectorAll = () => buttons;
    const responses = [];
    const context = {
        document: { getElementById: element }, window: {},
        uiText: zh => zh, escapeHtml: value => String(value),
        setLocalizedText: (id, zh) => { element(id).textContent = zh; },
        runSearchJob: async (url, numbers) => {
            responses.push({ url, numbers });
            return { results: numbers.map(oe => ({ oe, products: [{ partNumber: `Product ${oe}` }] })) };
        }
    };
    vm.runInNewContext(readFileSync(join(__dirname, '../public/brake-pads.js'), 'utf8'), context);
    const input = element('brakePadsInput');
    const output = element('brakePadsResults');
    const submit = region => element('brakePadsSearchForm').listeners.submit({
        preventDefault() {}, submitter: { dataset: { brakePadsSource: region } }
    });

    input.value = '11111';
    input.listeners.input();
    await submit('au');
    assert.match(output.innerHTML, /11111/);

    input.value = '22222';
    input.listeners.input();
    assert.equal(output.innerHTML, '');
    await submit('my');
    assert.match(output.innerHTML, /22222/);
    assert.doesNotMatch(output.innerHTML, /11111|Bendix Australia/);

    await submit('zf');
    assert.match(output.innerHTML, /Bendix Malaysia/);
    assert.match(output.innerHTML, /ZF China/);
    assert.deepEqual(responses.map(response => response.numbers[0]), ['11111', '22222', '22222']);
});
