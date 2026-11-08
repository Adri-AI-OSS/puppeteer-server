/**
 * Run scope: everything that belongs to ONE execution of a snippet.
 *
 * - Abort: snippets get proxies of `page` / `browser` (and page.keyboard /
 *   mouse / touchscreen). Once the run is aborted (timeout or cancel), every
 *   call through them throws RunAbortedError, and so does every in-flight call
 *   when it resolves. JS can't be killed, but an orphaned snippet now stops at
 *   its next browser interaction instead of driving a tab another run owns.
 * - Cleanup: listeners the snippet adds (page/browser on/once/addListener),
 *   request interception it turns on, and functions it exposes are undone when
 *   the run ends, unless the run asked to `persist`.
 * - Console: a per-run `console` whose output is returned with the result.
 * - Dialogs: a persistent, page-level default handler (installDialogHandler)
 *   settles JS dialogs nobody else handles and reports them to the runs active
 *   on that page.
 */

const util = require('util');
const log = require('./logger');
const { attachPageEvents, notifyDialogObservers } = require('./page-events');

const BLOCKED_BROWSER_METHODS = new Set(['disconnect', 'close']);
const ADD_LISTENER = new Set(['on', 'addListener']);
const REMOVE_LISTENER = new Set(['off', 'removeListener']);
const INPUT_OBJECTS = new Set(['keyboard', 'mouse', 'touchscreen']);

const LOG_MAX_ENTRIES = 500;
const LOG_MAX_BYTES = 64 * 1024;
const LOG_LEVELS = { log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'debug', trace: 'debug' };

const PAGE_EVENTS_MAX = 200;

async function clearViewportOverride(page) {
    const client = page._client();
    await client.send('Emulation.clearDeviceMetricsOverride');
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
}

/**
 * Page settings a snippet can change that would otherwise stick to the shared
 * tab. Each entry captures the state before the run's first change (it runs
 * synchronously, before the setter) and returns an async restore function.
 */
const SETTINGS = {
    setViewport: page => {
        const prev = page.viewport();
        return prev ? () => page.setViewport(prev) : () => clearViewportOverride(page);
    },
    setUserAgent: page => async () => page.setUserAgent(await page.browser().userAgent()),
    setExtraHTTPHeaders: page => () => page.setExtraHTTPHeaders({}),
    setOfflineMode: page => () => page.setOfflineMode(false),
    emulateNetworkConditions: page => () => page.emulateNetworkConditions(null),
    setJavaScriptEnabled: page => {
        const prev = page.isJavaScriptEnabled();
        return () => page.setJavaScriptEnabled(prev);
    },
    setCacheEnabled: page => () => page.setCacheEnabled(true),
    setBypassCSP: page => () => page.setBypassCSP(false),
    setBypassServiceWorker: page => {
        const prev = page.isServiceWorkerBypassed();
        return () => page.setBypassServiceWorker(prev);
    },
    emulateMediaType: page => () => page.emulateMediaType(undefined),
    emulateMediaFeatures: page => () => page.emulateMediaFeatures(undefined),
    emulateTimezone: page => () => page.emulateTimezone(undefined),
    emulateCPUThrottling: page => () => page.emulateCPUThrottling(null),
    emulateIdleState: page => () => page.emulateIdleState(),
    emulateVisionDeficiency: page => () => page.emulateVisionDeficiency('none'),
    setGeolocation: page => () => page._client().send('Emulation.clearGeolocationOverride'),
    authenticate: page => () => page.authenticate(null),
    setDefaultTimeout: page => {
        const prev = page.getDefaultTimeout();
        return async () => page.setDefaultTimeout(prev);
    },
    setDefaultNavigationTimeout: page => async () => page.setDefaultNavigationTimeout(30000)
};
// page.emulate(device) = viewport + user agent.
const COMPOSITE_SETTINGS = { emulate: ['setViewport', 'setUserAgent'] };

class RunAbortedError extends Error {
    constructor(run, reason) {
        super(`Run ${run} was aborted (${reason}); further page/browser calls from this snippet are refused`);
        this.name = 'RunAbortedError';
        this.isAborted = true;
        this.reason = reason;
    }
}

// page -> Set<RunScope> of runs currently executing on it (for dialog reports)
const activeScopes = new WeakMap();
const dialogHandled = new WeakSet();
const crashEventsEnabled = new WeakSet();

