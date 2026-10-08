const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getHeadlessMode } = require('../config');
const { browserOptions } = require('../browser');
const { navigateToCatalogue } = require('../site_navigation');
const { waitForProductOutcome } = require('../scraper_results');
const { catalogueUserAgent } = require('../catalogue_page');

test('catalogue User-Agent keeps the installed version and OS without the headless product token', () => {
    const actual = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/148.0.0.0 Safari/537.36';
    assert.equal(catalogueUserAgent(actual), 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36');
    const desktop = 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36';
    assert.equal(catalogueUserAgent(desktop), desktop);
});

test('all platforms default to headless and CF cannot opt into a visible browser', () => {
    assert.equal(getHeadlessMode({}, 'darwin'), true);
    assert.equal(getHeadlessMode({}, 'win32'), true);
    assert.equal(getHeadlessMode({}, 'linux'), true);
    assert.equal(getHeadlessMode({ NODE_ENV: 'production' }, 'darwin'), true);
    assert.equal(getHeadlessMode({ BROWSER_HEADLESS: 'true' }, 'darwin'), true);
    assert.equal(getHeadlessMode({ BROWSER_HEADLESS: 'false' }, 'darwin'), false);
    assert.equal(getHeadlessMode({ VCAP_APPLICATION: '{}', BROWSER_HEADLESS: 'false' }, 'linux'), true);
    assert.throws(() => getHeadlessMode({ BROWSER_HEADLESS: 'invalid' }, 'darwin'));
    assert.equal(browserOptions({ headless: true }).headless, true);
});

test('HTTP access restrictions and upstream failures are reported before waiting for catalogue controls', async () => {
    for (const [status, code] of [[403, 'SITE_ACCESS_DENIED'], [429, 'SITE_RATE_LIMITED'], [502, 'SITE_UNAVAILABLE'], [404, 'SITE_HTTP_ERROR']]) {
        const page = { goto: async () => ({ status: () => status }) };
        await assert.rejects(navigateToCatalogue(page, 'https://example.invalid/catalogue', 'Test'), { code, httpStatus: status });
    }
    const response = { status: () => 200 };
    assert.equal(await navigateToCatalogue({ goto: async () => response }, 'https://example.invalid/catalogue', 'Test'), response);
});

function resultPage(window, hasProducts = true, emptyText = '') {
    const element = text => ({ textContent: text, innerText: text, getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 100, height: 20 }) });
    const context = vm.createContext({ window, document: {
        querySelectorAll: selector => selector === '.product'
            ? (hasProducts ? [element('WK 712/2')] : []) : (emptyText ? [element(emptyText)] : [])
    } });
    window.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
    const frame = { evaluate: async (fn, ...args) => {
        context.args = args;
        return vm.runInContext(`(${fn.toString()})(...args)`, context);
    } };
    return { frames: () => [frame] };
}

test('MANN accepts results after navigation destroys the previous document observer', async () => {
    const page = resultPage({});
    assert.equal(await waitForProductOutcome(page, 'mann', '.product', 100, undefined, null, 'old-document'), 'products');
});

test('MANN rejects stale products and stale empty messages on the same document', async () => {
    const window = { __mannSearchDocumentId: 'same-document', __mannResultChanged: false };
    for (const page of [resultPage(window), resultPage(window, false, '对不起，没有找到结果')]) {
        assert.equal(await waitForProductOutcome(page, 'mann', '.product', 1, undefined, null, 'same-document'), 'timeout');
    }
});

test('MANN recognizes an explicit empty result after navigation', async () => {
    assert.equal(await waitForProductOutcome(resultPage({}, false, '对不起，没有找到结果'), 'mann', '.product', 100, undefined, null, 'old-document'), 'empty');
});
