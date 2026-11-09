# puppeteer-server — agent reference

A long-running HTTP server that holds **one authenticated Chrome session** and
runs Puppeteer code against it on demand. Use it to drive web apps that need an
interactive login (SSO / SAML / OAuth) where raw HTTP requests just get bounced
to a login page.

Need more than one authenticated session at a time? Launch the server multiple
times. Leave `port` blank and each instance auto-picks a free port (starting at
3000) with its own Chrome profile (`.chrome-profile/inst-<port>`), so they never
collide on the port or Chrome's profile lock. Set an explicit `port` to bind a
specific one (startup fails if it's already taken). Each instance is an
independent process driving its own browser — talk to each on its own port.

## Lifecycle

1. **Launch it** — from the Adri Libraries tree, hit the play button on
   `@adri/puppeteer-server` → set `port` (and optionally `url`, `headless`,
   `profile`, `maxTabs`) → Execute. It opens an integrated terminal
   running `node index.js …`.
2. **Log in once** — a Chrome window opens (omit `headless`). Complete the login
   in that window, then press ENTER in the terminal, or `POST /ready` from
   another process. The session is now live (`GET /health` → `ready: true`).
3. **Drive it over HTTP** — POST Puppeteer snippets to `http://localhost:<port>`.
   The browser stays authenticated for the life of the process.
4. **Stop it** — `POST /shutdown`, or close the terminal.

For headless / CI use, pass `--profile <dir>` once interactively to seed a
persistent profile, then later runs can use `--headless` against that profile.

## Tabs

Every page is a **tab with a name**. `main` is the tab the user logged in on.
Pass `"tab": "<name>"` to any execute route to work in your own tab: it is
created on first use (`tabCreated: true` in the response) and shares the login.
`"tab": "new"` gives a throwaway tab for one run.

- Runs on the same tab run one after another; runs on different tabs run **in
  parallel**. To work alongside other agents, use your own tab name.
- Each tab (except `main`) has its own window, so clicks work in parallel.
- Tab names survive reconnects and server restarts. Idle agent tabs close after
  30 minutes; `main` never does.
- `"isolated": true` on `POST /tabs` gives a tab with its own cookies (a
  logged-out view or a second account).

| Method & path | Purpose |
|---|---|
| `GET /tabs` | List tabs: `name, kind, url, title, busy, queued, expiresAt`; recently lost tabs have `lost: true`. |
| `POST /tabs` | Create `{ name?, url?, isolated? }` → 201 (409 if it exists or the tab limit is reached). |
| `GET /tabs/:name` · `DELETE /tabs/:name` | One tab / close it (`?force=true` for `main` or a busy tab). |

## HTTP API

Endpoints (each acts on `main` unless given `tab` in the body or `?tab=`):

| Method & path | Purpose |
|---|---|
| `POST /execute` | Run a Puppeteer snippet. Body: `{ "code": "...", "timeout": 30000 }` plus options below. Returns `{ success, result \| error, run, ... }`. |
| `POST /run` | Like `/execute` but returns only the raw `result`; the `X-Run-Id` header links it to the execution log. |
| `POST /goto` | Navigate. Body: `{ "url": "https://…", "waitUntil": "networkidle2" }`. |
| `GET /page` | Current URL + title. |
| `GET /content` | Full rendered HTML of the current page. |
| `GET /screenshot` | PNG screenshot of the current page. |
| `GET /cookies` | Cookies for the current context. |
| `GET /status` · `GET /health` | Server + browser liveness. |
| `POST /reconnect` | Drop and re-establish the CDP connection to the same Chrome (session kept). Rarely needed: requests auto-reconnect. |
| `POST /ready` | Mark the session ready (the user finished logging in) instead of pressing ENTER. |
| `GET /runs` · `GET /runs/:id` | Recent runs; one run's code, status, error, logs, dialogs, page events (live while running). |
| `GET /jobs/:id` · `POST /jobs/:id/cancel` | Poll / cancel a job started with `"async": true`. |
| `POST /watch` · `GET /watch/:id?since=N` · `DELETE /watch/:id` | Collect page events across calls (see below). |
| `GET /artifacts/:id` | Large results and downloads written to disk. |
| `POST /clear-queue` | Drop queued requests and abort the running ones (`?tab=` for one tab). |
| `POST /shutdown` | Close the browser and exit. |

Deprecated but still working: `pageName` (= `tab`), and the `/pool/*` routes.
`/pool/execute` = `"tab": "new"`. `/pool/acquire` holds a `tab-N` tab until
`/pool/release/:id`. `/pool/tab/:id/execute` = `"tab": id`. Prefer tabs in new
code.

## Writing snippets

The code runs as the body of an async function. In scope:

- `page`: the run's tab (`main` unless `tab` says otherwise). `browser`: the
  browser; `close()` / `disconnect()` are blocked.
- `console`: output is returned as `logs`.
- `helpers`: `wait(ms)`, `waitFor(selector, ms)`, `waitUntil(fn)`,
  `waitForContent()`, `getText`, `getAttr`, `getAllText`, `exists`, `getJson`,
  `screenshot`, `getUrl`, `getTitle`, plus `signal` (an AbortSignal) and
  `checkAborted()` for long loops, and:
  - `helpers.download(() => page.click('#export'), { timeout, inlineMaxBytes })`
    returns `{ filename, bytes, path, data }`, where `data` is base64. Files over
    `inlineMaxBytes` (default 5 MB) come back as `artifact` instead of `data`.
  - `helpers.files.<name>`: local paths of files sent with the request, for
    `elementHandle.uploadFile(...)`.

`return` a JSON-serializable value. Buffers (`page.screenshot()`, `page.pdf()`)
and typed arrays come back as `{ "$binary": "base64", "data": "…", "bytes": n }`.

Request options (all execute routes):

| option | meaning |
|---|---|
| `timeout` | ms, default 30000, capped by `--max-timeout` (then `timeoutCappedTo` is set) |
| `returnType` | `auto` \| `text` \| `none` |
| `tab` | `main` (default), any name (created on first use), or `new` (throwaway). `pageName` is an alias |
| `async` | `true`: respond `202 { jobId, run }` at once; poll `GET /jobs/:id` |
| `pageEvents` | `true` (console, pageerror, requestfailed, httpError) or a list of types; returned as `pageEvents` |
| `screenshotOnError` | attach a PNG (`errorScreenshot`) when the run fails or times out |
| `files` | `{ name: base64 \| { data, filename } }` → `helpers.files.name` |
| `persist` | keep listeners, interception, exposed functions, settings, scripts and tabs the run set up |
| `keepTabs` | keep only the tabs/contexts the run opened |
| `resultMaxBytes` | spill larger results to an artifact (default 5 MB) |
| `abortGraceMs` | default 5000 |

Response extras, present only when relevant:

| field | meaning |
|---|---|
| `logs` | `[{level, msg, ms}]` from `console.*`, also on failure. Capped at 500 lines / 64 KB (`logsTruncated: true`) |
| `dialogs` | JS dialogs auto-handled during the run: `[{type, message, action, ms}]` |
| `aborted` | `"timeout"` or `"queue cleared"`; `cancelled: true` when cancelled |
| `pageEvents` | page console messages, uncaught errors, failed / 4xx-5xx requests during the run |
| `errorScreenshot` | `$binary` PNG of the page when the run failed (`screenshotOnError`) |
| `sessionExpired` | the run ended on a login page (`--login-url-pattern`): ask the user to log in again; `sessionUrl` |
| `reconnected` | the CDP connection was re-established before this run (`{ ok, attempts, ms }`) |
| `browserRestarted` | Chrome had died and a new one was launched: session-only cookies and tabs are gone |
| `tabCrashed` | the named tab had crashed and was replaced |
| `tab` / `tabCreated` | the tab the run used / `true` if this run created it |
| `result.$artifact` | the result was too large and is at `result.url` (`GET /artifacts/:id`) |
| `persisted` / `keptTabs` | what `persist` / `keepTabs` kept |

Behaviour to rely on:

- **Timeouts stop the snippet.** After `timeout`, any further `page`/`browser`/
  `helpers` call from it throws `RunAbortedError`, so it can't interfere with
  the next request. Split long flows into several calls rather than raising the
  timeout a lot.
- **Each call starts clean.** When the call ends, the server undoes what the
  snippet set up: listeners (`page.on(...)`), request interception,
  `exposeFunction`, `evaluateOnNewDocument` scripts, and settings (viewport,
  user agent, extra headers, offline, JS on/off, cache, media / timezone /
  geolocation / throttling emulation, `authenticate`, default timeout). It also
  closes the tabs, popups and incognito contexts the snippet opened. Pass
  `"persist": true` (or `"keepTabs": true`) to keep them. Use `globalThis` or
  the page itself to carry data between calls.
- **Focus.** Chrome doesn't render background tabs, so `page.click()` on one
  never finishes. Named tabs avoid this by each having their own window. If your
  snippet opens a popup and then clicks the original page, call
  `await page.bringToFront()` first.
- **Dialogs don't block.** Unless your snippet registers
  `page.on('dialog', ...)`, the server accepts `alert`/`beforeunload` and
  dismisses `confirm`/`prompt`, and reports them in `dialogs`.
- **Lost browser connection.** If the CDP connection to Chrome drops, the next
  request reconnects to the same Chrome (3 attempts) before running, so the
  login survives (`reconnected`). If Chrome itself died, a new one is launched
  and the response says `browserRestarted`.
- **Long work.** Use `"async": true` and poll `GET /jobs/:id`. It shows `logs`,
  `dialogs` and `pageEvents` so far, then the full response; `POST
  /jobs/:id/cancel` stops it. Finished jobs expire after 10 minutes.
- **Watching across calls.** `POST /watch { "events": [...], "tab": "main",
  "maxEvents": 1000 }` returns a `watchId`. Then `GET
  /watch/:id?since=<next>` returns new events (`seq`, `ts`, `type`, ...) plus the
  cursor `next`, `dropped` and `closed`. Types: console, pageerror,
  requestfailed, httpError, response, request, framenavigated, popup, dialog.
- **Backpressure.** A full queue on a tab returns `429`. `"tab": "new"` returns
  `503` once all `--max-tabs` tabs are in use for `--acquire-timeout`. Use
  another tab or `async` for parallel work.
- **Not available:** streaming over one HTTP response, `require` (so you can't
  launch a second browser).

Every call's full code, outcome, logs, dialogs and page events are written to
`logs/puppeteer-server_<port>_latest.executions.jsonl`, keyed by `run`.
`GET /runs/:id` reads it back (`X-Run-Id` header on every execute response).

If the server was started with `--token`, send `Authorization: Bearer <token>`
on every request (`GET /health` is open).

## Example

```bash
# After launch + login:
curl -s localhost:3000/execute -H 'content-type: application/json' -d '{
  "code": "await page.goto(\"https://api.sap.com\"); return await page.title();"
}'

# Long export: run async, download the file, poll for the result
curl -s localhost:3000/execute -H 'content-type: application/json' -d '{
  "async": true, "timeout": 300000, "screenshotOnError": true,
  "code": "await page.goto(\"https://app.example.com/reports\"); return helpers.download(() => page.click(\"#export\"));"
}'                                  # -> 202 {"jobId":"j1",...}
curl -s localhost:3000/jobs/j1      # -> running (logs so far) ... then the result

# Answer a confirm() yourself, capture console output, keep a 60s budget:
curl -s localhost:3000/execute -H 'content-type: application/json' -d '{
  "timeout": 60000,
  "code": "page.on(\"dialog\", d => d.accept()); await page.click(\"#delete\"); console.log(\"clicked\"); return page.url();"
}'
```

See `examples/client.js` and `examples/sap-api-example.sh` for fuller flows.

## When to reach for it

Use it when the agent must act *as the logged-in user* in a real browser —
authenticated scraping, multi-step UI flows, or anything cookie/session bound.
For unauthenticated or pure-HTTP work, a direct HTTP client is simpler.
