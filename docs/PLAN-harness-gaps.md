# Plan: close the harness gaps for executed snippets

Status: all TODOs below are done; `npm test` runs the integration suite (27 tests).

Agents drive the browser by sending JavaScript to `/execute`, `/run`,
`/pool/execute` and `/pool/tab/:id/execute`. The code runs as an
`AsyncFunction(page, browser, helpers)` on a shared, authenticated tab.
Puppeteer's own API is reachable this way, but the way the harness runs code and
returns results leaves gaps. This plan fixes the ones that cause wrong results,
hangs or damage to the shared session, in priority order.

## TODOs (priority order)

### P1 — Abort a run when it times out
Today: when a run times out the request fails, but the snippet keeps running.
The sequential queue then starts the next request on the same tab while the old
snippet is still driving it.

- [x] Give each run its own `page` and `browser` proxies plus an `AbortController`.
      Once the run is aborted (timeout, or `/clear-queue`), every call through
      these proxies (`page.*`, `page.keyboard/mouse/touchscreen.*`, `browser.*`,
      `helpers.*`) throws `RunAbortedError`. The orphaned snippet then stops at
      its next browser call instead of running on.
- [x] Expose `helpers.signal` (an `AbortSignal`) and `helpers.checkAborted()`
      so snippets with their own loops can stop on time.
- [x] After a timeout, hold the tab or queue slot until the snippet settles, for
      at most `abortGraceMs` (default 5000). Log `orphan` if it still hasn't
      settled; this is the only case where overlap can still happen.
- [x] Record `aborted: true` and `settledAfterAbortMs` in the execution log.
- Limitation, documented: JS can't be killed. A CDP call that is already in
  flight (for example `waitForSelector` with a long timeout) still finishes.
  Handles obtained from the page (`ElementHandle`, `Frame`) aren't wrapped.

### P2 — Clean up per-run page state and handle dialogs
Today: `page.on(...)`, `setRequestInterception(true)` and `exposeFunction`
outlive the call. They pile up, and an orphaned interception handler hangs every
later request on the tab. A JS dialog nobody handles freezes the tab, so the
next call (even the `getPage` health check) hangs until it times out.

- [x] The page/browser proxies record listeners added with `on`/`once`/`addListener`,
      interception being turned on, and exposed functions. When the run ends,
      remove the listeners, turn interception back off and remove exposed
      functions.
- [x] Opt-out: `options.persist: true` keeps them (for deliberate multi-call
      setups), and the result says what was kept.
- [x] Install one persistent default dialog handler on every managed page
      (named pages, the adopted `main` tab and pool tabs). It acts only when no
      other `dialog` listener exists: `alert` and `beforeunload` → accept,
      `confirm` and `prompt` → dismiss. It logs each dialog and adds it to the
      running run's result as `dialogs: [{type, message, action}]`.
- [x] Bound `getPage`'s liveness probe with a timeout, so a page that is stuck
      or has an unhandled dialog gets reported instead of hanging the request.

### P3 — Return binary results as base64
Today: a Buffer result (from `page.screenshot()` or `page.pdf()`) serializes as
`{type:'Buffer', data:[…numbers…]}`, about 4× larger and awkward to decode.

- [x] In `processResult`, replace any `Buffer`, typed array or `ArrayBuffer`,
      top-level or nested in plain objects or arrays, with
      `{ "$binary": "base64", "data": "<base64>", "bytes": n }`.

### P4 — Return the snippet's console output
Today: `console.log` in a snippet goes only to the server log.

- [x] Shadow `console` inside the snippet with a per-run capturing console
      (`log/info/warn/error/debug/dir/table`, formatted with `util.format`). It
      also writes to the server log at debug level, tagged with `run=`.
- [x] Return the output as `logs: [{level, msg, ms}]` from `/execute` and the
      pool execute routes, and write it to the execution log's `end` record.
      Cap it at 500 entries / 64 KB and set `logsTruncated`.
- [x] `/run` returns only the raw value, so it keeps that shape; its
      `X-Run-Id` header lets callers look up the logs.

### P5 — Integration tests
- [x] `test/integration.test.js` (node:test, run with `npm test`). It starts the
      real server as a child process: headless system Chrome, a temp profile,
      `--pool`, `--no-prompt`, a random port and a temp log dir. It also starts a
      local fixture HTTP server with pages that open alert, confirm and
      beforeunload dialogs.
- [x] Cases, one or more per TODO above:
      - P1: a timed-out snippet stops at its next page call; the next queued
        request doesn't overlap with it; `helpers.signal` fires.
      - P2: listeners are removed after the run, `persist` keeps them;
        interception is turned off after the run and navigation still works;
        alert/confirm/beforeunload don't freeze the tab and are reported; a
        snippet's own dialog handler wins.
      - P3: a screenshot comes back as `$binary` base64 that decodes to a PNG;
        nested buffers are converted too.
      - P4: console output comes back in `logs`, in order, with levels; the cap
        and truncation work; logs are in the JSONL `end` record.
      - Regression: plain `/execute`, `/run`, `/pool/execute` and the blocked
        `browser.close()` still behave as before.

### P6 — Docs
- [x] README: document abort semantics, `persist`, dialog handling, the
      `$binary` format, `logs`, and the remaining limitations below.

## Out of scope (documented, not fixed here)
- Streaming results or events while a run is in progress.
- Background jobs with poll and cancel.
- Launching or connecting a second browser (`require` isn't defined in snippets).
- Downloads: they still need `page.createCDPSession()` +
  `Browser.setDownloadBehavior`.
- Snippets aren't sandboxed: `await import('fs')`, `process` and `fetch` work.
- Puppeteer is pinned at 21.x.
