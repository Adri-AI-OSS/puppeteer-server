/**
 * Shared test support: a local fixture site and a launcher for the real
 * server (child process, headless system Chrome, temp profile and log dir).
 */

const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── fixture site ────────────────────────────────────────────────────────────

const html = body => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const PAGES = {
    '/plain': '<title>plain</title><button id="b">b</button><p>hello</p>',
    '/alert': '<title>alert</title><script>alert("hello from alert")</script><p>after</p>',
    '/alert-later': '<title>later</title><script>setTimeout(() => alert("late alert"), 200)</script>',
    '/confirm': '<title>confirm</title><button id="b" onclick="window.answer = confirm(\'sure?\')">b</button>',
    '/beforeunload': '<title>bu</title><button id="b">b</button><script>' +
        'window.addEventListener("beforeunload", e => { e.preventDefault(); e.returnValue = ""; });</script>',
    '/login': '<title>Sign in</title><form><input name="user"></form>',
    '/events': '<title>events</title><script>' +
        'console.log("hello from page"); console.warn("page warning");' +
        'fetch("/missing").catch(() => {});' +
        'setTimeout(() => { throw new Error("page boom"); }, 50);</script>',
    '/later-events': '<title>later-events</title><button id="b" onclick="console.log(\'clicked \' + Date.now())">b</button>',
    '/dl': '<title>dl</title><a id="dl" href="/download">csv</a><a id="big" href="/download-big">big</a>',
    '/upload': '<title>upload</title><input type="file" id="f" multiple>',
    '/popup': '<title>popup</title>' +
        '<button id="open" onclick="window.open(\'/plain\')">open</button>' +
        '<a id="blank" href="/plain" target="_blank">blank</a>',
    '/cookie': '<title>cookie</title><script>document.cookie = "sess=abc123; path=/";' +
        'document.cookie = "keep=1; path=/; max-age=86400";</script>'
};

const CSV = 'id,name\n1,alpha\n2,beta\n';

function startFixture() {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://x');
            const p = url.pathname;
            if (p === '/data.json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end('{"ok":true}');
            }
            if (p === '/headers') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify(req.headers));
            }
            if (p === '/redirect-login') {
                res.writeHead(302, { location: '/login?next=/app' });
                return res.end();
            }
            if (p === '/download') {
                res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
                return res.end(CSV);
            }
            if (p === '/download-big') {
                res.writeHead(200, { 'content-type': 'application/octet-stream',
                    'content-disposition': 'attachment; filename="big.bin"' });
                return res.end(Buffer.alloc(2 * 1024 * 1024, 7));
            }
            if (p === '/slow') {
                return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<title>slow</title>')); },
                    Number(url.searchParams.get('ms') || 1000));
            }
            const body = PAGES[p];
            if (body == null) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('nope'); }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(html(body));
        });
        srv.listen(0, '127.0.0.1', () => {
            srv.url = `http://127.0.0.1:${srv.address().port}`;
            resolve(srv);
        });
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
        s.on('error', reject);
    });
}

// ── server under test ───────────────────────────────────────────────────────

/**
 * Start the server. Options:
 *   args    extra CLI args
 *   tmp     reuse a temp dir (profile + logs), e.g. to restart on the same profile
 *   port    reuse a port
 *   token   send this bearer token on every helper request
 *   prompt  true => don't pass --no-prompt
 *   env     extra env vars
 */
