const LOGIN_URL = /login|(?:^|[/_.-])auth|oauth|qrcode|wechat|weixin/i;
function isLoginUrl(value) {
    try { const url = new URL(value); return LOGIN_URL.test(url.hostname + url.pathname) || /^(login|auth|qrcode|wechat)$/i.test(url.searchParams.get('action') || ''); }
    catch { return false; }
}
function isUnauthenticated(body) {
    if (!body || typeof body !== 'object') return false;
    const codes = [body.code, body.status, body.errorCode, body.error?.code, body.data?.code];
    const messages = [body.message, body.msg, body.error?.message, body.data?.message];
    return codes.some(code => /^(401|unauthorized|unauthenticated|not[_-]?login|login[_-]?(required|expired)|session[_-]?expired)$/i.test(String(code))) ||
        messages.some(message => typeof message === 'string' && /未登录|尚未登录|请先登录|登录已过期|登录失效|not logged in|login required|session expired/i.test(message));
}
async function hasLoginDom(page) {
    for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) {
            const element = await frame.frameElement().catch(() => null);
            if (!element) continue;
            const visible = await element.isVisible().catch(() => false);
            await element.dispose();
            if (!visible) continue;
        }
        if (await frame.evaluate(() => {
            const visible = el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const selectors = 'input[type="password"], input[autocomplete="one-time-code"], input[name*="captcha" i], input[id*="captcha" i], input[name*="verifyCode" i], input[name*="smsCode" i], img[src*="qrcode" i], img[id*="qrcode" i], canvas[id*="qr" i], [class*="qrcode" i], [id*="qrcode" i], iframe[src*="wechat" i], iframe[src*="weixin" i]';
            return [...document.querySelectorAll(selectors)].some(visible) ||
                [...document.querySelectorAll('p, label, h1, h2, h3')].some(el => visible(el) && /^(微信验证|微信扫码登录|扫码登录|短信验证码)$/.test(el.textContent.trim()));
        }).catch(() => false)) return true;
    }
    return false;
}

function observeLogin(page, entryUrl) {
    let apiBlocked = false;
    let generation = 0;
    const pending = new Set();
    const origin = new URL(entryUrl).origin;
    const listener = response => {
        const observedGeneration = generation;
        const work = (async () => {
            // Third-party analytics failures must not invalidate the catalogue session.
            if (new URL(response.url()).origin !== origin) return;
            if (!['document', 'xhr', 'fetch'].includes(response.request().resourceType())) return;
            let blocked = response.status() === 401;
            if (!blocked && /json/i.test(response.headers()['content-type'] || '')) {
                const length = Number(response.headers()['content-length'] || 0);
                if (length <= 1024 * 1024) blocked = isUnauthenticated(await response.json());
            }
            if (blocked && generation === observedGeneration) apiBlocked = true;
        })().catch(() => {});
        pending.add(work);
        void work.finally(() => pending.delete(work));
    };
    page.on('response', listener);
    return {
        async blocked() {
            // Do not wait for streaming or unfinished response bodies.
            await Promise.race([Promise.all([...pending]), new Promise(resolve => setTimeout(resolve, 100))]);
            return apiBlocked || isLoginUrl(page.url()) || await hasLoginDom(page);
        },
        reset() { generation++; apiBlocked = false; },
        dispose() { page.off('response', listener); }
    };
}
module.exports = { isLoginUrl, isUnauthenticated, hasLoginDom, observeLogin };
