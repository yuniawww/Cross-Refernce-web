require('../runtime_version').checkRuntimeOrExit();
// This check always exercises the deployment path, even on a developer laptop.
process.env.BROWSER_HEADLESS = 'true';
const { runZf } = require('../zf_scraper');
const { createBendixRunner } = require('../bendix_scraper');
const runMann = require('../mann_scraper');
const checks = {
    mann: { query: '111', run: runMann },
    bendix_au: { query: 'DB1086', run: createBendixRunner('bendix_au') },
    bendix_my: { query: 'DB1086', run: createBendixRunner('bendix_my') },
    zf_trw_cn: { query: 'GDB1330', run: runZf }
};
async function main() {
    const brands = process.argv.slice(2);
    const selected = brands.length ? brands : Object.keys(checks);
    if (selected.some(brand => !checks[brand])) throw new Error(`Supported checks: ${Object.keys(checks).join(', ')}`);
    console.log(`Catalogue check: platform=${process.platform}, arch=${process.arch}, headless=true`);
    for (const brand of selected) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('catalogue_check_timeout'), 180000);
        try {
            const { query, run } = checks[brand];
            const results = await run([query], { signal: controller.signal, sessionId: 'catalogue-check' });
            const count = results.reduce((total, row) => total + (row.mannNumbers || row.products || []).length, 0);
            const success = results.length > 0 && results.every(row => row.statusCode === 'SEARCH_SUCCESS') && count > 0;
            console.log(JSON.stringify({ brand, query, success, products: count,
                statuses: results.map(row => row.statusCode) }));
            if (!success) process.exitCode = 1;
        } catch (error) {
            console.error(JSON.stringify({ brand, success: false, code: error.code || 'CHECK_FAILED', message: error.message }));
            process.exitCode = 1;
        } finally { clearTimeout(timer); }
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
