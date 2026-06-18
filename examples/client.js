/**
 * Puppeteer Server Client
 *
 * Simple client for interacting with the puppeteer-server.
 * Can be used from any Node.js script to execute browser automation.
 */

const http = require('http');

class PuppeteerClient {
    constructor(baseUrl = 'http://localhost:3000') {
        this.baseUrl = baseUrl;
    }

    /**
     * Make HTTP request to the server
     */
    async request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.baseUrl);
            const options = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                });
            });

            req.on('error', reject);

            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    /**
     * Execute code and return full result
     */
    async execute(code, options = {}) {
        return this.request('POST', '/execute', { code, ...options });
    }

    /**
     * Execute code and return raw result
     */
    async run(code, options = {}) {
        return this.request('POST', '/run', { code, ...options });
    }

    /**
     * Navigate to URL
     */
    async goto(url, waitUntil = 'networkidle2') {
        return this.request('POST', '/goto', { url, waitUntil });
    }

    /**
     * Get current page info
     */
    async getPage() {
        return this.request('GET', '/page');
    }

    /**
     * Get page HTML content
     */
    async getContent() {
        return this.request('GET', '/content');
    }

    /**
     * Get cookies
     */
    async getCookies() {
        return this.request('GET', '/cookies');
    }

    /**
     * Get server status
     */
    async getStatus() {
        return this.request('GET', '/status');
    }

    /**
     * Health check
     */
    async health() {
        return this.request('GET', '/health');
    }

    /**
     * Shutdown server
     */
    async shutdown() {
        return this.request('POST', '/shutdown');
    }
}

// Example usage
async function example() {
    const client = new PuppeteerClient('http://localhost:3000');

    // Check if server is running
    try {
        const health = await client.health();
        console.log('Server status:', health);
    } catch (error) {
        console.error('Server not running. Start it with: node ../index.js');
        return;
    }

    // Navigate to a page
    console.log('Navigating to example.com...');
    const nav = await client.goto('https://example.com');
    console.log('Navigation result:', nav);

    // Get page title
    console.log('Getting page title...');
    const title = await client.run('return await page.title()');
    console.log('Page title:', title);

    // Extract all links
    console.log('Extracting links...');
    const links = await client.run(`
        return await page.$$eval('a', anchors =>
            anchors.map(a => ({ text: a.textContent, href: a.href }))
        );
    `);
    console.log('Links found:', links);

    // Use helper functions
    console.log('Using helper function...');
    const heading = await client.run(`
        return await helpers.getText('h1');
    `);
    console.log('H1 text:', heading);
}

// Export for use as module
module.exports = PuppeteerClient;

// Run example if called directly
if (require.main === module) {
    example().catch(console.error);
}
