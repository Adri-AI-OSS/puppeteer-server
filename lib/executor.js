/**
 * Code Executor
 *
 * Safely executes JavaScript code with Puppeteer context.
 * Supports both sequential (legacy) and concurrent (tab pool) execution.
 */

const log = require('./logger');
const { preview, sizeOf } = log;

// AsyncFunction constructor for creating async functions from strings
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Browser methods that would tear down the server's shared connection/browser.
const BLOCKED_BROWSER_METHODS = new Set(['disconnect', 'close']);

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
        log.exec({ event: 'end', run: rec.run, req: rec.req, status, ms, ...rest, stack });
        const level = status === 'ok' ? 'info' : 'warn';
        const msg = status === 'timeout' ? 'timeout — snippet may still be running in the background' : status;
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
            returnType = 'auto' // 'auto', 'json', 'text', 'none'
        } = options;

        const rec = this.beginRun('sequential', code, { page: pageName, timeoutMs: timeout, returnType });

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
                duration: Date.now() - startTime
            };
        } catch (error) {
            this.endRun(rec, error.isTimeout ? 'timeout' : 'error', this.errorFields(error, { stage, queuedMs }));
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                run: rec.run,
                duration: Date.now() - startTime
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
        const { timeout = 30000, returnType = 'auto' } = options;
        const rec = this.beginRun('tab', code, { tabId, timeoutMs: timeout, returnType });
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
                duration: Date.now() - startTime
            };
        } catch (error) {
            this.endRun(rec, error.isTimeout ? 'timeout' : 'error', this.errorFields(error, { stage }));
            if (stage === 'lookupTab') throw error;  // route maps this to a 500, as before
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                tabId,
                run: rec.run,
                duration: Date.now() - startTime
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
        const { timeout = 30000, returnType = 'auto' } = options;
        const rec = this.beginRun('pool', code, { timeoutMs: timeout, returnType });
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
                duration: Date.now() - startTime
            };
        } catch (error) {
            this.endRun(rec, error.isTimeout ? 'timeout' : 'error', this.errorFields(error, { stage, tabId }));
            if (stage === 'acquireTab') throw error;  // route maps this to a 500, as before
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                tabId,
                run: rec.run,
                duration: Date.now() - startTime
            };
        } finally {
            if (tabId) await this.tabPoolManager.releaseTab(tabId);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SHARED HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Run code on a page with timeout. Records the run's `ok` end; failures
     * propagate to the caller, which records them (with the failing stage).
     */
    async runCode(page, browser, code, timeout, rec, extra = {}) {
        let pageUrl;
        try { pageUrl = page.url(); } catch { pageUrl = undefined; }
        rec.execStartedAt = Date.now();
        log.exec({ event: 'exec', run: rec.run, req: rec.req, url: pageUrl, ...extra });

        let timer;
        try {
            // Create async function from code string
            const fn = new AsyncFunction(
                'page',
                'browser',
                'helpers',
                code
            );

            // Create helpers object with utility functions
            const helpers = this.createHelpers(page);

            // Execute with timeout
            const result = await Promise.race([
                fn(page, this.guardBrowser(browser), helpers),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const err = new Error('Execution timeout');
                        err.isTimeout = true;
                        reject(err);
                    }, timeout);
                })
            ]);

            let endUrl;
            try { endUrl = page.url(); } catch { endUrl = undefined; }
            this.endRun(rec, 'ok', {
                execMs: Date.now() - rec.execStartedAt,
                resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
                resultBytes: sizeOf(result),
                url: endUrl !== pageUrl ? endUrl : undefined
            });
            return result;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Wrap the shared Browser so snippets can't disconnect or close it — doing
     * so leaves the server without a connection for every later request.
     */
    guardBrowser(browser) {
        if (!browser) return browser;
        return new Proxy(browser, {
            get(target, prop) {
                if (BLOCKED_BROWSER_METHODS.has(prop)) {
                    return () => {
                        log.warn('exec', `blocked browser.${String(prop)}() from snippet`);
                        throw new Error(
                            `browser.${String(prop)}() is not allowed in executed code: ` +
                            'the server owns the shared browser connection. Use POST /reconnect ' +
                            'or POST /shutdown instead.'
                        );
                    };
                }
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    }

    /**
     * Create helper functions available in executed code
     */
    createHelpers(page) {
        return {
            // Wait for a specified time
            wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

            // Smart wait: polls until condition is true or maxWait reached
            waitUntil: async (conditionFn, maxWaitMs = 8000, pollIntervalMs = 500) => {
                const startTime = Date.now();
                while (Date.now() - startTime < maxWaitMs) {
                    try {
                        const ready = await conditionFn();
                        if (ready) return true;
                    } catch {
                        // Condition threw, keep waiting
                    }
                    await new Promise(r => setTimeout(r, pollIntervalMs));
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
                    await new Promise(r => setTimeout(r, pollIntervalMs));
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
        log.warn('exec', 'queue cleared', { cleared, running: this.isExecuting });
        this.executionQueue.forEach(task => {
            this.endRun(task.rec, 'cancelled', { error: 'Queue cleared' });
            task.reject(new Error('Queue cleared'));
        });
        this.executionQueue = [];
        return cleared;
    }
}

module.exports = CodeExecutor;
