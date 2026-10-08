const { createHash } = require('node:crypto');
const { getStore } = require('../state_store');
const { writeCookies } = require('../scraper_session');

async function main() {
    const [brand, sessionId] = process.argv.slice(2);
    if (!['mahle', 'purolator', 'tora', 'ngk', 'torch'].includes(brand) || !sessionId) {
        throw new Error('Usage: npm run import:cookies -- BRAND CLIENT_SESSION_ID < cookies.json');
    }
    let input = '';
    for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 1024 * 1024) throw new Error('Cookie input is too large.');
    }
    const cookies = JSON.parse(input);
    if (!Array.isArray(cookies) || !cookies.every(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string')) {
        throw new Error('Expected an array of Puppeteer cookies.');
    }
    const store = getStore();
    if (store.mode !== 'redis') throw new Error('Cookie import requires Redis.');
    await store.connect();
    try {
        const key = createHash('sha256').update(sessionId).digest('hex');
        await writeCookies(`cookies:${brand}:${key}`, cookies, store);
        console.log('Cookies imported into the session store.');
    } finally { await store.close(); }
}
main().catch(() => { console.error('Cookie import failed. Check arguments, input and Redis configuration.'); process.exitCode = 1; });
