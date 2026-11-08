/**
 * Page event capture shared by per-run `pageEvents` and `/watch` subscriptions.
 *
 * attachPageEvents(page, types, push) registers raw listeners on the page and
 * returns a detach function. Each event is pushed as a plain, JSON-safe object
 * `{ type, ... }`.
 *
 * Types:
 *   console        browser console message      { level, text, url? }
 *   pageerror      uncaught exception in page   { message }
 *   requestfailed  network failure              { url, method, error, resourceType }
 *   httpError      response with status >= 400  { url, status, method, resourceType }
 *   response       every response               { url, status, method, resourceType }
 *   request        every request                { url, method, resourceType }
 *   framenavigated main-frame navigation        { url }
 *   popup          page opened a popup          { url }
 *   dialog         JS dialog (observed; the server's default handler or the
 *                  snippet still answers it)    { dialogType, message }
 */

const log = require('./logger');

const ALL_TYPES = ['console', 'pageerror', 'requestfailed', 'httpError', 'response', 'request',
    'framenavigated', 'popup', 'dialog'];
const DEFAULT_RUN_TYPES = ['console', 'pageerror', 'requestfailed', 'httpError'];
const TEXT_MAX = 2000;

function cap(s, max = TEXT_MAX) {
    s = s == null ? '' : String(s);
    return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

// page -> Set<fn(dialog info)>; notified by the default dialog handler.
const dialogObservers = new WeakMap();

function addDialogObserver(page, fn) {
    let set = dialogObservers.get(page);
    if (!set) dialogObservers.set(page, set = new Set());
    set.add(fn);
    return () => set.delete(fn);
}

function notifyDialogObservers(page, info) {
    const set = dialogObservers.get(page);
    if (set) for (const fn of set) { try { fn(info); } catch { /* observer bug */ } }
}

function normalizeTypes(types, fallback) {
    if (types === true || types == null) return fallback;
    const list = (Array.isArray(types) ? types : [types]).map(String);
    const unknown = list.filter(t => !ALL_TYPES.includes(t));
    if (unknown.length) {
        const err = new Error(`unknown event type(s): ${unknown.join(', ')}; valid: ${ALL_TYPES.join(', ')}`);
        err.status = 400;
        throw err;
    }
    return list;
}

function attachPageEvents(page, types, push) {
    const want = new Set(types);
    const offs = [];
    const on = (event, fn) => {
        const handler = log.background((...a) => {
            try { fn(...a); } catch (err) { log.debug('events', 'event capture failed', { event, error: err.message }); }
        });
        page.on(event, handler);
        offs.push(() => page.off(event, handler));
    };

    if (want.has('console')) {
        on('console', msg => {
            const loc = msg.location && msg.location();
            push({ type: 'console', level: msg.type(), text: cap(msg.text()), url: loc && loc.url ? loc.url : undefined });
        });
    }
    if (want.has('pageerror')) {
        on('pageerror', err => push({ type: 'pageerror', message: cap(err && err.message ? err.message : err) }));
    }
    if (want.has('requestfailed')) {
        on('requestfailed', req => push({
            type: 'requestfailed', url: cap(req.url(), 500), method: req.method(),
            error: req.failure() ? req.failure().errorText : undefined, resourceType: req.resourceType()
        }));
    }
    if (want.has('httpError') || want.has('response')) {
        on('response', res => {
            const status = res.status();
            const base = { url: cap(res.url(), 500), status, method: res.request().method(),
                resourceType: res.request().resourceType() };
            if (want.has('response')) push({ type: 'response', ...base });
            if (want.has('httpError') && status >= 400) push({ type: 'httpError', ...base });
        });
    }
    if (want.has('request')) {
        on('request', req => push({ type: 'request', url: cap(req.url(), 500), method: req.method(),
            resourceType: req.resourceType() }));
    }
    if (want.has('framenavigated')) {
        on('framenavigated', frame => {
            if (frame === page.mainFrame()) push({ type: 'framenavigated', url: cap(frame.url(), 500) });
        });
    }
    if (want.has('popup')) {
        on('popup', p => push({ type: 'popup', url: p ? cap(p.url(), 500) : undefined }));
    }
    if (want.has('dialog')) {
        offs.push(addDialogObserver(page, d => push({ type: 'dialog', dialogType: d.type, message: cap(d.message),
            action: d.action })));
    }
    return () => { for (const off of offs.splice(0)) { try { off(); } catch { /* page gone */ } } };
}

module.exports = { attachPageEvents, normalizeTypes, notifyDialogObservers, addDialogObserver,
    ALL_TYPES, DEFAULT_RUN_TYPES };
