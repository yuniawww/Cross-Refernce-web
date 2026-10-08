function proxyAddress(value, name) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} must be a valid proxy URL.`); }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) ||
        !url.hostname || url.username || url.password || url.pathname !== '' && url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`${name} must be a proxy URL without embedded credentials, path, query or fragment.`);
    }
    return `${url.protocol}//${url.host}`;
}

function browserProxyArgs(env = process.env) {
    const http = env.HTTP_PROXY || env.http_proxy;
    const https = env.HTTPS_PROXY || env.https_proxy;
    if (!http && !https) return [];
    const mappings = [];
    if (http) mappings.push(`http=${proxyAddress(http, 'HTTP_PROXY')}`);
    if (https) mappings.push(`https=${proxyAddress(https, 'HTTPS_PROXY')}`);
    const args = [`--proxy-server=${mappings.join(';')}`];
    const bypass = (env.NO_PROXY || env.no_proxy || '').split(/[;,]/).map(value => value.trim()).filter(Boolean);
    if (bypass.length) args.push(`--proxy-bypass-list=${bypass.join(';')}`);
    return args;
}

module.exports = { browserProxyArgs };
