const crypto = require('crypto');
const express = require('express');
const log = require('./logger');
const { preview } = log;
const { JobStore } = require('./jobs');
const { WatchManager } = require('./watch');

/**
 * HTTP Server
 *
 * Exposes endpoints for executing Puppeteer code and managing browser state.
 * Supports both legacy sequential execution and concurrent tab pool execution.
 */

class Server {
    constructor(executor, browserManager, options = {}) {
        this.executor = executor;
        this.browserManager = browserManager;
        this.tabPoolManager = options.tabPoolManager || null;
        this.options = {
            port: 3000,
            host: 'localhost',
            ...options
        };

        this.app = express();
        this.server = null;
        this.requestCounter = 0;
        this.jobs = new JobStore({ ttlMs: this.options.jobTtlMs });
        this.watches = new WatchManager(browserManager, this.tabPoolManager);
        this.artifacts = executor.artifacts;
        // "Ready" = the user finished logging in (ENTER in the terminal, or
        // POST /ready, or --no-prompt). Requests are accepted either way.
        this.ready = false;
        this.readyInfo = null;
        this._readyWaiters = [];
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandler();
    }

    /**
     * Set the tab pool manager (can be set after construction)
     */
    setTabPoolManager(tabPoolManager) {
        this.tabPoolManager = tabPoolManager;
        this.watches.tabPoolManager = tabPoolManager;
        if (this.executor) {
            this.executor.setTabPoolManager(tabPoolManager);
        }
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // Request context + logging. Registered before the body parsers so a
        // malformed/oversized body is still logged against a request id.
        this.app.use((req, res, next) => {
            const reqId = req.get('x-request-id') || `r${++this.requestCounter}`;
            const start = Date.now();
            res.setHeader('X-Request-Id', reqId);

            // Capture the error (if any) from JSON responses for the finish line.
            const origJson = res.json.bind(res);
            res.json = body => {
                if (body && typeof body === 'object' && !Array.isArray(body)) {
                    if (body.error) res.locals.logError = body.error;
                    else if (body.success === false) res.locals.logError = 'success=false';
                }
                return origJson(body);
            };

            res.on('finish', () => {
                const fields = {
                    status: res.statusCode,
                    ms: Date.now() - start,
                    bytes: Number(res.get('content-length')) || undefined,
                    // Full error + stack live in the executions JSONL (by run=).
                    error: res.locals.logError ? preview(res.locals.logError, 300) : undefined
                };
                const level = res.statusCode >= 500 || res.locals.logError ? 'warn' : 'info';
                // Polling endpoints are noisy; keep them at debug when healthy.
                const quiet = level === 'info' && /^\/(health|status|pool\/status)$/.test(req.path);
                log[quiet ? 'debug' : level]('http', `<- ${req.method} ${req.path}`, fields);
            });
            res.on('close', () => {
                if (!res.writableFinished) {
                    log.warn('http', `client went away before response: ${req.method} ${req.path}`, {
                        ms: Date.now() - start
                    });
                }
            });

            log.withContext({ reqId, method: req.method, path: req.path }, next);
        });

        // Optional bearer token (--token). GET /health stays open for liveness probes.
        if (this.options.token) {
            const expected = Buffer.from(String(this.options.token));
            this.app.use((req, res, next) => {
                if (req.method === 'OPTIONS' || (req.method === 'GET' && req.path === '/health')) return next();
                const header = req.get('authorization') || '';
                const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : (req.get('x-auth-token') || ''));
                if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
                log.warn('http', 'rejected: missing or wrong token', { client: req.ip });
                res.status(401).json({ error: 'unauthorized: send Authorization: Bearer <token>' });
            });
        }

        this.app.use(express.json({ limit: this.options.bodyLimit || '50mb' }));
        this.app.use(express.text({ limit: this.options.bodyLimit || '50mb' }));

