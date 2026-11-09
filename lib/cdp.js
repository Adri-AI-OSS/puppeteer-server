/**
 * Browser-level CDP commands without a browser-target session.
 *
 * In Puppeteer 21, opening a session on `browser.target()` and detaching it
 * can make Puppeteer drop the browser target ("Browser target is not found"
 * on every later browser.target() call). Browser-level commands (Target.*,
 * Browser.*) don't need a session: they go over the root connection, which
 * every page session exposes. Events without a session id are emitted on it.
 */

async function rootConnection(browser) {
    for (const page of await browser.pages()) {
        try {
            const conn = page._client().connection();
            if (conn) return conn;
        } catch { /* closing page: try the next one */ }
    }
    throw new Error('no open page to reach the browser connection through');
}

/** Send a browser-level CDP command. */
async function browserSend(browser, method, params = {}) {
    return (await rootConnection(browser)).send(method, params);
}

module.exports = { rootConnection, browserSend };
