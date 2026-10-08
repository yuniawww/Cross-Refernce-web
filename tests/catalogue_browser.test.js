const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { launchBrowser } = require('../browser');
const { createCataloguePage } = require('../catalogue_page');

test('catalogue pages pass compatible headers on navigation while Chromium stays headless', {
    skip: process.env.CATALOGUE_BROWSER_TEST !== '1', timeout: 30000
}, async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(/HeadlessChrome/.test(req.headers['user-agent']) ? 403 : 200, { 'Content-Type': 'text/html' });
        res.end('<input class="search-box__input" placeholder="Part number">');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let browser;
    try {
        browser = await launchBrowser({ headless: true });
        assert.ok(browser.process().spawnargs.some(arg => arg.startsWith('--headless')));
        const url = `http://127.0.0.1:${server.address().port}/catalogue`;
        const raw = await browser.newPage();
        assert.equal((await raw.goto(url)).status(), 403);
        const page = await createCataloguePage(browser);
        assert.equal((await page.goto(url)).status(), 200);
        assert.equal((await page.goto(`${url}?query=111`)).status(), 200);
        await page.waitForSelector('.search-box__input', { visible: true });
        const userAgent = await page.evaluate(() => navigator.userAgent);
        assert.doesNotMatch(userAgent, /HeadlessChrome/);
        assert.equal(userAgent, (await browser.userAgent()).replace('HeadlessChrome/', 'Chrome/'));
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
});
