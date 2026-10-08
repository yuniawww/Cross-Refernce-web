const crypto = require('node:crypto');
const { getStore } = require('./state_store');
const HISTORY_LIMIT = 10;
const historyKey = id => `history:${crypto.createHash('sha256').update(String(id)).digest('hex')}`;

async function saveSearchHistory({ clientSessionId, brand, oeList, status, results, error, createdAt, completedAt }) {
    if (!clientSessionId) return null;
    const record = {
        historyId: crypto.randomUUID(), brand,
        oeList: Array.isArray(oeList) ? oeList : [], status,
        results: Array.isArray(results) ? results : [], error: error || null,
        createdAt, completedAt
    };
    await getStore().prepend(historyKey(clientSessionId), record, HISTORY_LIMIT);
    return record;
}
async function listSearchHistory(id) {
    return (await getStore().list(historyKey(id))).map(record => ({
        historyId: record.historyId, brand: record.brand, status: record.status,
        oeCount: record.oeList.length, resultCount: record.results.length,
        createdAt: record.createdAt, completedAt: record.completedAt
    }));
}
async function getSearchHistory(id, historyId) {
    return (await getStore().list(historyKey(id))).find(record => record.historyId === historyId) || null;
}
async function clearSearchHistory(id) { await getStore().delete(historyKey(id)); }
module.exports = { clearSearchHistory, getSearchHistory, listSearchHistory, saveSearchHistory };
