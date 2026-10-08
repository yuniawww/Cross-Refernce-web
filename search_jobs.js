const { randomUUID, createHash } = require('node:crypto');
const { withLock } = require('./state_store');

const RETENTION = 60 * 60 * 1000;
const HEARTBEAT = 30000;
const OWNER_TTL = 20000;
const active = job => job && ['queued', 'running'].includes(job.status);
const key = value => createHash('sha256').update(String(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class SearchJobs {
    constructor(store, { classifyError, cancellationError, saveHistory, brandLabels, remoteLogin }) {
        Object.assign(this, { store, classifyError, cancellationError, saveHistory, brandLabels, remoteLogin });
        this.owner = randomUUID();
        // Only browser handles and AbortControllers are local. All observable state is shared.
        this.running = new Map();
        this.stopping = false;
    }
    async start() {
        await this.store.set(`owner:${this.owner}`, true, OWNER_TTL);
        this.timer = setInterval(() => {
            if (this.ticking) return;
            this.ticking = this.tick().catch(() => {
                console.error('Job storage unavailable; stopping local browser tasks.');
                for (const entry of this.running.values()) entry.controller.abort('storage_unavailable');
            }).finally(() => { this.ticking = null; });
        }, 3000);
        this.timer.unref();
    }
    async get(id, touch = false) {
        const job = id ? await this.store.get(`job:${id}`) : null;
        if (active(job) && !await this.store.get(`owner:${job.owner}`)) {
            job.status = 'failed';
            job.error = { code: 'WORKER_LOST', messageZh: '查询实例已停止，请重新提交查询。',
                messageEn: 'The search worker stopped. Submit the search again.' };
        }
        if (active(job) && touch) await this.store.set(`seen:${id}`, Date.now(), RETENTION);
        return job;
    }
    async getByRequest(requestId, touch = false) {
        return this.get(await this.store.get(`request:${key(requestId)}`), touch);
    }
    async cancel(id, reason = 'cancelled') {
        const job = await this.get(id);
        if (!active(job)) return job;
        await this.store.set(`cancel:${id}`, reason, RETENTION);
        this.running.get(id)?.controller.abort(reason);
        return { ...job, status: 'cancelled', error: this.cancellationError(reason) };
    }
    async cancelSession(id, reason = 'cancelled') {
        const jobId = await this.store.get(`session:${key(id)}`);
        const job = await this.get(jobId);
        if (!active(job)) return 0;
        await this.cancel(jobId, reason);
        return 1;
    }
    async submit({ clientSessionId, clientRequestId, brand, oeList }, runner) {
        if (this.stopping) { const error = new Error('Server is stopping.'); error.status = 503; throw error; }
        return withLock(this.store, `submit:${key(clientSessionId)}`, async () => {
            const existing = clientRequestId ? await this.getByRequest(clientRequestId) : null;
            if (existing && existing.clientSessionId === clientSessionId) return existing;
            const previousId = await this.store.get(`session:${key(clientSessionId)}`);
            if (active(await this.get(previousId))) {
                await this.cancel(previousId, 'replaced');
                const deadline = Date.now() + 15000;
                while (active(await this.get(previousId))) {
                    if (Date.now() >= deadline) {
                        const error = new Error('Previous search is still stopping. Retry shortly.');
                        error.status = 409;
                        throw error;
                    }
                    await pause(100);
                }
            }
            const job = { jobId: randomUUID(), owner: this.owner, clientSessionId, clientRequestId,
                brand, oeList, status: 'queued', results: [], error: null,
                createdAt: Date.now(), updatedAt: Date.now() };
            await this.store.set(`job:${job.jobId}`, job, RETENTION);
            await this.store.set(`seen:${job.jobId}`, Date.now(), RETENTION);
            await this.store.set(`session:${key(clientSessionId)}`, job.jobId, RETENTION);
            if (clientRequestId) await this.store.set(`request:${key(clientRequestId)}`, job.jobId, RETENTION);
            const entry = { job, controller: new AbortController(), writes: Promise.resolve() };
            this.running.set(job.jobId, entry);
            entry.promise = this.run(entry, runner).catch(() => {
                console.error('Unable to persist search completion.');
            }).finally(() => this.running.delete(job.jobId));
            return job;
        });
    }
    publish(entry) {
        const snapshot = structuredClone(entry.job);
        entry.writes = entry.writes.catch(() => {}).then(() => this.store.set(`job:${snapshot.jobId}`, snapshot, RETENTION));
        return entry.writes;
    }
    async run(entry, runner) {
        const { job, controller } = entry;
        try {
            job.status = 'running';
            await this.publish(entry);
            const options = {
                signal: controller.signal, sessionId: job.clientSessionId, jobId: job.jobId,
                onLoginRequired: async (details = {}) => {
                    job.loginResolvedAt = null;
                    job.loginRequired = { ...details, detectedAt: Date.now(),
                        messageZh: `${this.brandLabels[job.brand] || job.brand} 需要登录。请点击登录，在远程浏览器完成扫码或验证码。`,
                        messageEn: `${this.brandLabels[job.brand] || job.brand} requires sign in. Click Sign in, then use the QR code or verification code in the remote browser.` };
                    await this.publish(entry);
                },
                onLoginResolved: async () => {
                    job.loginResolvedAt = Date.now();
                    await this.publish(entry);
                }
            };
            job.results = await (this.remoteLogin
                ? this.remoteLogin.run(options, () => runner(job.oeList, options))
                : runner(job.oeList, options));
            const cancellation = controller.signal.reason || await this.store.get(`cancel:${job.jobId}`);
            if (cancellation) { controller.abort(cancellation); throw new Error('Cancelled'); }
            job.status = 'completed';
        } catch (error) {
            job.status = controller.signal.aborted ? 'cancelled' : 'failed';
            job.error = controller.signal.aborted ? this.cancellationError(controller.signal.reason) : this.classifyError(error, job.brand);
        }
        job.updatedAt = job.completedAt = Date.now();
        await this.publish(entry);
        try { await this.saveHistory(job); }
        catch { console.error('Unable to save search history.'); }
    }
    async tick() {
        await this.store.set(`owner:${this.owner}`, true, OWNER_TTL);
        for (const entry of this.running.values()) {
            if (!active(entry.job)) continue;
            const id = entry.job.jobId;
            const reason = await this.store.get(`cancel:${id}`);
            const seen = await this.store.get(`seen:${id}`);
            if (reason || !seen || seen < Date.now() - HEARTBEAT) entry.controller.abort(reason || 'heartbeat_timeout');
            // Snapshot writes are serialized with completion so a tick cannot overwrite a final result.
            if (active(entry.job)) { entry.job.updatedAt = Date.now(); await this.publish(entry); }
        }
    }
    async close() {
        this.stopping = true;
        clearInterval(this.timer);
        await this.ticking;
        for (const entry of this.running.values()) entry.controller.abort('cancelled');
        await Promise.all([...this.running.values()].map(entry => entry.promise));
        await this.store.delete(`owner:${this.owner}`);
    }
}

module.exports = { SearchJobs };
