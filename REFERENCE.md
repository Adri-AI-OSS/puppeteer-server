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
   `profile`, `pool`, `maxTabs`) → Execute. It opens an integrated terminal
   running `node index.js …`.
2. **Log in once** — a Chrome window opens (omit `headless`). Complete the login
   in that window, then press ENTER in the terminal. The session is now live.
3. **Drive it over HTTP** — POST Puppeteer snippets to `http://localhost:<port>`.
   The browser stays authenticated for the life of the process.
4. **Stop it** — `POST /shutdown`, or close the terminal.

For headless / CI use, pass `--profile <dir>` once interactively to seed a
persistent profile, then later runs can use `--headless` against that profile.

## HTTP API

Single-session (sequential) endpoints:

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
| `POST /clear-queue` | Drop queued sequential requests and abort the one running. |
| `POST /shutdown` | Close the browser and exit. |

Concurrent tab pool (enable with `--pool`):

| Method & path | Purpose |
|---|---|
| `POST /pool/execute` | Run a snippet on any free tab. |
| `POST /pool/acquire` | Reserve a tab → `{ tabId }`. |
| `POST /pool/tab/:tabId/execute` | Run on a specific reserved tab. |
| `POST /pool/release/:tabId` | Return a tab to the pool. |
| `DELETE /pool/tab/:tabId` | Close a tab. |
| `GET /pool/status` · `GET /pool/tabs` | Pool occupancy. |
| `POST /pool/close-all` · `POST /pool/prune` | Reclaim tabs. |

## Writing snippets

The code runs as the body of an async function. In scope:

- `page`: the session's tab (pool routes: the acquired tab). `browser`: the
  browser; `close()` / `disconnect()` are blocked.
- `console`: output is returned as `logs`.
- `helpers`: `wait(ms)`, `waitFor(selector, ms)`, `waitUntil(fn)`,
  `waitForContent()`, `getText`, `getAttr`, `getAllText`, `exists`, `getJson`,
  `screenshot`, `getUrl`, `getTitle`, plus `signal` (an AbortSignal) and
  `checkAborted()` for long loops.

`return` a JSON-serializable value. Buffers (`page.screenshot()`, `page.pdf()`)
and typed arrays come back as `{ "$binary": "base64", "data": "…", "bytes": n }`.

Request options (all execute routes): `timeout` (ms, default 30000),
`returnType` (`auto` | `text` | `none`), `pageName` (sequential routes, default
`main`), `persist` (see below), `abortGraceMs` (default 5000).

Response extras, present only when relevant:

| field | meaning |
|---|---|
| `logs` | `[{level, msg, ms}]` from `console.*`, also on failure. Capped at 500 lines / 64 KB (`logsTruncated: true`) |
| `dialogs` | JS dialogs auto-handled during the run: `[{type, message, action, ms}]` |
| `aborted` | `"timeout"` or `"queue cleared"` |
| `persisted` | what `persist: true` kept |

Behaviour to rely on:

- **Timeouts stop the snippet.** After `timeout`, any further `page`/`browser`/
  `helpers` call from it throws `RunAbortedError`, so it can't interfere with
  the next request. Split long flows into several calls rather than raising the
  timeout a lot.
- **Each call starts clean.** Listeners (`page.on(...)`), request interception
  and `exposeFunction` set up by a snippet are removed when the call ends. Pass
  `"persist": true` to keep them across calls. Use `globalThis` or the page
  itself to carry data between calls.
- **Dialogs don't block.** Unless your snippet registers
  `page.on('dialog', ...)`, the server accepts `alert`/`beforeunload` and
  dismisses `confirm`/`prompt`, and reports them in `dialogs`.
- **Lost browser connection.** If the CDP connection to Chrome drops, the next
  request reconnects to the same Chrome (3 attempts) before running, so the
  login survives. No `/reconnect` call is needed.
- **Not available:** streaming or progress output, background jobs, `require`
  (so you can't launch a second browser). Downloads need
  `page.createCDPSession()` + `Browser.setDownloadBehavior`.

Every call's full code, outcome, logs and dialogs are written to
`logs/puppeteer-server_<port>_latest.executions.jsonl`, keyed by `run`.

## Example

```bash
# After launch + login:
curl -s localhost:3000/execute -H 'content-type: application/json' -d '{
  "code": "await page.goto(\"https://api.sap.com\"); return await page.title();"
}'

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
