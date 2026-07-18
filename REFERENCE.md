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
| `POST /execute` | Run a Puppeteer snippet. Body: `{ "code": "...", "timeout": 30000 }`. `page`, `browser` are in scope; `return` a JSON-serializable value. |
| `POST /run` | Like `/execute`, for fire-and-forget scripts. |
| `POST /goto` | Navigate. Body: `{ "url": "https://…", "waitUntil": "networkidle2" }`. |
| `GET /page` | Current URL + title. |
| `GET /content` | Full rendered HTML of the current page. |
| `GET /screenshot` | PNG screenshot of the current page. |
| `GET /cookies` | Cookies for the current context. |
| `GET /status` · `GET /health` | Server + browser liveness. |
| `POST /clear-queue` | Drop queued sequential requests. |
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

## Example

```bash
# After launch + login:
curl -s localhost:3000/execute -H 'content-type: application/json' -d '{
  "code": "await page.goto(\"https://api.sap.com\"); return await page.title();"
}'
```

See `examples/client.js` and `examples/sap-api-example.sh` for fuller flows.

## When to reach for it

Use it when the agent must act *as the logged-in user* in a real browser —
authenticated scraping, multi-step UI flows, or anything cookie/session bound.
For unauthenticated or pure-HTTP work, a direct HTTP client is simpler.
