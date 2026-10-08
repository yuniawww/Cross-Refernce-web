const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { assertSupportedRuntime } = require('../runtime_version');

test('runtime guard matches the declared Node range', () => {
    for (const version of ['20.19.0', '22.9.0', '22.17.0', '23.0.0', '24.0.0']) {
        assert.throws(() => assertSupportedRuntime(version), /nvm install 22/);
    }
    for (const version of ['22.18.0', '22.23.3']) assert.doesNotThrow(() => assertSupportedRuntime(version));
});

test('startup rejects old Node before importing SQLite', () => {
    for (const entry of ['./server', './scripts/prepare-databases']) {
        const result = spawnSync(process.execPath, ['-e',
            `Object.defineProperty(process.versions, 'node', { value: '22.9.0' }); require('${entry}');`
        ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /22\.9\.0.*nvm install 22/);
        assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_BUILTIN_MODULE/);
    }
});
