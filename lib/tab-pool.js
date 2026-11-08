/**
 * Tab Pool Manager
 *
 * Manages a pool of browser tabs for concurrent operations.
 * Provides acquire/release semantics for tab usage.
 */

const log = require('./logger');
const { installDialogHandler, enableCrashEvents } = require('./run-scope');

const IDLE_PROBE_MS = 1500;

/** Resolves true if the page answers a trivial evaluate within `ms`. */
async function responds(page, ms = IDLE_PROBE_MS) {
    let timer;
    try {
        return await Promise.race([
            page.evaluate(() => true).then(() => true, () => false),
            new Promise(r => { timer = setTimeout(() => r(false), ms); })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

class TabPoolManager {
    constructor(browserManager, options = {}) {
        this.browserManager = browserManager;
        this.maxTabs = options.maxTabs || 10;
        // How long acquireTab() waits for a busy pool before giving up.
        this.acquireTimeoutMs = options.acquireTimeoutMs || 30000;
        this.tabs = new Map();  // tabId -> { page, status, createdAt, lastUsed }
        this.tabCounter = 0;
        this.waitingQueue = [];  // Callbacks waiting for a tab
    }

    /**
     * Acquire a tab from the pool.
     * Returns an existing idle tab or creates a new one.
     * If at max capacity, waits for a tab to become available.
     *
     * @returns {Promise<{tabId: string, page: object}>}
     */
    async acquireTab({ timeoutMs = this.acquireTimeoutMs } = {}) {
        // Verify (and if needed restore) the browser connection first, so a
        // dropped connection is repaired before handing out a tab.
        await this.browserManager.ensureConnected();

        // Try to find an idle tab
        for (const [tabId, tab] of [...this.tabs]) {
            if (tab.status === 'idle' && (!this.isPageUsable(tab.page) || tab.crashed)) {
                // Its browser connection was replaced (reconnect) or the tab died.
                log.info('pool', 'dropping stale tab', { tabId });
                this.tabs.delete(tabId);
                continue;
            }
            if (tab.status === 'idle') {
                tab.status = 'busy';
                // A crash isn't always reported: make sure the tab still answers.
                if (!(await responds(tab.page))) {
                    log.warn('pool', 'idle tab does not respond (crashed?); replacing it', { tabId });
                    tab.crashed = true;
                    this.tabs.delete(tabId);
                    tab.page.close().catch(() => {});
                    continue;
                }
                tab.lastUsed = Date.now();
                log.info('pool', 'acquired idle tab', { tabId, ...this.getStatus() });
                return { tabId, page: tab.page };
            }
        }

        // Create new tab if under limit
        if (this.tabs.size < this.maxTabs) {
            return await this.createTab();
        }

        // Wait for a tab to become available
        log.warn('pool', 'pool full; waiting for a tab', this.getStatus());
        const waitStart = Date.now();
        return new Promise((resolve) => {
            const waiter = result => {
                clearTimeout(timer);
                log.info('pool', 'waiter got a tab', { tabId: result.tabId, waitedMs: Date.now() - waitStart });
                resolve(result);
            };
            const timer = setTimeout(() => {
                const i = this.waitingQueue.indexOf(waiter);
                if (i >= 0) this.waitingQueue.splice(i, 1);
                log.warn('pool', 'timed out waiting for a tab', { timeoutMs, ...this.getStatus() });
                resolve({ tabId: null, page: null,
                    error: `no tab became free within ${timeoutMs}ms (pool of ${this.maxTabs} is busy)` });
            }, timeoutMs);
            this.waitingQueue.push(waiter);
        });
    }

    /**
     * Release a tab back to the pool.
     * If there are waiting requests, immediately assign the tab.
     *
     * @param {string} tabId
     */
    async releaseTab(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            log.warn('pool', 'release of unknown tab', { tabId });
            return;
        }

        tab.lastUsed = Date.now();

        if (tab.crashed) {
            // Never hand a crashed tab to the next user: replace it.
            log.warn('pool', 'released tab had crashed; closing it', { tabId });
            await this.closeTab(tabId);
            if (this.waitingQueue.length > 0) {
                const resolve = this.waitingQueue.shift();
                try { resolve(await this.createTab()); }
                catch (err) { resolve({ tabId: null, page: null, error: `could not replace crashed tab: ${err.message}` }); }
            }
            return;
        }

        // If someone is waiting, give them this tab immediately
        if (this.waitingQueue.length > 0) {
            const resolve = this.waitingQueue.shift();
            tab.status = 'busy';
            resolve({ tabId, page: tab.page });
        } else {
            tab.status = 'idle';
            log.info('pool', 'released tab', { tabId, ...this.getStatus() });
        }
    }

    /**
     * Create a new tab and add it to the pool.
     *
     * @returns {Promise<{tabId: string, page: object}>}
     */
    async createTab() {
        const tabId = `tab-${++this.tabCounter}`;
        const page = await this.browserManager.newPage();
        page.on('error', log.background(err => {
            const tab = this.tabs.get(tabId);
            if (tab) tab.crashed = true;
            log.error('pool', 'tab crashed', { tabId, error: err.message });
        }));
        installDialogHandler(page, tabId);
        enableCrashEvents(page);

        this.tabs.set(tabId, {
            page,
            status: 'busy',
            createdAt: Date.now(),
            lastUsed: Date.now()
        });

        log.info('pool', 'created tab', { tabId, ...this.getStatus() });
        return { tabId, page };
    }

    isPageUsable(page) {
        try {
            return !page.isClosed() && page.browser().isConnected();
        } catch {
            return false;
        }
    }

    /**
     * Close a specific tab and remove it from the pool.
     *
     * @param {string} tabId
     */
    async closeTab(tabId) {
        const tab = this.tabs.get(tabId);
        if (tab) {
            try {
                await tab.page.close();
            } catch (e) {
                // Page might already be closed
                log.debug('pool', 'tab close failed (already closed?)', { tabId, error: e.message });
            }
            this.tabs.delete(tabId);
            log.info('pool', 'closed tab', { tabId, wasStatus: tab.status });
        } else {
            log.warn('pool', 'close of unknown tab', { tabId });
        }
    }

    /**
     * Get a tab by ID (without changing status).
     *
     * @param {string} tabId
     * @returns {{page: object, status: string} | null}
     */
    getTab(tabId) {
        return this.tabs.get(tabId) || null;
    }

    /**
     * Check if a tab exists and is healthy.
     *
     * @param {string} tabId
     * @returns {Promise<boolean>}
     */
    async isTabHealthy(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) return false;

        try {
            await tab.page.evaluate(() => true);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get pool status summary.
     *
     * @returns {{total: number, idle: number, busy: number, waiting: number, maxTabs: number}}
     */
    getStatus() {
        let idle = 0;
        let busy = 0;

        for (const tab of this.tabs.values()) {
            if (tab.status === 'idle') idle++;
            else busy++;
        }

        return {
            total: this.tabs.size,
            idle,
            busy,
            waiting: this.waitingQueue.length,
            maxTabs: this.maxTabs
        };
    }

    /**
     * Get detailed info for all tabs.
     *
     * @returns {Array<{tabId: string, status: string, createdAt: number, lastUsed: number, url: string}>}
     */
    async getTabsInfo() {
        const info = [];

        for (const [tabId, tab] of this.tabs) {
            let url = 'unknown';
            try {
                url = tab.page.url();
            } catch {
                // Page might be closed
            }

            info.push({
                tabId,
                status: tab.status,
                createdAt: tab.createdAt,
                lastUsed: tab.lastUsed,
                url
            });
        }

        return info;
    }

    /**
     * Close all tabs and clear the pool.
     */
    async closeAll() {
        log.info('pool', 'closing all tabs', this.getStatus());
        // Reject all waiting requests
        for (const resolve of this.waitingQueue) {
            resolve({ tabId: null, page: null, error: 'Pool closed' });
        }
        this.waitingQueue = [];

        // Close all tabs
        for (const [tabId] of this.tabs) {
            await this.closeTab(tabId);
        }
    }

    /**
     * Close idle tabs that haven't been used recently.
     *
     * @param {number} maxIdleMs - Maximum idle time in milliseconds
     * @returns {number} - Number of tabs closed
     */
    async pruneIdleTabs(maxIdleMs = 60000) {
        const now = Date.now();
        let closed = 0;

        for (const [tabId, tab] of this.tabs) {
            if (tab.status === 'idle' && (now - tab.lastUsed) > maxIdleMs) {
                await this.closeTab(tabId);
                closed++;
            }
        }

        if (closed) log.info('pool', 'pruned idle tabs', { closed, maxIdleMs });
        return closed;
    }
}

module.exports = TabPoolManager;