async function startServer({ args = [], tmp, port, token, prompt = false, env = {}, pool = true, headless = true } = {}) {
    tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'pptr-srv-test-'));
    port = port || await freePort();
    const base = `http://localhost:${port}`;
    const argv = [
        path.join(ROOT, 'index.js'),
        '--port', String(port), ...(headless ? ['--headless'] : []),
        '--profile', path.join(tmp, 'profile'), '--log-dir', path.join(tmp, 'logs'),
        ...(pool ? ['--pool', '--max-tabs', '3'] : []),
        ...(prompt ? [] : ['--no-prompt']),
        ...args
    ];
    const child = spawn(process.execPath, argv, {
        cwd: ROOT, stdio: [prompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, LOG_LEVEL: 'info', ...env }
    });
    const srv = { tmp, port, base, child, token, output: '' };
    child.stdout.on('data', d => { srv.output += d; });
    child.stderr.on('data', d => { srv.output += d; });

    const headers = (extra = {}) => ({ ...(srv.token ? { authorization: `Bearer ${srv.token}` } : {}), ...extra });

    srv.request = async (method, route, body, extraHeaders = {}) => {
        const r = await fetch(`${base}${route}`, {
            method,
            headers: headers(body !== undefined ? { 'content-type': 'application/json', ...extraHeaders } : extraHeaders),
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
        const buf = Buffer.from(await r.arrayBuffer());
        let json;
        try { json = JSON.parse(buf.toString()); } catch { json = undefined; }
        return { status: r.status, headers: r.headers, body: json !== undefined ? json : buf.toString(), raw: buf };
    };
    srv.post = (route, body = {}) => srv.request('POST', route, body);
    srv.get = route => srv.request('GET', route);
    srv.del = route => srv.request('DELETE', route);
    /** POST /execute with a 15s default timeout; returns the parsed body. */
    srv.exec = async (code, opts = {}) => (await srv.post('/execute', { code, timeout: 15000, ...opts })).body;

    srv.logFile = () => path.join(tmp, 'logs', `puppeteer-server_${port}_latest.log`);
    srv.logText = () => fs.readFileSync(srv.logFile(), 'utf8');
    srv.execRecords = () => {
        const file = fs.realpathSync(path.join(tmp, 'logs', `puppeteer-server_${port}_latest.executions.jsonl`));
        return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    };
    srv.endRecord = run => srv.execRecords().find(r => r.event === 'end' && r.run === run);

    srv.waitHealthy = async (timeoutMs = 60000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            try {
                const r = await fetch(`${base}/health`);
                if (r.ok) return r.json();
            } catch { /* not up yet */ }
            if (child.exitCode !== null) throw new Error(`server exited early:\n${srv.output}`);
            await sleep(200);
        }
        throw new Error(`server not healthy in ${timeoutMs}ms:\n${srv.output}`);
    };

    /** Wait until the server's log contains `text` (it is ready after the banner). */
    srv.waitForOutput = async (text, timeoutMs = 60000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (srv.output.includes(text)) return;
            if (child.exitCode !== null) throw new Error(`server exited early:\n${srv.output}`);
            await sleep(100);
        }
        throw new Error(`"${text}" not seen in ${timeoutMs}ms:\n${srv.output}`);
    };

    /** Graceful stop (closes Chrome too). */
    srv.stop = async () => {
        if (child.exitCode === null) {
            try { await srv.post('/shutdown'); } catch { /* ignore */ }
            const t0 = Date.now();
            while (child.exitCode === null && Date.now() - t0 < 10000) await sleep(100);
            if (child.exitCode === null) child.kill('SIGKILL');
        }
        killChromeFor(path.join(tmp, 'profile'));
    };

    /** Hard kill of the server process only (Chrome survives). */
    srv.kill = async () => {
        child.kill('SIGKILL');
        const t0 = Date.now();
        while (child.exitCode === null && child.signalCode === null && Date.now() - t0 < 5000) await sleep(50);
    };

    srv.cleanup = () => {
        if (process.env.KEEP_TEST_LOGS) console.log(`test logs kept in ${tmp}`);
        else fs.rmSync(tmp, { recursive: true, force: true });
    };

    await srv.waitHealthy();
    if (!prompt) await srv.waitForOutput('Server is running!');
    return srv;
}

/** PIDs of Chrome processes using `profileDir`. */
function chromePidsFor(profileDir) {
    try {
        const out = execFileSync('pgrep', ['-f', '--', `--user-data-dir=${profileDir}`], { encoding: 'utf8' });
        return out.split('\n').map(Number).filter(Boolean);
    } catch {
        return [];
    }
}

function killChromeFor(profileDir) {
    for (const pid of chromePidsFor(profileDir)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
}

module.exports = { ROOT, sleep, startFixture, startServer, freePort, chromePidsFor, killChromeFor, CSV };
