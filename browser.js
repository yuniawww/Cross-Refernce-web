const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { tmpDirectory, headless } = require('./config');
const { browserProxyArgs } = require('./browser_proxy');

function browserOptions(options = {}) {
    const { args = [], ...rest } = options;
    const hasExplicitProxy = args.some(arg => /^--(?:proxy-server=|proxy-pac-url=|no-proxy-server(?:$|=)|proxy-auto-detect(?:$|=))/.test(arg));
    fs.mkdirSync(tmpDirectory, { recursive: true });
    return {
        ...rest,
        headless: process.env.VCAP_APPLICATION ? true : (options.headless ?? headless),
        ...(process.env.PUPPETEER_EXECUTABLE_PATH
            ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
        env: { ...process.env, TMPDIR: tmpDirectory, TMP: tmpDirectory, TEMP: tmpDirectory },
        args: [...new Set([
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--no-first-run', '--no-default-browser-check',
            ...(hasExplicitProxy ? [] : browserProxyArgs()), ...args
        ])]
    };
}

async function launchBrowser(options = {}) {
    // Each launch has its own disposable profile; persisted cookies live in the state store.
    const resolved = browserOptions(options);
    const profile = resolved.userDataDir || fs.mkdtempSync(path.join(tmpDirectory, 'browser-'));
    try {
        const browser = await puppeteer.launch({ ...resolved, userDataDir: profile });
        const cleanup = () => fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        const close = browser.close.bind(browser);
        let closing;
        browser.close = () => closing ||= close().finally(cleanup);
        // Disconnect fires before Chromium finishes flushing its profile. Clean after exit.
        browser.process()?.once('exit', () => { if (!closing) void cleanup().catch(() => {}); });
        return browser;
    } catch (error) {
        fs.rmSync(profile, { recursive: true, force: true });
        throw error;
    }
}

function requireInteractiveLogin(callback, page) {
    if (page?.__remoteLogin) return page.__remoteLogin.authorize();
    if (headless) {
        const error = new Error('A valid login session is required before running this site headlessly.');
        error.code = 'LOGIN_REQUIRED';
        throw error;
    }
    callback?.();
}

module.exports = { browserOptions, launchBrowser, requireInteractiveLogin };
