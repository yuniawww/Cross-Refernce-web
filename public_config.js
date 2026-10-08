const { siteUrl } = require('./config');

function publicConfig() {
    return {
        TAILWIND_URL: siteUrl('TAILWIND_URL', 'https://cdn.tailwindcss.com'),
        FONT_CSS_URL: siteUrl('FONT_CSS_URL', 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap'),
        ICON_CSS_URL: siteUrl('ICON_CSS_URL', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'),
        XLSX_URL: siteUrl('XLSX_URL', 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'),
        BENDIX_AU_URL: siteUrl('BENDIX_AU_URL', 'https://www.bendix.com.au/catalogue'),
        BENDIX_MY_URL: siteUrl('BENDIX_MY_URL', 'https://www.bendix.com.my/en-my/catalogue'),
        ZF_CATALOGUE_URL: siteUrl('ZF_CATALOGUE_URL', 'https://aftermarket.zf.com/cn/catalog/?country=CN'),
        ZF_ORIGIN: new URL(siteUrl('ZF_CATALOGUE_URL', 'https://aftermarket.zf.com/cn/catalog/?country=CN')).origin,
        MANN_ORIGIN: new URL(siteUrl('MANN_URL', 'https://www.mann-filter.com/cn-zh/catalog.html')).origin
    };
}

function renderHtml(template) {
    const config = publicConfig();
    return template.replace(/__PUBLIC_([A-Z_]+)__/g, (_, name) => {
        if (!(name in config)) throw new Error(`Unknown public configuration: ${name}`);
        return config[name].replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    });
}

function publicConfigScript() {
    // Explicit public allowlist: never expose process.env or service credentials.
    return `globalThis.APP_CONFIG = ${JSON.stringify(publicConfig()).replace(/</g, '\\u003c')};`;
}
module.exports = { publicConfig, renderHtml, publicConfigScript };
