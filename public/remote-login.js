(() => {
    'use strict';
    const match = location.hash.slice(1).match(/^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/);
    const status = document.getElementById('status');
    const screen = document.getElementById('screen');
    const input = document.getElementById('input');
    let language = 'zh';
    let statusText = ['正在连接临时浏览器…', 'Connecting to the temporary browser…'];
    let siteOrigin = '';
    const localized = (zh, en) => language === 'en' ? en : zh;
    function setStatus(zh, en) {
        statusText = [zh, en];
        status.textContent = localized(zh, en);
    }
    function setLanguage(value) {
        language = value === 'en' ? 'en' : 'zh';
        document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
        document.title = localized('站点远程授权', 'Remote site authorization');
        document.querySelectorAll('[data-zh][data-en]').forEach(element => {
            element.textContent = element.dataset[language];
        });
        document.querySelectorAll('[data-placeholder-zh][data-placeholder-en]').forEach(element => {
            element.placeholder = element.dataset[language === 'en' ? 'placeholderEn' : 'placeholderZh'];
        });
        screen.alt = screen.dataset[language === 'en' ? 'altEn' : 'altZh'];
        document.getElementById('languageZh').setAttribute('aria-pressed', String(language === 'zh'));
        document.getElementById('languageEn').setAttribute('aria-pressed', String(language === 'en'));
        status.textContent = localized(...statusText);
        if (siteOrigin) document.getElementById('site').textContent = localized(`当前站点：${siteOrigin}`, `Current site: ${siteOrigin}`);
        try { localStorage.setItem('crossReferenceLanguage', language); } catch {}
    }
    for (const code of ['zh', 'en']) document.getElementById(code === 'zh' ? 'languageZh' : 'languageEn').onclick = () => setLanguage(code);
    window.addEventListener('storage', event => {
        if (event.key === 'crossReferenceLanguage') setLanguage(event.newValue);
    });
    try { language = localStorage.getItem('crossReferenceLanguage') || 'zh'; } catch {}
    setLanguage(language);
    if (!match) { setStatus('登录入口无效，请回到查询页面重新打开。', 'Invalid sign-in link. Return to the search page and open it again.'); return; }
    const [, id, token] = match;
    const api = `/api/remote-login/${id}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    let stopped = false;
    let sending = Promise.resolve();
    let dragging = false;
    let lastMove = 0;
    let failures = 0;
    const send = command => {
        if (stopped) return;
        sending = sending.then(async () => {
            if (stopped) return;
            const response = await fetch(`${api}/commands`, { method: 'POST', headers, body: JSON.stringify(command) });
            if (!response.ok) throw new Error('COMMAND_FAILED');
        }).catch(() => { setStatus('操作未送达，请等待画面恢复后重试。', 'The action was not delivered. Wait for the screen to recover, then retry.'); });
    };
    function finish(zh, en) {
        stopped = true;
        setStatus(zh, en);
        input.value = '';
        screen.hidden = true;
        screen.removeAttribute('src');
        document.querySelectorAll('.controls button, #input-form button, #input-form input').forEach(element => { element.disabled = true; });
        history.replaceState(null, '', location.pathname);
    }
    async function poll() {
        try {
            const response = await fetch(api, { headers, cache: 'no-store' });
            if ([404, 410].includes(response.status)) { finish('登录入口已过期，请回到查询页面重试。', 'The sign-in link expired. Return to the search page and try again.'); return; }
            if (!response.ok) throw new Error('CONNECTION_FAILED');
            const data = await response.json();
            failures = 0;
            if (data.status !== 'waiting') {
                const messages = {
                    completed: ['授权成功，查询已自动继续。可以关闭此标签页。', 'Authorization successful. The search has resumed. You can close this tab.'],
                    cancelled: ['授权已取消，请回到查询页面。', 'Authorization cancelled. Return to the search page.'],
                    expired: ['授权超时，请回到查询页面重新查询。', 'Authorization timed out. Return to the search page and search again.'],
                    failed: ['授权未完成，请回到查询页面查看错误后重试。', 'Authorization was not completed. Check the search page for details and try again.']
                };
                finish(...(messages[data.status] || ['授权入口已关闭。', 'The authorization link has closed.']));
                return;
            }
            const remaining = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000));
            setStatus(`${data.brand.toUpperCase()} · 等待授权（剩余 ${remaining} 秒）`, `${data.brand.toUpperCase()} · Waiting for authorization (${remaining} seconds left)`);
            if (data.frame) {
                screen.src = `data:image/jpeg;base64,${data.frame.image}`;
                screen.hidden = false;
                siteOrigin = data.frame.origin;
                document.getElementById('site').textContent = localized(`当前站点：${siteOrigin}`, `Current site: ${siteOrigin}`);
            }
        } catch {
            failures++;
            setStatus('连接暂时中断，正在重试…', 'Connection interrupted. Retrying…');
            if (failures >= 20) { finish('连接失败，请回到查询页面重新打开授权入口。', 'Connection failed. Return to the search page and reopen the sign-in link.'); return; }
        }
        if (!stopped) setTimeout(poll, 800);
    }
    const point = event => {
        const rect = screen.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1279, (event.clientX - rect.left) * 1280 / rect.width)),
            y: Math.max(0, Math.min(899, (event.clientY - rect.top) * 900 / rect.height)) };
    };
    screen.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        screen.focus({ preventScroll: true });
        screen.setPointerCapture(event.pointerId);
        dragging = true;
        send({ type: 'pointer', action: 'down', ...point(event) });
    });
    screen.addEventListener('pointermove', event => {
        if (!dragging || Date.now() - lastMove < 80) return;
        lastMove = Date.now();
        send({ type: 'pointer', action: 'move', ...point(event) });
    });
    const release = event => {
        if (!dragging) return;
        dragging = false;
        send({ type: 'pointer', action: 'up', ...point(event) });
    };
    screen.addEventListener('pointerup', release);
    screen.addEventListener('pointercancel', release);
    screen.addEventListener('wheel', event => {
        event.preventDefault();
        send({ type: 'scroll', deltaY: Math.max(-1500, Math.min(1500, event.deltaY)) });
    }, { passive: false });
    screen.addEventListener('keydown', event => {
        if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
        if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); send({ type: 'key', key: event.key });
        } else if (event.key.length === 1) { event.preventDefault(); send({ type: 'text', text: event.key }); }
    });
    document.getElementById('input-form').addEventListener('submit', event => {
        event.preventDefault();
        if (input.value) send({ type: 'text', text: input.value });
        input.value = '';
    });
    for (const action of ['back', 'reload', 'cancel']) document.getElementById(action).onclick = () => send({ type: action });
    for (const [button, key] of [['tab', 'Tab'], ['enter', 'Enter'], ['backspace', 'Backspace']]) document.getElementById(button).onclick = () => send({ type: 'key', key });
    void poll();
})();
