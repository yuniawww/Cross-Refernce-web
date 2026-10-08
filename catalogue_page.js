function catalogueUserAgent(userAgent) {
    // Keep the installed browser version and platform. Some catalogue frontends
    // reject the HeadlessChrome product token before serving their search UI.
    return userAgent.replace(/\bHeadlessChrome\//g, 'Chrome/');
}

async function createCataloguePage(browser) {
    const page = await browser.newPage();
    try {
        const original = await browser.userAgent();
        const userAgent = catalogueUserAgent(original);
        if (userAgent !== original) await page.setUserAgent({ userAgent });
        await page.setViewport({ width: 1600, height: 1000 });
        return page;
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

module.exports = { catalogueUserAgent, createCataloguePage };
