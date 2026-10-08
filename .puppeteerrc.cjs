const path = require('node:path');

module.exports = {
    // Download the Linux browser during CF staging and retain it in the droplet.
    cacheDirectory: path.join(__dirname, 'node_modules', '.puppeteer-cache'),
    temporaryDirectory: path.join(__dirname, 'tmp')
};
