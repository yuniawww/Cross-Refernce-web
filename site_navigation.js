function assertNavigationResponse(response, label) {
    if (!response) return;
    const status = response.status();
    if (status < 400) return;
    const error = new Error(`${label}: HTTP ${status}`);
    error.httpStatus = status;
    error.code = status === 403 ? 'SITE_ACCESS_DENIED'
        : status === 429 ? 'SITE_RATE_LIMITED'
        : status >= 500 ? 'SITE_UNAVAILABLE' : 'SITE_HTTP_ERROR';
    throw error;
}

async function navigateToCatalogue(page, url, label) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    assertNavigationResponse(response, label);
    return response;
}

module.exports = { assertNavigationResponse, navigateToCatalogue };
