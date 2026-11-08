/**
 * Code Executor
 *
 * Executes JavaScript snippets with Puppeteer context. Supports sequential
 * (legacy, one shared page) and concurrent (tab pool) execution.
 *
 * Every execution is a "run": logged before it executes (full code in the
 * executions JSONL), executed inside a RunScope (abort, per-run cleanup,
 * console capture, page events, dialogs), and finished exactly once with a
 * response decorated with session/browser facts (reconnects, crashes, expired
 * login, error screenshot, large results spilled to artifacts).
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { preview, sizeOf } = log;
const { RunScope, registerScope, unregisterScope, installDialogHandler } = require('./run-scope');
const { normalizeTypes, DEFAULT_RUN_TYPES } = require('./page-events');
const { createHelpers } = require('./helpers');
const { ArtifactStore } = require('./artifacts');

// AsyncFunction constructor for creating async functions from strings
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// After a run is aborted, wait this long for the snippet to actually stop
// before handing its tab / queue slot to the next run.
const DEFAULT_ABORT_GRACE_MS = 5000;

const DEFAULTS = {
    maxQueue: 50,                          // sequential queue length before 429
    maxTimeoutMs: 10 * 60 * 1000,          // requested `timeout` is capped to this
    resultMaxBytes: 5 * 1024 * 1024,       // larger results are spilled to an artifact
    loginUrlPattern: null,                 // RegExp/string: run ending here => sessionExpired
    historySize: 500,                      // runs kept in memory for GET /runs/:id
    screenshotTimeoutMs: 5000              // screenshotOnError budget
};

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

/** endRun status for a failed run. */
function failStatus(error) {
    if (error && error.isTimeout) return 'timeout';
    if (error && error.isCancelled) return 'cancelled';
    return 'error';
}

function isBinary(v) {
    return Buffer.isBuffer(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;
}

function toBinaryRecord(v) {
    const buf = Buffer.isBuffer(v) ? v
        : v instanceof ArrayBuffer ? Buffer.from(v)
            : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return { $binary: 'base64', data: buf.toString('base64'), bytes: buf.length };
}

/**
 * Replace Buffers / typed arrays / ArrayBuffers (top level, or nested in plain
 * objects and arrays) with `{ $binary: 'base64', data, bytes }`.
 */
function encodeBinary(value, depth = 0, seen = new Set()) {
    if (value === null || typeof value !== 'object') return value;
    if (isBinary(value)) return toBinaryRecord(value);
    if (depth > 20 || seen.has(value)) return value;
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
        seen.add(value);
        let out = null;
        value.forEach((v, i) => {
            const e = encodeBinary(v, depth + 1, seen);
            if (e !== v) { out = out || value.slice(); out[i] = e; }
        });
        return out || value;
    }
    if (proto === Object.prototype || proto === null) {
        seen.add(value);
        let out = null;
        for (const [k, v] of Object.entries(value)) {
            const e = encodeBinary(v, depth + 1, seen);
            if (e !== v) { out = out || { ...value }; out[k] = e; }
        }
        return out || value;
    }
    return value;
}

function safeUrl(page) {
    try { return page.url(); } catch { return undefined; }
}

class CodeExecutor {
    constructor(browserManager, tabPoolManager = null, options = {}) {
        this.browserManager = browserManager;
        this.tabPoolManager = tabPoolManager;
        this.options = { ...DEFAULTS, ...stripUndefined(options) };
        this.loginRe = this.options.loginUrlPattern
            ? (this.options.loginUrlPattern instanceof RegExp
                ? this.options.loginUrlPattern : new RegExp(this.options.loginUrlPattern))
            : null;
        this.artifacts = options.artifacts || new ArtifactStore();

        // Legacy sequential queue (backward compatibility)
        this.executionQueue = [];
        this.isExecuting = false;

        // What's running right now — reported if the CDP connection drops.
        this.running = new Map();   // run -> run record (see beginRun)
        this.history = new Map();   // run -> summary (GET /runs/:id), most recent last
        this.runCounter = 0;
        this.browserManager.inFlight = () => {
            if (this.running.size === 0) return null;
            return [...this.running.values()].map(r => ({
                run: r.run, req: r.req, mode: r.mode, tabId: r.tabId,
                runningMs: Date.now() - r.startedAt
            }));
        };
    }

