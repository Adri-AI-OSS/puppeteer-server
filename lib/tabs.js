/**
 * Tab registry: every page the server drives is a named tab.
 *
 *   main       the tab the user logged in on; never closed automatically
 *   agent      created by name (POST /tabs, or first use of `tab: "<name>"`)
 *   pool       created by the /pool/acquire alias (names tab-N); reusable
 *   ephemeral  created for one `tab: "new"` run (names tab-N); closed after it
 *
 * Each tab has its own FIFO queue: runs on one tab are serialized, runs on
 * different tabs are concurrent. Non-main tabs open in their own window
 * (`tabsAs: 'windows'`) so each is the front tab of its window: headless
 * Chrome doesn't render background tabs, and page.click() on one never
 * completes.
 *
 * Names survive reconnects and server restarts: `{ name -> targetId }` is
 * written to `<profile>/puppeteer-server-tabs.json`; on attach every
 * registered tab is matched to its live Chrome target again.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { installDialogHandler, enableCrashEvents } = require('./run-scope');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED = new Set(['new']);
const PERSISTED_KINDS = new Set(['main', 'agent', 'pool']);
const LOST_KEEP_MS = 10 * 60 * 1000;
const IDLE_PROBE_MS = 1500;

function httpError(status, message, extra = {}) {
    const err = new Error(message);
    err.status = status;
    Object.assign(err, extra);
    return err;
}

function targetIdOf(page) {
    try { return page.target()._targetId; } catch { return null; }
}

function safeUrl(page) {
    try { return page.url(); } catch { return undefined; }
}

/** Resolves 'ok' | 'timeout' | Error for a trivial evaluate within `ms`. */
async function probe(page, ms) {
    let timer;
    try {
        return await Promise.race([
            page.evaluate(() => true).then(() => 'ok', err => err),
            new Promise(r => { timer = setTimeout(() => r('timeout'), ms); })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

class TabManager {
    constructor(browserManager, options = {}) {
        this.bm = browserManager;
        browserManager.tabs = this;
        const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
        this.opts = {
            maxTabs: 10,                    // non-main tabs (agent + pool + ephemeral)
            acquireTimeoutMs: 30000,        // wait for a free slot (tab: "new", /pool/acquire)
            idleTtlMs: 30 * 60 * 1000,      // agent/pool tabs idle this long are closed
            tabsAs: 'windows',              // 'windows' | 'tabs'
            pageProbeTimeoutMs: 5000,       // liveness probe before a run
            ...defined
        };
        if (!['windows', 'tabs'].includes(this.opts.tabsAs)) {
            throw new Error(`tabsAs must be 'windows' or 'tabs', got ${this.opts.tabsAs}`);
        }
        this.tabs = new Map();      // name -> tab
        this.queues = new Map();    // name -> { items: [], running: null }
        this.lost = new Map();      // name -> { at, url, reason }
        this.counter = 0;           // tab-N names
        this.waiters = [];          // callbacks waiting for capacity
        this.sweeper = setInterval(() => this.sweep(),
            Math.max(1000, Math.min(60000, Math.floor(this.opts.idleTtlMs / 2))));
        this.sweeper.unref();
    }

    // ── names ────────────────────────────────────────────────────────────────

    validateName(name) {
        if (typeof name !== 'string' || !NAME_RE.test(name) || RESERVED.has(name)) {
            throw httpError(400, `invalid tab name ${JSON.stringify(name)}: use letters, digits, '-' or '_' ` +
                `(max 64, not starting with '-'/'_'); "new" is reserved`);
        }
        return name;
    }

    nextName() {
        let name;
        do { name = `tab-${++this.counter}`; } while (this.tabs.has(name));
        return name;
    }

    has(name) { return this.tabs.has(name); }
    get(name) { return this.tabs.get(name) || null; }

    nonMainCount() {
        let n = 0;
        for (const t of this.tabs.values()) if (t.kind !== 'main') n++;
        return n;
    }

    isBusy(tab) {
        const q = this.queues.get(tab.name);
        return !!(tab.leased || (q && (q.running || q.items.length)) || tab.ephemeralRun);
    }

    // ── registry file ────────────────────────────────────────────────────────

    registryFile() {
        const dir = this.bm.options.profileDir;
        return dir ? path.join(path.resolve(dir), 'puppeteer-server-tabs.json') : null;
    }

    save() {
        const file = this.registryFile();
        if (!file) return;
        const tabs = {};
        for (const t of this.tabs.values()) {
            if (!PERSISTED_KINDS.has(t.kind) || t.isolated || !t.targetId) continue;
            tabs[t.name] = { targetId: t.targetId, kind: t.kind, createdAt: t.createdAt, url: safeUrl(t.page) };
        }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(),
                counter: this.counter, tabs }, null, 2));
        } catch (err) {
            log.warn('tabs', 'could not write tab registry', { file, error: err.message });
        }
    }

    loadRegistry() {
        const file = this.registryFile();
        if (!file || !fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            log.warn('tabs', 'unreadable tab registry; ignoring it', { file, error: err.message });
            return null;
        }
    }

    // ── connection lifecycle (called by BrowserManager) ──────────────────────

    /** The CDP connection is gone: page objects are dead, names are kept. */
    onDisconnected() {
        for (const t of this.tabs.values()) t.page = null;
    }

    /**
     * After connecting: on 'launch' (a fresh Chrome) no previous tab exists,
     * so the registry is reset; on 'attach' every registered tab is matched to
     * its live target again (from memory, or the registry file after a server
     * restart), and `main` falls back to the first non-blank tab.
     */
    async reconcile(browser, { via }) {
        if (via === 'launch') {
            const had = [...this.tabs.keys()].filter(n => n !== 'main');
            for (const name of had) this.markLost(name, null, 'browser restarted');
            this.tabs.clear();
            this.save();
            if (had.length) log.warn('tabs', 'new Chrome: previous tabs are gone', { tabs: had });
            return;
        }

        if (this.tabs.size === 0) {
            const reg = this.loadRegistry();
            if (reg && reg.tabs) {
                this.counter = Math.max(this.counter, reg.counter || 0);
                for (const [name, e] of Object.entries(reg.tabs)) {
                    this.tabs.set(name, this.newTab(name, e.kind, { targetId: e.targetId, createdAt: e.createdAt,
                        lastUrl: e.url }));
                }
                log.info('tabs', 'loaded tab registry', { tabs: Object.keys(reg.tabs) });
            }
        }

        const pages = (await browser.pages()).filter(p => !safeUrl(p).startsWith('devtools://'));
        const byId = new Map(pages.map(p => [targetIdOf(p), p]));
        const adopted = [];
        for (const tab of [...this.tabs.values()]) {
            const page = tab.targetId ? byId.get(tab.targetId) : null;
            if (page) {
                this.attachPage(tab, page);
                byId.delete(tab.targetId);
                adopted.push(tab.name);
            } else if (tab.kind !== 'main') {
                this.markLost(tab.name, tab, 'tab no longer exists in Chrome');
                this.tabs.delete(tab.name);
            }
        }
        const main = this.tabs.get('main');
        if (!main || !main.page) {
            // No registered main (first attach, or it was closed): adopt the
            // first non-blank unregistered tab, which holds the session.
            const free = [...byId.values()];
            const page = free.find(p => safeUrl(p) !== 'about:blank') || free[0];
            if (page) {
                const tab = main || this.newTab('main', 'main');
                this.tabs.set('main', tab);
                this.attachPage(tab, page);
                adopted.push('main');
            } else if (main) {
                this.tabs.delete('main');
            }
        }
        this.save();
        log.info('tabs', 're-adopted tabs after attach', { adopted, lost: [...this.lost.keys()] });
    }

    markLost(name, tab, reason) {
        this.lost.set(name, { at: Date.now(), url: tab ? (tab.lastUrl || safeUrl(tab.page)) : undefined, reason });
        log.warn('tabs', 'tab lost', { tab: name, reason });
    }

    // ── tabs ─────────────────────────────────────────────────────────────────

    newTab(name, kind, extra = {}) {
        return { name, kind, page: null, targetId: null, isolated: false, context: null,
            createdAt: Date.now(), lastUsedAt: Date.now(), leased: false, crashed: false, ...extra };
    }

    attachPage(tab, page) {
        tab.page = page;
        tab.targetId = targetIdOf(page);
        tab.crashed = false;
        if (tab.isolated || page.browserContext() !== this.bm.getBrowser().defaultBrowserContext()) {
            tab.context = page.browserContext();
        }
        installDialogHandler(page, tab.name);
        enableCrashEvents(page);
        if (!page.__tabWatched) {
            page.__tabWatched = true;
            page.on('error', log.background(err => {
                const t = this.tabs.get(tab.name);
                if (t && t.page === page) t.crashed = true;
                log.error('page', 'tab crashed', { tab: tab.name, error: err.message });
            }));
            page.on('close', log.background(() => {
                const t = this.tabs.get(tab.name);
                if (t && t.page === page) {
                    t.lastUrl = safeUrl(page);
                    t.page = null;
                    log.info('tabs', 'tab page closed', { tab: tab.name });
                }
            }));
        }
    }

    /** Open the Chrome page for `tab` (its own window unless tabsAs: 'tabs'). */
    async openPage(tab) {
        const browser = this.bm.getBrowser();
        if (tab.isolated && !tab.context) tab.context = await browser.createIncognitoBrowserContext();
        let page;
        if (tab.kind === 'main' || this.opts.tabsAs === 'tabs') {
            page = tab.context ? await tab.context.newPage() : await browser.newPage();
        } else {
            const session = await browser.target().createCDPSession();
            try {
                const params = { url: 'about:blank', newWindow: true };
                if (tab.context && tab.context.id) params.browserContextId = tab.context.id;
                const { targetId } = await session.send('Target.createTarget', params);
                const target = await browser.waitForTarget(t => t._targetId === targetId, { timeout: 10000 });
                page = await target.page();
            } finally {
                session.detach().catch(() => {});
            }
        }
        this.attachPage(tab, page);
        if (tab.kind === 'main') {
            try { await page.bringToFront(); } catch { /* best effort */ }
        }
        return page;
    }

    /**
     * Create a tab. `name` optional (tab-N). Throws 400 (bad name), 409
     * (exists, or no capacity for an explicit create).
     */
    async create(name, { kind = 'agent', url, isolated = false, auto = false } = {}) {
        await this.bm.ensureConnected();
        if (name == null) name = this.nextName();
        else if (name !== 'main' || kind !== 'main') this.validateName(name);
        if (this.tabs.has(name)) throw httpError(409, `tab "${name}" already exists`);
        if (kind !== 'main' && this.nonMainCount() >= this.opts.maxTabs) {
            const idle = [...this.tabs.values()].filter(t => t.kind !== 'main' && !this.isBusy(t)).map(t => t.name);
            throw httpError(409, `tab limit reached (${this.opts.maxTabs} besides main); close one first`,
                { idleTabs: idle });
        }
        const tab = this.newTab(name, kind, { isolated: !!isolated });
        this.tabs.set(name, tab);   // reserve the name before awaiting
        try {
            await this.openPage(tab);
            if (url) await tab.page.goto(url, { waitUntil: 'load', timeout: 30000 });
        } catch (err) {
            this.tabs.delete(name);
            if (tab.page) tab.page.close().catch(() => {});
            if (tab.context) tab.context.close().catch(() => {});
            throw err;
        }
        this.lost.delete(name);
        this.save();
        log.info('tabs', auto ? 'tab created on first use' : 'tab created', {
            tab: name, kind, isolated: isolated || undefined, window: kind !== 'main' && this.opts.tabsAs === 'windows',
            url: url || undefined, nonMain: this.nonMainCount()
        });
        return tab;
    }

    /**
     * Get `name` ready to run on: connected, page alive (crashed/closed pages
     * replaced and reported in the request context). Unknown names are
     * created when `create` (reported as ctx.tabCreated).
     */
    async resolve(name, { create = true } = {}) {
        await this.bm.ensureConnected();
        const ctx = log.context();
        let tab = this.tabs.get(name);
        if (!tab) {
            if (!create) throw httpError(404, `Tab ${name} not found`);
            tab = await this.create(name, { kind: name === 'main' ? 'main' : 'agent', auto: true });
            if (ctx && name !== 'main') ctx.tabCreated = true;
        }
        await this.ensureLivePage(tab);
        tab.lastUsedAt = Date.now();
        return tab;
    }

    async ensureLivePage(tab) {
        const ctx = log.context();
        const replaced = (reason, error) => {
            const url = tab.lastUrl || safeUrl(tab.page);
            log.warn('tabs', `replacing tab page: ${reason}`, { tab: tab.name, url, error });
            if (ctx) ctx.tabCrashed = { tab: tab.name, page: tab.name, url, replaced: true, error };
            const old = tab.page;
            tab.page = null;
            if (old) old.close().catch(() => {});
        };
        if (tab.page && tab.crashed) {
            replaced('it crashed');
        } else if (tab.page && !tab.page.isClosed()) {
            const r = await probe(tab.page, this.opts.pageProbeTimeoutMs);
            if (r === 'ok') return tab;
            if (r === 'timeout') {
                // Keep it (it may hold session state); the run's timeout bounds the rest.
                log.warn('tabs', 'tab unresponsive (busy main thread?); using it anyway',
                    { tab: tab.name, probeTimeoutMs: this.opts.pageProbeTimeoutMs, url: safeUrl(tab.page) });
                return tab;
            }
            replaced('it is dead', r.message);
        } else if (tab.page) {
            replaced('it was closed');
        }
        if (!tab.page) {
            await this.openPage(tab);
            this.save();
        }
        return tab;
    }

    /** Close a tab. `main` and busy tabs need `force`. */
    async close(name, { force = false, reason = 'closed' } = {}) {
        const tab = this.tabs.get(name);
        if (!tab) throw httpError(404, `tab "${name}" not found`);
        if (tab.kind === 'main' && !force) throw httpError(409, 'refusing to close "main" without ?force=true');
        if (this.isBusy(tab) && !force && !tab.leased) {
            throw httpError(409, `tab "${name}" is busy; use ?force=true to close it anyway`);
        }
        this.tabs.delete(name);
        const page = tab.page;
        tab.page = null;
        try { if (page && !page.isClosed()) await page.close(); }
        catch (err) { log.debug('tabs', 'page close failed', { tab: name, error: err.message }); }
        if (tab.context) {
            try { await tab.context.close(); } catch { /* already gone */ }
        }
        if (PERSISTED_KINDS.has(tab.kind)) this.save();
        log.info('tabs', 'tab closed', { tab: name, kind: tab.kind, reason });
        this.notify();
        return true;
    }

    // ── capacity: tab: "new" and the pool aliases ────────────────────────────

    notify() {
        const waiters = this.waiters.splice(0);
        for (const w of waiters) w();
    }

    /**
     * Get a tab for exclusive use: an idle pool tab, or a new tab-N of `kind`
     * ('ephemeral' or 'pool'), waiting up to acquireTimeoutMs for capacity.
     * Returns the tab (leased) or { error }.
     */
    async take(kind = 'ephemeral', { timeoutMs = this.opts.acquireTimeoutMs } = {}) {
        await this.bm.ensureConnected();
        const deadline = Date.now() + timeoutMs;
        let waitedFrom = null;
        for (;;) {
            for (const tab of [...this.tabs.values()]) {
                if (tab.kind !== 'pool' || this.isBusy(tab)) continue;
                tab.leased = true;
                const alive = tab.page && !tab.crashed && (await probe(tab.page, IDLE_PROBE_MS)) === 'ok';
                if (!alive) {
                    log.warn('tabs', 'idle pool tab does not respond (crashed?); replacing it', { tab: tab.name });
                    tab.leased = false;
                    await this.close(tab.name, { force: true, reason: 'unresponsive' });
                    continue;
                }
                tab.lastUsedAt = Date.now();
                if (waitedFrom) log.info('tabs', 'waiter got a tab', { tab: tab.name, waitedMs: Date.now() - waitedFrom });
                return tab;
            }
            if (this.nonMainCount() < this.opts.maxTabs) {
                const tab = await this.create(null, { kind, auto: true });
                tab.leased = true;
                return tab;
            }
            const left = deadline - Date.now();
            if (left <= 0) {
                log.warn('tabs', 'timed out waiting for a tab', { timeoutMs, ...this.poolStatus() });
                return { error: `no tab became free within ${timeoutMs}ms (limit of ${this.opts.maxTabs} tabs reached)` };
            }
            if (!waitedFrom) {
                waitedFrom = Date.now();
                log.warn('tabs', 'tab limit reached; waiting for a tab', this.poolStatus());
            }
            await new Promise(resolve => {
                const timer = setTimeout(done, left);
                function done() { clearTimeout(timer); resolve(); }
                this.waiters.push(done);
            });
        }
    }

    /** Give back a tab from take(): ephemeral tabs are closed, pool tabs go idle. */
    async giveBack(tab) {
        tab.leased = false;
        tab.lastUsedAt = Date.now();
        if (!this.tabs.has(tab.name)) return this.notify();
        if (tab.kind === 'ephemeral' || tab.crashed) {
            await this.close(tab.name, { force: true, reason: tab.crashed ? 'crashed' : 'run finished' });
        } else {
            log.info('tabs', 'tab released', { tab: tab.name, ...this.poolStatus() });
            this.notify();
        }
    }

    // ── per-tab queues ───────────────────────────────────────────────────────

    queue(name) {
        let q = this.queues.get(name);
        if (!q) this.queues.set(name, q = { items: [], running: null });
        return q;
    }

    queueLength(name) {
        const q = this.queues.get(name);
        return q ? q.items.length : 0;
    }

    totalQueued() {
        let n = 0;
        for (const q of this.queues.values()) n += q.items.length;
        return n;
    }

    /** Add `item` ({ run: async fn, ... }) to `name`'s queue; resolves with run()'s result. */
    enqueue(name, item) {
        const q = this.queue(name);
        return new Promise((resolve, reject) => {
            q.items.push({ ...item, resolve, reject });
            this.pump(name);
        });
    }

    async pump(name) {
        const q = this.queue(name);
        if (q.running || q.items.length === 0) return;
        const item = q.items.shift();
        q.running = item;
        try {
            item.resolve(await item.run());
        } catch (err) {
            item.reject(err);
        } finally {
            q.running = null;
            const tab = this.tabs.get(name);
            if (tab) tab.lastUsedAt = Date.now();
            if (q.items.length) this.pump(name);
            else this.queues.delete(name);
        }
    }

    /** Remove queued items matching `pred` (optionally only on `name`); returns them. */
    removeQueued(pred, name = null) {
        const out = [];
        for (const [n, q] of this.queues) {
            if (name && n !== name) continue;
            const keep = [];
            for (const it of q.items) (pred(it) ? out : keep).push(it);
            q.items = keep;
        }
        return out;
    }

    // ── views ────────────────────────────────────────────────────────────────

    view(tab) {
        const q = this.queues.get(tab.name);
        const expires = tab.kind === 'agent' || tab.kind === 'pool';
        return {
            name: tab.name, kind: tab.kind, url: safeUrl(tab.page) || tab.lastUrl || null,
            busy: this.isBusy(tab), running: !!(q && q.running) || !!tab.ephemeralRun,
            queued: q ? q.items.length : 0, leased: tab.leased || undefined,
            isolated: tab.isolated || undefined, crashed: tab.crashed || undefined,
            createdAt: tab.createdAt, lastUsedAt: tab.lastUsedAt,
            expiresAt: expires && !this.isBusy(tab) ? tab.lastUsedAt + this.opts.idleTtlMs : undefined
        };
    }

    async list() {
        const out = [];
        for (const tab of this.tabs.values()) {
            const v = this.view(tab);
            if (tab.page) {
                try { v.title = await Promise.race([tab.page.title(), new Promise(r => setTimeout(() => r(undefined), 1000))]); }
                catch { /* closed meanwhile */ }
            }
            out.push(v);
        }
        const now = Date.now();
        for (const [name, l] of this.lost) {
            if (now - l.at > LOST_KEEP_MS) { this.lost.delete(name); continue; }
            if (!this.tabs.has(name)) out.push({ name, lost: true, lostAt: l.at, reason: l.reason, url: l.url || null });
        }
        return out;
    }

    /** /pool/status shape, over all non-main tabs. */
    poolStatus() {
        let idle = 0;
        let busy = 0;
        for (const t of this.tabs.values()) {
            if (t.kind === 'main') continue;
            if (this.isBusy(t)) busy++; else idle++;
        }
        return { total: idle + busy, idle, busy, waiting: this.waiters.length, maxTabs: this.opts.maxTabs };
    }

    /** /pool/tabs shape. */
    poolTabs() {
        return [...this.tabs.values()].filter(t => t.kind !== 'main').map(t => ({
            tabId: t.name, kind: t.kind, status: this.isBusy(t) ? 'busy' : 'idle',
            createdAt: t.createdAt, lastUsed: t.lastUsedAt, url: safeUrl(t.page) || 'unknown'
        }));
    }

    /** Close idle non-main tabs unused for more than `maxIdleMs`. */
    async prune(maxIdleMs, reason = 'pruned') {
        const now = Date.now();
        let closed = 0;
        for (const t of [...this.tabs.values()]) {
            if (t.kind === 'main' || t.kind === 'ephemeral' || this.isBusy(t)) continue;
            if (now - t.lastUsedAt > maxIdleMs) {
                await this.close(t.name, { reason });
                closed++;
            }
        }
        if (closed) log.info('tabs', 'closed idle tabs', { closed, maxIdleMs, reason });
        return closed;
    }

    async closeAll() {
        for (const t of [...this.tabs.values()]) {
            if (t.kind === 'main') continue;
            await this.close(t.name, { force: true, reason: 'close-all' });
        }
    }

    sweep() {
        if (!this.bm.isRunning()) return;
        this.prune(this.opts.idleTtlMs, 'idle expiry').catch(err =>
            log.warn('tabs', 'idle sweep failed', { error: err.message }));
    }
}

module.exports = { TabManager, NAME_RE };
