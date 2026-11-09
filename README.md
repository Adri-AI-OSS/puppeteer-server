# Puppeteer Server

An HTTP server that provides remote control of an authenticated browser session via Puppeteer. Designed for automating interactions with websites that require login (SSO, OAuth, SAML, etc.) where session cookies cannot be easily replicated via direct HTTP requests.

## Origin & Problem Statement

This tool was created to solve a specific challenge: **scraping authenticated web applications**.

### The Problem

When automating data extraction from websites like SAP Business Accelerator Hub (api.sap.com), we encountered these issues:

1. **Authentication Barrier**: The site uses SAP Universal ID with SAML-based SSO. Direct HTTP requests return login pages instead of data.

2. **Session Cookies Don't Persist**: SAP's authentication cookies are session-only (`"session": true, "expires": -1`), meaning they expire when the browser closes and cannot be saved/restored.

3. **Puppeteer Session Isolation**: Puppeteer's bundled Chromium has a different profile format than system Chrome, making session persistence unreliable.

4. **Multi-Request Workflows**: We need to make many authenticated requests (fetching 250+ products, each with multiple packages and APIs), but the authentication state must be maintained throughout.

### The Solution

Instead of trying to persist authentication, we:

1. **Keep the browser open** with an active authenticated session
2. **Expose an HTTP API** that accepts JavaScript code to execute in the browser context
3. **Execute code dynamically** against the authenticated `page` object

This allows any external tool (curl, scripts, AI assistants) to control the browser without needing to handle authentication themselves.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Puppeteer Server                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Browser    │    │   Executor   │    │  HTTP Server │  │
│  │   Manager    │◄───│              │◄───│   (Express)  │  │
│  │              │    │  AsyncFunc   │    │              │  │
│  │  - launch()  │    │  execution   │    │  POST /run   │  │
│  │  - getPage() │    │  with queue  │    │  POST /goto  │  │
│  │  - close()   │    │              │    │  GET /page   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                                       ▲          │
│         ▼                                       │          │
│  ┌──────────────┐                              │          │
│  │   Chrome     │                    HTTP Requests        │
│  │   Browser    │                    (curl, scripts)      │
│  │  (with your  │                              │          │
│  │   session)   │                              │          │
│  └──────────────┘                              │          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. Browser Manager (`lib/browser.js`)
- Launches Chrome/Chromium with optional profile persistence
- Uses system Chrome by default (better for existing sessions)
- Connects to (or re-attaches to) Chrome; named tabs live in `lib/tabs.js`

### 2. Code Executor (`lib/executor.js`)
- Executes JavaScript code strings using `AsyncFunction`
- Provides `page`, `browser`, `helpers` and `console` objects to executed code
- Queues requests to prevent race conditions
- Aborts runs on timeout, cleans up per-run page state, returns console output (`lib/run-scope.js`)

### 3. HTTP Server (`lib/server.js`)
- Express server with REST endpoints
- Accepts code via POST requests
- Returns JSON results

### 4. CLI (`index.js`)
- Launches browser and navigates to initial URL
- Waits for user to authenticate manually
- Starts HTTP server after authentication

## Usage

### Starting the Server

```bash
cd puppeteer-server
npm install

# Start with initial URL
node index.js 8080 https://api.sap.com

# Or with named arguments
node index.js --port 8080 --url https://api.sap.com

# Allow up to 5 tabs besides "main" (default 10)
node index.js --max-tabs 5 --port 8080 --url https://api.sap.com

# Autonomous mode (skip "Press ENTER" prompt for CI/testing)
node index.js --port 8080 --no-prompt

# Hardened: token, expired-login detection, limits
node index.js --port 8080 --token "$TOKEN" --login-url-pattern 'accounts\.sap\.com|/login' \
  --max-queue 20 --max-timeout 300000 --result-max-bytes 2000000
```