/**
 * Puppeteer turns `Inspector.targetCrashed` into the page 'error' event but
 * never enables the Inspector domain, so on some platforms (Linux) crashes go
 * unreported. Enable it once per page.
 */
function enableCrashEvents(page) {
    if (!page || crashEventsEnabled.has(page)) return;
    crashEventsEnabled.add(page);
    try {
        page._client().send('Inspector.enable').catch(err =>
            log.debug('page', 'Inspector.enable failed', { error: err.message }));
    } catch { /* page gone */ }
}

class RunScope {
    constructor({ run, persist = false, keepTabs = false }) {
        this.run = run;
        this.persist = !!persist;
        this.keepTabs = !!keepTabs || this.persist;
        this.controller = new AbortController();
        this.abortReason = null;
        this.abortedAt = null;
        this.startedAt = Date.now();
        this.ended = false;

        this.listeners = [];            // { emitter, event, handler, owner }
        this.interception = false;      // snippet turned request interception on
        this.interceptionPage = null;
        this.exposed = [];              // { page, name }
        this.settings = new Map();      // method -> { page, restore }
        this.newDocScripts = [];        // { page, identifier }
        this.tabs = new Set();          // page Targets the run opened (newPage, popups)
        this.contexts = new Set();      // browser contexts the run created
        this.cleanupReport = null;

        this.pageEvents = null;         // [] when the run asked for pageEvents
        this.pageEventsTruncated = false;
        this._detachEvents = null;
        this._detachTabWatch = null;

        this.logs = [];
        this.logBytes = 0;
        this.logsTruncated = false;
        this.dialogs = [];

        this.console = this._makeConsole();
    }

    get signal() {
        return this.controller.signal;
    }

    get aborted() {
        return this.abortReason !== null;
    }

    abort(reason) {
        if (this.aborted) return;
        this.abortReason = reason;
        this.abortedAt = Date.now();
        this.controller.abort(new RunAbortedError(this.run, reason));
    }

    check() {
        if (this.aborted) throw new RunAbortedError(this.run, this.abortReason);
    }

    // ── proxies ──────────────────────────────────────────────────────────────

    /** Call `fn` unless aborted; a promise result also re-checks on settle. */
    _guarded(fn, target, args) {
        this.check();
        const r = fn.apply(target, args);
        if (r && typeof r.then === 'function') {
            return r.then(
                v => { this.check(); return v; },
                e => { if (this.aborted) throw new RunAbortedError(this.run, this.abortReason); throw e; }
            );
        }
        return r;
    }

    _trackListeners(target, proxyRef, owner) {
        const scope = this;
        return {
            add(event, handler) {
                scope.check();
                target.on(event, handler);
                scope.listeners.push({ emitter: target, event, handler, owner });
                return proxyRef();
            },
            once(event, handler) {
                scope.check();
                // Wrap ourselves so the exact function we register can be removed.
                const wrapper = (...a) => {
                    target.off(event, wrapper);
                    scope.listeners = scope.listeners.filter(l => l.handler !== wrapper);
                    return handler(...a);
                };
                wrapper.original = handler;
                target.on(event, wrapper);
                scope.listeners.push({ emitter: target, event, handler: wrapper, owner });
                return proxyRef();
            },
            remove(event, handler) {
                const rec = scope.listeners.find(l => l.emitter === target && l.event === event
                    && (l.handler === handler || l.handler.original === handler));
                const fn = rec ? rec.handler : handler;
                target.off(event, fn);
                if (rec) scope.listeners = scope.listeners.filter(l => l !== rec);
                return proxyRef();
            }
        };
    }

    _wrapPlain(obj) {
        const scope = this;
        return new Proxy(obj, {
            get(target, prop) {
                const value = Reflect.get(target, prop, target);
                if (typeof value !== 'function') return value;
                return (...args) => scope._guarded(value, target, args);
            }
        });
    }

