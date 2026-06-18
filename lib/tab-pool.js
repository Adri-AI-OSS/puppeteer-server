/**
 * Tab Pool Manager
 *
 * Manages a pool of browser tabs for concurrent operations.
 * Provides acquire/release semantics for tab usage.
 */

class TabPoolManager {
    constructor(browserManager, options = {}) {
        this.browserManager = browserManager;
        this.maxTabs = options.maxTabs || 10;
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
    async acquireTab() {
        // Try to find an idle tab
        for (const [tabId, tab] of this.tabs) {
            if (tab.status === 'idle') {
                tab.status = 'busy';
                tab.lastUsed = Date.now();
                return { tabId, page: tab.page };
            }
        }

        // Create new tab if under limit
        if (this.tabs.size < this.maxTabs) {
            return await this.createTab();
        }

        // Wait for a tab to become available
        return new Promise((resolve) => {
            this.waitingQueue.push(resolve);
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
        if (!tab) return;

        tab.lastUsed = Date.now();

        // If someone is waiting, give them this tab immediately
        if (this.waitingQueue.length > 0) {
            const resolve = this.waitingQueue.shift();
            tab.status = 'busy';
            resolve({ tabId, page: tab.page });
        } else {
            tab.status = 'idle';
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

        this.tabs.set(tabId, {
            page,
            status: 'busy',
            createdAt: Date.now(),
            lastUsed: Date.now()
        });

        return { tabId, page };
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
            }
            this.tabs.delete(tabId);
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

        return closed;
    }
}

module.exports = TabPoolManager;
