(() => {
    let current;
    let currentLogin;
    let dialog;
    let reopen;
    let message;
    let link;
    let close;
    const english = () => document.documentElement.lang === 'en';
    function renderLanguage() {
        if (!currentLogin) return;
        message.textContent = english()
            ? currentLogin.messageEn || 'Sign in to this site in the remote browser to continue the search.'
            : currentLogin.messageZh || '请点击登录，在远程浏览器完成站点授权后继续查询。';
        link.textContent = english() ? 'Sign in' : '点击登录';
        close.textContent = english() ? 'Sign in later' : '稍后登录';
        reopen.textContent = english() ? 'Continue sign in' : '继续登录';
    }
    function clear() {
        dialog?.remove();
        reopen?.remove();
        dialog = reopen = null;
        current = null;
        currentLogin = null;
    }
    window.refreshRemoteLoginPromptLanguage = renderLanguage;
    window.updateRemoteLoginPrompt = job => {
        if (!job || job.loginResolvedAt || !['queued', 'running'].includes(job.status)) { clear(); return; }
        const login = job.loginRequired;
        if (!login?.url) return;
        if (current === login.sessionId) { currentLogin = login; renderLanguage(); return; }
        if (!/^\/remote-login\.html#[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(login.url)) return;
        clear();
        current = login.sessionId;
        currentLogin = login;
        dialog = document.createElement('dialog');
        dialog.style.cssText = 'max-width:480px;padding:28px;border:1px solid #ccd5df;border-radius:12px;font:16px/1.6 system-ui';
        message = document.createElement('p');
        link = document.createElement('a');
        link.href = login.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'display:inline-block;color:#1759a8;text-decoration:underline;margin-right:18px';
        close = document.createElement('button');
        close.onclick = () => dialog.close();
        dialog.append(message, link, close);
        reopen = document.createElement('button');
        reopen.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9999;padding:12px;background:#1759a8;color:white;border-radius:8px';
        reopen.onclick = () => { if (!dialog.open) dialog.showModal(); };
        document.body.append(dialog, reopen);
        renderLanguage();
        dialog.showModal();
    };
})();