    wrapPage(page) {
        if (!page) return page;
        const scope = this;
        let proxy;
        const lt = this._trackListeners(page, () => proxy, 'page');
        const inputs = {};
        proxy = new Proxy(page, {
            get(target, prop) {
                if (INPUT_OBJECTS.has(prop)) {
                    const obj = Reflect.get(target, prop, target);
                    if (!obj) return obj;
                    return inputs[prop] || (inputs[prop] = scope._wrapPlain(obj));
                }
                const value = Reflect.get(target, prop, target);
                if (typeof value !== 'function') return value;
                if (ADD_LISTENER.has(prop)) return lt.add;
                if (prop === 'once') return lt.once;
                if (REMOVE_LISTENER.has(prop)) return lt.remove;
                if (prop === 'browser') {
                    // Same guarded browser the snippet got as `browser`.
                    return () => { scope.check(); return scope.wrapBrowser(target.browser()); };
                }
                if (prop === 'setRequestInterception') {
                    return async (enabled) => {
                        await scope._guarded(value, target, [enabled]);
                        scope.interception = !!enabled;
                        scope.interceptionPage = enabled ? target : null;
                    };
                }
                if (SETTINGS[prop] || COMPOSITE_SETTINGS[prop]) {
                    return (...args) => {
                        scope.check();
                        for (const name of COMPOSITE_SETTINGS[prop] || [prop]) {
                            if (!scope.settings.has(name)) {
                                try { scope.settings.set(name, { page: target, restore: SETTINGS[name](target) }); }
                                catch (e) { log.debug('exec', 'could not capture setting', { run: scope.run, name, error: e.message }); }
                            }
                        }
                        return scope._guarded(value, target, args);
                    };
                }
                if (prop === 'evaluateOnNewDocument') {
                    return async (...args) => {
                        const r = await scope._guarded(value, target, args);
                        if (r && r.identifier) scope.newDocScripts.push({ page: target, identifier: r.identifier });
                        return r;
                    };
                }
                if (prop === 'removeScriptToEvaluateOnNewDocument') {
                    return async (identifier) => {
                        const r = await scope._guarded(value, target, [identifier]);
                        scope.newDocScripts = scope.newDocScripts.filter(e => e.identifier !== identifier);
                        return r;
                    };
                }
                if (prop === 'exposeFunction') {
                    return async (name, fn) => {
                        const r = await scope._guarded(value, target, [name, fn]);
                        scope.exposed.push({ page: target, name });
                        return r;
                    };
                }
                if (prop === 'removeExposedFunction') {
                    return async (name) => {
                        const r = await scope._guarded(value, target, [name]);
                        scope.exposed = scope.exposed.filter(e => !(e.page === target && e.name === name));
                        return r;
                    };
                }
                return (...args) => scope._guarded(value, target, args);
            }
        });
        return proxy;
    }

    wrapBrowser(browser) {
        if (!browser) return browser;
        if (this._browserProxy && this._browserTarget === browser) return this._browserProxy;
        const scope = this;
        let proxy;
        const lt = this._trackListeners(browser, () => proxy, 'browser');
        proxy = new Proxy(browser, {
            get(target, prop) {
                if (BLOCKED_BROWSER_METHODS.has(prop)) {
                    return () => {
                        log.warn('exec', `blocked browser.${String(prop)}() from snippet`, { run: scope.run });
                        throw new Error(
                            `browser.${String(prop)}() is not allowed in executed code: ` +
                            'the server owns the shared browser connection. Use POST /reconnect ' +
                            'or POST /shutdown instead.'
                        );
                    };
                }
                const value = Reflect.get(target, prop, target);
                if (typeof value !== 'function') return value;
                if (ADD_LISTENER.has(prop)) return lt.add;
                if (prop === 'once') return lt.once;
                if (REMOVE_LISTENER.has(prop)) return lt.remove;
                if (prop === 'newPage') {
                    return async (...args) => {
                        const p = await scope._guarded(value, target, args);
                        scope.tabs.add(p.target());
                        return p;
                    };
                }
                if (prop === 'createIncognitoBrowserContext' || prop === 'createBrowserContext') {
                    return async (...args) => {
                        const ctx = await scope._guarded(value, target, args);
                        scope.contexts.add(ctx);
                        return ctx;
                    };
                }
                return (...args) => scope._guarded(value, target, args);
            }
        });
        this._browserTarget = browser;
        this._browserProxy = proxy;
        return proxy;
    }

    // ── cleanup ──────────────────────────────────────────────────────────────