    /**
     * Set the tab pool manager (can be set after construction)
     */
    setTabPoolManager(tabPoolManager) {
        this.tabPoolManager = tabPoolManager;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // OPTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /** Validate and default per-request options. Throws 400 on bad input. */
    normalize(options = {}) {
        const o = { ...options };
        const timeout = o.timeout == null ? 30000 : Number(o.timeout);
        if (!Number.isFinite(timeout) || timeout <= 0) throw httpError(400, `invalid timeout: ${o.timeout}`);
        const opts = {
            pageName: o.pageName || 'main',
            timeout: Math.min(timeout, this.options.maxTimeoutMs),
            returnType: o.returnType || 'auto',
            persist: !!o.persist,
            keepTabs: !!o.keepTabs,
            abortGraceMs: o.abortGraceMs == null ? DEFAULT_ABORT_GRACE_MS : Number(o.abortGraceMs),
            pageEvents: o.pageEvents ? normalizeTypes(o.pageEvents, DEFAULT_RUN_TYPES) : null,
            screenshotOnError: !!o.screenshotOnError,
            files: o.files || null,
            resultMaxBytes: o.resultMaxBytes == null ? this.options.resultMaxBytes : Number(o.resultMaxBytes)
        };
        if (timeout > this.options.maxTimeoutMs) opts.timeoutCappedTo = this.options.maxTimeoutMs;
        if (opts.files && (typeof opts.files !== 'object' || Array.isArray(opts.files))) {
            throw httpError(400, 'files must be an object: { name: base64 | { data, filename } }');
        }
        return opts;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RUN LIFECYCLE (execution log)
    // ═══════════════════════════════════════════════════════════════════════
    //
    // beginRun() is called as soon as the request reaches the executor —
    // before queueing, tab acquisition or page lookup — and synchronously
    // appends a `start` record with the FULL code to the executions JSONL.
    // endRun() is called exactly once on every path (ok / error / timeout /
    // cancelled). So any failure, even one before the code starts, is tied to
    // its request and code.

    beginRun(mode, code, opts, meta = {}) {
        const run = ++this.runCounter;
        const ctx = log.context() || {};
        const logged = {
            ...meta, timeoutMs: opts.timeout, returnType: opts.returnType,
            persist: opts.persist || undefined, keepTabs: opts.keepTabs || undefined,
            pageEvents: opts.pageEvents || undefined, screenshotOnError: opts.screenshotOnError || undefined,
            files: opts.files ? Object.keys(opts.files) : undefined,
            timeoutCappedTo: opts.timeoutCappedTo
        };
        const rec = {
            run, req: ctx.reqId, method: ctx.method, path: ctx.path, mode,
            ...meta, opts, startedAt: Date.now(), code
        };
        log.exec({
            event: 'start', run, req: rec.req, method: rec.method, path: rec.path, mode,
            ...logged, codeChars: code.length, code
        });
        log.info('exec', 'start', { run, mode, ...logged, codeChars: code.length, code: preview(code, 120) });
        this.running.set(run, rec);
        this.remember(rec, { status: 'running' });
        return rec;
    }

    endRun(rec, status, fields = {}) {
        if (rec.ended) return;
        rec.ended = true;
        this.running.delete(rec.run);
        const ms = Date.now() - rec.startedAt;
        const { stack, ...rest } = fields;
        const scoped = rec.scope ? rec.scope.logFields() : {};
        log.exec({ event: 'end', run: rec.run, req: rec.req, status, ms, ...rest, ...scoped, stack });
        this.remember(rec, { status, ms, endedAt: Date.now(), ...rest, ...scoped, stack });
        const textFields = { ...rest };
        if (scoped.logs) textFields.logLines = scoped.logs.length;
        if (scoped.dialogs) textFields.dialogs = scoped.dialogs.length;
        if (scoped.pageEvents) textFields.pageEvents = scoped.pageEvents.length;
        const level = status === 'ok' ? 'info' : 'warn';
        const orphan = rec.scope && rec.scope.orphan;
        const msg = status === 'timeout'
            ? (orphan ? 'timeout — snippet aborted but still running (orphan)' : 'timeout — snippet aborted')
            : status;
        log[level]('exec', msg, {
            run: rec.run, ms, ...textFields,
            error: rest.error ? preview(rest.error, 300) : undefined,
            stack: status === 'error' ? stack : undefined
        });
    }

    errorFields(error, extra = {}) {
        return {
            error: error && error.message ? error.message : String(error),
            stack: error && error.stack,
            browserConnected: this.browserManager.isRunning(),
            ...extra
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RUN HISTORY (GET /runs, GET /runs/:id)
    // ═══════════════════════════════════════════════════════════════════════

    remember(rec, fields) {
        const prev = this.history.get(rec.run);
        const entry = prev || {
            run: rec.run, req: rec.req, method: rec.method, path: rec.path, mode: rec.mode,
            page: rec.page, startedAt: rec.startedAt, code: rec.code
        };
        if (rec.tabId) entry.tabId = rec.tabId;
        Object.assign(entry, fields);
        this.history.delete(rec.run);           // re-insert: most recent last
        this.history.set(rec.run, entry);
        while (this.history.size > this.options.historySize) {
            this.history.delete(this.history.keys().next().value);
        }
    }

    /** Full record of a run: memory first, then the executions JSONL. */
    getRun(run) {
        run = Number(run);
        const entry = this.history.get(run);
        if (entry) {
            const out = { ...entry };
            const rec = this.running.get(run);
            if (rec && rec.scope) {
                out.phase = 'executing';
                out.logs = rec.scope.logs.slice();
                if (rec.scope.dialogs.length) out.dialogs = rec.scope.dialogs.slice();
                if (rec.scope.pageEvents) out.pageEvents = rec.scope.pageEvents.slice();
            } else if (rec) {
                out.phase = 'queued';
            }
            return out;
        }
        return this.readRunFromLog(run);
    }

    readRunFromLog(run) {
        const file = log.getExecFilePath();
        if (!file || !fs.existsSync(file)) return null;
        const needle = `"run":${run},`;
        let out = null;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.includes(needle)) continue;
            let r;
            try { r = JSON.parse(line); } catch { continue; }
            if (r.run !== run) continue;
            const { event, ts, ...rest } = r;
            out = out || { run };
            if (event === 'start') Object.assign(out, rest, { startedAt: Date.parse(ts), status: 'unknown' });
            else if (event === 'end') Object.assign(out, rest, { endedAt: Date.parse(ts) });
            else if (event === 'exec') out.url = rest.url;
        }
        if (out) out.source = 'executions log';
        return out;
    }

    listRuns(limit = 20) {
        const all = [...this.history.values()];
        return all.slice(-limit).reverse().map(e => ({
            run: e.run, req: e.req, path: e.path, mode: e.mode, status: e.status, ms: e.ms,
            startedAt: e.startedAt, error: e.error ? preview(e.error, 200) : undefined,
            code: preview(e.code, 120)
        }));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SEQUENTIAL EXECUTION (legacy, named pages)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Execute code on a named page via the sequential queue.
     * `hooks.onRun(rec)` is called synchronously once the run is registered
     * (used by async jobs).
     */
    async execute(code, options = {}, hooks = {}) {
        const opts = this.normalize(options);
        if (this.executionQueue.length >= this.options.maxQueue) {
            log.warn('exec', 'queue full; rejecting request', {
                queued: this.executionQueue.length, maxQueue: this.options.maxQueue
            });
            throw httpError(429, `queue full: ${this.executionQueue.length} requests waiting ` +
                `(max ${this.options.maxQueue}); retry later or use the tab pool`);
        }
        const rec = this.beginRun('sequential', code, opts, { page: opts.pageName });
        if (hooks.onRun) hooks.onRun(rec);

        return new Promise((resolve, reject) => {
            this.executionQueue.push({
                rec, resolve, reject, ctx: log.context(), enqueuedAt: Date.now()
            });
            if (this.isExecuting || this.executionQueue.length > 1) {
                log.info('exec', 'queued behind running task', {
                    run: rec.run, position: this.executionQueue.length
                });
            }
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isExecuting || this.executionQueue.length === 0) return;

        this.isExecuting = true;
        const task = this.executionQueue.shift();

        try {
            // Run in the submitting request's log context (queue hops lose it).
            const result = await log.withContext(task.ctx || {}, () => this.executeTask(task));
            task.resolve(result);
        } catch (error) {
            // executeTask never throws, but never leave a run without an end record.
            this.endRun(task.rec, 'error', this.errorFields(error, { stage: 'queue' }));
            task.reject(error);
        } finally {
            this.isExecuting = false;
            this.processQueue();
        }
    }

    async executeTask(task) {
        const { rec } = task;
        const startTime = Date.now();
        const queuedMs = task.enqueuedAt ? startTime - task.enqueuedAt : 0;
        let stage = 'getPage';
        let page = null;

        try {
            page = await this.browserManager.getPage(rec.opts.pageName);
            const browser = this.browserManager.getBrowser();
            this.throwIfCancelled(rec);
            // Other tabs (pool, popups) may have taken the foreground; a
            // background tab doesn't render, so clicks on it never complete.
            await this.bringToFront(page);

            stage = 'run';
            const result = await this.runCode(page, browser, rec, { queuedMs });
            stage = 'serialize';
            return await this.complete(rec, page, { result, startTime, logExtra: { queuedMs } });
        } catch (error) {
            return this.complete(rec, page, { error, stage, startTime, logExtra: { queuedMs } });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONCURRENT EXECUTION (Tab Pool)
    // ═══════════════════════════════════════════════════════════════════════

    /** Execute code on a specific pool tab (bypasses the sequential queue). */
    async executeOnTab(tabId, code, options = {}, hooks = {}) {
        const opts = this.normalize(options);
        const rec = this.beginRun('tab', code, opts, { tabId });
        if (hooks.onRun) hooks.onRun(rec);
        const startTime = Date.now();
        let stage = 'lookupTab';
        let page = null;

        try {
            if (!this.tabPoolManager) throw httpError(400, 'Tab pool not enabled');
            const tab = this.tabPoolManager.getTab(tabId);
            if (!tab) throw httpError(404, `Tab ${tabId} not found`);
            page = tab.page;

            stage = 'run';
            const result = await this.runCode(page, this.browserManager.getBrowser(), rec);
            stage = 'serialize';
            return await this.complete(rec, page, { result, startTime, tabId });
        } catch (error) {
            const resp = await this.complete(rec, page, { error, stage, startTime, tabId });
            if (stage === 'lookupTab') throw error;  // route maps this to an HTTP error
            return resp;
        }
    }

    /** Acquire a pool tab, execute, release. */
    async executeWithPool(code, options = {}, hooks = {}) {
        const opts = this.normalize(options);
        const rec = this.beginRun('pool', code, opts);
        if (hooks.onRun) hooks.onRun(rec);
        let stage = 'acquireTab';
        let tabId = null;
        let page = null;
        const acquireStart = Date.now();
        let startTime = acquireStart;

        try {
            if (!this.tabPoolManager) throw httpError(400, 'Tab pool not enabled');
            const acquired = await this.tabPoolManager.acquireTab();
            if (!acquired.tabId) throw httpError(503, acquired.error || 'Could not acquire a tab');
            tabId = acquired.tabId;
            page = acquired.page;
            rec.tabId = tabId;
            startTime = Date.now();
            this.throwIfCancelled(rec);

            stage = 'run';
            const result = await this.runCode(page, this.browserManager.getBrowser(), rec,
                { tabId, acquireMs: startTime - acquireStart });
            stage = 'serialize';
            return await this.complete(rec, page, { result, startTime, tabId });
        } catch (error) {
            const resp = await this.complete(rec, page, { error, stage, startTime, tabId });
            if (stage === 'acquireTab') throw error;  // route maps this to an HTTP error
            return resp;
        } finally {
            if (tabId) await this.tabPoolManager.releaseTab(tabId);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CANCELLATION
    // ═══════════════════════════════════════════════════════════════════════

    throwIfCancelled(rec) {
        if (rec.cancelRequested) {
            const err = new Error(`Execution cancelled (${rec.cancelRequested})`);
            err.isCancelled = true;
            throw err;
        }
    }

    /**
     * Cancel a run: abort it if executing, drop it if queued, or mark it so it
     * stops right after it gets its page/tab. Returns false if not running.
     */
    cancelRun(run, reason = 'cancelled') {
        const rec = this.running.get(Number(run));
        if (!rec) return false;
        rec.cancelRequested = reason;
        if (rec.scope) {
            rec.scope.abort(reason);
            return true;
        }
        const i = this.executionQueue.findIndex(t => t.rec === rec);
        if (i >= 0) {
            const [task] = this.executionQueue.splice(i, 1);
            const err = new Error(`Execution cancelled (${reason})`);
            err.isCancelled = true;
            log.withContext(task.ctx || {}, () => this.complete(rec, null, { error: err, stage: 'queue',
                startTime: Date.now() })).then(task.resolve, task.reject);
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SHARED
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Run code on a page with timeout, inside a RunScope (abortable page/browser
     * proxies, per-run cleanup, captured console, page events, uploads). On
     * timeout/cancel the snippet is aborted and given `abortGraceMs` to stop
     * before the tab or queue slot is handed on. Returns the raw result.
     */
    async runCode(page, browser, rec, extra = {}) {
        const opts = rec.opts;
        rec.pageUrl = safeUrl(page);
        rec.execStartedAt = Date.now();
        const reconnect = (log.context() || {}).reconnect;
        log.exec({ event: 'exec', run: rec.run, req: rec.req, url: rec.pageUrl, reconnect, ...extra });

        const scope = new RunScope({ run: rec.run, persist: opts.persist, keepTabs: opts.keepTabs });
        rec.scope = scope;
        installDialogHandler(page, rec.tabId || rec.page || 'page');
        registerScope(page, scope);
        scope.startTracking(page, browser, { pageEvents: opts.pageEvents });

        let timer;
        let fnPromise = null;
        let uploadDir = null;
        try {
            const fn = new AsyncFunction('page', 'browser', 'helpers', 'console', rec.code);
            let files = {};
            if (opts.files) ({ files, dir: uploadDir } = this.writeUploads(rec, opts.files));
            const wrappedPage = scope.wrapPage(page);
            const helpers = createHelpers(wrappedPage, scope, { rawBrowser: browser, files, artifacts: this.artifacts });
            fnPromise = fn(wrappedPage, scope.wrapBrowser(browser), helpers, scope.console);
            // Never let a late rejection from an orphaned snippet go unhandled.
            fnPromise.catch(() => {});

            const result = await Promise.race([
                fnPromise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const err = new Error(`Execution timeout after ${opts.timeout}ms`);
                        err.isTimeout = true;
                        scope.abort('timeout');
                        reject(err);
                    }, opts.timeout);
                }),
                new Promise((_, reject) => {
                    scope.signal.addEventListener('abort', () => {
                        if (scope.abortReason === 'timeout') return;  // handled above
                        const err = new Error(`Execution cancelled (${scope.abortReason})`);
                        err.isCancelled = true;
                        reject(err);
                    }, { once: true });
                })
            ]);
            clearTimeout(timer);
            await this.finishScope(page, scope, null, 0, uploadDir);
            return result;
        } catch (error) {
            clearTimeout(timer);
            await this.finishScope(page, scope, scope.aborted ? fnPromise : null, opts.abortGraceMs, uploadDir);
            throw error;
        }
    }

    /** Write request `files` to a per-run temp dir; returns { files: name->path, dir }. */
    writeUploads(rec, files) {
        const dir = path.join(this.artifacts.dir(), 'uploads', `run-${rec.run}`);
        fs.mkdirSync(dir, { recursive: true });
        const out = {};
        for (const [name, spec] of Object.entries(files)) {
            const { data, filename } = typeof spec === 'string' ? { data: spec, filename: name } : (spec || {});
            if (typeof data !== 'string') throw httpError(400, `files.${name}: expected base64 string or { data, filename }`);
            const file = path.join(dir, path.basename(String(filename || name)));
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            out[name] = file;
        }
        log.info('exec', 'wrote uploaded files', { run: rec.run, files: Object.keys(out), dir });
        return { files: out, dir };
    }

    /**
     * End a run's scope: after an abort, wait (bounded) for the snippet to
     * settle, then undo its page state and remove uploads. Never throws.
     */
    async finishScope(page, scope, abortedPromise, graceMs, uploadDir) {
        if (abortedPromise) {
            const t0 = Date.now();
            let settled = false;
            let graceTimer;
            await Promise.race([
                abortedPromise.then(() => { settled = true; }, () => { settled = true; }),
                new Promise(r => { graceTimer = setTimeout(r, graceMs); })
            ]);
            clearTimeout(graceTimer);
            if (settled) {
                scope.settledAfterAbortMs = Date.now() - t0;
                log.info('exec', 'aborted snippet stopped', { run: scope.run, settledAfterAbortMs: scope.settledAfterAbortMs });
            } else {
                scope.orphan = true;
                log.warn('exec', 'aborted snippet did not stop within grace period (orphan); its further page calls will fail',
                    { run: scope.run, graceMs });
                abortedPromise.then(
                    () => log.info('exec', 'orphaned snippet finished', { run: scope.run }),
                    e => log.info('exec', 'orphaned snippet stopped', { run: scope.run, error: preview(e && e.message, 200) })
                );
            }
        }
        try { await scope.cleanup(); }
        catch (e) { log.warn('exec', 'scope cleanup failed', { run: scope.run, error: e.message }); }
        if (uploadDir) {
            try { fs.rmSync(uploadDir, { recursive: true, force: true }); }
            catch (e) { log.debug('exec', 'could not remove upload dir', { dir: uploadDir, error: e.message }); }
        }
        scope.ended = true;
        unregisterScope(page, scope);
    }

    /**
     * Build the response for a finished run (success or failure), add session
     * and browser facts, record the run's end, and return the response.
     */
    async complete(rec, page, { result, error, stage, startTime, tabId, logExtra = {} }) {
        const opts = rec.opts;
        const resp = { success: !error };
        const endFields = { ...logExtra };

        if (!error) {
            let processed;
            try {
                processed = this.processResult(result, opts.returnType);
                processed = this.spill(rec, processed);
            } catch (e) {
                error = e;
                stage = 'serialize';
                resp.success = false;
            }
            if (!error) {
                resp.result = processed;
                const endUrl = page ? safeUrl(page) : undefined;
                Object.assign(endFields, {
                    execMs: rec.execStartedAt ? Date.now() - rec.execStartedAt : undefined,
                    resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
                    resultBytes: sizeOf(processed),
                    artifact: processed && processed.$artifact ? processed.$artifact : undefined,
                    url: endUrl !== rec.pageUrl ? endUrl : undefined
                });
            }
        }
        if (error) {
            resp.error = error.message;
            resp.stack = error.stack;
            if (error.isCancelled) resp.cancelled = true;
        }
        if (tabId) resp.tabId = tabId;
        resp.run = rec.run;
        resp.duration = Date.now() - (startTime || rec.startedAt);
        if (opts.timeoutCappedTo) resp.timeoutCappedTo = opts.timeoutCappedTo;

        // Browser/session facts gathered while getting the page.
        const ctx = log.context() || {};
        if (ctx.reconnect) {
            resp.reconnected = { ok: ctx.reconnect.ok, attempts: ctx.reconnect.attempts, ms: ctx.reconnect.ms };
        }
        if (ctx.browserRestarted) resp.browserRestarted = ctx.browserRestarted;
        if (ctx.tabCrashed) resp.tabCrashed = ctx.tabCrashed;

        if (page && this.loginRe) {
            const url = safeUrl(page);
            if (url && this.loginRe.test(url)) {
                resp.sessionExpired = true;
                resp.sessionUrl = url;
                log.warn('exec', 'run ended on a login page: session looks expired', { run: rec.run, url });
            }
        }

        if (error && opts.screenshotOnError && page) {
            const shot = await this.safeScreenshot(page);
            if (shot.data) resp.errorScreenshot = toBinaryRecord(shot.data);
            else resp.errorScreenshotError = shot.error;
        }

        Object.assign(resp, rec.scope ? rec.scope.responseFields() : {});

        const sessionFields = {
            reconnected: resp.reconnected, browserRestarted: resp.browserRestarted, tabCrashed: resp.tabCrashed,
            sessionExpired: resp.sessionExpired, sessionUrl: resp.sessionUrl,
            errorScreenshot: resp.errorScreenshot ? resp.errorScreenshot.bytes + ' bytes' : undefined
        };
        if (error) {
            this.endRun(rec, failStatus(error), this.errorFields(error, { stage, tabId, ...endFields, ...sessionFields }));
        } else {
            this.endRun(rec, 'ok', { ...endFields, ...sessionFields });
        }
        return resp;
    }

    async bringToFront(page) {
        let timer;
        try {
            await Promise.race([
                page.bringToFront(),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), 2000); })
            ]);
        } catch (err) {
            log.debug('exec', 'bringToFront failed', { error: err.message });
        } finally {
            clearTimeout(timer);
        }
    }

    async safeScreenshot(page) {
        let timer;
        try {
            const data = await Promise.race([
                page.screenshot({ type: 'png' }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('screenshot timed out')), this.options.screenshotTimeoutMs);
                })
            ]);
            return { data };
        } catch (err) {
            return { error: err.message };
        } finally {
            clearTimeout(timer);
        }
    }

    /** Replace a result larger than `resultMaxBytes` with an artifact reference. */
    spill(rec, value) {
        const max = rec.opts.resultMaxBytes;
        if (!max || max <= 0 || value == null) return value;
        let item = null;
        if (value && value.$binary === 'base64' && typeof value.data === 'string') {
            if (value.bytes > max) item = this.artifacts.store(Buffer.from(value.data, 'base64'), { run: rec.run });
        } else {
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            if (Buffer.byteLength(text) > max) {
                item = this.artifacts.store(text, {
                    run: rec.run, contentType: typeof value === 'string' ? 'text/plain' : 'application/json'
                });
            }
        }
        if (!item) return value;
        log.info('exec', 'result spilled to artifact', { run: rec.run, artifact: item.id, bytes: item.bytes, max });
        return ArtifactStore.ref(item);
    }

    /**
     * Process result for serialization
     */
    processResult(result, returnType) {
        if (result === undefined || result === null) return null;
        if (returnType === 'none') return null;
        if (returnType === 'text') return String(result);

        if (returnType === 'json' || returnType === 'auto') {
            // Binary data (screenshots, PDFs, ...) → base64 instead of a JSON
            // array of numbers.
            result = encodeBinary(result);
            try {
                if (typeof result === 'function') return '[Function]';
                if (result instanceof Error) return { error: result.message, stack: result.stack };
                JSON.stringify(result);
                return result;
            } catch {
                return String(result);
            }
        }
        return result;
    }

    /**
     * Get queue status
     */
    getStatus() {
        const status = {
            isExecuting: this.isExecuting,
            queueLength: this.executionQueue.length,
            maxQueue: this.options.maxQueue,
            running: this.running.size
        };
        if (this.tabPoolManager) status.pool = this.tabPoolManager.getStatus();
        return status;
    }

    /**
     * Clear pending executions and abort the running sequential run.
     */
    clearQueue() {
        const cleared = this.executionQueue.length;
        let aborted = 0;
        for (const rec of this.running.values()) {
            if (rec.mode === 'sequential' && rec.scope && !rec.scope.aborted) {
                rec.cancelRequested = 'queue cleared';
                rec.scope.abort('queue cleared');
                aborted++;
            }
        }
        log.warn('exec', 'queue cleared', { cleared, aborted, running: this.isExecuting });
        this.executionQueue.forEach(task => {
            this.endRun(task.rec, 'cancelled', { error: 'Queue cleared' });
            task.reject(new Error('Queue cleared'));
        });
        this.executionQueue = [];
        return cleared;
    }
}

function stripUndefined(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v;
    return out;
}

module.exports = CodeExecutor;
module.exports.encodeBinary = encodeBinary;
