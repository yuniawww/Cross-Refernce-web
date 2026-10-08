const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createBrakeFluidLookup } = require('../brake_fluid');
const { MemoryStore } = require('../state_store');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

test('VIN imports use external storage; invalid imports preserve state and baseline stays unchanged', async () => {
    const store = new MemoryStore();
    const directory = mkdtempSync(path.join(tmpdir(), 'brake-import-'));
    const filename = path.join(directory, 'brakeoil.db');
    let lookup;
    try {
        const db = new DatabaseSync(filename);
        db.exec(`
            CREATE TABLE vin_map (vin TEXT, liyang_id TEXT, PRIMARY KEY(vin, liyang_id)) WITHOUT ROWID;
            CREATE INDEX idx_vin_map_liyang_id ON vin_map(liyang_id);
            CREATE TABLE original_specs (liyang_id TEXT, original_spec TEXT);
            CREATE TABLE vehicle_models (liyang_id TEXT, brand TEXT, model TEXT);
            INSERT INTO vin_map VALUES ('1D4GP25B*7*******', 'old');
            INSERT INTO original_specs VALUES ('new', 'DOT 4');
            INSERT INTO vehicle_models VALUES ('new', '品牌', '车型');
        `);
        db.close();
        const baselineHash = createHash('sha256').update(readFileSync(filename)).digest('hex');
        lookup = createBrakeFluidLookup(filename, store);
        assert.equal((await lookup.source()).type, 'builtin');
        const imported = await lookup.replaceMapping([
            ['1c8gyb5b*2*******', 'new'], ['1C8GYB5B*2*******', 'new'],
            ['1C8GYB5B*2*******', 'second']
        ], 'mapping.xlsx');
        assert.equal(imported.rowCount, 2);
        assert.equal(imported.duplicates, 1);
        assert.equal((await lookup.lookup('1D4GP25B07A123456')).matches.length, 0);
        const matches = (await lookup.lookup('1C8GYB5B02A123456')).matches;
        assert.equal(matches.length, 2);
        assert.equal(matches.find(row => row.liyangId === 'new').originalSpec, 'DOT 4');
        assert.equal(matches.find(row => row.liyangId === 'second').complete, false);
        for (const rows of [[], [['invalid', 'new']], [['1C8GYB5B*2*******', '']], [['1C8GYB5B*2*******', 'new', 'extra']], [['1D4GP25B*7*******', 'new'], ['bad', 'new']]]) {
            await assert.rejects(() => lookup.replaceMapping(rows, 'invalid.xlsx'), { status: 400 });
            assert.equal((await lookup.source()).filename, 'mapping.xlsx');
            assert.equal((await lookup.lookup('1C8GYB5B02A123456')).matches.length, 2);
            assert.equal((await lookup.lookup('1D4GP25B07A123456')).matches.length, 0);
        }
        lookup.close();
        lookup = createBrakeFluidLookup(filename, store);
        assert.equal((await lookup.source()).rowCount, 2);
        assert.equal((await lookup.source()).filename, 'mapping.xlsx');
        assert.equal((await lookup.lookup('1C8GYB5B02A123456')).matches.length, 2);
        const inspect = new DatabaseSync(filename, { readOnly: true });
        assert.deepEqual(inspect.prepare('PRAGMA table_info(vin_map)').all().map(row => row.name), ['vin', 'liyang_id']);
        assert.equal(inspect.prepare('SELECT count(*) AS n FROM original_specs').get().n, 1);
        assert.equal(inspect.prepare('SELECT count(*) AS n FROM vehicle_models').get().n, 1);
        inspect.close();
        // Reported source template contains the letter O, which must remain O.
        await lookup.replaceMapping([['LJNOGOBG*7*******', 'new']], 'remark-id.xlsx');
        assert.equal((await lookup.lookup('LJNOGOBG07A123456')).matches[0].liyangId, 'new');
        assert.equal((await lookup.lookup('LJN0G0BG07A123456')).matches.length, 0);
        for (const vin of ['*****************', 'LJNOGOBG*7******', 'LJNOGOBG?7*******']) {
            await assert.rejects(() => lookup.replaceMapping([[vin, 'new']], 'bad.xlsx'), { status: 400 });
        }
        await assert.rejects(() => lookup.lookup('LJNOGOBG*7*******'), { status: 400 });
        lookup.close();
        lookup = createBrakeFluidLookup(filename, store);
        assert.equal((await lookup.lookup('LJNOGOBG07A123456')).matches[0].originalSpec, 'DOT 4');
        assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), baselineHash);
    } finally {
        lookup?.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