1. Browser opens and navigates to the URL
2. Log in manually if required (skip with `--no-prompt` for autonomous use)
3. Press ENTER, or `POST /ready` from another process, to mark the session ready
   (`GET /health` reports `ready`). The port is bound from the start, so
   requests are accepted even before that.
4. Server listens on specified port (default: 3000)

Other flags: `--token`, `--login-url-pattern`, `--max-queue` (default 50),
`--max-timeout` (default 600000), `--result-max-bytes` (default 5242880),
`--job-ttl-ms` (default 600000), `--max-tabs` (default 10), `--acquire-timeout` (wait
for a free tab, default 30000), `--tab-idle-ttl` (default 1800000), `--tabs-as
windows|tabs` (default `windows`). `--pool` is accepted and ignored.
See `node index.js --help`.

### Making Requests

#### Execute arbitrary code
```bash
curl -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{"code": "return await page.title()"}'
```

#### Navigate to URL
```bash
curl -X POST http://localhost:8080/goto \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

#### Get current page info
```bash
curl http://localhost:8080/page
```

#### Take screenshot
```bash
curl http://localhost:8080/screenshot > screenshot.png
```

### Available in Executed Code

When you send code to `/run` or `/execute`, these objects are available:

- **`page`** - Puppeteer Page object (current tab), wrapped per run (see [Run lifecycle](#run-lifecycle))
- **`browser`** - Puppeteer Browser object, wrapped per run; `close()`/`disconnect()` are blocked
- **`console`** - captured per run and returned as `logs` (see below)
- **`helpers`** - Utility functions:
  - `helpers.signal` - `AbortSignal` that fires when the run times out or is cancelled
  - `helpers.checkAborted()` - throw if the run was aborted (use it in long loops)
  - `helpers.wait(ms)` - Wait for specified milliseconds (rejects if the run is aborted)
  - `helpers.waitUntil(conditionFn, maxWaitMs, pollIntervalMs)` - Poll until condition is true
  - `helpers.waitForContent(options)` - Smart wait for page content (see below)
  - `helpers.getText(selector)` - Get text content of element
  - `helpers.getAttr(selector, attr)` - Get attribute value
  - `helpers.getAllText(selector)` - Get text from all matching elements
  - `helpers.exists(selector)` - Check if element exists
  - `helpers.waitFor(selector, timeout)` - Wait for selector
  - `helpers.getUrl()` - Get current URL
  - `helpers.getTitle()` - Get page title
  - `helpers.getJson()` - Parse page content as JSON (useful for API responses)
  - `helpers.screenshot(options)` - Take screenshot as base64
  - `helpers.download(trigger, {timeout, inlineMaxBytes})` - run `trigger` (e.g.
    `() => page.click('#export')`) and wait for the download it starts. Returns
    `{filename, bytes, url, path, data}` with `data` in base64; files over
    `inlineMaxBytes` (default 5 MB) return `artifact` instead of `data`
  - `helpers.files` - `{name: localPath}` for files sent with the request
    (`files` option), for `elementHandle.uploadFile(...)`

#### Smart Wait for Dynamic Content

Use `helpers.waitForContent()` for pages with dynamic content loading (e.g., SAP Help Portal):

```javascript
// Polls every 500ms, exits early when content is ready, max 8 seconds
await helpers.waitForContent({
    maxWaitMs: 8000,        // Maximum wait time (default: 8000)
    pollIntervalMs: 500,    // Poll interval (default: 500)
    minContentLength: 2000, // Minimum text length to consider "ready" (default: 2000)
    noLoadingText: true     // Wait until "Loading" text disappears (default: true)
});
```

### Request options

`/execute` and `/run` (and the deprecated `/pool/...` execute aliases) accept a
JSON body `{ code, ...options }`:

| option | default | meaning |
|---|---|---|
| `timeout` | `30000` | ms before the run is aborted; capped at `--max-timeout` (response then has `timeoutCappedTo`) |
| `returnType` | `auto` | `auto`/`json`, `text` or `none` |
| `tab` | `main` | which [tab](#tabs) to run on: `main`, any name (created on first use), or `new` (a throwaway tab). `pageName` is an alias |
| `async` | `false` | respond `202 {jobId, run, poll}` at once; see [Async jobs](#async-jobs) |
| `pageEvents` | off | `true` (= `console`, `pageerror`, `requestfailed`, `httpError`) or a list of event types; returned as `pageEvents` |
| `screenshotOnError` | `false` | attach a PNG of the page (`errorScreenshot`) when the run fails or times out |
| `files` | none | `{name: base64 \| {data, filename}}`, written to a temp dir for the run; paths in `helpers.files` |
| `persist` | `false` | keep everything the snippet set up (see [Run lifecycle](#run-lifecycle)) |
| `keepTabs` | `false` | keep only the tabs/contexts the snippet opened |
| `resultMaxBytes` | `--result-max-bytes` (5 MB) | larger results are written to an artifact |
| `abortGraceMs` | `5000` | after an abort, how long to wait for the snippet to stop before the tab/queue moves on |

### Response fields

`/execute` returns `{ success, result | error, stack, run, duration, tab, tabId? }`
(`tabId` = `tab` for any tab other than `main`) plus, only when relevant:

| field | meaning |
|---|---|
| `logs` | `[{level, msg, ms}]` the snippet wrote with `console.*` (also on failure). Capped at 500 entries / 64 KB |
| `logsTruncated` | `true` when the cap was hit |
| `dialogs` | `[{type, message, action, ms}]` JS dialogs auto-handled during the run |
| `pageEvents` | `[{type, ..., ms}]` page events requested with `pageEvents` (max 200, then `pageEventsTruncated`) |
| `errorScreenshot` | `{$binary, data, bytes}` PNG when the run failed and `screenshotOnError` was set |
| `aborted` / `cancelled` | `timeout` or the cancel reason / `true` when cancelled |
| `sessionExpired` / `sessionUrl` | the run ended on a URL matching `--login-url-pattern`: the login must be redone |
| `reconnected` | `{ok, attempts, ms}`: the CDP connection was re-established before this run |
| `browserRestarted` | Chrome had died and a new one was launched on the profile (session-only cookies and tabs lost) |
| `tabCrashed` | `{page, url, replaced}`: the named tab had crashed and was replaced before this run |
| `persisted` / `keptTabs` | what `persist` / `keepTabs` kept |
| `timeoutCappedTo` | the requested timeout exceeded `--max-timeout` |
| `tabCreated` | `true` when this run created the named tab (watch for typos) |

`/run` returns only the raw `result`; its `X-Run-Id` header (also set on the
other execute routes) is the run id: `GET /runs/:id` returns its code, status,
`logs`, `dialogs` and `pageEvents`.

**Large results.** A result bigger than `resultMaxBytes` is written to
`<log dir>/artifacts/` and replaced by
`{ "$artifact": "<id>", "bytes", "contentType", "url": "/artifacts/<id>", "path" }`.

**Binary results.** Buffers, typed arrays and ArrayBuffers (top-level, or nested
in plain objects/arrays) come back as
`{ "$binary": "base64", "data": "<base64>", "bytes": n }`, e.g.
`return page.screenshot()` or `return { pdf: await page.pdf() }`.

### Run lifecycle

Each request runs in its own scope:

- **Timeouts abort the run.** JavaScript can't be killed, so on timeout (or
  `POST /clear-queue`, which aborts the running sequential run) every later call
  the snippet makes through `page`, `page.keyboard/mouse/touchscreen`,
  `browser` or `helpers` throws `RunAbortedError`. So does any such call that
  was already in flight, once it returns. The server waits up to `abortGraceMs`
  for the snippet to stop before the next queued run on that tab gets it. A snippet that keeps going past that is logged as an `orphan`
  and can no longer touch the browser. Not covered: element handles and frames
  the snippet already obtained, and non-browser work (timers, `fetch`). For
  those, check `helpers.signal` / `helpers.checkAborted()`.
- **Per-run cleanup.** When the run ends, the server undoes what the snippet
  set up on the shared session:
  - it removes listeners added with `page.on/once/addListener` and `browser.on/...`
  - it turns off request interception the snippet turned on (a forgotten
    interception handler would hang every later request on the tab)
  - it removes exposed functions and `evaluateOnNewDocument` scripts
  - it restores settings: `setViewport`/`emulate`, `setUserAgent`,
    `setExtraHTTPHeaders`, `setOfflineMode`, `emulateNetworkConditions`,
    `setJavaScriptEnabled`, `setCacheEnabled`, `setBypassCSP`,
    `setBypassServiceWorker`, `emulateMediaType`/`MediaFeatures`/`Timezone`/
    `CPUThrottling`/`IdleState`/`VisionDeficiency`, `setGeolocation`,
    `authenticate`, `setDefaultTimeout` (`setDefaultNavigationTimeout` goes back
    to 30 s)
  - it closes tabs the snippet opened (`browser.newPage()`, popups opened from
    the run's page, at any depth) and incognito contexts it created

  Pass `persist: true` to keep all of it for deliberate multi-call setups, or
  `keepTabs: true` to keep only the tabs. The execution log's `cleanup` field
  lists what was undone.
- **Focus.** Every tab except `main` opens in its own window, so it is always
  the front tab of its window. That matters because Chrome (headless or not)
  doesn't render background tabs, and `page.click()` on one never completes.
  Tabs running in parallel can all click. A snippet that opens a popup and then
  clicks the original page should still call `await page.bringToFront()` first.
  `--tabs-as tabs` puts tabs in one window instead, and then only the front tab
  takes clicks.
- **Crashes.** A run whose tab crashes fails at once ("The tab crashed during
  the run") instead of waiting for its timeout. If a named tab's renderer
  crashed, the next request on that tab replaces it (same name, new window) and
  reports `tabCrashed`. A crashed idle tab is never handed out by `"tab": "new"`. If Chrome itself died, the next request launches a new one
  on the same profile and reports `browserRestarted`.
- **JS dialogs never freeze a tab.** Every tab has a default dialog handler. If no other
  `dialog` listener is registered, it accepts `alert` and `beforeunload` and
  dismisses `confirm` and `prompt`. Each handled dialog is logged and, if it
  happened during a run, reported in that run's `dialogs`. To answer a dialog
  yourself, register `page.on('dialog', d => d.accept(...))` in the snippet, and
  the default handler stays out of it.

### Known limitations

- No streaming within one HTTP response: use async jobs or watches and poll.
- `require` isn't defined in snippets, so you can't launch or connect a second
  browser. Snippets aren't sandboxed: `await import('fs')`, `process` and
  `fetch` work.
- `helpers.download` changes the browser-wide download behaviour while it
  runs; downloads are serialized.
- Puppeteer 21.x APIs only.

### Async jobs

Add `"async": true` to any execute route to get `202 { jobId, run, poll, cancel }`
immediately:

- `GET /jobs/:id` while running: `{status: "running", phase: "queued" |
  "executing", logs, dialogs, pageEvents}`, i.e. what the run has produced so far.
- When finished: `status` is `succeeded`, `failed`, `timeout` or `cancelled`,
  followed by the full execute response (`result`, `error`, `logs`, ...).
- `POST /jobs/:id/cancel` aborts a running job (it stops at its next browser
  call) or drops a queued one. A job that has already finished returns `409`.
- Finished jobs are kept for `--job-ttl-ms` (default 10 min), then return `404`.
  `GET /jobs` lists them.

### Watches

Observe a page across calls, for example to see what a UI does while you drive
it in other requests:

```bash
curl -s -XPOST localhost:8080/watch -H 'content-type: application/json' \
  -d '{"events": ["console", "pageerror", "httpError", "framenavigated"], "page": "main"}'
