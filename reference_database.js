require('./runtime_version').assertSupportedRuntime();
const { DatabaseSync } = require('node:sqlite');

function openReferenceDatabase(filename) {
    const database = new DatabaseSync(filename, { readOnly: true, timeout: 15000 });
    // Reject WAL baselines: deployment must include a self-contained, checkpointed database.
    if (database.prepare('PRAGMA journal_mode').get().journal_mode === 'wal') {
        database.close();
        throw new Error('Reference database uses WAL. Run npm run prepare:db before deployment.');
    }
    return database;
}

module.exports = { openReferenceDatabase };
