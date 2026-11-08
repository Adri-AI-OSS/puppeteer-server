/**
 * Integration tests: the real server (child process) driving headless system
 * Chrome against a local fixture site. Run with `npm test`.
 *
 * Covers docs/PLAN-harness-gaps.md: P1 abort on timeout, P2 per-run cleanup and
 * dialog handling, P3 binary results, P4 console capture, plus regressions.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── fixture site ────────────────────────────────────────────────────────────

const PAGES = {
    '/plain': '<title>plain</title><button id="b">b</button><p>hello</p>',
    '/alert': '<title>alert</title><script>alert("hello from alert")</script><p>after</p>',
    '/alert-later': '<title>later</title><script>setTimeout(() => alert("late alert"), 200)</script>',
    '/confirm': '<title>confirm</title><button id="b" onclick="window.answer = confirm(\'sure?\')">b</button>',
    '/beforeunload': '<title>bu</title><button id="b">b</button><script>' +
        'window.addEventListener("beforeunload", e => { e.preventDefault(); e.returnValue = ""; });</script>',
    '/data.json': null
};

function startFixture() {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            const url = req.url.split('?')[0];
            if (url === '/data.json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end('{"ok":true}');
            }
            const body = PAGES[url];
            if (body == null) { res.writeHead(404); return res.end('nope'); }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(`<!doctype html><html><body>${body}</body></html>`);
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
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

let fixture, FIX, BASE, child, tmp, serverOutput = '';

async function waitForHealthy(timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`${BASE}/health`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        if (child.exitCode !== null) throw new Error(`server exited early:\n${serverOutput}`);
        await sleep(250);
    }
    throw new Error(`server not healthy in ${timeoutMs}ms:\n${serverOutput}`);
}

async function post(route, body) {
    const r = await fetch(`${BASE}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, headers: r.headers, body: json };
}

/** /execute with sane defaults; returns the parsed response body. */
async function exec(code, opts = {}) {
    return (await post('/execute', { code, timeout: 15000, ...opts })).body;
}

function execRecords() {
    const file = path.join(tmp, 'logs', fs.readdirSync(path.join(tmp, 'logs'))
        .find(f => f.endsWith('.executions.jsonl') && !f.includes('_latest')));
    return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

function endRecord(run) {
    return execRecords().find(r => r.event === 'end' && r.run === run);
}

before(async () => {
    fixture = await startFixture();
    FIX = `http://127.0.0.1:${fixture.address().port}`;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptr-srv-test-'));
    const port = await freePort();
    BASE = `http://localhost:${port}`;
    child = spawn(process.execPath, [
        path.join(ROOT, 'index.js'),
        '--port', String(port), '--headless', '--pool', '--max-tabs', '3', '--no-prompt',
        '--profile', path.join(tmp, 'profile'), '--log-dir', path.join(tmp, 'logs')
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOG_LEVEL: 'info' } });
    child.stdout.on('data', d => { serverOutput += d; });
    child.stderr.on('data', d => { serverOutput += d; });
    await waitForHealthy();
});