# -> {"watchId": "w1", ...}      ("tab": "crm" watches another tab)
curl -s 'localhost:8080/watch/w1?since=0'
# -> {"events": [{"seq": 1, "ts": "...", "type": "console", "level": "log", "text": "..."}],
#     "next": 1, "more": false, "dropped": 0, "closed": false}
curl -s -XDELETE localhost:8080/watch/w1
```

Event types: `console`, `pageerror`, `requestfailed`, `httpError` (status ≥
400), `response`, `request`, `framenavigated` (main frame), `popup`, `dialog`.
The default is all except `response` and `request`. The buffer keeps the last
`maxEvents` (default 1000); older events are counted in `dropped`. A watch is
bound to one tab: `closed: true` once that tab is closed or replaced. Watches
nobody reads for 30 minutes expire.

### Example: Fetching JSON from authenticated endpoint

```bash
curl -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "code": "await page.goto(\"https://api.sap.com/api/1.0/container/SAPSuccessFactors/cpcache?containerType=product\", { waitUntil: \"networkidle2\" }); return await helpers.getJson();"
  }'
```

## API Endpoints

### Endpoints

All execute and fixed-purpose routes act on `main` unless given a `tab` (body)
or `?tab=` (query); see [Tabs](#tabs).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/execute` | Execute code on a tab, return full result with metadata |
| POST | `/run` | Execute code, return raw result only (`X-Run-Id` header = run id) |
| POST | `/goto` | Navigate to URL |
| GET | `/page` | Get current URL and title |
| GET | `/content` | Get page HTML |
| GET | `/screenshot` | Take screenshot (returns PNG) |
| GET | `/cookies` | Get session cookies |
| GET | `/status` | Get queue status |
| GET | `/health` | Health check |
| POST | `/clear-queue` | Clear queued runs and abort the running ones (`?tab=` for one tab) |
| POST | `/reconnect` | Re-attach to the running Chrome (launches only if none is alive; never kills Chrome) |
| POST | `/ready` | Mark the session ready (user finished logging in), instead of pressing ENTER |
| GET | `/runs` · `/runs/:id` | Recent runs · one run's code, status, error, logs, dialogs, page events |
| GET | `/jobs` · `/jobs/:id` | Async jobs · one job's progress or result |
| POST | `/jobs/:id/cancel` | Cancel an async job |
| POST | `/watch` | Start watching a tab's events (`{events, tab, maxEvents}`) |
| GET | `/watch` · `/watch/:id?since=N` | List watches · read events after cursor `N` |
| DELETE | `/watch/:id` | Stop a watch |
| GET | `/artifacts/:id` | A large result or download written to disk |
| POST | `/shutdown` | Stop server and browser |

