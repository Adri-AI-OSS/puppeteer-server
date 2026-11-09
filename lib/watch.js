/**
 * Watches: observe a page's events across calls.
 *
 *   POST   /watch            { events?, tab?, maxEvents? } -> { watchId }   (page/tabId: aliases of tab)
 *   GET    /watch/:id?since= -> { events: [{seq, ts, type, ...}], next, dropped, closed }
 *   DELETE /watch/:id
 *   GET    /watch
 *
 * Events go into a bounded ring buffer (oldest dropped first, counted in
 * `dropped`). A watch is bound to one page object: if that page closes or is
 * replaced (crash), the watch reports `closed: true`. Unread watches expire
 * after `idleTtlMs`.
 */

const log = require('./logger');
const { attachPageEvents, normalizeTypes } = require('./page-events');
const { installDialogHandler } = require('./run-scope');

const DEFAULT_WATCH_TYPES = ['console', 'pageerror', 'requestfailed', 'httpError', 'framenavigated', 'dialog', 'popup'];
const MAX_EVENTS_LIMIT = 10000;

class WatchManager {
    constructor(tabs, { idleTtlMs = 30 * 60 * 1000 } = {}) {
        this.tabs = tabs;
        this.idleTtlMs = idleTtlMs;
        this.watches = new Map();
        this.counter = 0;
        this.sweeper = setInterval(() => this.sweep(), 60000);
        this.sweeper.unref();
    }

    async create({ events, tab: tabName, page: pageName, tabId, maxEvents = 1000 } = {}) {
        const types = normalizeTypes(events, DEFAULT_WATCH_TYPES);
        const max = Math.max(1, Math.min(Number(maxEvents) || 1000, MAX_EVENTS_LIMIT));
        const label = tabName || tabId || pageName || 'main';
        this.tabs.validateName(label);
        // Only "main" is created on demand; other tabs must exist.
        const tab = await this.tabs.resolve(label, { create: label === 'main' });
        const page = tab.page;
        installDialogHandler(page, label);

        const w = {
            id: `w${++this.counter}`, target: label, types, max, page,
            events: [], seq: 0, dropped: 0, closed: false,
            createdAt: Date.now(), lastReadAt: Date.now()
        };
        w.detach = attachPageEvents(page, types, ev => {
            w.events.push({ seq: ++w.seq, ts: new Date().toISOString(), ...ev });
            if (w.events.length > w.max) {
                w.events.shift();
                w.dropped++;
            }
        });
        const onClose = log.background(() => {
            w.closed = true;
            log.info('watch', 'watched page closed', { watch: w.id, target: label });
        });
        page.once('close', onClose);
        w.offClose = () => page.off('close', onClose);
        this.watches.set(w.id, w);
        log.info('watch', 'watch started', { watch: w.id, target: label, types, maxEvents: max });
        return this.summary(w);
    }

    summary(w) {
        return { watchId: w.id, tab: w.target, target: w.target, events: w.types, maxEvents: w.max,
            buffered: w.events.length, lastSeq: w.seq, dropped: w.dropped, closed: w.closed,
            createdAt: w.createdAt };
    }

    read(id, { since = 0, limit = 500 } = {}) {
        const w = this.watches.get(id);
        if (!w) return null;
        w.lastReadAt = Date.now();
        since = Number(since) || 0;
        limit = Math.max(1, Math.min(Number(limit) || 500, MAX_EVENTS_LIMIT));
        const events = w.events.filter(e => e.seq > since).slice(0, limit);
        const next = events.length ? events[events.length - 1].seq : Math.max(since, 0);
        return {
            watchId: w.id, target: w.target, events, next,
            more: w.events.some(e => e.seq > next),
            dropped: w.dropped, closed: w.closed
        };
    }

    delete(id) {
        const w = this.watches.get(id);
        if (!w) return false;
        try { w.detach(); } catch { /* page gone */ }
        try { w.offClose(); } catch { /* page gone */ }
        this.watches.delete(id);
        log.info('watch', 'watch stopped', { watch: id, events: w.seq, dropped: w.dropped });
        return true;
    }

    list() {
        return [...this.watches.values()].map(w => this.summary(w));
    }

    sweep() {
        const now = Date.now();
        for (const w of [...this.watches.values()]) {
            if (now - w.lastReadAt > this.idleTtlMs) {
                log.info('watch', 'watch expired (not read)', { watch: w.id, idleMs: now - w.lastReadAt });
                this.delete(w.id);
            }
        }
    }

    closeAll() {
        for (const id of [...this.watches.keys()]) this.delete(id);
    }
}

module.exports = { WatchManager, DEFAULT_WATCH_TYPES };