after(async () => {
    if (child && child.exitCode === null) {
        try { await post('/shutdown'); } catch { /* ignore */ }
        const t0 = Date.now();
        while (child.exitCode === null && Date.now() - t0 < 10000) await sleep(100);
        if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (fixture) fixture.close();
    if (process.env.KEEP_TEST_LOGS) console.log(`test logs kept in ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
});

// ── regression ──────────────────────────────────────────────────────────────

describe('regression', () => {
    test('/execute returns result and run id', async () => {
        const r = await exec(`await page.goto(${JSON.stringify(FIX + '/plain')}); return page.title();`);
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(r.result, 'plain');
        assert.equal(typeof r.run, 'number');
        assert.equal(r.logs, undefined, 'no logs field when snippet logs nothing');
    });

    test('/run returns the raw value with an X-Run-Id header', async () => {
        const r = await post('/run', { code: 'return {a: 1}' });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { a: 1 });
        assert.match(r.headers.get('x-run-id'), /^\d+$/);
    });

    test('browser.close() is still blocked', async () => {
        const r = await exec('await browser.close(); return 1');
        assert.equal(r.success, false);
        assert.match(r.error, /not allowed/);
        const viaPage = await exec('await page.browser().close(); return 1');
        assert.equal(viaPage.success, false);
        assert.match(viaPage.error, /not allowed/);
        assert.equal((await exec('return (await browser.pages()).length > 0')).result, true);
    });

    test('syntax errors are reported as failures', async () => {
        const r = await exec('return (');
        assert.equal(r.success, false);
        assert.match(r.error, /Unexpected/);
    });
});

// ── P1: abort on timeout ────────────────────────────────────────────────────

describe('P1 abort on timeout', () => {
    test('timed-out snippet stops at its next page call', async () => {
        const t0 = Date.now();
        const r = await exec(`
            await page.goto(${JSON.stringify(FIX + '/plain')});
            for (;;) {
                await page.evaluate(() => { window.__ticks = (window.__ticks || 0) + 1; });
                await new Promise(r => setTimeout(r, 20));
            }`, { timeout: 800 });
        assert.equal(r.success, false);
        assert.match(r.error, /timeout/i);
        assert.equal(r.aborted, 'timeout');
        assert.ok(Date.now() - t0 < 4000, 'responds shortly after the timeout');

        const a = (await exec('return page.evaluate(() => window.__ticks)')).result;
        await sleep(400);
        const b = (await exec('return page.evaluate(() => window.__ticks)')).result;
        assert.ok(a > 0);
        assert.equal(a, b, 'the aborted loop is no longer touching the page');

        const end = endRecord(r.run);
        assert.equal(end.status, 'timeout');
        assert.equal(typeof end.settledAfterAbortMs, 'number');
        assert.equal(end.orphan, undefined);
    });

    test('queued request does not overlap with the timed-out one', async () => {
        await exec(`await page.goto(${JSON.stringify(FIX + '/plain')}); return 1`);
        const slow = post('/execute', { timeout: 600, code: `
            for (;;) {
                await page.evaluate(() => { window.__w = (window.__w || 0) + 1; });
                await new Promise(r => setTimeout(r, 10));
            }` });
        await sleep(50);
        const next = post('/execute', { timeout: 5000, code: `
            const a = await page.evaluate(() => window.__w || 0);
            await helpers.wait(300);
            const b = await page.evaluate(() => window.__w || 0);
            return { a, b };` });
        const [s, n] = await Promise.all([slow, next]);
        assert.equal(s.body.success, false);
        assert.equal(n.body.success, true, JSON.stringify(n.body));
        assert.ok(n.body.result.a > 0);
        assert.equal(n.body.result.a, n.body.result.b, 'no writes from the old run during the new one');
    });

    test('helpers.signal fires and helpers.wait rejects on abort', async () => {
        const r = await exec(`
            globalThis.__abortSeen = null;
            helpers.signal.addEventListener('abort', () => { globalThis.__abortSeen = helpers.signal.reason.name; });
            await helpers.wait(10000);
            globalThis.__afterWait = true;`, { timeout: 300 });
        assert.equal(r.aborted, 'timeout');
        const seen = await exec('return [globalThis.__abortSeen, globalThis.__afterWait === true]');
        assert.deepEqual(seen.result, ['RunAbortedError', false]);
    });

    test('snippet that ignores the abort becomes an orphan whose later page calls fail', async () => {
        await exec(`await page.goto(${JSON.stringify(FIX + '/plain')}); return 1`);
        const t0 = Date.now();
        const r = await exec(`
            await new Promise(r => setTimeout(r, 2000));   // not abort-aware
            await page.evaluate(() => { window.__late = true; });`,
        { timeout: 300, abortGraceMs: 300 });
        const took = Date.now() - t0;
        assert.equal(r.aborted, 'timeout');
        assert.ok(took < 1800, `released after timeout + grace, took ${took}ms`);
        assert.equal(endRecord(r.run).orphan, true);
        await sleep(2200);
        const late = await exec('return page.evaluate(() => window.__late === true)');
        assert.equal(late.result, false, 'orphan was refused when it touched the page');
    });

    test('/clear-queue aborts the running sequential run', async () => {
        const running = post('/execute', { timeout: 30000, code: 'for (;;) await helpers.wait(50);' });
        await sleep(300);
        const t0 = Date.now();
        await post('/clear-queue');
        const r = (await running).body;
        assert.equal(r.success, false);
        assert.match(r.error, /cancelled/);
        assert.ok(Date.now() - t0 < 3000);
        assert.equal(endRecord(r.run).status, 'cancelled');
    });
});

// ── P2: per-run cleanup and dialogs ─────────────────────────────────────────

describe('P2 cleanup', () => {
    test('listeners added by a run are removed when it ends', async () => {
        const base = (await exec(`return [page.listenerCount('console'), page.listenerCount('request'),
            browser.listenerCount('targetcreated')]`)).result;
        const during = await exec(`
            page.on('console', () => {});
            page.once('request', () => {});
            page.addListener('console', () => {});
            browser.on('targetcreated', () => {});
            return [page.listenerCount('console'), page.listenerCount('request'),
                browser.listenerCount('targetcreated')];`);
        assert.deepEqual(during.result, [base[0] + 2, base[1] + 1, base[2] + 1]);
        const afterRun = (await exec(`return [page.listenerCount('console'), page.listenerCount('request'),
            browser.listenerCount('targetcreated')]`)).result;
        assert.deepEqual(afterRun, base);
    });

    test('off() of a once() listener works through the proxy', async () => {
        const r = await exec(`
            const h = () => {};
            const before = page.listenerCount('framenavigated');
            page.once('framenavigated', h);
            page.off('framenavigated', h);
            return page.listenerCount('framenavigated') - before;`);
        assert.equal(r.result, 0);
    });

    test('persist: true keeps listeners and reports them', async () => {
        const base = (await exec(`return page.listenerCount('x-test-event')`)).result;
        const r = await exec(`page.on('x-test-event', () => {}); return 1`, { persist: true });
        assert.deepEqual(r.persisted, { listeners: 1, interception: false, exposed: [] });
        assert.equal((await exec(`return page.listenerCount('x-test-event')`)).result, base + 1);
    });

    test('request interception is turned off after the run', async () => {
        const r = await exec(`
            await page.setRequestInterception(true);
            page.on('request', req => req.continue());
            await page.goto(${JSON.stringify(FIX + '/plain')});
            return page.title();`);
        assert.equal(r.result, 'plain', JSON.stringify(r));
        // Without cleanup this navigation hangs: interception on, handler gone.
        const nav = await exec(`await page.goto(${JSON.stringify(FIX + '/data.json')}); return page.content();`,
            { timeout: 8000 });
        assert.equal(nav.success, true, JSON.stringify(nav));
        assert.match(nav.result, /"ok":true/);
        assert.equal(endRecord(r.run).cleanup.removed.interception, true);
    });

    test('exposed functions are removed after the run', async () => {
        const r = await exec(`
            await page.exposeFunction('__ping', () => 'pong');
            await page.goto(${JSON.stringify(FIX + '/plain')});
            return page.evaluate(() => window.__ping());`);
        assert.equal(r.result, 'pong', JSON.stringify(r));
        const after = await exec(`await page.goto(${JSON.stringify(FIX + '/plain')});
            return page.evaluate(() => typeof window.__ping);`);
        assert.equal(after.result, 'undefined');
    });
});

describe('P2 dialogs', () => {
    test('alert during page load is accepted and reported', async () => {
        const r = await exec(`await page.goto(${JSON.stringify(FIX + '/alert')}); return page.title();`,
            { timeout: 10000 });
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(r.result, 'alert');
        assert.equal(r.dialogs.length, 1);
        assert.deepEqual({ ...r.dialogs[0], ms: 0 },
            { type: 'alert', message: 'hello from alert', action: 'accepted', ms: 0 });
        assert.equal(endRecord(r.run).dialogs.length, 1);
    });

    test('confirm is dismissed by default', async () => {
        const r = await exec(`
            await page.goto(${JSON.stringify(FIX + '/confirm')});
            await page.click('#b');
            return page.evaluate(() => window.answer);`);
        assert.equal(r.result, false);
        assert.equal(r.dialogs[0].type, 'confirm');
        assert.equal(r.dialogs[0].action, 'dismissed');
    });

    test("a snippet's own dialog handler wins", async () => {
        const r = await exec(`
            page.on('dialog', d => d.accept());
            await page.goto(${JSON.stringify(FIX + '/confirm')});
            await page.click('#b');
            return page.evaluate(() => window.answer);`);
        assert.equal(r.result, true);
        assert.equal(r.dialogs, undefined, 'default handler stayed out of it');
    });

    test('beforeunload does not block navigation', async () => {
        const r = await exec(`
            await page.goto(${JSON.stringify(FIX + '/beforeunload')});
            await page.click('#b');                       // user activation arms beforeunload
            await page.goto(${JSON.stringify(FIX + '/plain')});
            return page.title();`, { timeout: 10000 });
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(r.result, 'plain');
        assert.deepEqual(r.dialogs.map(d => [d.type, d.action]), [['beforeunload', 'accepted']]);
    });

    test('a dialog that opens between runs does not freeze the tab', async () => {
        await exec(`await page.goto(${JSON.stringify(FIX + '/alert-later')}); return 1`);
        await sleep(700);                                 // alert fires with no run active
        const t0 = Date.now();
        const r = await exec('return page.evaluate(() => document.title)', { timeout: 5000 });
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(r.result, 'later');
        assert.ok(Date.now() - t0 < 3000);
    });
});

// ── P3: binary results ──────────────────────────────────────────────────────

describe('P3 binary results', () => {
    test('a screenshot Buffer comes back as base64', async () => {
        const r = await exec(`await page.goto(${JSON.stringify(FIX + '/plain')}); return page.screenshot();`);
        assert.equal(r.result.$binary, 'base64');
        const png = Buffer.from(r.result.data, 'base64');
        assert.equal(png.length, r.result.bytes);
        assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    });

    test('nested buffers and typed arrays are converted too', async () => {
        const r = await exec(`return { shot: await page.screenshot({ type: 'jpeg' }), n: 1,
            arr: [new Uint8Array([1, 2, 3])], s: 'x' };`);
        assert.equal(r.result.n, 1);
        assert.equal(r.result.s, 'x');
        assert.equal(r.result.shot.$binary, 'base64');
        assert.deepEqual([...Buffer.from(r.result.shot.data, 'base64').subarray(0, 2)], [0xff, 0xd8]);
        assert.deepEqual(r.result.arr[0], { $binary: 'base64', data: 'AQID', bytes: 3 });
    });

    test('/run also returns base64 binaries', async () => {
        const r = await post('/run', { code: 'return page.pdf()' });
        assert.equal(r.status, 200);
        assert.equal(Buffer.from(r.body.data, 'base64').subarray(0, 4).toString(), '%PDF');
    });
});

// ── P4: console capture ─────────────────────────────────────────────────────

describe('P4 console capture', () => {
    test('console output is returned in order with levels', async () => {
        const r = await exec(`
            console.log('a', 1, { x: 2 });
            console.warn('careful');
            console.error('bad %s', 'thing');
            console.debug('dbg');
            return 'done';`);
        assert.equal(r.result, 'done');
        assert.deepEqual(r.logs.map(l => [l.level, l.msg]), [
            ['log', 'a 1 { x: 2 }'], ['warn', 'careful'], ['error', 'bad thing'], ['debug', 'dbg']
        ]);
        assert.ok(r.logs.every(l => typeof l.ms === 'number'));
        assert.equal(endRecord(r.run).logs.length, 4);
    });

    test('logs are returned for failed runs too', async () => {
        const r = await exec(`console.log('step 1'); throw new Error('boom');`);
        assert.equal(r.success, false);
        assert.equal(r.error, 'boom');
        assert.deepEqual(r.logs.map(l => l.msg), ['step 1']);
    });

    test('output is capped and flagged as truncated', async () => {
        const r = await exec(`for (let i = 0; i < 600; i++) console.log('line', i); return 1`);
        assert.equal(r.logs.length, 500);
        assert.equal(r.logsTruncated, true);
    });

    test('pool runs return logs and dialogs as well', async () => {
        const r = (await post('/pool/execute', { timeout: 10000, code: `
            console.log('in pool');
            await page.goto(${JSON.stringify(FIX + '/alert')});
            return page.title();` })).body;
        assert.equal(r.success, true, JSON.stringify(r));
        assert.match(r.tabId, /^tab-/);
        assert.deepEqual(r.logs.map(l => l.msg), ['in pool']);
        assert.equal(r.dialogs[0].type, 'alert');
        const status = await (await fetch(`${BASE}/pool/status`)).json();
        assert.equal(status.busy ?? status.busyTabs ?? 0, 0, JSON.stringify(status));
    });

    test('pool timeout aborts and frees the tab', async () => {
        const r = (await post('/pool/execute', { timeout: 300, code: 'for (;;) await page.evaluate(() => 1);' })).body;
        assert.equal(r.success, false);
        assert.equal(r.aborted, 'timeout');
        const ok = (await post('/pool/execute', { timeout: 5000, code: 'return 7' })).body;
        assert.equal(ok.result, 7);
    });
});
