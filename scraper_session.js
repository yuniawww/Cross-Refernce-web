const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDirectory } = require('./config');
const { getStore } = require('./state_store');
const { seal, unseal } = require('./encrypted_state');

function getScraperSessionPaths(baseDirectory, brand, sessionId) {
    const sessionKey = crypto.createHash('sha256').update(String(sessionId || 'local-default')).digest('hex');
    fs.mkdirSync(tmpDirectory, { recursive: true });
    return {
        profileDirectory: fs.mkdtempSync(path.join(tmpDirectory, `${brand}-`)),
        cookieKey: `cookies:${brand}:${sessionKey}`
    };
}

async function readCookies(key) {
    const store = getStore();
    const value = await store.get(key);
    // Old plaintext cookies must be re-authorized/imported; never keep using them silently.
    if (!value || Array.isArray(value)) return [];
    return unseal(store, key, value);
}
async function writeCookies(key, cookies, store = getStore()) {
    await store.set(key, seal(store, key, cookies));
}
async function saveCookies(page, key) {
    await writeCookies(key, page.browserContext ? await page.browserContext().cookies() : await page.cookies());
}

module.exports = { getScraperSessionPaths, readCookies, saveCookies, writeCookies };
