const express = require('express');

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
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Set the tab pool manager (can be set after construction)
     */
    setTabPoolManager(tabPoolManager) {
        this.tabPoolManager = tabPoolManager;
        if (this.executor) {
            this.executor.setTabPoolManager(tabPoolManager);
        }
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.text({ limit: '10mb' }));

        // Request logging
        this.app.use((req, res, next) => {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] ${req.method} ${req.path}`);
            next();
        });

        // CORS for local development
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type');
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
                queue: this.executor.getStatus()
            });
        });

        // Execute code (legacy sequential)
        this.app.post('/execute', async (req, res) => {
            try {
                const { code, options } = this.parseRequest(req);

                if (!code) {
                    return res.status(400).json({
                        success: false,
                        error: 'No code provided'
                    });
                }

                const result = await this.executor.execute(code, options);
                res.json(result);
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Execute and return raw result (legacy sequential)
        this.app.post('/run', async (req, res) => {
            try {
                const { code, options } = this.parseRequest(req);

                if (!code) {
                    return res.status(400).json({ error: 'No code provided' });
                }

                const result = await this.executor.execute(code, options);

                if (result.success) {
                    res.json(result.result);
                } else {
                    res.status(500).json({ error: result.error });
                }
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

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
                res.status(500).json({ error: error.message });
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
                res.status(500).json({ error: error.message });
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
                res.status(500).json({ error: error.message });
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
                res.status(500).json({ error: error.message });
            }
        });

        // Get cookies
        this.app.get('/cookies', async (req, res) => {
            try {
                const code = `return await page.cookies();`;
                const result = await this.executor.execute(code);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Queue status
        this.app.get('/status', (req, res) => {
            res.json({
                browser: this.browserManager.isRunning(),
                queue: this.executor.getStatus()
            });
        });

        // Clear queue
        this.app.post('/clear-queue', (req, res) => {
            const cleared = this.executor.clearQueue();
            res.json({ cleared });
        });

        // Shutdown (graceful)
        this.app.post('/shutdown', async (req, res) => {
            res.json({ message: 'Shutting down...' });
            setTimeout(() => this.stop(), 100);
        });

        // ═══════════════════════════════════════════════════════════════════
        // CONCURRENT EXECUTION ENDPOINTS (Tab Pool)
        // ═══════════════════════════════════════════════════════════════════

        // Execute with automatic tab pool management
        this.app.post('/pool/execute', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                const { code, options } = this.parseRequest(req);

                if (!code) {
                    return res.status(400).json({ error: 'No code provided' });
                }

                const result = await this.executor.executeWithPool(code, options);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Acquire a tab manually
        this.app.post('/pool/acquire', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                const { tabId, page } = await this.tabPoolManager.acquireTab();
                res.json({
                    tabId,
                    url: page.url()
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
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
                res.status(500).json({ error: error.message });
            }
        });

        // Execute on a specific tab
        this.app.post('/pool/tab/:tabId/execute', async (req, res) => {
            try {
                if (!this.tabPoolManager) {
                    return res.status(400).json({ error: 'Tab pool not enabled' });
                }

                const { code, options } = this.parseRequest(req);

                if (!code) {
                    return res.status(400).json({ error: 'No code provided' });
                }

                const result = await this.executor.executeOnTab(
                    req.params.tabId,
                    code,
                    options || {}
                );
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
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
                res.status(500).json({ error: error.message });
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
                res.status(500).json({ error: error.message });
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
                res.status(500).json({ error: error.message });
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
                res.status(500).json({ error: error.message });
            }
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
        const { code, pageName, timeout, returnType } = req.body;
        return {
            code,
            options: { pageName, timeout, returnType }
        };
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
                    console.log(`Server listening on http://${this.options.host}:${this.options.port}`);
                    resolve(srv);
                });
                // `app.listen` is the only atomic port reservation — a prior
                // free-port probe can race with a sibling instance across the
                // (slow) Chrome-launch window. When auto-picking, bump and retry
                // so the bound port is always the source of truth. When the port
                // was explicitly requested, surface EADDRINUSE instead.
                srv.once('error', err => {
                    if (err.code === 'EADDRINUSE' && autoBump && tries < maxTries) {
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
        if (this.tabPoolManager) {
            await this.tabPoolManager.closeAll();
        }
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        await this.browserManager.close();
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
