const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const sessionId = '12345678-1234-1234-1234-123456789abc';
const url = `/remote-login.html#${sessionId}.${'A'.repeat(43)}`;

test('remote login prompt follows the main page language and uses a sign-in link', () => {
    const created = [];
    const element = tag => {
        const item = {
            tag, textContent: '', open: false, removed: false, style: {},
            append(...children) { this.children = children; },
            remove() { this.removed = true; },
            showModal() { this.open = true; },
            close() { this.open = false; }
        };
        created.push(item);
        return item;
    };
    const document = { documentElement: { lang: 'en' }, createElement: element,
        body: { append() {} } };
    const window = {};
    vm.runInNewContext(readFileSync(join(__dirname, '../public/remote-login-prompt.js'), 'utf8'), { document, window });
    const job = { status: 'running', loginRequired: { sessionId, url,
        messageZh: '请点击登录', messageEn: 'Click Sign in' } };
    window.updateRemoteLoginPrompt(job);
    const link = created.find(item => item.tag === 'a');
    const message = created.find(item => item.tag === 'p');
    assert.equal(link.textContent, 'Sign in');
    assert.equal(message.textContent, 'Click Sign in');
    document.documentElement.lang = 'zh-CN';
    window.refreshRemoteLoginPromptLanguage();
    assert.equal(link.textContent, '点击登录');
    assert.equal(message.textContent, '请点击登录');
    window.updateRemoteLoginPrompt({ ...job, loginResolvedAt: Date.now() });
    assert.equal(created.find(item => item.tag === 'dialog').removed, true);
});

test('remote authorization success remains translated when its page language changes', async () => {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            id, textContent: '', dataset: {}, value: '', hidden: true, attrs: {},
            setAttribute(name, value) { this.attrs[name] = value; },
            removeAttribute(name) { delete this.attrs[name]; },
            addEventListener() {},
            focus() {}
        });
        return elements.get(id);
    }
    const heading = { dataset: { zh: '站点远程授权', en: 'Remote site authorization' }, textContent: '' };
    const storage = { crossReferenceLanguage: 'en' };
    const document = {
        documentElement: { lang: 'zh-CN' }, title: '', getElementById: element,
        querySelectorAll(selector) {
            if (selector === '[data-zh][data-en]') return [heading];
            if (selector === '[data-placeholder-zh][data-placeholder-en]') return [];
            return [];
        }
    };
    element('screen').dataset = { altZh: '远程画面', altEn: 'Remote screen' };
    const context = {
        document, window: { addEventListener() {} },
        location: { hash: url.slice(url.indexOf('#')), pathname: '/remote-login.html' },
        history: { replaceState() {} },
        localStorage: { getItem: key => storage[key], setItem: (key, value) => { storage[key] = value; } },
        fetch: async () => ({ status: 200, ok: true, json: async () => ({ status: 'completed' }) }),
        setTimeout() {}, Date, Math, Promise
    };
    vm.runInNewContext(readFileSync(join(__dirname, '../public/remote-login.js'), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.title, 'Remote site authorization');
    assert.match(element('status').textContent, /Authorization successful/);
    element('languageZh').onclick();
    assert.equal(document.title, '站点远程授权');
    assert.match(element('status').textContent, /授权成功/);
});

test('the search page announces authorization success in its selected language', async () => {
    const html = readFileSync(join(__dirname, '../OE号智能匹配工具 (1).html'), 'utf8');
    const source = html.slice(html.indexOf('    async function runSearchJob('), html.indexOf('    async function startOnlineSearch('));
    for (const language of ['zh', 'en']) {
        const notifications = [];
        const jobs = [
            { jobId: 'job-1', status: 'running', loginRequired: { sessionId, url,
                messageZh: '请点击登录', messageEn: 'Click Sign in' } },
            { jobId: 'job-1', status: 'completed', loginRequired: { sessionId, url },
                loginResolvedAt: 123, results: [] }
        ];
        const context = vm.createContext({
            currentLanguage: language, clientSessionId: 'owner', activeOnlineJobId: '',
            createClientRequestId: () => 'request-1',
            fetch: async () => ({}), readSearchResponse: async () => jobs.shift(),
            recoverSearchJob: async () => null, wait: async () => {},
            uiText: (zh, en) => language === 'en' ? en : zh,
            showNotification: (type, title, message) => {
                notifications.push({ type, title, message });
                return { isConnected: true, querySelectorAll: () => [{ textContent: '' }, { textContent: '' }], remove() {} };
            },
            dismissNotification() {}, window: { updateRemoteLoginPrompt() {} }
        });
        vm.runInContext(`${source}; this.runSearchJob = runSearchJob`, context);
        await context.runSearchJob('/api/search/ngk', ['123'], 'NGK', () => {});
        const success = notifications.find(item => item.type === 'success');
        assert.equal(success.title, language === 'en' ? 'Authorization successful' : '授权成功');
        assert.match(success.message, language === 'en' ? /search is continuing/ : /查询正在继续/);
    }
});

test('the active sign-in notification changes language without restarting the search', async () => {
    const html = readFileSync(join(__dirname, '../OE号智能匹配工具 (1).html'), 'utf8');
    const source = html.slice(html.indexOf('    async function runSearchJob('), html.indexOf('    async function startOnlineSearch('));
    const paragraphs = [{ textContent: '' }, { textContent: '' }];
    let language = 'zh';
    const jobs = [
        { jobId: 'job-2', status: 'running', loginRequired: { sessionId, url,
            messageZh: '请点击登录', messageEn: 'Click Sign in' } },
        { jobId: 'job-2', status: 'completed', loginRequired: { sessionId, url },
            loginResolvedAt: 456, results: [] }
    ];
    const context = vm.createContext({
        currentLanguage: language, clientSessionId: 'owner', activeOnlineJobId: '',
        createClientRequestId: () => 'request-2',
        fetch: async () => ({}), readSearchResponse: async () => jobs.shift(),
        recoverSearchJob: async () => null,
        uiText: (zh, en) => language === 'en' ? en : zh,
        showNotification: () => ({ isConnected: true, querySelectorAll: () => paragraphs, remove() {} }),
        dismissNotification() {}, window: { updateRemoteLoginPrompt() {} },
        wait: async () => {
            language = 'en';
            context.currentLanguage = 'en';
            context.window.activeLoginNotificationRefreshers.forEach(refresh => refresh());
            assert.equal(paragraphs[0].textContent, 'NGK login required');
            assert.equal(paragraphs[1].textContent, 'Click Sign in');
        }
    });
    vm.runInContext(`${source}; this.runSearchJob = runSearchJob`, context);
    await context.runSearchJob('/api/search/ngk', ['123'], 'NGK', () => {});
});