**Automatic reconnect.** Before running a request, the server pings the browser
it's connected to, with a 3 s limit. If the connection is gone, or open but not
responding (for example after the laptop sleeps or Chrome freezes), the server
reconnects *before* running the request, so the caller doesn't need to call
`/reconnect`:

1. It makes up to 3 attempts, waiting 250 ms and then 500 ms between them. Each
   attempt tries the endpoint it was last connected to, then the profile's
   `DevToolsActivePort` file.
2. A successful attempt reuses the existing logged-in tab as `main`, and the
   request continues.
3. If every attempt fails, or the Chrome this server launched has exited, it
   launches a new Chrome.

The outcome (`ok`, number of attempts, time taken, endpoint) is logged with the
request and saved on the run's `exec` record in the executions JSONL. Every
named tab is re-adopted by its Chrome target id, so `crm` is still `crm` after a
reconnect or a server restart (see [Tabs](#tabs)).
Executed code can't call `browser.disconnect()` or `browser.close()`, because
the connection is shared by every request.

### Logs

Every run writes `logs/puppeteer-server_<port>_<UTC ts>.log` (in the repo,
regardless of cwd) and points `logs/puppeteer-server_<port>_latest.log` at it.
This is the same convention as adri-agents' `dev-scripts`. The file captures
everything printed to stdout and stderr. Override the location with
`--log-dir <dir>` or `PUPPETEER_SERVER_LOG_DIR`, and the verbosity with
`--log-level debug|info|warn|error` or `LOG_LEVEL`.

Each line is `[ISO time] LEVEL [scope] message key=value…`. Lines written while
handling a request carry the same `req=` id, which is also returned in the
`X-Request-Id` response header. Log lines are written straight to disk, so they
survive a crash.

**Full code goes in a separate file.** Each run also writes
`puppeteer-server_<port>_<ts>.executions.jsonl` (plus a
`_latest.executions.jsonl` symlink). The text log only shows a short preview of
the code alongside `run=` and `req=` ids. Every code execution (from `/execute`,
`/run`, `/goto`, `/page`, `/content`, `/screenshot`, `/cookies` or the pool
routes) writes these records:

| event | when | contents |
|---|---|---|
| `start` | when the request reaches the executor, **before** queueing, page lookup or launch | `run`, `req`, `method`, `path`, `mode`, `page`/`tabId`, `timeoutMs`, the **full `code`** |
| `exec` | right before the code runs | page `url`, `queuedMs` / `acquireMs` |
| `end` | exactly once, whatever the outcome | `status` (`ok`, `error`, `timeout` or `cancelled`), `ms`, and on failure `error`, `stack`, `stage` (`getPage`, `acquireTab`, `lookupTab`, `run` or `serialize`); on success `resultType` and `resultBytes`; when relevant `logs`, `logsTruncated`, `dialogs`, `aborted`, `settledAfterAbortMs`, `orphan`, `cleanup` |

The `start` record is written to disk before anything else happens. A run that
hangs or crashes the server still has its code on record: it's the `start`
with no matching `end`. API responses include `run`.

```bash
J=logs/puppeteer-server_8080_latest.executions.jsonl
grep '"req":"r42"' $J                                  # code and outcome for one request
jq -r 'select(.run==17 and .event=="start") | .code' $J # the exact code of run 17
jq -c 'select(.event=="end" and .status!="ok") | {run,req,status,stage,error}' $J
```

Useful greps on the text log:

```bash
tail -f logs/puppeteer-server_8080_latest.log
grep 'req=r42' logs/puppeteer-server_8080_latest.log                    # one request end to end
grep -E '\[browser\]|\[cdp\]' logs/puppeteer-server_8080_latest.log     # connection lifecycle
grep 'CDP disconnected' logs/puppeteer-server_8080_latest.log           # why the connection dropped
```

When the connection drops unexpectedly, the server logs the WebSocket close
code and meaning, the last socket error, the message counts and largest message
size, which snippet was running, whether Chrome's PID and DevTools endpoint are
still alive, and a diagnosis. System sleep and event-loop stalls show up as
`clock jumped` warnings.

## Tabs

Every page the server drives is a **tab with a name**:

| kind | name | lifetime |
|---|---|---|
| `main` | `main` | the tab the user logged in on; never closed automatically |
| agent | any name you choose | created with `POST /tabs` or on first use of `"tab": "<name>"`; closed after `--tab-idle-ttl` idle (default 30 min) |
| throwaway | `tab-N` | created for one `"tab": "new"` run, closed when it ends |

- **One queue per tab.** Runs on one tab are serialized; runs on different tabs
  run in parallel. A slow run on `crm` never blocks `main`.
- **Same session.** All tabs share the logged-in browser context (cookies,
  storage), except `isolated` tabs, which get their own incognito context, e.g.
  for a logged-out view or a second account.
- **One window each.** Every tab except `main` opens in its own window, so
  clicks work on all of them at once (`--tabs-as tabs` to opt out).
- **Same URL, same time.** Chrome serializes concurrent requests for the exact
  same URL (HTTP cache lock), so two tabs loading the same URL take as long as
  one tab loading it twice. Distinct URLs load in parallel.
- **Names survive.** `{name → Chrome target id}` is kept in
  `<profile>/puppeteer-server-tabs.json`. After a reconnect or a server restart
  every named tab is re-adopted. If Chrome itself died, the old tabs are listed
  as `lost` for 10 minutes and are created fresh on next use.
- **Limits.** At most `--max-tabs` tabs besides `main`. `"tab": "new"` waits up
  to `--acquire-timeout` for a free slot (then 503); `POST /tabs` returns 409
  with the idle tabs you could close. Each tab's queue holds `--max-queue`
  requests (then 429).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tabs` | All tabs: `name, kind, url, title, busy, running, queued, createdAt, lastUsedAt, expiresAt, isolated`; recently lost tabs with `lost: true` |
| POST | `/tabs` | Create `{ name?, url?, isolated? }` → 201 (name generated if omitted; 409 if it exists or the limit is reached) |
| GET | `/tabs/:name` | One tab |
| DELETE | `/tabs/:name` | Close it (`?force=true` for `main` or a busy tab) |

```bash
# Run on your own tab (created on first use; response has tabCreated: true)
curl -s localhost:8080/execute -H 'content-type: application/json' \
  -d '{"tab": "crm", "code": "await page.goto(\"https://crm.example.com\"); return page.title();"}'

# In parallel, on a throwaway tab
curl -s localhost:8080/execute -H 'content-type: application/json' \
  -d '{"tab": "new", "code": "await page.goto(\"https://example.com\"); return page.url();"}'

# The fixed-purpose routes take ?tab=
curl -s 'localhost:8080/screenshot?tab=crm' > crm.png
curl -s -XDELETE localhost:8080/tabs/crm
```

### Deprecated aliases

The earlier page and pool APIs still work and map onto tabs:

| Old | Same as |
|---|---|
| `{ "pageName": "x" }` | `{ "tab": "x" }` (names must now match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`) |
| `POST /pool/execute` | `POST /execute { "tab": "new" }` (response keeps `tabId`) |
| `POST /pool/acquire` → `{ tabId }` | a `tab-N` tab you hold until released |
| `POST /pool/tab/:id/execute` | `POST /execute { "tab": id }` (404 if the tab doesn't exist) |
| `POST /pool/release/:id` | release the hold; the tab stays idle, is reused by `"tab": "new"`, and expires |
| `DELETE /pool/tab/:id` | `DELETE /tabs/:id?force=true` |
| `GET /pool/status`, `GET /pool/tabs` | counts / list over all tabs except `main` (same shapes) |
| `POST /pool/close-all`, `POST /pool/prune` | close every tab except `main` / idle ones older than `maxIdleMs` |
| `--pool` | ignored: tabs are always available |

Behaviour that changed: named pages used to share one global queue, and now
run in parallel. Pool and agent tabs open in their own windows.

### Using ConcurrentUrlClient (Node.js)

For programmatic use, see `lib/concurrent-client.js`:

```javascript
const ConcurrentUrlClient = require('../lib/concurrent-client');

class MyClient extends ConcurrentUrlClient {
    constructor() {
        super({ maxConcurrency: 5, serverPort: 8080 });
        this.urls = ['https://example1.com', 'https://example2.com', ...];
        this.index = 0;
    }

    async next() {
        if (this.index >= this.urls.length) return null;
        const url = this.urls[this.index++];
        return { url, maxWaitTime: 2000, context: { outputPath: `output/${this.index}.json` } };
    }

    async onSuccess(task, result) {
        console.log(`Done: ${task.url}`);
        // Save result to task.context.outputPath
    }
}

const client = new MyClient();
const { results, errors, stats } = await client.run();
console.log(`Completed ${stats.completed} in ${stats.elapsed}ms`);
```

## Use Cases

### 1. SAP Business Accelerator Hub Scraping
The primary use case - indexing APIs from api.sap.com which requires SAP Universal ID authentication.

### 2. Any SSO-Protected Site
Works with any site using:
- SAML authentication
- OAuth flows
- Corporate SSO (Okta, Azure AD, etc.)
- Multi-factor authentication

### 3. AI-Assisted Browser Automation
An AI assistant can control the browser by sending curl requests, enabling:
- Dynamic web scraping
- Form filling
- Data extraction
- Testing authenticated workflows

## Integration with Scripts

See `scripts/index-apis.js` for an example of using puppeteer-server programmatically:

```javascript
async puppeteerRequest(code) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ code });
        const options = {
            hostname: 'localhost',
            port: this.serverPort,
            path: '/run',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        // ... make HTTP request
    });
}

// Usage
async fetchJson(url) {
    const code = `
        await page.goto("${url}", { waitUntil: "networkidle2", timeout: 30000 });
        return await helpers.getJson();
    `;
    return this.puppeteerRequest(code);
}
```

## Security Considerations

- **Local use only**: Server binds to localhost by default
- **Optional token**: `--token <t>` (or `$PUPPETEER_SERVER_TOKEN`) makes every
  request except `GET /health` require `Authorization: Bearer <t>` (or
  `X-Auth-Token: <t>`). Without it, anyone with local access can execute code
- **eval() equivalent**: The executor runs arbitrary JavaScript - use responsibly
- **Session exposure**: Cookies and session state are accessible via API

## Files

```
puppeteer-server/
├── index.js              # CLI entry point
├── package.json          # Dependencies
├── .gitignore            # Ignores .chrome-profile/
├── lib/
│   ├── browser.js        # Browser lifecycle management
│   ├── executor.js       # Code execution engine
│   ├── run-scope.js      # Per-run abort, cleanup, console capture, dialog handling
│   ├── helpers.js        # `helpers` given to snippets (incl. download/files)
│   ├── page-events.js    # Page event capture (pageEvents, watches)
│   ├── jobs.js           # Async jobs
│   ├── watch.js          # Watches (page events across calls)
│   ├── artifacts.js      # Large results / downloads on disk
│   ├── tabs.js           # Named tabs: registry, per-tab queues, windows, persistence
│   ├── logger.js         # Structured logs + executions JSONL
│   ├── server.js         # Express HTTP server
│   └── index.js          # Module exports
├── test/
│   ├── support.js        # Fixture site + server launcher
│   ├── integration.test.js # Abort, cleanup, dialogs, binaries, console
│   ├── features.test.js  # Logging, routes, settings/tabs, jobs, watches, files, crashes
│   ├── lifecycle.test.js # Token, /ready, reconnect, Chrome death, server restart
│   └── tabs.test.js      # Named tabs: API, queues, windows, isolation, persistence
├── .github/workflows/test.yml # CI: npm test on ubuntu-latest with Chrome
├── docs/
│   ├── PLAN-harness-gaps.md
│   ├── PLAN-2026-11-09-next-features.md
│   └── DESIGN-2026-11-10-named-tabs.md
└── examples/
    ├── client.js         # Node.js client library
    └── sap-api-example.sh # Shell script example
```

## Tests

```bash
npm test
```

The integration tests (`test/*.test.js`) start the real server headless, on a
random port with a temp profile and log dir, against a local fixture site
(`test/support.js`). They need Google Chrome installed. `KEEP_TEST_LOGS=1 npm
test` keeps the server logs. The lifecycle tests use
`PUPPETEER_SERVER_TEST_HOOKS=1`, which enables `POST /__test/drop-connection`
to simulate a dropped CDP socket; never set it in normal use. CI runs the same
suite (`.github/workflows/test.yml`).

## Troubleshooting

### Browser doesn't open
- Check if Chrome is installed at the expected path
- Try with `--headless` flag for debugging

### Session not authenticated
- Make sure you completed login before pressing ENTER
- Check that you're on the correct page/domain

### Requests timeout
- Increase timeout in code: `{ timeout: 60000 }`
- Check if page requires interaction before loading

### Code execution fails
- Ensure code is valid JavaScript
- Check for syntax errors in JSON payload
- Use `/execute` instead of `/run` to see full error details
