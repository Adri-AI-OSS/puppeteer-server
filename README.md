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
- Manages named pages for reuse across requests

### 2. Code Executor (`lib/executor.js`)
- Executes JavaScript code strings using `AsyncFunction`
- Provides `page`, `browser`, and `helpers` objects to executed code
- Queues requests to prevent race conditions
- Includes timeout protection

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

# Start with pool mode (concurrent execution)
node index.js --pool --max-tabs 5 --port 8080 --url https://api.sap.com

# Autonomous mode (skip "Press ENTER" prompt for CI/testing)
node index.js --pool --max-tabs 5 --port 8080 --no-prompt
```

1. Browser opens and navigates to the URL
2. Log in manually if required (skip with `--no-prompt` for autonomous use)
3. Press ENTER to start the HTTP server
4. Server listens on specified port (default: 3000)

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

- **`page`** - Puppeteer Page object (current tab)
- **`browser`** - Puppeteer Browser object
- **`helpers`** - Utility functions:
  - `helpers.wait(ms)` - Wait for specified milliseconds
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

### Example: Fetching JSON from authenticated endpoint

```bash
curl -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "code": "await page.goto(\"https://api.sap.com/api/1.0/container/SAPSuccessFactors/cpcache?containerType=product\", { waitUntil: \"networkidle2\" }); return await helpers.getJson();"
  }'
```

## API Endpoints

### Legacy Endpoints (Sequential Execution)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/execute` | Execute code, return full result with metadata |
| POST | `/run` | Execute code, return raw result only |
| POST | `/goto` | Navigate to URL |
| GET | `/page` | Get current URL and title |
| GET | `/content` | Get page HTML |
| GET | `/screenshot` | Take screenshot (returns PNG) |
| GET | `/cookies` | Get session cookies |
| GET | `/status` | Get queue status |
| GET | `/health` | Health check |
| POST | `/clear-queue` | Clear pending executions |
| POST | `/reconnect` | Re-attach to the running Chrome (launches only if none is alive; never kills Chrome) |
| POST | `/shutdown` | Stop server and browser |

If the CDP connection to Chrome drops while Chrome keeps running, the next
request re-attaches to it via the profile's `DevToolsActivePort` file, so the
logged-in session survives. Executed code can't call `browser.disconnect()` or
`browser.close()`, because the connection is shared by every request.

### Logs

Every run writes `logs/puppeteer-server_<port>_<UTC ts>.log` (in the repo,
regardless of cwd) and points `logs/puppeteer-server_<port>_latest.log` at it.
This is the same convention as adri-agents' `dev-scripts`. The file captures
everything printed to stdout and stderr. Override the location with
`--log-dir <dir>` or `PUPPETEER_SERVER_LOG_DIR`, and the verbosity with
`--log-level debug|info|warn|error` or `LOG_LEVEL`.

Each line is `[ISO time] LEVEL [scope] message key=value…`. Lines written while
handling a request carry the same `req=` id, which is also returned in the
`X-Request-Id` response header. Useful greps:

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

### Pool Endpoints (Concurrent Execution)

Enable with `--pool` flag: `node index.js --pool --max-tabs 5`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/pool/execute` | Execute with automatic tab acquisition/release |
| POST | `/pool/acquire` | Manually acquire a tab from pool |
| POST | `/pool/release/:tabId` | Release a tab back to pool |
| POST | `/pool/tab/:tabId/execute` | Execute code on a specific tab |
| DELETE | `/pool/tab/:tabId` | Close a specific tab |
| GET | `/pool/status` | Get pool status (idle/busy/waiting counts) |
| GET | `/pool/tabs` | Get info for all tabs in pool |
| POST | `/pool/close-all` | Close all tabs in pool |
| POST | `/pool/prune` | Close idle tabs (body: `{maxIdleMs: 60000}`) |

## Concurrent Execution

For scraping multiple pages in parallel, use the tab pool feature.

### Starting with Pool Enabled

```bash
# Enable pool with 5 concurrent tabs
node index.js --pool --max-tabs 5 --port 8080 --url https://api.sap.com
```

### Using the Pool API

```bash
# Execute with automatic tab management (recommended)
curl -X POST http://localhost:8080/pool/execute \
  -H "Content-Type: application/json" \
  -d '{"code": "await page.goto(\"https://example.com\"); return page.url();"}'

# Or manually manage tabs for more control
# 1. Acquire a tab
TAB_ID=$(curl -s -X POST http://localhost:8080/pool/acquire | jq -r '.tabId')

# 2. Execute on that tab
curl -X POST "http://localhost:8080/pool/tab/$TAB_ID/execute" \
  -H "Content-Type: application/json" \
  -d '{"code": "await page.goto(\"https://example.com\"); return page.title();"}'

# 3. Release the tab
curl -X POST "http://localhost:8080/pool/release/$TAB_ID"
```

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
- **No authentication**: Anyone with local access can execute code
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
│   ├── server.js         # Express HTTP server
│   └── index.js          # Module exports
└── examples/
    ├── client.js         # Node.js client library
    └── sap-api-example.sh # Shell script example
```

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
