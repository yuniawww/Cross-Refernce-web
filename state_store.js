const { randomUUID } = require('node:crypto');
const { getRedisOptions } = require('./config');

// Memory mode is for local development only and never writes business data to disk.
class MemoryStore {
    constructor() { this.values = new Map(); this.mode = 'memory'; }
    async connect() {}
    async close() {}
    async get(key) {
        const entry = this.values.get(key);
        if (!entry) return null;
        if (entry.expires && entry.expires <= Date.now()) { this.values.delete(key); return null; }
        return structuredClone(entry.value);
    }
    async set(key, value, ttl = 0) {
        this.values.set(key, { value: structuredClone(value), expires: ttl ? Date.now() + ttl : 0 });
    }
    async delete(key) { this.values.delete(key); }
    async claim(key, value, ttl) {
        const entry = this.values.get(key);
        if (entry && (!entry.expires || entry.expires > Date.now())) return false;
        this.values.set(key, { value: structuredClone(value), expires: Date.now() + ttl });
        return true;
    }
    async release(key, value) {
        if (this.values.get(key)?.value === value) this.values.delete(key);
    }
    async list(key) { return await this.get(key) || []; }
    async enqueue(key, value, ttl, limit = 128) {
        const entry = this.values.get(key);
        const values = entry && (!entry.expires || entry.expires > Date.now()) ? entry.value : [];
        if (values.length >= limit) return false;
        values.push(structuredClone(value));
        this.values.set(key, { value: values, expires: Date.now() + ttl });
        return true;
    }
    async dequeue(key) {
        const entry = this.values.get(key);
        if (!entry || (entry.expires && entry.expires <= Date.now())) return null;
        return entry.value.shift() || null;
    }
    async prepend(key, value, limit) {
        const entry = this.values.get(key);
        this.values.set(key, { value: [structuredClone(value), ...(entry?.value || [])].slice(0, limit) });
    }
}

class RedisStore {
    constructor(options, prefix = process.env.STATE_KEY_PREFIX || 'cross-reference:') {
        const { createClient } = require('redis');
        this.mode = 'redis';
        this.prefix = prefix;
        this.client = createClient({ ...options, disableOfflineQueue: true,
            socket: { connectTimeout: 10000, ...options.socket,
                reconnectStrategy: retries => retries < 3 ? 500 : false } });
        this.client.on('error', () => console.error('Redis connection error.'));
    }
    async connect() { await this.client.connect(); }
    async close() { if (this.client.isOpen) await this.client.quit(); }
    async get(key) {
        const value = await this.client.get(this.prefix + key);
        return value === null ? null : JSON.parse(value);
    }
    async set(key, value, ttl = 0) {
        await this.client.set(this.prefix + key, JSON.stringify(value), ttl ? { PX: ttl } : {});
    }
    async delete(key) { await this.client.del(this.prefix + key); }
    async claim(key, value, ttl) {
        return await this.client.set(this.prefix + key, JSON.stringify(value), { NX: true, PX: ttl }) === 'OK';
    }
    async release(key, value) {
        await this.client.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1]) end return 0`, {
            keys: [this.prefix + key], arguments: [JSON.stringify(value)]
        });
    }
    async list(key) {
        return (await this.client.lRange(this.prefix + key, 0, -1)).map(value => JSON.parse(value));
    }
    async enqueue(key, value, ttl, limit = 128) {
        return Boolean(await this.client.eval(`if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
            redis.call('RPUSH', KEYS[1], ARGV[1]); redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1`, {
            keys: [this.prefix + key], arguments: [JSON.stringify(value), String(ttl), String(limit)]
        }));
    }
    async dequeue(key) {
        const value = await this.client.lPop(this.prefix + key);
        return value === null ? null : JSON.parse(value);
    }
    async prepend(key, value, limit) {
        await this.client.multi().lPush(this.prefix + key, JSON.stringify(value))
            .lTrim(this.prefix + key, 0, limit - 1).exec();
    }
}

let store;
function getStore() {
    if (!store) {
        const options = getRedisOptions();
        const mode = process.env.STATE_STORE || (options ? 'redis' : 'memory');
        if (!['redis', 'memory'].includes(mode)) throw new Error('STATE_STORE must be redis or memory.');
        if (mode === 'memory' && (process.env.VCAP_APPLICATION || process.env.NODE_ENV === 'production')) {
            throw new Error('Cloud/production requires Redis: set REDIS_URL or bind a Redis service.');
        }
        if (mode === 'redis' && !options) throw new Error('Redis configuration is missing.');
        store = mode === 'redis' ? new RedisStore(options) : new MemoryStore();
    }
    return store;
}

async function withLock(store, key, task) {
    const token = randomUUID();
    if (!await store.claim(key, token, 60000)) {
        const error = new Error('Another request for this session is in progress. Retry shortly.');
        error.status = 409;
        throw error;
    }
    try { return await task(); }
    finally { await store.release(key, token); }
}

module.exports = { MemoryStore, RedisStore, getStore, withLock };
