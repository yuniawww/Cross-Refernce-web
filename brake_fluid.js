const { existsSync } = require('node:fs');
const { openReferenceDatabase } = require('./reference_database');
const { getStore } = require('./state_store');

function createBrakeFluidLookup(databasePath, store = getStore()) {
    if (!existsSync(databasePath)) throw new Error('制动液数据库不存在。');
    const database = openReferenceDatabase(databasePath);
    const statement = database.prepare(`
        SELECT DISTINCT v.liyang_id AS liyangId, m.brand, m.model,
                        s.original_spec AS originalSpec
          FROM vin_map v
          LEFT JOIN vehicle_models m ON m.liyang_id = v.liyang_id
          LEFT JOIN original_specs s ON s.liyang_id = v.liyang_id
         WHERE ? GLOB REPLACE(v.vin, '*', '?')
         ORDER BY v.liyang_id, m.brand, m.model, s.original_spec
    `);
    const importedStatement = database.prepare(`
        SELECT DISTINCT ids.value AS liyangId, m.brand, m.model, s.original_spec AS originalSpec
          FROM json_each(?) ids
          LEFT JOIN vehicle_models m ON m.liyang_id = ids.value
          LEFT JOIN original_specs s ON s.liyang_id = ids.value
         ORDER BY ids.value, m.brand, m.model, s.original_spec
    `);
    return {
        async source() {
            const imported = await store.get('brake:vin-map');
            return imported ? imported.source : {
                type: 'builtin', rowCount: database.prepare('SELECT COUNT(*) AS count FROM vin_map').get().count
            };
        },
        async replaceMapping(rows, filename) {
            const fail = message => { const error = new Error(message); error.status = 400; throw error; };
            if (!Array.isArray(rows) || !rows.length) fail('Excel 中没有可导入的 VIN 关联数据。');
            if (rows.length > 1000000) fail('一次最多导入 100 万行 VIN 关联数据。');
            const unique = new Map();
            for (let index = 0; index < rows.length; index++) {
                const row = rows[index];
                if (!Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== 'string')) fail(`第 ${index + 2} 行格式错误，必须仅包含 vin 和 liyang 两列。`);
                const vin = row[0].trim().toUpperCase();
                const id = row[1].trim();
                if (!/^[A-Z0-9*]{17}$/.test(vin) || !/[A-Z0-9]/.test(vin)) fail(`第 ${index + 2} 行 VIN 无效，应为 17 位 VIN 或含 * 的模板。`);
                if (!id || id.length > 100) fail(`第 ${index + 2} 行 liyang 为空或过长。`);
                unique.set(JSON.stringify([vin, id]), [vin, id]);
            }
            const source = { type: 'imported', filename: String(filename || 'Excel').slice(0, 255),
                importedAt: new Date().toISOString(), rowCount: unique.size };
            // Atomic replacement; validation or storage failures leave the previous mapping intact.
            await store.set('brake:vin-map', { source, rows: [...unique.values()] });
            return { ...source, duplicates: rows.length - unique.size };
        },
        async lookup(value) {
            const vin = typeof value === 'string' ? value.trim().toUpperCase() : '';
            if (!/^[A-Z0-9]{17}$/.test(vin)) {
                const error = new Error('请输入完整的 17 位 VIN 码（仅限英文字母和数字，不含 *）。');
                error.status = 400;
                throw error;
            }
            const imported = await store.get('brake:vin-map');
            let matches;
            if (imported) {
                const ids = [...new Set(imported.rows.filter(([pattern]) =>
                    [...pattern].every((char, index) => char === '*' || char === vin[index])
                ).map(([, id]) => id))];
                matches = importedStatement.all(JSON.stringify(ids));
            } else {
                matches = statement.all(vin);
            }
            return { vin, matches: matches.map(row => ({
                ...row,
                complete: [row.brand, row.model, row.originalSpec].every(value => typeof value === 'string' && value.trim())
            })) };
        },
        close: () => database.close()
    };
}

module.exports = { createBrakeFluidLookup };
