const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const log = require('./logger');
const { installDialogHandler } = require('./run-scope');

/**
 * Browser Manager
 *
 * Handles browser lifecycle - launching, page management, and cleanup.
 * Supports both system Chrome and bundled Chromium.
 *
 * Every CDP connection goes through an instrumented WebSocket transport so that
 * when the connection drops we log *why* (close code/reason, socket errors,
 * whether Chrome is still alive, what request was in flight). Puppeteer's own
 * transport swallows all of that.
 */

// `ws` is a dependency of puppeteer-core (pnpm keeps it out of our top-level
// node_modules), so resolve it through puppeteer -> puppeteer-core.
const WebSocket = require(require.resolve('ws', {
    paths: [path.dirname(require.resolve('puppeteer-core/package.json', {
        paths: [path.dirname(require.resolve('puppeteer/package.json'))]
    }))]
}));

const CHROME_PATHS = {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    linux: '/usr/bin/google-chrome'
};

// Same limits puppeteer's NodeWebSocketTransport uses.
const WS_MAX_PAYLOAD = 256 * 1024 * 1024;

// RFC 6455 close codes worth naming in logs.
const WS_CLOSE_CODES = {
    1000: 'normal',
    1001: 'going-away',
    1005: 'no-status (peer closed without a code)',
    1006: 'abnormal (socket dropped, no close frame)',
    1009: 'message-too-big (> 256MB CDP message)',
    1011: 'server-error'
};

/**
 * Minimal CDP ConnectionTransport over `ws` that records how it closed.
 */
class InstrumentedTransport {
    static create(url, info) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, [], {
                followRedirects: true,
                perMessageDeflate: false,
                maxPayload: WS_MAX_PAYLOAD,
                // Don't hang on a frozen/suspended Chrome during (re)connect.
                handshakeTimeout: 3000,
                headers: { 'User-Agent': 'puppeteer-server' }
            });
            ws.once('open', () => resolve(new InstrumentedTransport(ws, url, info)));
            ws.once('error', reject);
        });
    }

    constructor(ws, url, info) {
        this.ws = ws;
        this.url = url;
        this.info = info;              // shared object the manager reads on disconnect
        this.onmessage = null;
        this.onclose = null;
        this.openedAt = Date.now();
        this.lastMessageAt = Date.now();
        this.messagesIn = 0;
        this.messagesOut = 0;
        this.largestIn = 0;

        const bg = log.background;
        ws.on('message', bg(data => {
            this.lastMessageAt = Date.now();
            this.messagesIn++;
            const len = data.length || 0;
            if (len > this.largestIn) this.largestIn = len;
            if (len > 50 * 1024 * 1024) {
                log.warn('cdp', 'very large CDP message received', { bytes: len });
            }
            if (this.onmessage) this.onmessage.call(null, data.toString());
        }));
        ws.on('error', bg(err => {
            // ws emits the error, then 'close'. Keep it for the close log line.
            this.info.lastError = err.message;
            log.warn('cdp', 'websocket error', { error: err.message, code: err.code });
        }));
        ws.on('close', bg((code, reasonBuf) => {
            this.info.closeCode = code;
            this.info.closeReason = reasonBuf && reasonBuf.length ? reasonBuf.toString() : '';
            this.info.closedAt = Date.now();
            this.info.stats = this.stats();
            if (this.onclose) this.onclose.call(null);
        }));
    }

    stats() {
        return {
            openForMs: Date.now() - this.openedAt,
            idleMs: Date.now() - this.lastMessageAt,
            messagesIn: this.messagesIn,
            messagesOut: this.messagesOut,
            largestInBytes: this.largestIn
        };
    }

    send(message) {
        this.messagesOut++;
        this.ws.send(message);
    }

    close() {
        this.ws.close();
    }
}

function readDevToolsActivePort(profileDir) {
    try {
        const file = path.join(path.resolve(profileDir), 'DevToolsActivePort');
        const [port, wsPath] = fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim());
        return port && wsPath ? { port, wsPath } : null;
    } catch {
        return null;
    }
}