    /**
     * Undo per-run page state. With `persist`, nothing is undone and the
     * report lists what was kept. Never throws.
     */
    async cleanup() {
        this.stopTracking();
        const tabs = [...this.tabs].filter(t => !isTargetClosed(t));
        const report = {
            listeners: this.listeners.length,
            interception: this.interception,
            exposed: this.exposed.map(e => e.name),
            settings: [...this.settings.keys()],
            newDocumentScripts: this.newDocScripts.length,
            tabs: tabs.length,
            contexts: this.contexts.size
        };
        const empty = !report.listeners && !report.interception && !report.exposed.length
            && !report.settings.length && !report.newDocumentScripts && !report.tabs && !report.contexts;
        if (empty) {
            this.cleanupReport = null;
            return null;
        }
        if (this.persist) {
            this.cleanupReport = { kept: report };
            log.info('exec', 'persist: keeping snippet page state', { run: this.run, ...report });
            return this.cleanupReport;
        }
        const errors = [];
        const attempt = async (what, fn) => {
            try { await fn(); } catch (e) { errors.push(`${what}: ${e.message}`); }
        };
        // Interception first: with it on and its handler gone, requests hang.
        if (this.interception && this.interceptionPage && !this.interceptionPage.isClosed()) {
            await attempt('setRequestInterception(false)', () => this.interceptionPage.setRequestInterception(false));
        }
        for (const l of this.listeners) {
            await attempt(`off(${String(l.event)})`, () => l.emitter.off(l.event, l.handler));
        }
        for (const e of this.exposed) {
            if (e.page.isClosed()) continue;
            await attempt(`removeExposedFunction(${e.name})`, () => e.page.removeExposedFunction(e.name));
        }
        for (const [name, { page, restore }] of this.settings) {
            if (page.isClosed()) continue;
            await attempt(`restore ${name}`, restore);
        }
        for (const { page, identifier } of this.newDocScripts) {
            if (page.isClosed()) continue;
            await attempt('removeScriptToEvaluateOnNewDocument',
                () => page.removeScriptToEvaluateOnNewDocument(identifier));
        }
        let keptTabs = 0;
        if (this.keepTabs) {
            keptTabs = tabs.length + this.contexts.size;
        } else {
            for (const t of tabs) {
                await attempt('close tab', async () => {
                    const p = await t.page();
                    if (p && !p.isClosed()) await p.close();
                });
            }
            for (const ctx of this.contexts) {
                await attempt('close browser context', () => ctx.close());
            }
        }
        this.listeners = [];
        this.exposed = [];
        this.settings.clear();
        this.newDocScripts = [];
        this.interception = false;
        this.cleanupReport = {
            removed: report,
            keptTabs: keptTabs || undefined,
            errors: errors.length ? errors : undefined
        };
        log.info('exec', 'cleaned up snippet page state', { run: this.run, ...report,
            keptTabs: keptTabs || undefined, errors: errors.length ? errors : undefined });
        return this.cleanupReport;
    }

    // ── tab tracking and page events ─────────────────────────────────────────

    /**
     * Start tracking for the run on `page`: popups whose opener chain leads to
     * the run's page (or to a tab the run opened), and, if asked, page events.
     */
    startTracking(page, browser, { pageEvents } = {}) {
        if (browser) {
            const mine = page.target();
            const onTarget = log.background(t => {
                if (t.type() !== 'page') return;
                for (let o = t.opener(); o; o = o.opener()) {
                    if (o === mine || this.tabs.has(o)) { this.tabs.add(t); return; }
                }
            });
            browser.on('targetcreated', onTarget);
            this._detachTabWatch = () => browser.off('targetcreated', onTarget);
        }
        if (pageEvents) {
            this.pageEvents = [];
            this._detachEvents = attachPageEvents(page, pageEvents, ev => {
                if (this.pageEvents.length >= PAGE_EVENTS_MAX) { this.pageEventsTruncated = true; return; }
                this.pageEvents.push({ ...ev, ms: Date.now() - this.startedAt });
            });
        }
    }

    stopTracking() {
        if (this._detachTabWatch) { this._detachTabWatch(); this._detachTabWatch = null; }
        if (this._detachEvents) { this._detachEvents(); this._detachEvents = null; }
    }

    // ── console ──────────────────────────────────────────────────────────────

