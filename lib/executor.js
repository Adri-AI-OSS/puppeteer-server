/**
 * Code Executor
 *
 * Safely executes JavaScript code with Puppeteer context.
 * Supports both sequential (legacy) and concurrent (tab pool) execution.
 */

// AsyncFunction constructor for creating async functions from strings
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class CodeExecutor {
    constructor(browserManager, tabPoolManager = null) {
        this.browserManager = browserManager;
        this.tabPoolManager = tabPoolManager;

        // Legacy sequential queue (backward compatibility)
        this.executionQueue = [];
        this.isExecuting = false;
    }

    /**
     * Set the tab pool manager (can be set after construction)
     */
    setTabPoolManager(tabPoolManager) {
        this.tabPoolManager = tabPoolManager;
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

        // Queue the execution
        return new Promise((resolve, reject) => {
            this.executionQueue.push({
                code,
                pageName,
                timeout,
                returnType,
                resolve,
                reject
            });
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
            const result = await this.executeTask(task);
            task.resolve(result);
        } catch (error) {
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
        const { code, pageName, timeout, returnType } = task;

        const startTime = Date.now();

        try {
            // Get page and browser
            const page = await this.browserManager.getPage(pageName);
            const browser = this.browserManager.getBrowser();

            const result = await this.runCode(page, browser, code, timeout);

            // Process result based on returnType
            const processedResult = this.processResult(result, returnType);

            return {
                success: true,
                result: processedResult,
                duration: Date.now() - startTime
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                stack: error.stack,
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

        if (!this.tabPoolManager) {
            throw new Error('Tab pool manager not configured');
        }

        const tab = this.tabPoolManager.getTab(tabId);
        if (!tab) {
            throw new Error(`Tab ${tabId} not found`);
        }

        const startTime = Date.now();

        try {
            const browser = this.browserManager.getBrowser();
            const result = await this.runCode(tab.page, browser, code, timeout);
            const processedResult = this.processResult(result, returnType);

            return {
                success: true,
                result: processedResult,
                tabId,
                duration: Date.now() - startTime
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                tabId,
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

        if (!this.tabPoolManager) {
            throw new Error('Tab pool manager not configured');
        }

        const { tabId, page } = await this.tabPoolManager.acquireTab();
        const startTime = Date.now();

        try {
            const browser = this.browserManager.getBrowser();
            const result = await this.runCode(page, browser, code, timeout);
            const processedResult = this.processResult(result, returnType);

            return {
                success: true,
                result: processedResult,
                tabId,
                duration: Date.now() - startTime
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                stack: error.stack,
                tabId,
                duration: Date.now() - startTime
            };
        } finally {
            await this.tabPoolManager.releaseTab(tabId);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SHARED HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Run code on a page with timeout
     */
    async runCode(page, browser, code, timeout) {
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
            fn(page, browser, helpers),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Execution timeout')), timeout)
            )
        ]);

        return result;
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
        this.executionQueue.forEach(task => {
            task.reject(new Error('Queue cleared'));
        });
        this.executionQueue = [];
        return cleared;
    }
}

module.exports = CodeExecutor;
