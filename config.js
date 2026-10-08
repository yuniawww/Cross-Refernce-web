const path = require('node:path');

function getPort(env = process.env) {
    if (!/^\d+$/.test(env.PORT || '')) throw new Error('PORT must be set to a port between 1 and 65535.');
    const port = Number(env.PORT);
    if (port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    return port;
}

function getRedisOptions(env = process.env) {
    if (env.REDIS_URL) return { url: env.REDIS_URL };
    let services;
    try { services = JSON.parse(env.VCAP_SERVICES || '{}'); }
    catch { throw new Error('VCAP_SERVICES must be valid JSON.'); }
    const bindings = Object.entries(services).flatMap(([label, entries]) =>
        entries.map(service => ({ ...service, label })));
    const candidates = bindings.filter(service => env.REDIS_SERVICE_NAME
        ? service.name === env.REDIS_SERVICE_NAME
        : /redis/i.test([service.label, service.name, ...(service.tags || [])].join(' ')));
    if (candidates.length > 1) throw new Error('Set REDIS_SERVICE_NAME to select one Redis binding.');
    if (!candidates.length) {
        if (env.REDIS_SERVICE_NAME) throw new Error('The configured Redis service binding was not found.');
        return null;
    }
    const c = candidates[0].credentials || {};
    const url = c.uri || c.url;
    if (url) return { url };
    if (!c.hostname && !c.host) throw new Error('Redis binding has no host or URI. Set REDIS_URL.');
    return {
        username: c.username || undefined,
        password: c.password || undefined,
        socket: { host: c.hostname || c.host, port: Number(c.port || 6379),
            ...(c.tls === true || c.tls === 'true' ? { tls: true } : {}) }
    };
}

function siteUrl(name, fallback) {
    const value = process.env[name] || fallback;
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must be an HTTP(S) URL without credentials.`);
    }
    return value;
}

const tmpDirectory = path.join(__dirname, 'tmp');
function getHeadlessMode(env = process.env) {
    if (env.VCAP_APPLICATION) return true;
    if (env.BROWSER_HEADLESS !== undefined && env.BROWSER_HEADLESS !== '') {
        if (!['true', 'false'].includes(env.BROWSER_HEADLESS)) throw new Error('BROWSER_HEADLESS must be true or false.');
        return env.BROWSER_HEADLESS === 'true';
    }
    return true;
}
const headless = getHeadlessMode();
module.exports = { getPort, getRedisOptions, siteUrl, tmpDirectory, headless, getHeadlessMode };
