require('../runtime_version').checkRuntimeOrExit();
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { existsSync, mkdirSync, renameSync, rmSync } = require('node:fs');

// Build self-contained deployment snapshots; never mutate the source databases.
async function main() {
    const directory = path.join(__dirname, '..', 'data');
    mkdirSync(directory, { recursive: true });
    for (const [name, sourcePath, indexes] of [
        ['sparkplug.db', process.env.SPARK_DATABASE_SOURCE, `
            CREATE INDEX IF NOT EXISTS idx_ngk_product_model ON ngk (UPPER(TRIM("产品型号")));
            CREATE INDEX IF NOT EXISTS idx_bosch_liyang_id ON bosch ("力洋ID");
            CREATE INDEX IF NOT EXISTS idx_torch_liyang_id ON torch ("力洋ID");
        `],
        ['brakeoil.db', process.env.BRAKE_DATABASE_SOURCE, `
            CREATE INDEX IF NOT EXISTS idx_vin_map_liyang_id ON vin_map (liyang_id);
            CREATE INDEX IF NOT EXISTS idx_vehicle_models_liyang_id ON vehicle_models (liyang_id);
            CREATE INDEX IF NOT EXISTS idx_original_specs_liyang_id ON original_specs (liyang_id);
        `]
    ]) {
        const source = sourcePath || path.join(__dirname, '..', name);
        if (!existsSync(source)) throw new Error(`Missing source database: ${name}`);
        const output = path.join(directory, name);
        const temporary = `${output}.${process.pid}.preparing`;
        let input;
        let db;
        try {
            input = new DatabaseSync(source, { readOnly: true, timeout: 15000 });
            await backup(input, temporary);
            input.close();
            input = null;
            db = new DatabaseSync(temporary, { timeout: 15000 });
            db.exec('PRAGMA journal_mode = DELETE');
            db.exec(indexes);
            if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Database validation failed.');
            db.close();
            db = null;
            renameSync(temporary, output);
            console.log(`Prepared data/${name}`);
        } finally {
            input?.close();
            db?.close();
            rmSync(temporary, { force: true });
        }
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
