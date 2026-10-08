function createAbortError(reason) {
    const error = new Error(`Search job aborted: ${reason || 'cancelled'}`);
    error.code = 'JOB_ABORTED';
    return error;
}

async function runBrowserTask(browser, signal, task) {
    let abortHandler = null;
    let closePromise = null;
    const closeBrowser = () => {
        if (!closePromise) closePromise = browser.close().catch(() => undefined);
        return closePromise;
    };

    const abortPromise = new Promise((resolve, reject) => {
        abortHandler = () => {
            void closeBrowser();
            reject(createAbortError(signal?.reason));
        };

        if (signal?.aborted) abortHandler();
        else signal?.addEventListener('abort', abortHandler, { once: true });
    });

    try {
        return signal
            ? await Promise.race([Promise.resolve().then(task), abortPromise])
            : await task();
    } finally {
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        await closeBrowser();
    }
}

module.exports = { runBrowserTask };
