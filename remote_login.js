const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { launchBrowser } = require('./browser');
const { seal, unseal } = require('./encrypted_state');
const { writeCookies } = require('./scraper_session');
const { observeLogin, hasLoginDom, isLoginUrl } = require('./login_detection');

const loginContext = new AsyncLocalStorage();
const TTL = 5 * 60 * 1000;
const WIDTH = 1280;
const HEIGHT = 900;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = token => createHash('sha256').update(token).digest();
const failure = (code, message = code) => Object.assign(new Error(message), { code });

function validCommand(command) {
    if (!command || typeof command !== 'object') return false;
    if (['cancel', 'reload', 'back'].includes(command.type)) return true;
    if (command.type === 'text') return typeof command.text === 'string' && command.text.length > 0 && command.text.length <= 1000;
    if (command.type === 'key') return ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(command.key);
    if (command.type === 'scroll') return Number.isFinite(command.deltaY) && Math.abs(command.deltaY) <= 1500;
    return command.type === 'pointer' && ['down', 'move', 'up'].includes(command.action) &&
        Number.isFinite(command.x) && Number.isFinite(command.y) && command.x >= 0 && command.x < WIDTH && command.y >= 0 && command.y < HEIGHT;
}

async function executeCommand(page, command) {
    if (command.type === 'pointer') {
        await page.mouse.move(command.x, command.y);
        if (command.action === 'down') await page.mouse.down();
        if (command.action === 'up') await page.mouse.up();
    } else if (command.type === 'text') await page.keyboard.sendCharacter(command.text);
    else if (command.type === 'key') await page.keyboard.press(command.key);
    else if (command.type === 'scroll') await page.mouse.wheel({ deltaY: command.deltaY });
    else if (command.type === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    else if (command.type === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
}

class RemoteLogin {
    constructor(store, { launch = launchBrowser, timeout = TTL } = {}) {
        Object.assign(this, { store, launch, timeout });
    }
    run(context, task) { return loginContext.run({ ...context, manager: this }, task); }
    publicPrompt(prompt, authorized) {
        if (!prompt) return undefined;
        const { access, ...publicValue } = prompt;
        if (access && authorized) {
            const token = unseal(this.store, `remote-link:${prompt.sessionId}`, access);
            publicValue.url = `/remote-login.html#${prompt.sessionId}.${token}`;
        }
        return publicValue;
    }
    async authenticate(id, token) {
        if (!/^[a-f0-9-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
        const meta = await this.store.get(`login:${id}`);
        if (!meta || !timingSafeEqual(digest(token), Buffer.from(meta.tokenHash, 'hex'))) return null;
        return meta;
    }
    mount(app) {
        app.use('/api/remote-login/:id', async (req, res, next) => {
            res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
            const meta = await this.authenticate(req.params.id, (req.get('Authorization') || '').replace(/^Bearer /, ''));
            if (!meta) return res.status(404).json({ error: '登录入口不存在或已过期。' });
            req.remoteLogin = meta;
            next();
        });
        app.get('/api/remote-login/:id', async (req, res) => {
            const meta = req.remoteLogin;
            let status = meta.status;
            if (status === 'waiting' && (meta.expiresAt < Date.now() || meta.updatedAt < Date.now() - 20000)) status = 'expired';
            if (status === 'waiting') await this.store.set(`seen:${meta.jobId}`, Date.now(), 60 * 60 * 1000);
            const encrypted = status === 'waiting' ? await this.store.get(`login-frame:${req.params.id}`) : null;
            const frame = encrypted ? unseal(this.store, `login-frame:${req.params.id}`, encrypted) : null;
            res.json({ status, brand: meta.brand, expiresAt: meta.expiresAt, width: WIDTH, height: HEIGHT, frame });
        });
        app.post('/api/remote-login/:id/commands', async (req, res) => {
            const meta = req.remoteLogin;
            const origin = req.get('Origin');
            if (origin) {
                try { if (new URL(origin).host !== req.get('Host')) return res.sendStatus(403); }
                catch { return res.sendStatus(403); }
            }
            if (meta.status !== 'waiting' || meta.expiresAt < Date.now() || meta.updatedAt < Date.now() - 20000) return res.sendStatus(410);
            if (!validCommand(req.body)) return res.status(400).json({ error: 'Unsupported browser operation.' });
            const key = `login-commands:${req.params.id}`;
            const accepted = await this.store.enqueue(key, seal(this.store, key, req.body), this.timeout);
            res.sendStatus(accepted ? 202 : 429);
        });
    }
    async authorize(source, options, context) {
        const { brand, entryUrl, cookieKey, isAuthenticated } = options;
        const { signal, jobId, onLoginRequired, onLoginResolved } = context;
        if (signal?.aborted || source.isClosed()) throw failure('JOB_ABORTED');
        const id = randomUUID();
        const token = randomBytes(32).toString('base64url');
        const metaKey = `login:${id}`;
        const frameKey = `login-frame:${id}`;
        const queueKey = `login-commands:${id}`;
        const expiresAt = Date.now() + this.timeout;
        const meta = { tokenHash: digest(token).toString('hex'), jobId, brand, expiresAt, updatedAt: Date.now(), status: 'waiting' };
        let browser;
        let page;
        let aborted = false;
        let timedOut = false;
        let heartbeatWrite;
        let heartbeat;
        const abort = () => { aborted = true; void browser?.close().catch(() => {}); };
        const deadline = setTimeout(() => { timedOut = true; abort(); }, this.timeout);
        signal?.addEventListener('abort', abort, { once: true });
        source.once('close', abort);
        try {
            // CDP stays on loopback with an ephemeral port. CF only exposes the app's HTTPS route.
            // Puppeteer skips its port flag when ANY --remote-debugging-* argument exists.
            browser = await this.launch({ headless: true, debuggingPort: 0,
                args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
            if (aborted) throw failure('JOB_ABORTED');
            const firstPage = await browser.newPage();
            const cookies = await source.browserContext().cookies();
            if (cookies.length) await browser.defaultBrowserContext().setCookie(...cookies);
            page = firstPage;
            await page.setViewport({ width: WIDTH, height: HEIGHT });
            await this.store.set(metaKey, meta, this.timeout + 60000);
            heartbeat = setInterval(() => {
                if (heartbeatWrite) return;
                meta.updatedAt = Date.now();
                heartbeatWrite = this.store.set(metaKey, { ...meta }, this.timeout + 60000)
                    .catch(abort).finally(() => { heartbeatWrite = null; });
            }, 3000);
            await onLoginRequired?.({ sessionId: id, expiresAt, access: seal(this.store, `remote-link:${id}`, token) });
            // Keep a same-origin login/query route (including SPA hash state). For an
            // external OAuth callback, restart at the entry to obtain fresh CSRF tokens.
            const currentUrl = source.url();
            const loginUrl = new URL(currentUrl).origin === new URL(entryUrl).origin ? currentUrl : entryUrl;
            await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            let lastFrame = 0;
            let authenticatedSamples = 0;
            while (Date.now() < expiresAt) {
                if (aborted || signal?.aborted) throw failure('JOB_ABORTED');
                const pages = (await browser.pages()).filter(item => !item.isClosed() && item.url() !== 'about:blank');
                const active = pages.at(-1) || firstPage;
                if (page !== active) {
                    page = active;
                    authenticatedSamples = 0;
                    await page.setViewport({ width: WIDTH, height: HEIGHT });
                }
                for (let count = 0; count < 20; count++) {
                    const encrypted = await this.store.dequeue(queueKey);
                    if (!encrypted) break;
                    const command = unseal(this.store, queueKey, encrypted);
                    if (command.type === 'cancel') throw failure('LOGIN_CANCELLED', '用户取消了远程登录。');
                    await executeCommand(page, command).catch(error => {
                        // Navigations can replace an input target between two human operations.
                        if (!page.isClosed() && !/context.*destroyed|Cannot find context|detached frame|Navigation timeout/i.test(error.message)) throw error;
                    });
                    if (page.isClosed()) break;
                }
                if (page.isClosed()) continue;
                if (Date.now() - lastFrame >= 800) {
                    meta.updatedAt = Date.now();
                    await this.store.set(metaKey, meta, this.timeout + 60000);
                    const inBusinessOrigin = new URL(page.url()).origin === new URL(entryUrl).origin;
                    const ready = inBusinessOrigin && !isLoginUrl(page.url()) &&
                        await isAuthenticated(page) && !await hasLoginDom(page);
                    authenticatedSamples = ready ? authenticatedSamples + 1 : 0;
                    if (authenticatedSamples >= 3) {
                        const freshCookies = await browser.defaultBrowserContext().cookies();
                        const storage = await page.evaluate(() => ({ origin: location.origin,
                            local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
                        // Preserve same-origin tokens used by SPAs as well as HttpOnly cookies.
                        const oldCookies = await source.browserContext().cookies();
                        if (oldCookies.length) await source.browserContext().deleteCookie(...oldCookies);
                        await source.browserContext().setCookie(...freshCookies);
                        const script = await source.evaluateOnNewDocument(value => {
                            if (location.origin !== value.origin) return;
                            localStorage.clear();
                            sessionStorage.clear();
                            for (const [key, item] of value.local) localStorage.setItem(key, item);
                            for (const [key, item] of value.session) sessionStorage.setItem(key, item);
                        }, storage);
                        try { await source.goto(entryUrl, { waitUntil: 'networkidle2', timeout: 45000 }); }
                        finally { await source.removeScriptToEvaluateOnNewDocument(script.identifier); }
                        if (timedOut) throw failure('LOGIN_TIMEOUT');
                        if (aborted || signal?.aborted) throw failure('JOB_ABORTED');
                        if (!await isAuthenticated(source) || await hasLoginDom(source)) throw failure('LOGIN_TRANSFER_FAILED', '登录状态未能恢复，请重新授权。');
                        await writeCookies(cookieKey, freshCookies, this.store);
                        meta.status = 'completed';
                        break;
                    }
                    const image = await page.screenshot({ type: 'jpeg', quality: 85, encoding: 'base64' });
                    await this.store.set(frameKey, seal(this.store, frameKey, { image, origin: new URL(page.url()).origin }), 15000);
                    lastFrame = Date.now();
                }
                await pause(100);
            }
            if (meta.status !== 'completed') throw failure('LOGIN_TIMEOUT', '远程登录等待超时，请重新查询。');
        } catch (error) {
            if (timedOut) error = failure('LOGIN_TIMEOUT', '远程登录等待超时，请重新查询。');
            else if (aborted) error = failure('JOB_ABORTED');
            meta.status = error.code === 'LOGIN_TIMEOUT' ? 'expired' : aborted || error.code === 'LOGIN_CANCELLED' ? 'cancelled' : 'failed';
            throw error;
        } finally {
            clearTimeout(deadline);
            clearInterval(heartbeat);
            await heartbeatWrite;
            signal?.removeEventListener('abort', abort);
            source.off('close', abort);
            await browser?.close().catch(() => {});
            await Promise.all([this.store.delete(frameKey), this.store.delete(queueKey), this.store.set(metaKey, meta, 60000)]);
        }
        await onLoginResolved?.();
    }
}

function attachRemoteLogin(page, options) {
    const context = loginContext.getStore();
    if (!context) return;
    const observer = observeLogin(page, options.entryUrl);
    let authorizing;
    page.once('close', () => observer.dispose());
    page.__remoteLogin = {
        intercepted: () => observer.blocked(),
        async authorize() {
            await (authorizing ||= context.manager.authorize(page, options, context).finally(() => { authorizing = null; }));
            observer.reset();
            if (page.__loginQuery) throw failure('LOGIN_RETRY');
        },
        async checkpoint() {
            if (await observer.blocked()) await this.authorize();
        }
    };
}

async function withLoginRetry(page, task) {
    page.__loginQuery = true;
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await page.__remoteLogin?.checkpoint();
                const result = await task();
                await page.__remoteLogin?.checkpoint();
                return result;
            } catch (error) {
                if (error.code !== 'LOGIN_RETRY' && !error.code?.startsWith('LOGIN_') && await page.__remoteLogin?.intercepted()) {
                    try { await page.__remoteLogin.authorize(); }
                    catch (loginError) { error = loginError; }
                }
                if (error.code !== 'LOGIN_RETRY') throw error;
                if (attempt === 2) throw failure('LOGIN_REQUIRED', '站点重复要求授权，请稍后重新查询。');
            }
        }
    } finally { page.__loginQuery = false; }
}

module.exports = { RemoteLogin, attachRemoteLogin, withLoginRetry, validCommand, executeCommand };
