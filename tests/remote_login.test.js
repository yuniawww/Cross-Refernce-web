const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { MemoryStore } = require('../state_store');
const { seal, unseal, encryptionKey } = require('../encrypted_state');
const { isLoginUrl, isUnauthenticated, observeLogin } = require('../login_detection');
const { RemoteLogin, attachRemoteLogin, withLoginRetry, validCommand, executeCommand } = require('../remote_login');
const { SearchJobs } = require('../search_jobs');

test('encrypted cookies and login data are bound to their user/session key and detect tampering', () => {
    const store = new MemoryStore();
    const original = [{ name: 'session', value: 'private-cookie' }];
    const encrypted = seal(store, 'cookies:ngk:user-a', original);
    assert.doesNotMatch(JSON.stringify(encrypted), /private-cookie/);
    assert.deepEqual(unseal(store, 'cookies:ngk:user-a', encrypted), original);
    assert.throws(() => unseal(store, 'cookies:ngk:user-b', encrypted));
    assert.throws(() => unseal(store, 'cookies:ngk:user-a', { ...encrypted, tag: randomBytes(16).toString('base64') }));
    assert.throws(() => encryptionKey({ mode: 'redis' }, {}), /COOKIE_ENCRYPTION_KEY/);
    assert.throws(() => encryptionKey(store, { COOKIE_ENCRYPTION_KEY: 'weak' }), /32 random bytes/);
    assert.equal(encryptionKey({ mode: 'redis' }, { COOKIE_ENCRYPTION_KEY: randomBytes(32).toString('base64') }).length, 32);
});

test('login detection covers URL, 401, business errors and ignores unrelated failures', async () => {
    for (const path of ['/login', '/auth', '/qrcode', '/wechat', '/OAuth2/authorize']) assert.ok(isLoginUrl('https://example.com' + path));
    assert.equal(isLoginUrl('https://example.com/catalog?returnUrl=/login'), false);
    assert.equal(isUnauthenticated({ code: 'NOT_LOGIN' }), true);
    assert.equal(isUnauthenticated({ code: 401 }), true);
    assert.equal(isUnauthenticated({ msg: '请先登录' }), true);
    assert.equal(isUnauthenticated({ code: 200, data: { products: [] } }), false);
    const page = Object.assign(new EventEmitter(), { url: () => 'https://catalog.example.com/', frames: () => [] });
    const observer = observeLogin(page, page.url());
    const response = (origin, status, body) => ({ url: () => origin, status: () => status,
        request: () => ({ resourceType: () => 'xhr' }), headers: () => ({ 'content-type': 'application/json' }), json: async () => body });
    page.emit('response', response('https://analytics.example.com/event', 401, {}));
    assert.equal(await observer.blocked(), false);
    page.emit('response', response(page.url(), 401, {}));
    assert.equal(await observer.blocked(), true);
    observer.reset();
    page.emit('response', response(page.url(), 200, { code: 'SESSION_EXPIRED' }));
    assert.equal(await observer.blocked(), true);
    observer.dispose();
    assert.equal(page.listenerCount('response'), 0);
});

test('input relay rejects arbitrary CDP/navigation and bounds its FIFO queue', async () => {
    for (const invalid of [{ type: 'evaluate', code: '1+1' }, { type: 'goto', url: 'file:///etc/passwd' },
        { type: 'pointer', action: 'down', x: 9000, y: 10 }, { type: 'text', text: 'a'.repeat(1001) }, { type: 'key', key: 'F12' }]) {
        assert.equal(validCommand(invalid), false);
    }
    assert.equal(validCommand({ type: 'pointer', action: 'move', x: 100, y: 150 }), true);
    const store = new MemoryStore();
    assert.deepEqual(await Promise.all([1, 2, 3].map(value => store.enqueue('queue', value, 1000, 2))), [true, true, false]);
    assert.equal(await store.dequeue('queue'), 1);
    assert.equal(await store.dequeue('queue'), 2);
    assert.equal(await store.dequeue('queue'), null);
});

