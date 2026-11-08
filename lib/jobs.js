/**
 * Async jobs: `{ "async": true }` on an execute route starts the run and
 * returns a job id at once; `GET /jobs/:id` reports progress (logs, dialogs,
 * page events so far) and, when done, the full response. Finished jobs expire
 * after `ttlMs`.
 */

const log = require('./logger');

class JobStore {
    constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
        this.ttlMs = ttlMs;
        this.jobs = new Map();
        this.counter = 0;
        this.sweeper = setInterval(() => this.sweep(), Math.min(30000, Math.max(1000, ttlMs / 2)));
        this.sweeper.unref();
    }

    create(kind, rec) {
        const job = { id: `j${++this.counter}`, kind, rec, run: rec.run, status: 'running',
            createdAt: Date.now(), finishedAt: null, response: null };
        this.jobs.set(job.id, job);
        log.info('jobs', 'job started', { job: job.id, run: job.run, kind });
        return job;
    }

    finish(job, response) {
        job.response = response;
        job.finishedAt = Date.now();
        job.status = response.success ? 'succeeded'
            : response.aborted === 'timeout' ? 'timeout'
                : response.cancelled || (response.aborted && response.aborted !== 'timeout') ? 'cancelled'
                    : 'failed';
        job.rec = null;
        log.info('jobs', 'job finished', { job: job.id, run: job.run, status: job.status,
            ms: job.finishedAt - job.createdAt });
    }

    get(id) {
        this.sweep();
        return this.jobs.get(id) || null;
    }

    /** Public view of a job. */
    view(job) {
        const base = { jobId: job.id, kind: job.kind, run: job.run, status: job.status,
            createdAt: job.createdAt, elapsedMs: (job.finishedAt || Date.now()) - job.createdAt };
        if (job.status !== 'running') {
            return { ...base, finishedAt: job.finishedAt,
                expiresAt: job.finishedAt + this.ttlMs, ...job.response };
        }
        const rec = job.rec;
        const scope = rec && rec.scope;
        return {
            ...base,
            phase: scope ? 'executing' : 'queued',
            logs: scope ? scope.logs.slice() : [],
            logsTruncated: scope && scope.logsTruncated ? true : undefined,
            dialogs: scope && scope.dialogs.length ? scope.dialogs.slice() : undefined,
            pageEvents: scope && scope.pageEvents ? scope.pageEvents.slice() : undefined
        };
    }

    list() {
        this.sweep();
        return [...this.jobs.values()].map(j => ({ jobId: j.id, run: j.run, kind: j.kind, status: j.status,
            createdAt: j.createdAt, finishedAt: j.finishedAt }));
    }

    sweep() {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            if (job.finishedAt && now - job.finishedAt > this.ttlMs) {
                this.jobs.delete(id);
                log.debug('jobs', 'job expired', { job: id, run: job.run });
            }
        }
    }
}

module.exports = { JobStore };
