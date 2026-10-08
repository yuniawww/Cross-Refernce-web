const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const root = path.join(__dirname, '..');

test('server requires valid PORT and refuses ephemeral state in CF', () => {
    for (const overrides of [{ PORT: '' }, { PORT: 'oops' }, { PORT: '43219', VCAP_APPLICATION: '{}', STATE_STORE: 'memory' }]) {
        const result = spawnSync(process.execPath, ['server.js'], { cwd: root,
            env: { ...process.env, REDIS_URL: '', VCAP_SERVICES: '', ...overrides }, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /PORT|requires Redis/);
    }
});

test('HTTP health, configured assets and VIN imports work without modifying packaged databases', {
    skip: process.env.CF_SERVER_TEST !== '1', timeout: 20000
}, async () => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const hash = filename => createHash('sha256').update(fs.readFileSync(path.join(root, 'data', filename))).digest('hex');
    const hashes = ['sparkplug.db', 'brakeoil.db'].map(hash);
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
        ...process.env, PORT: String(port), STATE_STORE: 'memory', NODE_ENV: 'test',
        VCAP_APPLICATION: '', VCAP_SERVICES: '', REDIS_URL: '',
        TAILWIND_URL: 'https://assets.example.invalid/tailwind.js'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const url = `http://127.0.0.1:${port}`;
    try {
        for (let i = 0; ; i++) {
            if (child.exitCode !== null) throw new Error(output);
            try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
            if (i >= 100) throw new Error(`Startup timeout: ${output}`);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        const health = await fetch(`${url}/health`);
        assert.deepEqual(await health.json(), { status: 'ok' });
        const html = await (await fetch(url)).text();
        assert.match(html, /https:\/\/assets.example.invalid\/tailwind.js/);
        assert.doesNotMatch(html, /__PUBLIC_/);
        const source = await fetch(`${url}/api/brake-fluid/source`);
        assert.equal(source.status, 200);
        const imported = await fetch(`${url}/api/brake-fluid/import`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: [['1C8GYB5B*2*******', 'test-id']], filename: 'test.xlsx' })
        });
        assert.equal(imported.status, 200);
        assert.equal((await imported.json()).rowCount, 1);
        assert.deepEqual(['sparkplug.db', 'brakeoil.db'].map(hash), hashes);
        assert.deepEqual(fs.readdirSync(path.join(root, 'data')).sort(), ['brakeoil.db', 'sparkplug.db']);
    } finally {
        child.kill('SIGTERM');
        await exited;
    }
});