test('remote text input uses the installed Puppeteer keyboard and reaches CDP without losing Unicode', async () => {
    const { CdpKeyboard } = require('puppeteer-core/lib/cjs/puppeteer/cdp/Input.js');
    const requests = [];
    const keyboard = new CdpKeyboard({ send: async (method, payload) => { requests.push({ method, payload }); } });
    await executeCommand({ keyboard }, { type: 'text', text: '654321验证码' });
    assert.deepEqual(requests, [{ method: 'Input.insertText', payload: { text: '654321验证码' } }]);
});

test('job prompts can reappear after an earlier authorization and never expose their encrypted capability by default', async () => {
    const store = new MemoryStore();
    const manager = new RemoteLogin(store);
    const jobs = new SearchJobs(store, { remoteLogin: manager, brandLabels: {}, classifyError: error => ({ code: error.code }),
        cancellationError: () => ({}), saveHistory: async () => {} });
    await jobs.start();
    try {
        const job = await jobs.submit({ clientSessionId: 'owner', clientRequestId: 'one', brand: 'ngk', oeList: ['1'] }, async (_, hooks) => {
            await hooks.onLoginRequired({ sessionId: 'first' });
            hooks.onLoginResolved();
            await hooks.onLoginRequired({ sessionId: 'second' });
            return [];
        });
        await jobs.running.get(job.jobId).promise;
        const result = await jobs.get(job.jobId);
        assert.equal(result.loginRequired.sessionId, 'second');
        assert.equal(result.loginResolvedAt, null);
        const prompt = { sessionId: 'test', access: seal(store, 'remote-link:test', 'secret') };
        assert.deepEqual(manager.publicPrompt(prompt, false), { sessionId: 'test' });
        assert.equal(manager.publicPrompt(prompt, true).url, '/remote-login.html#test.secret');
    } finally { await jobs.close(); }
});