    _makeConsole() {
        const scope = this;
        const c = {};
        for (const [method, level] of Object.entries(LOG_LEVELS)) {
            c[method] = (...args) => scope._capture(level, util.format(...args));
        }
        c.dir = (obj, opts) => scope._capture('log', util.inspect(obj, { depth: 4, ...opts }));
        c.table = (data) => scope._capture('log', util.inspect(data, { depth: 3 }));
        c.assert = (cond, ...args) => {
            if (!cond) scope._capture('error', 'Assertion failed' + (args.length ? ': ' + util.format(...args) : ''));
        };
        return c;
    }

    _capture(level, msg) {
        const ms = Date.now() - this.startedAt;
        if (this.ended) {
            // Output from an orphaned snippet after its run ended.
            log.warn('exec', 'console output after run ended', { run: this.run, level, msg: log.preview(msg, 300) });
            return;
        }
        log.debug('exec', 'snippet console', { run: this.run, level, msg: log.preview(msg, 300) });
        if (this.logsTruncated) return;
        const bytes = Buffer.byteLength(msg);
        if (this.logs.length >= LOG_MAX_ENTRIES || this.logBytes + bytes > LOG_MAX_BYTES) {
            this.logsTruncated = true;
            return;
        }
        this.logBytes += bytes;
        this.logs.push({ level, msg, ms });
    }

    // ── results ──────────────────────────────────────────────────────────────

    /** Fields added to the HTTP response. */
    responseFields() {
        const f = {};
        if (this.logs.length) f.logs = this.logs;
        if (this.logsTruncated) f.logsTruncated = true;
        if (this.dialogs.length) f.dialogs = this.dialogs;
        if (this.pageEvents && this.pageEvents.length) f.pageEvents = this.pageEvents;
        if (this.pageEventsTruncated) f.pageEventsTruncated = true;
        if (this.cleanupReport && this.cleanupReport.kept) f.persisted = this.cleanupReport.kept;
        if (this.cleanupReport && this.cleanupReport.keptTabs) f.keptTabs = this.cleanupReport.keptTabs;
        if (this.aborted) f.aborted = this.abortReason;
        return f;
    }

    /** Fields added to the execution log's `end` record. */
    logFields() {
        return {
            ...this.responseFields(),
            settledAfterAbortMs: this.settledAfterAbortMs,
            orphan: this.orphan || undefined,
            cleanup: this.cleanupReport || undefined
        };
    }
}

// ── page-level wiring ────────────────────────────────────────────────────────

function isTargetClosed(target) {
    try {
        const b = target.browser();
        return !b.targets().includes(target);
    } catch {
        return true;
    }
}

function registerScope(page, scope) {
    let set = activeScopes.get(page);
    if (!set) activeScopes.set(page, set = new Set());
    set.add(scope);
}

function unregisterScope(page, scope) {
    const set = activeScopes.get(page);
    if (set) set.delete(scope);
}

/**
 * Settle JS dialogs that no one else handles, so they can't freeze the tab.
 * alert/beforeunload → accept; confirm/prompt → dismiss. Idempotent per page.
 */
function installDialogHandler(page, label) {
    if (!page || dialogHandled.has(page)) return;
    dialogHandled.add(page);
    const handler = log.background(async (dialog) => {
        // Someone else (a snippet) listens for dialogs: they own it.
        if (page.listenerCount('dialog') > 1) return;
        const type = dialog.type();
        const message = dialog.message();
        const action = (type === 'alert' || type === 'beforeunload') ? 'accepted' : 'dismissed';
        try {
            if (action === 'accepted') await dialog.accept();
            else await dialog.dismiss();
        } catch (err) {
            log.debug('page', 'default dialog handler: already handled', { page: label, type, error: err.message });
            return;
        }
        const scopes = activeScopes.get(page);
        const runs = scopes ? [...scopes].map(s => s.run) : [];
        log.warn('page', `auto-${action} JS dialog`, { page: label, type, message: log.preview(message, 200),
            runs: runs.length ? runs.join(',') : undefined });
        if (scopes) for (const s of scopes) s.dialogs.push({ type, message, action, ms: Date.now() - s.startedAt });
        notifyDialogObservers(page, { type, message, action });
    });
    page.on('dialog', handler);
}

module.exports = { RunScope, RunAbortedError, registerScope, unregisterScope, installDialogHandler, enableCrashEvents };
