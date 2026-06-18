const puppeteer = require('puppeteer');
const path = require('path');

/**
 * Browser Manager
 *
 * Handles browser lifecycle - launching, page management, and cleanup.
 * Supports both system Chrome and bundled Chromium.
 */

const CHROME_PATHS = {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    linux: '/usr/bin/google-chrome'
};

class BrowserManager {
    constructor(options = {}) {
        this.options = {
            headless: false,
            useSystemChrome: true,
            profileDir: options.profileDir || path.join(process.cwd(), '.chrome-profile'),
            viewport: { width: 1200, height: 800 },
            ...options
        };

        this.browser = null;
        this.pages = new Map(); // Named pages for reuse
    }

    /**
     * Get Chrome executable path for current platform
     */
    getChromePath() {
        return CHROME_PATHS[process.platform] || CHROME_PATHS.linux;
    }

    /**
     * Launch browser with configured options
     */
    async launch() {
        if (this.browser) {
            return this.browser;
        }

        const launchOptions = {
            headless: this.options.headless,
            defaultViewport: this.options.viewport,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-default-apps'
            ]
        };

        // Use system Chrome if requested (better for session persistence)
        if (this.options.useSystemChrome) {
            launchOptions.executablePath = this.getChromePath();
            launchOptions.userDataDir = this.options.profileDir;
        }

        this.browser = await puppeteer.launch(launchOptions);

        // Handle browser disconnect
        this.browser.on('disconnected', () => {
            this.browser = null;
            this.pages.clear();
        });

        return this.browser;
    }

    /**
     * Get or create a named page
     * @param {string} name - Page identifier (default: 'main')
     */
    async getPage(name = 'main') {
        if (!this.browser) {
            await this.launch();
        }

        if (this.pages.has(name)) {
            const page = this.pages.get(name);
            // Check if page is still valid
            try {
                await page.evaluate(() => true);
                return page;
            } catch {
                this.pages.delete(name);
            }
        }

        const page = await this.browser.newPage();
        this.pages.set(name, page);
        return page;
    }

    /**
     * Create a new page (not tracked)
     */
    async newPage() {
        if (!this.browser) {
            await this.launch();
        }
        return this.browser.newPage();
    }

    /**
     * Close a named page
     */
    async closePage(name) {
        if (this.pages.has(name)) {
            const page = this.pages.get(name);
            await page.close();
            this.pages.delete(name);
        }
    }

    /**
     * Get all open pages
     */
    async getAllPages() {
        if (!this.browser) return [];
        return this.browser.pages();
    }

    /**
     * Close browser and cleanup
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.pages.clear();
        }
    }

    /**
     * Check if browser is running
     */
    isRunning() {
        return this.browser !== null && this.browser.isConnected();
    }

    /**
     * Get browser instance (for advanced usage)
     */
    getBrowser() {
        return this.browser;
    }
}

module.exports = BrowserManager;