test('authorization success is published while the search is still running', async () => {
    const store = new MemoryStore();
    const jobs = new SearchJobs(store, { remoteLogin: null, brandLabels: {}, classifyError: error => ({ code: error.code }),
        cancellationError: () => ({}), saveHistory: async () => {} });
    let continueSearch;
    const waiting = new Promise(resolve => { continueSearch = resolve; });
    await jobs.start();
    try {
        const job = await jobs.submit({ clientSessionId: 'owner', clientRequestId: 'auth-publish', brand: 'ngk', oeList: ['1'] }, async (_, hooks) => {
            await hooks.onLoginRequired({ sessionId: 'session' });
            await hooks.onLoginResolved();
            await waiting;
            return [];
        });
        for (let attempt = 0; attempt < 20 && !(await jobs.get(job.jobId)).loginResolvedAt; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const published = await jobs.get(job.jobId);
        assert.equal(published.status, 'running');
        assert.ok(published.loginResolvedAt);
        assert.match(published.loginRequired.messageEn, /Click Sign in/);
        continueSearch();
        await jobs.running.get(job.jobId).promise;
    } finally {
        continueSearch();
        await jobs.close();
    }
});

test('cancel, timeout and abort during browser launch all close the login browser and remove transient state', async () => {
    for (const scenario of ['cancel', 'timeout', 'abort-launch']) {
        const store = new MemoryStore();
        const controller = new AbortController();
        let closed = 0;
        let prompt;
        const source = Object.assign(new EventEmitter(), {
            isClosed: () => false, url: () => 'https://example.com/login', browserContext: () => ({ cookies: async () => [] })
        });
        const page = Object.assign(new EventEmitter(), {
            isClosed: () => false, url: () => 'https://example.com/login', setViewport: async () => {},
            goto: async () => {}, screenshot: async () => 'fixture-image', frames: () => []
        });
        const browser = { newPage: async () => page, pages: async () => [page],
            defaultBrowserContext: () => ({ setCookie: async () => {} }), close: async () => { closed++; } };
        const manager = new RemoteLogin(store, { timeout: scenario === 'timeout' ? 30 : 5000,
            launch: async () => {
                if (scenario === 'abort-launch') controller.abort();
                return browser;
            } });
        await assert.rejects(manager.authorize(source, { brand: 'ngk', entryUrl: 'https://example.com/',
            cookieKey: 'cookies:test', isAuthenticated: async () => false }, {
            signal: controller.signal, jobId: 'job', onLoginRequired: async value => {
                prompt = value;
                if (scenario === 'cancel') {
                    const key = `login-commands:${value.sessionId}`;
                    await store.enqueue(key, seal(store, key, { type: 'cancel' }), 1000);
                }
            }
        }), { code: { cancel: 'LOGIN_CANCELLED', timeout: 'LOGIN_TIMEOUT', 'abort-launch': 'JOB_ABORTED' }[scenario] });
        assert.ok(closed > 0, scenario);
        if (prompt) {
            assert.equal(await store.get(`login-frame:${prompt.sessionId}`), null);
            assert.equal(await store.get(`login-commands:${prompt.sessionId}`), null);
            assert.equal((await store.get(`login:${prompt.sessionId}`)).status, scenario === 'timeout' ? 'expired' : 'cancelled');
        }
        assert.equal(source.listenerCount('close'), 0);
    }
});

test('headless remote login relays across app instances, transfers cookies, resumes current query and destroys the temporary browser', {
    skip: process.env.REMOTE_LOGIN_BROWSER_TEST !== '1', timeout: 60000
}, async (t) => {
    const express = require('express');
    const path = require('node:path');
    const fs = require('node:fs');
    const { launchBrowser } = require('../browser');
    const store = new MemoryStore();
    const browsers = [];
    const profiles = [];
    const commands = [];
    const enqueue = store.enqueue.bind(store);
    store.enqueue = (key, value, ttl) => {
        const command = unseal(store, key, value);
        commands.push(command.type === 'text' ? { type: command.type, length: command.text.length } : command);
        return enqueue(key, value, ttl);
    };
    let validSession = 'old';
    let calls = 0;
    const sourceApp = express();
    sourceApp.get('/', (req, res) => {
        if ((req.headers.cookie || '').includes(`session=${validSession}`)) return res.send('<h1 id="business">Catalogue</h1>');
        res.send(`<canvas id="qrcode" width="100" height="60"></canvas><form action="/verify">
            <input name="code" autocomplete="one-time-code" style="position:absolute;left:20px;top:90px;width:200px;height:30px">
            <button style="position:absolute;left:20px;top:140px;width:200px;height:40px">Sign in</button></form>`);
    });
    sourceApp.get('/verify', (req, res) => {
        t.diagnostic(`Fixture verification accepted: ${req.query.code === '654321'}`);
        if (req.query.code !== '654321') return res.sendStatus(401);
        validSession = 'new-private-cookie';
        res.cookie('session', validSession, { httpOnly: true });
        res.redirect('/');
    });
    sourceApp.get('/query', (req, res) => {
        calls++;
        if (calls === 1) { validSession = 'expired'; return res.status(401).json({ code: 'NOT_LOGIN' }); }
        res.json({ result: 'OE-111' });
    });
    const sourceServer = sourceApp.listen(0, '127.0.0.1');
    await once(sourceServer, 'listening');
    const sourceUrl = `http://127.0.0.1:${sourceServer.address().port}/`;
    const manager = new RemoteLogin(store, { timeout: 20000, launch: async options => {
        t.diagnostic('Launching temporary login browser');
        assert.equal(options.headless, true);
        assert.equal(options.debuggingPort, 0);
        const browser = await launchBrowser(options);
        t.diagnostic('Temporary login browser launched');
        browsers.push(browser);
        profiles.push(browser.process().spawnargs.find(arg => arg.startsWith('--user-data-dir=')).slice(16));
        return browser;
    } });
    // HTTP requests land on another app instance; only the shared store connects it to the owner.
    const proxy = new RemoteLogin(store);
    const portal = express();
    portal.use(express.json());
    proxy.mount(portal);
    portal.use(express.static(path.join(__dirname, '..', 'public')));
    const portalServer = portal.listen(0, '127.0.0.1');
    await once(portalServer, 'listening');
    const portalUrl = `http://127.0.0.1:${portalServer.address().port}`;
    const sourceBrowser = await launchBrowser({ headless: true });
    const controller = new AbortController();
    t.signal.addEventListener('abort', () => controller.abort(), { once: true });
    let running;
    try {
        const source = await sourceBrowser.newPage();
        t.diagnostic('Query browser page created');
        await source.setCookie({ name: 'session', value: 'old', url: sourceUrl });
        let prompt;
        const context = { signal: controller.signal, jobId: 'job-fixture', onLoginRequired: details => { prompt = details; }, onLoginResolved: () => {} };
        running = manager.run(context, async () => {
            attachRemoteLogin(source, { brand: 'ngk', entryUrl: sourceUrl, cookieKey: 'cookies:ngk:fixture',
                isAuthenticated: page => page.$('#business').then(Boolean) });
            await source.goto(sourceUrl);
            t.diagnostic('Query page loaded');
            const result = await withLoginRetry(source, () => source.evaluate(async () => (await fetch('/query')).json()));
            return ['already-completed', result.result];
        });
        let settled;
        const resultPromise = running.then(result => (settled = { result }), error => (settled = { error }));
        for (let i = 0; !prompt; i++) {
            if (settled?.error) throw settled.error;
            assert.equal(settled, undefined, 'query must pause for authorization');
            assert.ok(i < 300, 'login prompt was published');
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        const publicPrompt = proxy.publicPrompt(prompt, true);
        const token = publicPrompt.url.split('.html#')[1].split('.')[1];
        const endpoint = `${portalUrl}/api/remote-login/${prompt.sessionId}`;
        assert.equal((await fetch(endpoint)).status, 404);
        assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${'A'.repeat(43)}` } })).status, 404);
        assert.equal((await fetch(`${endpoint}/commands`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'evaluate', code: 'process.env' }) })).status, 400);
        const viewer = await sourceBrowser.newPage();
        await viewer.goto(portalUrl + publicPrompt.url);
        await viewer.waitForSelector('#screen:not([hidden])', { timeout: 15000 });
        await viewer.waitForFunction(() => { const image = document.getElementById('screen'); return image.complete && image.naturalWidth > 0; });
        t.diagnostic('Remote login frame displayed');
        assert.ok((await store.get('seen:job-fixture')) > 0);
        const encryptedFrame = await store.get(`login-frame:${prompt.sessionId}`);
        assert.ok(encryptedFrame.data);
        assert.equal(encryptedFrame.image, undefined);
        // Use the actual remote UI to focus the verification field and send a code.
        await viewer.$eval('#screen', element => element.scrollIntoView());
        const bounds = await viewer.$eval('#screen', element => {
            const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        await viewer.mouse.click(bounds.x + 100 * bounds.width / 1280, bounds.y + 105 * bounds.height / 900);
        await viewer.type('#input', '654321');
        await viewer.click('#input-form button');
        const remotePage = (await browsers[0].pages()).at(-1);
        await remotePage.waitForFunction(() => document.querySelector('input[name="code"]')?.value === '654321', { timeout: 5000 }).catch(error => {
            t.diagnostic(JSON.stringify(commands));
            throw error;
        });
        await viewer.click('#enter');
        t.diagnostic('Verification controls submitted');
        const outcome = await resultPromise;
        if (outcome.error) {
            t.diagnostic(await viewer.$eval('#status', element => element.textContent));
            throw outcome.error;
        }
        assert.deepEqual(outcome.result, ['already-completed', 'OE-111']);
        assert.equal(calls, 2);
        assert.equal(browsers[0].connected, false);
        assert.equal(fs.existsSync(profiles[0]), false);
        assert.equal(await store.get(`login-frame:${prompt.sessionId}`), null);
        assert.equal(await store.get(`login-commands:${prompt.sessionId}`), null);
        assert.equal((await store.get(`login:${prompt.sessionId}`)).status, 'completed');
        const encrypted = await store.get('cookies:ngk:fixture');
        assert.doesNotMatch(JSON.stringify(encrypted), /new-private-cookie/);
        assert.equal(unseal(store, 'cookies:ngk:fixture', encrypted).find(cookie => cookie.name === 'session').value, 'new-private-cookie');
        await viewer.waitForFunction(() => document.getElementById('status').textContent.includes('授权成功'));
        assert.equal((await fetch(`${endpoint}/commands`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'reload' }) })).status, 410);
    } finally {
        controller.abort();
        await sourceBrowser.close();
        await Promise.all(browsers.map(browser => browser.close()));
        await running?.catch(() => {});
        await Promise.all([new Promise(resolve => sourceServer.close(resolve)), new Promise(resolve => portalServer.close(resolve))]);
    }
});
