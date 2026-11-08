/**
 * Code Executor
 *
 * Safely executes JavaScript code with Puppeteer context.
 * Supports both sequential (legacy) and concurrent (tab pool) execution.
 */

const log = require('./logger');
const { preview, sizeOf } = log;
const { RunScope, registerScope, unregisterScope, installDialogHandler } = require('./run-scope');

// AsyncFunction constructor for creating async functions from strings
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// After a run is aborted, wait this long for the snippet to actually stop
// before handing its tab / queue slot to the next run.
const DEFAULT_ABORT_GRACE_MS = 5000;

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

/** Response fields contributed by the run's scope (logs, dialogs, ...). */
function scopeFields(rec) {
    return rec && rec.scope ? rec.scope.responseFields() : {};
}

class CodeExecutor {
    constructor(browserManager, tabPoolManager = null) {
        this.browserManager = browserManager;
        this.tabPoolManager = tabPoolManager;

        // Legacy sequential queue (backward compatibility)
        this.executionQueue = [];
        this.isExecuting = false;

        // What's running right now — reported if the CDP connection drops.
        this.running = new Map();   // run -> run record (see beginRun)
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
    // RUN LIFECYCLE (execution log)
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Every code execution is a "run". beginRun() is called as soon as the
    // request reaches the executor — before queueing, tab acquisition or page
    // lookup — and synchronously appends a `start` record with the FULL code to
    // the executions JSONL. endRun() is called exactly once on every path
    // (ok / error / timeout / cancelled) with the outcome. So any failure, even
    // one before the code itself starts, is tied to its request and code.

    beginRun(mode, code, meta = {}) {
        const run = ++this.runCounter;
        const ctx = log.context() || {};
        const rec = {
            run, req: ctx.reqId, method: ctx.method, path: ctx.path, mode,
            ...meta, startedAt: Date.now(), code
        };
        log.exec({
            event: 'start', run, req: rec.req, method: rec.method, path: rec.path, mode,
            ...meta, codeChars: code.length, code
        });
        log.info('exec', 'start', { run, mode, ...meta, codeChars: code.length, code: preview(code, 120) });
        this.running.set(run, rec);
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
        if (scoped.logs) rest.logLines = scoped.logs.length;
        if (scoped.dialogs) rest.dialogs = scoped.dialogs.length;
        const level = status === 'ok' ? 'info' : 'warn';
        const orphan = rec.scope && rec.scope.orphan;
        const msg = status === 'timeout'
            ? (orphan ? 'timeout — snippet aborted but still running (orphan)' : 'timeout — snippet aborted')
            : status;
        log[level]('exec', msg, {
            run: rec.run, ms, ...rest,
            error: rest.error ? preview(rest.error, 300) : undefined,
            stack: status === 'error' ? stack : undefined
        });
    }

    errorFields(error, extra = {}) {
        return {
            error: error && error.message ? error.message : String(error),
            stack: error && error.stack,
            browserConnected: this.browserManager.isRunning(),
            reconnect: (log.context() || {}).reconnect,
            ...extra
        };
    }

    /**
     * Execute code with Puppeteer context (LEGACY - sequential)
     * @param {string} code - JavaScript code to execute
     * @param {object} options - Execution options
     * @returns {Promise<object>} Execution result
     */
    async execute(code, options = {}) {
        const {
            pageName = 'main',
            timeout = 30000,
            returnType = 'auto', // 'auto', 'json', 'text', 'none'
            persist = false,
            abortGraceMs = DEFAULT_ABORT_GRACE_MS
        } = options;

        const rec = this.beginRun('sequential', code, { page: pageName, timeoutMs: timeout, returnType,
            persist: persist || undefined });
        rec.runOpts = { persist, abortGraceMs };

        // Queue the execution
        return new Promise((resolve, reject) => {
            this.executionQueue.push({
                rec,
                code,
                pageName,
                timeout,
                returnType,
                resolve,
                reject,
                ctx: log.context(),
                enqueuedAt: Date.now()
            });
            if (this.isExecuting || this.executionQueue.length > 1) {
                log.info('exec', 'queued behind running task', {
                    run: rec.run, position: this.executionQueue.length
                });
            }
            this.processQueue();
        });
    }

    /**
     * Process execution queue sequentially (LEGACY)
     */
    async processQueue() {
        if (this.isExecuting || this.executionQueue.length === 0) {
            return;
        }

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
            this.processQueue(); // Process next in queue
        }
    }

