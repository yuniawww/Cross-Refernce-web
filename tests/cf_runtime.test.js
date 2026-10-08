process.env.BROWSER_HEADLESS = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getPort, getRedisOptions, tmpDirectory } = require('../config');
const { openReferenceDatabase } = require('../reference_database');
const { MemoryStore, withLock } = require('../state_store');
const { SearchJobs } = require('../search_jobs');
const { browserOptions, requireInteractiveLogin } = require('../browser');
const { publicConfigScript, renderHtml } = require('../public_config');
const { getScraperSessionPaths, readCookies, saveCookies } = require('../scraper_session');
const { saveSearchHistory, listSearchHistory, getSearchHistory, clearSearchHistory } = require('../search_history');

test('PORT is required and invalid values never silently select another port', () => {
    for (const PORT of [undefined, '', 'abc', '0', '-1', '65536', '3000abc', '3.5']) {
        assert.throws(() => getPort({ PORT }), /PORT/);
    }
    assert.equal(getPort({ PORT: '43210' }), 43210);
});

test('Redis accepts explicit URL and named CF bindings, without silent ambiguous selection', () => {
    const services = { redis: [
        { name: 'one', credentials: { uri: 'rediss://one:6379' } },
        { name: 'two', credentials: { host: 'two', port: 6380, password: 'secret', tls: true } }
    ] };
    const env = { VCAP_SERVICES: JSON.stringify(services) };
    assert.equal(getRedisOptions({ ...env, REDIS_URL: 'redis://override:6379' }).url, 'redis://override:6379');
    assert.throws(() => getRedisOptions(env), /REDIS_SERVICE_NAME/);
    assert.deepEqual(getRedisOptions({ ...env, REDIS_SERVICE_NAME: 'two' }), {
        username: undefined, password: 'secret', socket: { host: 'two', port: 6380, tls: true }
    });
    assert.throws(() => getRedisOptions({ VCAP_SERVICES: 'broken' }), /valid JSON/);
    assert.equal(getRedisOptions({}), null);
});

test('read-only baseline rejects writes and missing files, and does not create sidecars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-readonly-'));
    try {
        const filename = path.join(dir, 'baseline.db');
        const writable = new DatabaseSync(filename);
        writable.exec('CREATE TABLE sample (id INTEGER); INSERT INTO sample VALUES (1)');
        writable.close();
        const db = openReferenceDatabase(filename);
        assert.equal(db.prepare('SELECT id FROM sample').get().id, 1);
        assert.throws(() => db.exec('INSERT INTO sample VALUES (2)'), /readonly/);
        db.close();
        assert.throws(() => openReferenceDatabase(path.join(dir, 'missing.db')));
        assert.deepEqual(fs.readdirSync(dir), ['baseline.db']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('container browser options keep site flags, use tmp and reject interactive login', () => {
    const options = browserOptions({ args: ['--disable-http2'] });
    assert.equal(options.headless, true);
    for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-http2']) assert.ok(options.args.includes(flag));
    assert.equal(options.env.TMPDIR, tmpDirectory);
    assert.throws(() => requireInteractiveLogin(), { code: 'LOGIN_REQUIRED' });
});

test('public configuration escapes HTML and never serializes service secrets', () => {
    process.env.REDIS_URL = 'redis://secret-password@example.invalid';
    process.env.TAILWIND_URL = 'https://assets.example.invalid/?x="test"&y=2';
    try {
        assert.equal(renderHtml('__PUBLIC_TAILWIND_URL__'), 'https://assets.example.invalid/?x=&quot;test&quot;&amp;y=2');
        assert.doesNotMatch(publicConfigScript(), /secret-password|REDIS_URL/);
    } finally { delete process.env.REDIS_URL; delete process.env.TAILWIND_URL; }
});

test('shared state retains empty arrays, limits histories and serializes same-session submissions', async () => {
    const store = new MemoryStore();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.prepend('history', { i, results: [] }, 10)));
    assert.equal((await store.list('history')).length, 10);
    assert.deepEqual((await store.list('history'))[0].results, []);
    let finish;
    const first = withLock(store, 'session', () => new Promise(resolve => { finish = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(withLock(store, 'session', async () => {}), { status: 409 });
    finish();
    await first;
    await withLock(store, 'session', async () => {});
});

test('cookie sessions are isolated and history stores complete records without local JSON files', async () => {
    const first = getScraperSessionPaths(__dirname, 'ngk', 'test-user-a');
    const second = getScraperSessionPaths(__dirname, 'ngk', 'test-user-b');
    try {
        assert.ok(first.profileDirectory.startsWith(tmpDirectory + path.sep));
        assert.notEqual(first.profileDirectory, second.profileDirectory);
        await saveCookies({ cookies: async () => [{ name: 'session', value: 'fixture' }] }, first.cookieKey);
        assert.equal((await readCookies(first.cookieKey))[0].value, 'fixture');
        assert.deepEqual(await readCookies(second.cookieKey), []);
        assert.deepEqual(fs.readdirSync(first.profileDirectory), []);
        const record = await saveSearchHistory({ clientSessionId: 'test-history', brand: 'ngk',
            oeList: ['one'], status: 'completed', results: [], createdAt: 1, completedAt: 2 });
        assert.equal((await listSearchHistory('test-history'))[0].resultCount, 0);
        assert.deepEqual(await getSearchHistory('test-history', record.historyId), record);
        await clearSearchHistory('test-history');
        assert.deepEqual(await listSearchHistory('test-history'), []);
    } finally {
        fs.rmSync(first.profileDirectory, { recursive: true, force: true });
        fs.rmSync(second.profileDirectory, { recursive: true, force: true });
    }
});

test('jobs can be polled and cancelled on another instance; duplicates do not rerun and lost workers fail', async () => {
    const store = new MemoryStore();
    const history = [];
    const options = { classifyError: error => ({ code: error.code || 'FAILED' }),
        cancellationError: reason => ({ code: reason }), saveHistory: async job => history.push(structuredClone(job)), brandLabels: {} };
    const first = new SearchJobs(store, options);
    const second = new SearchJobs(store, options);
    await first.start();
    await second.start();
    let calls = 0;
    const runner = async (_, { signal }) => {
        calls++;
        return new Promise((resolve, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    };
    try {
        const request = { clientSessionId: 'session', clientRequestId: 'request', brand: 'test', oeList: ['one'] };
        const job = await first.submit(request, runner);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal((await second.submit(request, runner)).jobId, job.jobId);
        assert.equal(calls, 1);
        assert.equal((await second.getByRequest('request', true)).status, 'running');
        await second.cancel(job.jobId);
        await first.tick();
        await first.running.get(job.jobId)?.promise;
        assert.equal((await second.get(job.jobId)).status, 'cancelled');
        assert.equal(history[0].status, 'cancelled');
        const lost = await first.submit({ ...request, clientRequestId: 'lost' }, runner);
        await store.delete(`owner:${first.owner}`);
        assert.equal((await second.get(lost.jobId)).error.code, 'WORKER_LOST');
    } finally { await first.close(); await second.close(); }
});