/** Is Chrome's DevTools HTTP endpoint answering on this port? */
function probeDevTools(port, timeoutMs = 1500) {
    return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

function pidAlive(pid) {
    if (!pid) return null;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

class BrowserManager {
    constructor(options = {}) {
        this.options = {
            headless: false,
            useSystemChrome: true,
            profileDir: options.profileDir || path.join(process.cwd(), '.chrome-profile'),
            // `null` => don't override the page viewport, so headful Chrome uses the
            // real window size AND the display's true devicePixelRatio. A fixed
            // viewport without deviceScaleFactor forces DPR=1, which makes canvas
            // content (e.g. the Univer spreadsheet) render at 1x and look pixelated
            // on a retina/HiDPI panel. Pass an explicit viewport to override.
            viewport: null,
            // When a browser we were connected to becomes unreachable, try this
            // many times to re-attach before launching a new one.
            reconnectAttempts: 3,
            reconnectBackoffMs: 250,      // 250ms, 500ms, ... between attempts
            healthCheckTimeoutMs: 3000,   // per-request liveness ping
            pageProbeTimeoutMs: 5000,     // getPage() liveness probe of a named page
            ...options
        };

        this.browser = null;
        this.pages = new Map(); // Named pages for reuse
        this.chromePid = null;  // known when we launched Chrome ourselves
        this.connInfo = null;   // diagnostics for the current connection
        this.connections = 0;   // how many connections this process has made
        this.inFlight = null;   // () => description of the request in flight (set by executor)
        this.lastEndpoint = null;   // ws endpoint of the browser we were last connected to
        this.lastReconnect = null;  // outcome of the most recent automatic reconnect
        this.lastRelaunch = null;   // set when a NEW Chrome replaced one we were connected to
        this.crashed = new WeakSet(); // pages whose renderer crashed
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
        if (this.browser && this.browser.isConnected()) {
            return this.browser;
        }
        // Coalesce concurrent callers onto one launch/attach attempt.
        if (!this._launching) {
            this._launching = this._launchOrAttach().finally(() => {
                this._launching = null;
            });
        }
        return this._launching;
    }

    async _launchOrAttach() {
        this.browser = null;
        this.pages.clear();

        // If a Chrome already owns our profile (e.g. we lost the CDP connection
        // but the browser survived), re-attach to it instead of launching a new
        // one — a fresh launch would fail on the profile's SingletonLock, and
        // re-attaching preserves the authenticated session.
        const attached = await this.attachWithRetry();
        if (attached) return attached;

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

        log.info('browser', 'launching Chrome', {
            executable: launchOptions.executablePath || 'bundled',
            profile: this.options.profileDir,
            headless: this.options.headless
        });
        const started = Date.now();
        let launched;
        try {
            launched = await puppeteer.launch(launchOptions);
        } catch (err) {
            log.error('browser', 'Chrome launch failed', {
                profile: this.options.profileDir,
                error: err.message,
                hint: /SingletonLock|profile.*in use|already running/i.test(err.message)
                    ? 'another Chrome holds this profile and its DevTools endpoint is unreachable'
                    : undefined
            });
            throw err;
        }

        const proc = launched.process();
        this.chromePid = proc ? proc.pid : null;
        if (proc) {
            // chromePid is kept after exit (pidAlive() then reports false) so
            // reconnect logic can tell the browser is gone and skip retries.
            proc.once('exit', log.background((code, signal) => {
                log.warn('browser', 'Chrome process exited', { pid: proc.pid, code, signal });
            }));
        }
        const wsEndpoint = launched.wsEndpoint();
        log.info('browser', 'Chrome launched', {
            pid: this.chromePid, wsEndpoint, ms: Date.now() - started
        });

        // Swap puppeteer's own (opaque) connection for an instrumented one so a
        // later disconnect is diagnosable. Disconnecting doesn't stop Chrome.
        launched.disconnect();
        const hadConnection = this.lastEndpoint !== null;
        await this._connect(wsEndpoint, 'launch');
        if (hadConnection) {
            // The browser we were driving is gone; this is a fresh Chrome on the
            // same profile. Persistent cookies survive; session-only ones don't.
            this.lastRelaunch = {
                at: Date.now(), pid: this.chromePid,
                note: 'previous Chrome was unreachable; launched a new one on the same profile. ' +
                    'Session-only cookies and open tabs are lost; the login may need to be redone.'
            };
            log.warn('browser', 'browser restarted: previous Chrome was gone', this.lastRelaunch);
        }
        return this.browser;
    }

    async _connect(wsEndpoint, via) {
        const info = { via, wsEndpoint, connectedAt: Date.now(), intentional: null };
        const transport = await InstrumentedTransport.create(wsEndpoint, info);
        this.transport = transport;
        const browser = await puppeteer.connect({ transport, defaultViewport: this.options.viewport });
        this.connections++;
        info.n = this.connections;
        this.lastEndpoint = wsEndpoint;
        this.connInfo = info;
        this._setBrowser(browser, info);
        log.info('browser', 'CDP connected', { via, n: info.n, wsEndpoint });
        return browser;
    }

    _setBrowser(browser, info) {
        this.browser = browser;
        const bg = log.background;
        browser.on('disconnected', bg(() => this._onDisconnected(browser, info)));
        browser.on('targetcreated', bg(t => {
            if (t.type() === 'page') log.debug('browser', 'tab opened', { url: t.url() });
        }));
        browser.on('targetdestroyed', bg(t => {
            if (t.type() !== 'page') return;
            const named = [...this.pages.entries()].find(([, p]) => p.target() === t);
            const level = named ? 'warn' : 'debug';
            log[level]('browser', 'tab closed', { url: t.url(), name: named ? named[0] : undefined });
        }));
    }

    async _onDisconnected(browser, info) {
        const current = this.browser === browser;
        if (current) {
            this.browser = null;
            this.pages.clear();
        }

        const codeName = WS_CLOSE_CODES[info.closeCode];
        const fields = {
            n: info.n,
            via: info.via,
            intentional: info.intentional || false,
            closeCode: info.closeCode,
            closeMeaning: codeName,
            closeReason: info.closeReason || undefined,
            lastError: info.lastError,
            connectedForMs: Date.now() - info.connectedAt,
            ...(info.stats || {}),
            inFlight: this.inFlight ? this.inFlight() : null
        };

        if (info.intentional) {
            log.info('browser', 'CDP disconnected (intentional)', fields);
            return;
        }

        // Unexpected: work out whether Chrome itself is gone or just the socket.
        // Brief grace period — when Chrome dies the socket closes a moment
        // before the process is reaped.
        await new Promise(r => setTimeout(r, 500));
        const port = info.wsEndpoint && (info.wsEndpoint.match(/:(\d+)\//) || [])[1];
        const devtoolsUp = port ? await probeDevTools(port) : null;
        fields.chromePid = this.chromePid;
        fields.chromePidAlive = pidAlive(this.chromePid);
        fields.devtoolsReachable = devtoolsUp;
        fields.diagnosis = devtoolsUp
            ? 'Chrome is still running; only the CDP socket closed — next request will re-attach'
            : 'Chrome is not reachable (exited or crashed) — next request will launch a new one';
        log.error('browser', 'CDP disconnected unexpectedly', fields);
    }

    /**
     * Re-attach to a browser we know about. If this process was connected to
     * a browser before (a lost connection), retry up to `reconnectAttempts`
     * times with backoff — Chrome can be briefly unreachable (wake from sleep,
     * busy main thread) — before giving up and letting the caller launch.
     * At first start (never connected) a single attempt is made.
     */
    async attachWithRetry() {
        const hadConnection = this.lastEndpoint !== null;
        const attempts = hadConnection ? Math.max(1, this.options.reconnectAttempts) : 1;
        const started = Date.now();
        let lastError = null;
        let made = 0;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            made = attempt;
            const { browser, error } = await this.attachExisting({ attempt, attempts });
            if (browser) {
                if (hadConnection) {
                    this.lastReconnect = {
                        at: started, ok: true, attempts: attempt, ms: Date.now() - started,
                        endpoint: this.lastEndpoint
                    };
                    log.info('browser', 'reconnected to previous browser', this.lastReconnect);
                }
                return browser;
            }
            lastError = error;
            if (!hadConnection) break;

            // If we launched Chrome and its process is gone, retrying is pointless.
            if (this.chromePid && pidAlive(this.chromePid) === false) {
                log.warn('browser', 'Chrome process we launched has exited; not retrying attach', {
                    pid: this.chromePid, attempt
                });
                break;
            }
            if (attempt < attempts) {
                const delay = this.options.reconnectBackoffMs * 2 ** (attempt - 1);
                log.warn('browser', 'reconnect attempt failed; retrying', {
                    attempt, attempts, retryInMs: delay, error
                });
                await new Promise(res => setTimeout(res, delay));
            }
        }

        if (hadConnection) {
            this.lastReconnect = {
                at: started, ok: false, attempts: made, ms: Date.now() - started,
                endpoint: this.lastEndpoint, error: lastError
            };
            log.error('browser', 'could not reconnect to previous browser; launching a new one', this.lastReconnect);
        }
        return null;
    }

    /**
     * One attach attempt: try the endpoint we were last connected to, then the
     * one in the profile's DevToolsActivePort (differs if Chrome restarted).
     * Returns { browser } on success or { error } on failure.
     */
    async attachExisting({ attempt = 1, attempts = 1 } = {}) {
        const candidates = [];
        if (this.lastEndpoint) candidates.push({ wsEndpoint: this.lastEndpoint, source: 'last-connected' });
        if (this.options.useSystemChrome && this.options.profileDir) {
            const active = readDevToolsActivePort(this.options.profileDir);
            if (active) {
                const wsEndpoint = `ws://127.0.0.1:${active.port}${active.wsPath}`;
                if (!candidates.some(c => c.wsEndpoint === wsEndpoint)) {
                    candidates.push({ wsEndpoint, source: 'DevToolsActivePort' });
                }
            }
        }
        if (candidates.length === 0) {
            log.debug('browser', 'no known browser endpoint; nothing to attach to', {
                profile: this.options.profileDir
            });
            return { error: 'no known endpoint' };
        }

        let error = null;
        for (const { wsEndpoint, source } of candidates) {
            try {
                const browser = await this._connect(wsEndpoint, 'attach');
                // Adopt an existing tab as 'main' so callers keep driving the
                // already-authenticated page rather than a fresh blank one.
                const existing = (await browser.pages()).filter(p => !p.url().startsWith('devtools://'));
                const main = existing.find(p => p.url() !== 'about:blank') || existing[0];
                if (main) {
                    this._watchPage(main, 'main');
                    this.pages.set('main', main);
                }
                log.info('browser', 're-attached to existing Chrome', {
                    source, attempt, attempts, tabs: existing.length, main: main ? main.url() : null
                });
                return { browser };
            } catch (err) {
                error = err.message;
                log.info('browser', 'attach failed', { source, wsEndpoint, attempt, attempts, error });
            }
        }
        return { error };
    }

    /**
     * Make sure there is a live, responsive connection before running a
     * request. Pings the browser (a socket can look open yet be dead, e.g.
     * after sleep); if it's gone, reconnects (with retries) before returning.
     * The reconnect outcome is attached to the request's log context.
     */
    async ensureConnected() {
        if (this.browser && this.browser.isConnected()) {
            const error = await this._ping();
            if (!error) return this.browser;
            log.warn('browser', 'browser did not answer health check; dropping connection', {
                timeoutMs: this.options.healthCheckTimeoutMs, error
            });
            if (this.connInfo) this.connInfo.intentional = `health check failed: ${error}`;
            try { this.browser.disconnect(); } catch { /* already gone */ }
            this.browser = null;
            this.pages.clear();
        } else if (this.lastEndpoint) {
            log.warn('browser', 'connection to browser lost; reconnecting before running request', {
                endpoint: this.lastEndpoint
            });
        }

        const started = Date.now();
        await this.launch();
        const ctx = log.context();
        if (ctx && this.lastReconnect && this.lastReconnect.at >= started - 50) {
            ctx.reconnect = this.lastReconnect;
        }
        if (ctx && this.lastRelaunch && this.lastRelaunch.at >= started - 50) {
            ctx.browserRestarted = this.lastRelaunch;
        }
        return this.browser;
    }

    /** Returns null if the browser answers, else an error string. */
    async _ping() {
        let timer;
        try {
            await Promise.race([
                this.browser.version(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('timed out')), this.options.healthCheckTimeoutMs);
                })
            ]);
            return null;
        } catch (err) {
            return err.message;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Drop the current connection (without killing Chrome) and re-attach,
     * launching only if no Chrome is running on the profile.
     */
    async reconnect(reason = 'reconnect requested') {
        log.info('browser', 'reconnecting', { reason, wasConnected: this.isRunning() });
        if (this.browser) {
            if (this.connInfo) this.connInfo.intentional = reason;
            try { this.browser.disconnect(); } catch { /* already gone */ }
        }
        this.browser = null;
        this.pages.clear();
        return this.launch();
    }

    /**
     * Get or create a named page
     * @param {string} name - Page identifier (default: 'main')
     */
    async getPage(name = 'main') {
        await this.ensureConnected();

        if (this.pages.has(name) && this.crashed.has(this.pages.get(name))) {
            const dead = this.pages.get(name);
            let url;
            try { url = dead.url(); } catch { url = undefined; }
            log.warn('browser', 'named page crashed earlier; replacing it', { page: name, url });
            this.pages.delete(name);
            try { await dead.close(); } catch { /* already gone */ }
            const ctx = log.context();
            if (ctx) ctx.tabCrashed = { page: name, url, replaced: true };
        }

        if (this.pages.has(name)) {
            const page = this.pages.get(name);
            // Check if page is still valid. Bounded: a page stuck on a JS
            // dialog (or a busy main thread) never answers evaluate().
            if (!page.isClosed()) {
                let probeTimer;
                const probe = await Promise.race([
                    page.evaluate(() => true).then(() => 'ok', err => err),
                    new Promise(r => { probeTimer = setTimeout(() => r('timeout'), this.options.pageProbeTimeoutMs); })
                ]);
                clearTimeout(probeTimer);
                if (probe === 'ok') return page;
                if (probe === 'timeout') {
                    // Keep the tab (it may hold the authenticated session); the
                    // run's own timeout bounds whatever happens next.
                    log.warn('browser', 'named page unresponsive (JS dialog open or main thread busy?); using it anyway',
                        { page: name, probeTimeoutMs: this.options.pageProbeTimeoutMs, url: page.url() });
                    return page;
                }
                log.warn('browser', 'named page is dead; replacing it', { page: name, error: probe.message });
            } else {
                log.warn('browser', 'named page was closed; replacing it', { page: name });
            }
            this.pages.delete(name);
        }

        const page = await this.browser.newPage();
        this._watchPage(page, name);
        this.pages.set(name, page);
        // A background tab doesn't render (headless) or is throttled, which
        // makes visibility-dependent calls such as page.click() hang. The
        // named page is the one being driven, so put it in front.
        try { await page.bringToFront(); }
        catch (err) { log.debug('browser', 'bringToFront failed', { page: name, error: err.message }); }
        log.info('browser', 'opened new named page', { page: name });
        return page;
    }

    _watchPage(page, name) {
        installDialogHandler(page, name);
        page.on('error', log.background(err => {
            // Puppeteer emits 'error' when the tab's renderer crashes.
            this.crashed.add(page);
            log.error('page', 'page crashed', { page: name, error: err.message });
        }));
    }

    /**
     * Create a new page (not tracked)
     */
    async newPage() {
        await this.ensureConnected();
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
            log.info('browser', 'closing Chrome', { pid: this.chromePid });
            if (this.connInfo) this.connInfo.intentional = 'close';
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
     * Snapshot for /health and /status.
     */
    describe() {
        return {
            connected: this.isRunning(),
            via: this.connInfo ? this.connInfo.via : null,
            connections: this.connections,
            lastEndpoint: this.lastEndpoint,
            lastReconnect: this.lastReconnect,
            lastRelaunch: this.lastRelaunch,
            chromePid: this.chromePid,
            chromeAlive: pidAlive(this.chromePid),
            profile: this.options.profileDir
        };
    }

    /**
     * Get browser instance (for advanced usage)
     */
    getBrowser() {
        return this.browser;
    }
}

module.exports = BrowserManager;