    /**
     * Execute a single task (LEGACY)
     */
    async executeTask(task) {
        const { rec, code, pageName, timeout, returnType } = task;

        const startTime = Date.now();
        const queuedMs = task.enqueuedAt ? startTime - task.enqueuedAt : 0;
        let stage = 'getPage';

        try {
            // Get page and browser
            const page = await this.browserManager.getPage(pageName);
            const browser = this.browserManager.getBrowser();

            stage = 'run';
            const result = await this.runCode(page, browser, code, timeout, rec, { queuedMs });

            // Process result based on returnType
            stage = 'serialize';
            const processedResult = this.processResult(result, returnType);

            return {
                success: true,
                result: processedResult,
                run: rec.run,
                duration: Date.now() - startTime,
                ...scopeFields(rec)
            };
        } catch (error) {
            this.endRun(rec, failStatus(error), this.errorFields(error, { stage, queuedMs }));
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                run: rec.run,
                duration: Date.now() - startTime,
                ...scopeFields(rec)
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONCURRENT EXECUTION (Tab Pool)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Execute code on a specific tab (CONCURRENT mode)
     * Does NOT use the sequential queue.
     *
     * @param {string} tabId - Tab identifier
     * @param {string} code - JavaScript code to execute
     * @param {object} options - Execution options
     * @returns {Promise<object>} Execution result
     */
    async executeOnTab(tabId, code, options = {}) {
        const { timeout = 30000, returnType = 'auto', persist = false,
            abortGraceMs = DEFAULT_ABORT_GRACE_MS } = options;
        const rec = this.beginRun('tab', code, { tabId, timeoutMs: timeout, returnType,
            persist: persist || undefined });
        rec.runOpts = { persist, abortGraceMs };
        const startTime = Date.now();
        let stage = 'lookupTab';

        try {
            if (!this.tabPoolManager) {
                throw new Error('Tab pool manager not configured');
            }
            const tab = this.tabPoolManager.getTab(tabId);
            if (!tab) {
                throw new Error(`Tab ${tabId} not found`);
            }

            stage = 'run';
            const browser = this.browserManager.getBrowser();
            const result = await this.runCode(tab.page, browser, code, timeout, rec);
            stage = 'serialize';
            const processedResult = this.processResult(result, returnType);

            return {
                success: true,
                result: processedResult,
                tabId,
                run: rec.run,
                duration: Date.now() - startTime,
                ...scopeFields(rec)
            };
        } catch (error) {
            this.endRun(rec, failStatus(error), this.errorFields(error, { stage }));
            if (stage === 'lookupTab') throw error;  // route maps this to a 500, as before
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                tabId,
                run: rec.run,
                duration: Date.now() - startTime,
                ...scopeFields(rec)
            };
        }
    }

    /**
     * Execute code with automatic tab acquisition/release.
     * Acquires a tab, executes the code, then releases the tab.
     *
     * @param {string} code - JavaScript code to execute
     * @param {object} options - Execution options
     * @returns {Promise<object>} Execution result with tabId
     */
    async executeWithPool(code, options = {}) {
        const { timeout = 30000, returnType = 'auto', persist = false,
            abortGraceMs = DEFAULT_ABORT_GRACE_MS } = options;
        const rec = this.beginRun('pool', code, { timeoutMs: timeout, returnType,
            persist: persist || undefined });
        rec.runOpts = { persist, abortGraceMs };
        let stage = 'acquireTab';
        let tabId = null;
        const acquireStart = Date.now();
        let startTime = acquireStart;

        try {
            if (!this.tabPoolManager) {
                throw new Error('Tab pool manager not configured');
            }
            const acquired = await this.tabPoolManager.acquireTab();
            if (!acquired.tabId) {
                throw new Error(acquired.error || 'Could not acquire a tab');
            }
            tabId = acquired.tabId;
            rec.tabId = tabId;
            startTime = Date.now();

            stage = 'run';
            const browser = this.browserManager.getBrowser();
            const result = await this.runCode(acquired.page, browser, code, timeout, rec,
                { tabId, acquireMs: startTime - acquireStart });
            stage = 'serialize';
            const processedResult = this.processResult(result, returnType);

            return {
                success: true,
                result: processedResult,
                tabId,
                run: rec.run,
                duration: Date.now() - startTime,
                ...scopeFields(rec)
            };
        } catch (error) {
            this.endRun(rec, failStatus(error), this.errorFields(error, { stage, tabId }));
            if (stage === 'acquireTab') throw error;  // route maps this to a 500, as before
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                tabId,
                run: rec.run,
                duration: Date.now() - startTime,
                ...scopeFields(rec)
            };
        } finally {
            if (tabId) await this.tabPoolManager.releaseTab(tabId);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SHARED HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Run code on a page with timeout, inside a RunScope (abortable page/browser
     * proxies, per-run cleanup, captured console). Records the run's `ok` end;
     * failures propagate to the caller, which records them (with the failing
     * stage). On timeout/cancel the snippet is aborted and given
     * `abortGraceMs` to stop before the tab or queue slot is handed on.
     */
    async runCode(page, browser, code, timeout, rec, extra = {}) {
        let pageUrl;
        try { pageUrl = page.url(); } catch { pageUrl = undefined; }
        rec.execStartedAt = Date.now();
        const reconnect = (log.context() || {}).reconnect;
        log.exec({ event: 'exec', run: rec.run, req: rec.req, url: pageUrl, reconnect, ...extra });

        const { persist = false, abortGraceMs = DEFAULT_ABORT_GRACE_MS } = rec.runOpts || {};
        const scope = new RunScope({ run: rec.run, persist });
        rec.scope = scope;
        installDialogHandler(page, rec.tabId || rec.page || 'page');
        registerScope(page, scope);

        let timer;
        let fnPromise = null;
        try {
            const fn = new AsyncFunction('page', 'browser', 'helpers', 'console', code);
            const wrappedPage = scope.wrapPage(page);
            const helpers = this.createHelpers(wrappedPage, scope);
            fnPromise = fn(wrappedPage, scope.wrapBrowser(browser), helpers, scope.console);
            // Never let a late rejection from an orphaned snippet go unhandled.
            fnPromise.catch(() => {});

            const result = await Promise.race([
                fnPromise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const err = new Error(`Execution timeout after ${timeout}ms`);
                        err.isTimeout = true;
                        scope.abort('timeout');
                        reject(err);
                    }, timeout);
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
            await this.finishScope(page, scope, null, 0);

            let endUrl;
            try { endUrl = page.url(); } catch { endUrl = undefined; }
            this.endRun(rec, 'ok', {
                execMs: Date.now() - rec.execStartedAt,
                resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
                resultBytes: sizeOf(result),
                url: endUrl !== pageUrl ? endUrl : undefined
            });
            return result;
        } catch (error) {
            clearTimeout(timer);
            await this.finishScope(page, scope, scope.aborted ? fnPromise : null, abortGraceMs);
            throw error;
        }
    }

    /**
     * End a run's scope: after an abort, wait (bounded) for the snippet to
     * settle, then undo its page state. Never throws.
     */
    async finishScope(page, scope, abortedPromise, graceMs) {
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
        scope.ended = true;
        unregisterScope(page, scope);
    }

    /**
     * Create helper functions available in executed code. `page` is the
     * run's abortable page proxy; sleeps and polls stop when the run aborts.
     */
    createHelpers(page, scope) {
        const sleep = (ms) => new Promise((resolve, reject) => {
            if (scope.aborted) return reject(scope.signal.reason);
            const t = setTimeout(() => { scope.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
            const onAbort = () => { clearTimeout(t); reject(scope.signal.reason); };
            scope.signal.addEventListener('abort', onAbort, { once: true });
        });
        return {
            // Aborted when the run times out or is cancelled.
            signal: scope.signal,

            // Throws if the run has been aborted — call it in long loops.
            checkAborted: () => scope.check(),

            // Wait for a specified time (rejects if the run is aborted)
            wait: sleep,

            // Smart wait: polls until condition is true or maxWait reached
            waitUntil: async (conditionFn, maxWaitMs = 8000, pollIntervalMs = 500) => {
                const startTime = Date.now();
                while (Date.now() - startTime < maxWaitMs) {
                    try {
                        const ready = await conditionFn();
                        if (ready) return true;
                    } catch {
                        // Condition threw, keep waiting (unless the run was aborted)
                        scope.check();
                    }
                    await sleep(pollIntervalMs);
                }
                return false;
            },

            // Wait for page content to be ready (smart wait with early exit)
            waitForContent: async (options = {}) => {
                const {
                    maxWaitMs = 8000,
                    pollIntervalMs = 500,
                    minContentLength = 2000,
                    noLoadingText = true
                } = options;

                const startTime = Date.now();
                while (Date.now() - startTime < maxWaitMs) {
                    const ready = await page.evaluate((minLen, checkLoading) => {
                        const text = document.body?.innerText || '';
                        const hasEnoughContent = text.length > minLen;
                        const isLoading = checkLoading && text.includes('Loading') && text.length < 5000;
                        return hasEnoughContent && !isLoading;
                    }, minContentLength, noLoadingText);

                    if (ready) return true;
                    await sleep(pollIntervalMs);
                }
                return false;
            },

            // Safe text extraction
            getText: async (selector) => {
                try {
                    const element = await page.$(selector);
                    if (!element) return null;
                    return page.evaluate(el => el.textContent, element);
                } catch {
                    scope.check();
                    return null;
                }
            },

            // Safe attribute extraction
            getAttr: async (selector, attr) => {
                try {
                    const element = await page.$(selector);
                    if (!element) return null;
                    return page.evaluate((el, a) => el.getAttribute(a), element, attr);
                } catch {
                    scope.check();
                    return null;
                }
            },

            // Extract all matching elements' text
            getAllText: async (selector) => {
                return page.$$eval(selector, els => els.map(el => el.textContent));
            },

            // Check if element exists
            exists: async (selector) => {
                const element = await page.$(selector);
                return element !== null;
            },

            // Wait for selector with custom timeout
            waitFor: async (selector, timeout = 10000) => {
                try {
                    await page.waitForSelector(selector, { timeout });
                    return true;
                } catch {
                    scope.check();
                    return false;
                }
            },

            // Get current URL
            getUrl: () => page.url(),

            // Get page title
            getTitle: async () => page.title(),

            // Extract JSON from page (useful for API responses)
            getJson: async () => {
                const content = await page.evaluate(() => document.body.innerText);
                try {
                    return JSON.parse(content);
                } catch {
                    scope.check();
                    return null;
                }
            },

            // Take screenshot and return as base64
            screenshot: async (options = {}) => {
                const buffer = await page.screenshot({ encoding: 'base64', ...options });
                return buffer;
            }
        };
    }

    /**
     * Process result for serialization
     */
    processResult(result, returnType) {
        if (result === undefined || result === null) {
            return null;
        }

        if (returnType === 'none') {
            return null;
        }

        if (returnType === 'text') {
            return String(result);
        }

        if (returnType === 'json' || returnType === 'auto') {
            // Binary data (screenshots, PDFs, ...) → base64 instead of a JSON
            // array of numbers.
            result = encodeBinary(result);
            // Try to serialize
            try {
                // Handle common non-serializable types
                if (typeof result === 'function') {
                    return '[Function]';
                }
                if (result instanceof Error) {
                    return { error: result.message, stack: result.stack };
                }
                // Test if serializable
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
            queueLength: this.executionQueue.length
        };

        if (this.tabPoolManager) {
            status.pool = this.tabPoolManager.getStatus();
        }

        return status;
    }

    /**
     * Clear pending executions
     */
    clearQueue() {
        const cleared = this.executionQueue.length;
        // Also abort the sequential run that is executing right now.
        let aborted = 0;
        for (const rec of this.running.values()) {
            if (rec.mode === 'sequential' && rec.scope && !rec.scope.aborted) {
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

module.exports = CodeExecutor;
module.exports.encodeBinary = encodeBinary;