        // Log the request with its route-relevant details (after body parsing).
        this.app.use((req, res, next) => {
            const fields = { client: req.ip };
            if (Object.keys(req.query || {}).length) fields.query = req.query;
            const body = req.body;
            if (typeof body === 'string' && body.length) {
                fields.codeChars = body.length;
                fields.code = preview(body, 200);
            } else if (body && typeof body === 'object' && Object.keys(body).length) {
                const { code, ...rest } = body;
                if (code !== undefined) {
                    fields.codeChars = String(code).length;
                    fields.code = preview(code, 200);
                }
                if (Object.keys(rest).length) fields.body = rest;
            }
            const quiet = /^\/(health|status|pool\/status)$/.test(req.path);
            log[quiet ? 'debug' : 'info']('http', `-> ${req.method} ${req.path}`, fields);
            next();
        });

        // CORS for local development
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token, X-Request-Id');
            res.header('Access-Control-Expose-Headers', 'X-Request-Id, X-Run-Id');
            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }
            next();
        });
    }

    /**
     * Setup API routes
     */
    setupRoutes() {
        // ═══════════════════════════════════════════════════════════════════
        // LEGACY ENDPOINTS (Sequential Execution)
        // ═══════════════════════════════════════════════════════════════════

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                browser: this.browserManager.isRunning(),
                browserInfo: this.browserManager.describe(),
                queue: this.executor.getStatus(),
                ready: this.ready,
                readyInfo: this.readyInfo || undefined,
                auth: this.options.token ? 'token' : 'none',
                logFile: log.getLogFilePath(),
                executionsFile: log.getExecFilePath(),
                uptimeSec: Math.round(process.uptime())
            });
        });

        // Execute code (legacy sequential). `async: true` -> 202 + job id.
        this.app.post('/execute', (req, res) =>
            this.runExecution(req, res, 'execute', (code, options, hooks) => this.executor.execute(code, options, hooks)));

        // Execute and return the raw result (legacy sequential)
        this.app.post('/run', (req, res) =>
            this.runExecution(req, res, 'run', (code, options, hooks) => this.executor.execute(code, options, hooks),
                { raw: true }));

        // Navigate to URL
        this.app.post('/goto', async (req, res) => {
            try {
                const { url, waitUntil = 'networkidle2' } = req.body;

                if (!url) {
                    return res.status(400).json({ error: 'No URL provided' });
                }

                const code = `
                    await page.goto(${JSON.stringify(url)}, {
                        waitUntil: ${JSON.stringify(waitUntil)},
                        timeout: 30000
                    });
                    return { url: page.url(), title: await page.title() };
                `;

                const result = await this.executor.execute(code);
                res.json(result);
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Get current page info
        this.app.get('/page', async (req, res) => {
            try {
                const code = `
                    return {
                        url: page.url(),
                        title: await page.title()
                    };
                `;
                const result = await this.executor.execute(code);
                res.json(result);
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Get page content/HTML
        this.app.get('/content', async (req, res) => {
            try {
                const code = `return await page.content();`;
                const result = await this.executor.execute(code);
                if (result.success) {
                    res.type('html').send(result.result);
                } else {
                    res.status(500).json({ error: result.error });
                }
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Take screenshot
        this.app.get('/screenshot', async (req, res) => {
            try {
                const { fullPage = false } = req.query;
                const code = `
                    return await page.screenshot({
                        encoding: 'base64',
                        fullPage: ${fullPage === 'true'}
                    });
                `;
                const result = await this.executor.execute(code);
                if (result.success) {
                    const buffer = Buffer.from(result.result, 'base64');
                    res.type('png').send(buffer);
                } else {
                    res.status(500).json({ error: result.error });
                }
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Get cookies
        this.app.get('/cookies', async (req, res) => {
            try {
                const code = `return await page.cookies();`;
                const result = await this.executor.execute(code);
                res.json(result);
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Queue status
        this.app.get('/status', (req, res) => {
            res.json({
                browser: this.browserManager.isRunning(),
                browserInfo: this.browserManager.describe(),
                queue: this.executor.getStatus()
            });
        });

        // Re-attach to the browser (re-uses a running Chrome on the profile,
        // launching only if none is alive). Never kills Chrome.
        this.app.post('/reconnect', async (req, res) => {
            try {
                await this.browserManager.reconnect('POST /reconnect');
                const pages = await this.browserManager.getAllPages();
                res.json({
                    success: true,
                    browser: this.browserManager.isRunning(),
                    pages: pages.map(p => p.url())
                });
            } catch (error) {
                this.fail(res, error, { success: false });
            }
        });

        // Clear queue
        this.app.post('/clear-queue', (req, res) => {
            const cleared = this.executor.clearQueue();
            log.info('http', 'queue cleared via API', { cleared });
            res.json({ cleared });
        });

        // Shutdown (graceful)
        this.app.post('/shutdown', async (req, res) => {
            log.warn('server', 'shutdown requested via API', { client: req.ip });
            res.json({ message: 'Shutting down...' });
            setTimeout(() => this.stop(), 100);
        });

        // ═══════════════════════════════════════════════════════════════════
        // CONCURRENT EXECUTION ENDPOINTS (Tab Pool)
        // ═══════════════════════════════════════════════════════════════════

        // Execute with automatic tab pool management
        this.app.post('/pool/execute', (req, res) => {
            if (!this.tabPoolManager) return res.status(400).json({ error: 'Tab pool not enabled' });
            return this.runExecution(req, res, 'pool/execute',
                (code, options, hooks) => this.executor.executeWithPool(code, options, hooks));
        });

        // Acquire a tab manually
        this.app.post('/pool/acquire', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                const { tabId, page, error } = await this.tabPoolManager.acquireTab();
                if (!tabId) {
                    return res.status(503).json({ error: error || 'No tab available' });
                }
                res.json({
                    tabId,
                    url: page.url()
                });
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Release a tab back to pool
        this.app.post('/pool/release/:tabId', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                await this.tabPoolManager.releaseTab(req.params.tabId);
                res.json({ success: true });
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Execute on a specific tab
        this.app.post('/pool/tab/:tabId/execute', (req, res) => {
            if (!this.tabPoolManager) return res.status(400).json({ error: 'Tab pool not enabled' });
            return this.runExecution(req, res, 'pool/tab/execute',
                (code, options, hooks) => this.executor.executeOnTab(req.params.tabId, code, options, hooks));
        });

        // Close a specific tab
        this.app.delete('/pool/tab/:tabId', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                await this.tabPoolManager.closeTab(req.params.tabId);
                res.json({ success: true });
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Get pool status
        this.app.get('/pool/status', (req, res) => {
            if (!this.tabPoolManager) {
                return res.status(400).json({ error: 'Tab pool not enabled' });
            }

            res.json(this.tabPoolManager.getStatus());
        });

        // Get all tabs info
        this.app.get('/pool/tabs', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                const tabs = await this.tabPoolManager.getTabsInfo();
                res.json(tabs);
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Close all tabs in pool
        this.app.post('/pool/close-all', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                await this.tabPoolManager.closeAll();
                res.json({ success: true });
            } catch (error) {
                this.fail(res, error);
            }
        });

        // Prune idle tabs
        this.app.post('/pool/prune', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                const { maxIdleMs = 60000 } = req.body;
                const closed = await this.tabPoolManager.pruneIdleTabs(maxIdleMs);
                res.json({ closed });
            } catch (error) {
                this.fail(res, error);
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // RUNS, JOBS, WATCHES, ARTIFACTS, READINESS
        // ═══════════════════════════════════════════════════════════════════

        // Recent runs (summaries) and one run's full record.
        this.app.get('/runs', (req, res) => {
            res.json(this.executor.listRuns(Math.min(Number(req.query.limit) || 20, 500)));
        });
        this.app.get('/runs/:id', (req, res) => {
            const run = this.executor.getRun(req.params.id);
            if (!run) return res.status(404).json({ error: `run ${req.params.id} not found` });
            res.json(run);
        });

        // Async jobs (started with `async: true` on an execute route).
        this.app.get('/jobs', (req, res) => res.json(this.jobs.list()));
        this.app.get('/jobs/:id', (req, res) => {
            const job = this.jobs.get(req.params.id);
            if (!job) return res.status(404).json({ error: `job ${req.params.id} not found (or expired)` });
            res.json(this.jobs.view(job));
        });
        this.app.post('/jobs/:id/cancel', (req, res) => {
            const job = this.jobs.get(req.params.id);
            if (!job) return res.status(404).json({ error: `job ${req.params.id} not found (or expired)` });
            if (job.status !== 'running') {
                return res.status(409).json({ error: `job ${job.id} already ${job.status}`, status: job.status });
            }
            const ok = this.executor.cancelRun(job.run, `cancelled via POST /jobs/${job.id}/cancel`);
            log.info('jobs', 'cancel requested', { job: job.id, run: job.run, ok });
            res.json({ jobId: job.id, run: job.run, cancelRequested: ok });
        });

        // Watches: page events across calls.
        this.app.post('/watch', async (req, res) => {
            try {
                const body = req.body && typeof req.body === 'object' ? req.body : {};
                res.json(await this.watches.create(body));
            } catch (error) {
                this.fail(res, error);
            }
        });
        this.app.get('/watch', (req, res) => res.json(this.watches.list()));
        this.app.get('/watch/:id', (req, res) => {
            const out = this.watches.read(req.params.id, { since: req.query.since, limit: req.query.limit });
            if (!out) return res.status(404).json({ error: `watch ${req.params.id} not found (or expired)` });
            res.json(out);
        });
        this.app.delete('/watch/:id', (req, res) => {
            if (!this.watches.delete(req.params.id)) {
                return res.status(404).json({ error: `watch ${req.params.id} not found` });
            }
            res.json({ deleted: true });
        });

        // Large results / downloads written to disk.
        this.app.get('/artifacts/:id', (req, res) => {
            const item = this.artifacts.get(req.params.id);
            if (!item) return res.status(404).json({ error: `artifact ${req.params.id} not found` });
            res.type(item.contentType);
            if (item.name) res.set('Content-Disposition', `inline; filename="${item.name.replace(/"/g, '')}"`);
            res.sendFile(item.path);
        });

        // Tell the server the user has finished logging in (alternative to
        // pressing ENTER in its terminal).
        this.app.post('/ready', (req, res) => {
            const already = this.ready;
            this.markReady('POST /ready');
            res.json({ ready: true, already, readyInfo: this.readyInfo });
        });

        // Test-only hooks (PUPPETEER_SERVER_TEST_HOOKS=1): simulate failures.
        if (process.env.PUPPETEER_SERVER_TEST_HOOKS === '1') {
            log.warn('server', 'test hooks enabled');
            this.app.post('/__test/drop-connection', (req, res) => {
                const t = this.browserManager.transport;
                if (!t || !t.ws) return res.status(409).json({ error: 'no transport' });
                t.ws.terminate();   // abnormal close (1006), like a dropped socket
                res.json({ dropped: true });
            });
        }
    }

    /**
     * Log and send a 500 for an exception thrown in a route handler.
     */
    fail(res, error, extra = {}) {
        const status = error.status || 500;
        log[status >= 500 ? 'error' : 'warn']('http', status >= 500 ? 'route handler threw' : 'request rejected', {
            status,
            error: error.message,
            browserConnected: this.browserManager.isRunning(),
            stack: status >= 500 ? error.stack : undefined
        });
        res.status(status).json({ ...extra, error: error.message });
    }

    /**
     * Shared handler for the execute routes. Synchronous by default; with
     * `async: true` returns 202 + a job id right after the run is registered.
     */
    async runExecution(req, res, kind, start, { raw = false } = {}) {
        let job = null;
        try {
            const { code, options, async: isAsync } = this.parseRequest(req);
            if (!code) {
                return res.status(400).json(raw ? { error: 'No code provided' } : { success: false, error: 'No code provided' });
            }
            const hooks = {
                onRun: rec => {
                    res.set('X-Run-Id', String(rec.run));
                    if (isAsync) job = this.jobs.create(kind, rec);
                }
            };
            const promise = start(code, options, hooks);
            if (isAsync && job) {
                const j = job;
                promise.then(resp => this.jobs.finish(j, resp),
                    err => this.jobs.finish(j, { success: false, error: err.message, status: err.status }));
                return res.status(202).json({ jobId: j.id, run: j.run, status: 'running',
                    poll: `/jobs/${j.id}`, cancel: `/jobs/${j.id}/cancel` });
            }
            const result = await promise;
            if (!raw) return res.json(result);
            if (result.success) return res.json(result.result);
            return res.status(500).json({ error: result.error, run: result.run });
        } catch (error) {
            this.fail(res, error, raw ? {} : { success: false });
        }
    }

    markReady(source) {
        if (this.ready) return;
        this.ready = true;
        this.readyInfo = { at: new Date().toISOString(), source };
        log.info('server', 'session marked ready', { source });
        for (const fn of this._readyWaiters.splice(0)) fn(source);
    }

    /** Resolves when markReady() is called (e.g. via POST /ready). */
    whenReady() {
        if (this.ready) return Promise.resolve(this.readyInfo.source);
        return new Promise(resolve => this._readyWaiters.push(resolve));
    }

    /**
     * Final error handler: malformed JSON, oversized bodies, unexpected throws.
     */
    setupErrorHandler() {
        this.app.use((req, res) => {
            res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
        });
        // eslint-disable-next-line no-unused-vars
        this.app.use((err, req, res, next) => {
            const status = err.status || err.statusCode || 500;
            log[status >= 500 ? 'error' : 'warn']('http', 'request error', {
                status, type: err.type, error: err.message,
                stack: status >= 500 ? err.stack : undefined
            });
            if (res.headersSent) return;
            res.status(status).json({ error: err.message });
        });
    }

    /**
     * Parse request body - supports both JSON and plain text
     */
    parseRequest(req) {
        // If content-type is text/plain, treat body as code
        if (typeof req.body === 'string') {
            return { code: req.body, options: {} };
        }

        // Otherwise expect JSON with code and options
        const { code, async: isAsync, ...options } = req.body || {};
        return { code, options, async: !!isAsync };
    }

    /**
     * Start the server
     */
    async start({ autoBump = false, maxTries = 100 } = {}) {
        return new Promise((resolve, reject) => {
            let tries = 0;
            const attempt = () => {
                const srv = this.app.listen(this.options.port, this.options.host);
                srv.once('listening', () => {
                    this.server = srv;
                    log.info('server', `listening on http://${this.options.host}:${this.options.port}`);
                    resolve(srv);
                });
                // `app.listen` is the only atomic port reservation — a prior
                // free-port probe can race with a sibling instance across the
                // (slow) Chrome-launch window. When auto-picking, bump and retry
                // so the bound port is always the source of truth. When the port
                // was explicitly requested, surface EADDRINUSE instead.
                srv.once('error', err => {
                    if (err.code === 'EADDRINUSE' && autoBump && tries < maxTries) {
                        log.info('server', 'port in use; trying next', { port: this.options.port });
                        tries++;
                        this.options.port++;
                        attempt();
                    } else {
                        reject(err);
                    }
                });
            };
            attempt();
        });
    }

    /**
     * Stop the server
     */
    async stop() {
        log.info('server', 'stopping');
        this.watches.closeAll();
        if (this.tabPoolManager) {
            await this.tabPoolManager.closeAll();
        }
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        try {
            await this.browserManager.close();
        } catch (err) {
            log.error('server', 'error closing browser during stop', { error: err.message });
        }
        log.info('server', 'stopped');
        process.exit(0);
    }

    /**
     * Get Express app (for testing)
     */
    getApp() {
        return this.app;
    }
}

module.exports = Server;
