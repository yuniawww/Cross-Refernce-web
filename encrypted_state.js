const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

let memoryKey;
function encryptionKey(store, env = process.env) {
    if (env.COOKIE_ENCRYPTION_KEY) {
        const key = Buffer.from(env.COOKIE_ENCRYPTION_KEY, 'base64');
        if (key.length !== 32 || key.toString('base64') !== env.COOKIE_ENCRYPTION_KEY) {
            throw new Error('COOKIE_ENCRYPTION_KEY must be 32 random bytes encoded as base64.');
        }
        return key;
    }
    if (store.mode !== 'memory') throw new Error('COOKIE_ENCRYPTION_KEY is required with Redis.');
    return memoryKey ||= randomBytes(32);
}

function seal(store, context, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(store), iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unseal(store, context, value) {
    if (value?.v !== 1) throw new Error('Encrypted state has an unsupported format.');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(store), Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
}

module.exports = { encryptionKey, seal, unseal };
