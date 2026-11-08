/**
 * Integration tests for docs/PLAN-2026-11-09-next-features.md, items #2-#3 and
 * #5-#17, #19, against the real server + headless Chrome. Lifecycle items
 * (#1, #18, #20, #21) are in lifecycle.test.js.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sleep, startFixture, startServer, CSV } = require('./support');

let fixture, FIX, srv;
const J = JSON.stringify;
const exec = (code, opts) => srv.exec(code, opts);

before(async () => {
    fixture = await startFixture();
    FIX = fixture.url;
    srv = await startServer({
        args: ['--max-tabs', '2', '--login-url-pattern', '/login', '--max-queue', '3',
            '--acquire-timeout', '1500', '--max-timeout', '20000', '--result-max-bytes', '1000000',
            '--job-ttl-ms', '3000']
    });
});

after(async () => {
    if (srv) { await srv.stop(); srv.cleanup(); }
    if (fixture) fixture.close();
});

async function waitJob(jobId, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
        const r = await srv.get(`/jobs/${jobId}`);
        if (r.body.status !== 'running') return r.body;
        if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} still running: ${J(r.body)}`);
        await sleep(100);
    }
}

// ── P0 #2: logging ──────────────────────────────────────────────────────────

describe('#2 execution logging', () => {
    test('start/exec/end records carry the full code and link to the request id', async () => {
        const code = `await page.goto(${J(FIX + '/plain')});\n// marker-${Date.now()}\nreturn page.title();`;
        const r = await srv.request('POST', '/execute', { code }, { 'x-request-id': 'req-log-test' });
        assert.equal(r.body.success, true, J(r.body));
        const run = r.body.run;
        assert.equal(r.headers.get('x-run-id'), String(run));
        const recs = srv.execRecords().filter(x => x.run === run);
        assert.deepEqual(recs.map(x => x.event), ['start', 'exec', 'end']);
        assert.equal(recs[0].code, code, 'full code, newlines included');
        assert.equal(recs[0].req, 'req-log-test');
        assert.equal(recs[2].status, 'ok');
        const lines = srv.logText().split('\n').filter(l => l.includes(`run=${run} `) || l.endsWith(`run=${run}`));
        assert.ok(lines.length >= 2, 'text log lines carry run=');
        assert.ok(lines.every(l => l.includes('req=req-log-test')), 'and req=');
    });

    test('a run that fails before its code runs still gets an end record', async () => {
        const r = await srv.post('/pool/tab/tab-nope/execute', { code: 'return 1' });
        assert.equal(r.status, 404);
        const run = Number(r.headers.get('x-run-id'));
        const end = srv.endRecord(run);
        assert.equal(end.status, 'error');
        assert.equal(end.stage, 'lookupTab');
        assert.match(end.error, /not found/);
        assert.equal(srv.execRecords().find(x => x.run === run && x.event === 'start').code, 'return 1');
    });
});

// ── P0 #3: routes ───────────────────────────────────────────────────────────

describe('#3 routes', () => {
    test('/goto, /page, /content, /screenshot, /cookies, /status', async () => {
        const g = await srv.post('/goto', { url: FIX + '/cookie', waitUntil: 'load' });
        assert.equal(g.body.success, true, J(g.body));
        assert.equal(g.body.result.title, 'cookie');
        const p = await srv.get('/page');
        assert.equal(p.body.result.url, FIX + '/cookie');
        const c = await srv.get('/content');
        assert.match(c.body, /document\.cookie/);
        const s = await srv.get('/screenshot');
        assert.equal(s.headers.get('content-type'), 'image/png');
        assert.deepEqual([...s.raw.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
        const k = await srv.get('/cookies');
        assert.ok(k.body.result.some(x => x.name === 'sess' && x.value === 'abc123'), J(k.body));
        const st = await srv.get('/status');
        assert.equal(st.body.browser, true);
        assert.equal(st.body.queue.maxQueue, 3);
    });

    test('/reconnect keeps the session tab', async () => {
        await exec(`await page.goto(${J(FIX + '/plain?reconnect=1')}); return 1`);
        const r = await srv.post('/reconnect');
        assert.equal(r.body.success, true, J(r.body));
        assert.ok(r.body.pages.includes(FIX + '/plain?reconnect=1'), J(r.body));
        assert.equal((await exec('return page.url()')).result, FIX + '/plain?reconnect=1');
    });

    test('pool acquire / tab execute / release / tabs / prune / close-all', async () => {
        const a = await srv.post('/pool/acquire');
        assert.match(a.body.tabId, /^tab-/);
        const tabId = a.body.tabId;
        const e = await srv.post(`/pool/tab/${tabId}/execute`, { code: 'return 6 * 7' });
        assert.equal(e.body.result, 42);
        let tabs = (await srv.get('/pool/tabs')).body;
        assert.equal(tabs.find(t => t.tabId === tabId).status, 'busy');
        await srv.post(`/pool/release/${tabId}`);
        tabs = (await srv.get('/pool/tabs')).body;
        assert.equal(tabs.find(t => t.tabId === tabId).status, 'idle');
        const pr = await srv.post('/pool/prune', { maxIdleMs: 0 });
        assert.ok(pr.body.closed >= 1);
        await srv.post('/pool/acquire');
        await srv.post('/pool/close-all');
        assert.equal((await srv.get('/pool/status')).body.total, 0);
    });

    test('#19 full pool: acquire times out with 503 instead of waiting forever', async () => {
        const t1 = (await srv.post('/pool/acquire')).body.tabId;
        const t2 = (await srv.post('/pool/acquire')).body.tabId;
        const t0 = Date.now();
        const r = await srv.post('/pool/acquire');
        assert.equal(r.status, 503);
        assert.match(r.body.error, /no tab became free within 1500ms/);
        assert.ok(Date.now() - t0 < 4000);
        const pe = await srv.post('/pool/execute', { code: 'return 1' });
        assert.equal(pe.status, 503, J(pe.body));
        await srv.post(`/pool/release/${t1}`);
        await srv.post(`/pool/release/${t2}`);
        assert.equal((await srv.post('/pool/execute', { code: 'return 2' })).body.result, 2);
    });
});

// ── P1: protect the shared tab ──────────────────────────────────────────────

describe('P1 shared-tab protection', () => {
    const probe = `
        await page.goto(${J(FIX + '/plain')});
        return {
            w: await page.evaluate(() => innerWidth),
            ua: await page.evaluate(() => navigator.userAgent),
            tz: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
            dark: await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
            print: await page.evaluate(() => matchMedia('print').matches),
            js: page.isJavaScriptEnabled(),
            timeout: page.getDefaultTimeout(),
            hdr: (await (await fetch(${J(FIX + '/headers')})).json())['x-test'] || null
        };`;

    test('#5 settings changed by a run are restored afterwards', async () => {
        const base = (await exec(probe)).result;
        const during = await exec(`
            await page.setViewport({ width: 500, height: 400 });
            await page.setUserAgent('TestAgent/1.0');
            await page.emulateTimezone('Asia/Tokyo');
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
            await page.setExtraHTTPHeaders({ 'x-test': 'yes' });
            page.setDefaultTimeout(1234);
            await page.setOfflineMode(true);
            await page.setOfflineMode(false);
            await page.goto(${J(FIX + '/plain')});
            return {
                w: await page.evaluate(() => innerWidth),
                ua: await page.evaluate(() => navigator.userAgent),
                tz: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
                dark: await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
                print: await page.evaluate(() => matchMedia('print').matches),
                timeout: page.getDefaultTimeout(),
                hdr: await page.evaluate(async u => (await (await fetch(u)).json())['x-test'] || null, ${J(FIX + '/headers')})
            };`);
        assert.equal(during.success, true, J(during));
        assert.deepEqual(during.result, { w: 500, ua: 'TestAgent/1.0', tz: 'Asia/Tokyo', dark: true, print: false,
            timeout: 1234, hdr: 'yes' });
        const cleanup = srv.endRecord(during.run).cleanup.removed;
        assert.deepEqual(cleanup.settings.sort(), ['emulateMediaFeatures', 'emulateTimezone',
            'setDefaultTimeout', 'setExtraHTTPHeaders', 'setOfflineMode', 'setUserAgent', 'setViewport'].sort());
        const afterRun = (await exec(probe)).result;
        assert.deepEqual(afterRun, base);
    });

    test('#5 JS disabled by a run is re-enabled; persist keeps settings', async () => {
        const off = await exec(`await page.setJavaScriptEnabled(false); return page.isJavaScriptEnabled()`);
        assert.equal(off.result, false);
        assert.equal((await exec('return page.isJavaScriptEnabled()')).result, true);
        const print = `return page.evaluate(() => matchMedia('print').matches)`;
        assert.equal((await exec(`await page.emulateMediaType('print'); ${print}`)).result, true);
        assert.equal((await exec(print)).result, false);
        const kept = await exec(`await page.setUserAgent('Persisted/1'); return 1`, { persist: true });
        assert.deepEqual(kept.persisted.settings, ['setUserAgent']);
        assert.equal((await exec('return page.evaluate(() => navigator.userAgent)')).result, 'Persisted/1');
        // A normal run that touches the UA restores the browser default.
        await exec(`await page.setUserAgent('Temp/1'); return 1`);
        assert.notEqual((await exec('return page.evaluate(() => navigator.userAgent)')).result, 'Persisted/1');
    });

    test('#6 evaluateOnNewDocument scripts are removed after the run', async () => {
        const r = await exec(`
            await page.evaluateOnNewDocument(() => { window.__injected = 42; });
            await page.goto(${J(FIX + '/plain')});
            return page.evaluate(() => window.__injected);`);
        assert.equal(r.result, 42);
        assert.equal(srv.endRecord(r.run).cleanup.removed.newDocumentScripts, 1);
        const after = await exec(`await page.goto(${J(FIX + '/plain')}); return page.evaluate(() => window.__injected ?? null);`);
        assert.equal(after.result, null);
    });

    test('#7 tabs, popups and contexts opened by a run are closed afterwards', async () => {
        const count = 'return (await browser.pages()).length';
        const base = (await exec(count)).result;
        const r = await exec(`
            await page.goto(${J(FIX + '/popup')});
            const popup = new Promise(r => page.once('popup', r));
            await page.click('#open');
            await popup;
            await page.bringToFront();   // the popup took focus; background tabs don't take clicks
            const blank = new Promise(r => page.once('popup', r));
            await page.click('#blank');
            await blank;
            await browser.newPage();
            await page.bringToFront();
            const ctx = await browser.createIncognitoBrowserContext();
            await ctx.newPage();
            return (await browser.pages()).length;`);
        assert.equal(r.success, true, J(r));
        assert.equal(r.result, base + 4);
        const removed = srv.endRecord(r.run).cleanup.removed;
        assert.equal(removed.tabs, 3);
        assert.equal(removed.contexts, 1);
        assert.equal((await exec(count)).result, base);
    });

    test('#7 keepTabs keeps them', async () => {
        const base = (await exec('return (await browser.pages()).length')).result;
        const r = await exec(`const p = await browser.newPage(); await p.goto(${J(FIX + '/plain?kept=1')}); return 1`,
            { keepTabs: true });
        assert.equal(r.keptTabs, 1);
        assert.equal((await exec('return (await browser.pages()).length')).result, base + 1);
        await exec(`for (const p of await browser.pages()) if (p.url().includes('kept=1')) await p.close(); return 1`);
    });

    test('#8 a run that ends on the login page reports sessionExpired', async () => {
        const r = await exec(`await page.goto(${J(FIX + '/redirect-login')}); return page.title();`);
        assert.equal(r.result, 'Sign in');
        assert.equal(r.sessionExpired, true);
        assert.match(r.sessionUrl, /\/login\?next=/);
        assert.equal(srv.endRecord(r.run).sessionExpired, true);
        const ok = await exec(`await page.goto(${J(FIX + '/plain')}); return 1`);
        assert.equal(ok.sessionExpired, undefined);
    });
});

// ── P2: feedback for agents ─────────────────────────────────────────────────

describe('P2 agent feedback', () => {
    test('#9 GET /runs/:id returns code, status and logs for a /run call', async () => {
        const code = `console.log('from run'); return 'raw';`;
        const r = await srv.post('/run', { code });
        assert.equal(r.body, 'raw');
        const id = r.headers.get('x-run-id');
        const run = (await srv.get(`/runs/${id}`)).body;
        assert.equal(run.code, code);
        assert.equal(run.status, 'ok');
        assert.equal(run.path, '/run');
        assert.deepEqual(run.logs.map(l => l.msg), ['from run']);
        const list = (await srv.get('/runs?limit=5')).body;
        assert.equal(list[0].run, Number(id));
        assert.equal((await srv.get('/runs/999999')).status, 404);
    });

    test('#10 pageEvents returns console messages, page errors and failed requests', async () => {
        const r = await exec(`await page.goto(${J(FIX + '/events')}); await helpers.wait(400); return 1`,
            { pageEvents: true });
        assert.equal(r.success, true, J(r));
        const ev = r.pageEvents;
        assert.ok(ev.some(e => e.type === 'console' && e.level === 'log' && e.text === 'hello from page'), J(ev));
        assert.ok(ev.some(e => e.type === 'console' && e.level === 'warning' && e.text === 'page warning'));
        assert.ok(ev.some(e => e.type === 'httpError' && e.status === 404 && e.url.endsWith('/missing')));
        assert.ok(ev.some(e => e.type === 'pageerror' && /page boom/.test(e.message)));
        const bad = await srv.post('/execute', { code: 'return 1', pageEvents: ['nope'] });
        assert.equal(bad.status, 400);
        assert.match(bad.body.error, /unknown event type/);
    });

    test('#11 screenshotOnError attaches a screenshot to failures and timeouts', async () => {
        const r = await exec(`await page.goto(${J(FIX + '/plain')}); await page.click('#nope');`,
            { screenshotOnError: true });
        assert.equal(r.success, false);
        assert.equal(r.errorScreenshot.$binary, 'base64');
        assert.deepEqual([...Buffer.from(r.errorScreenshot.data, 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
        const t = await exec('await new Promise(r => setTimeout(r, 3000));',
            { timeout: 300, abortGraceMs: 100, screenshotOnError: true });
        assert.equal(t.aborted, 'timeout');
        assert.equal(t.errorScreenshot.$binary, 'base64');
        const ok = await exec('return 1', { screenshotOnError: true });
        assert.equal(ok.errorScreenshot, undefined);
    });
});

// ── P3: long-running work ───────────────────────────────────────────────────

describe('P3 async jobs and watches', () => {
    test('#12 async job: 202, progress logs while running, result when done', async () => {
        const r = await srv.post('/execute', { async: true, code: `
            console.log('step 1');
            await helpers.wait(800);
            console.log('step 2');
            return 42;` });
        assert.equal(r.status, 202);
        assert.match(r.body.jobId, /^j\d+$/);
        await sleep(300);
        const mid = (await srv.get(`/jobs/${r.body.jobId}`)).body;
        assert.equal(mid.status, 'running');
        assert.equal(mid.phase, 'executing');
        assert.deepEqual(mid.logs.map(l => l.msg), ['step 1']);
        const runMid = (await srv.get(`/runs/${r.body.run}`)).body;
        assert.equal(runMid.status, 'running');
        const done = await waitJob(r.body.jobId);
        assert.equal(done.status, 'succeeded');
        assert.equal(done.result, 42);
        assert.deepEqual(done.logs.map(l => l.msg), ['step 1', 'step 2']);
        assert.equal((await srv.post(`/jobs/${r.body.jobId}/cancel`)).status, 409);
    });

    test('#12 cancel stops a running job, and a queued one', async () => {
        const a = (await srv.post('/execute', { async: true, timeout: 20000,
            code: 'for (;;) { await helpers.wait(50); }' })).body;
        const b = (await srv.post('/execute', { async: true, code: 'return "never"' })).body;
        await sleep(200);
        assert.equal((await srv.get(`/jobs/${b.jobId}`)).body.phase, 'queued');
        assert.equal((await srv.post(`/jobs/${b.jobId}/cancel`)).body.cancelRequested, true);
        const bDone = await waitJob(b.jobId);
        assert.equal(bDone.status, 'cancelled');
        const t0 = Date.now();
        await srv.post(`/jobs/${a.jobId}/cancel`);
        const aDone = await waitJob(a.jobId);
        assert.equal(aDone.status, 'cancelled', J(aDone));
        assert.ok(Date.now() - t0 < 3000);
        assert.equal(srv.endRecord(a.run).status, 'cancelled');
    });

    test('#12 async works on the pool, and finished jobs expire', async () => {
        const r = (await srv.post('/pool/execute', { async: true, code: 'return 7' })).body;
        const done = await waitJob(r.jobId);
        assert.equal(done.result, 7);
        assert.match(done.tabId, /^tab-/);
        await sleep(3300);
        assert.equal((await srv.get(`/jobs/${r.jobId}`)).status, 404);
    });

    test('#19 a full sequential queue returns 429; timeouts are capped', async () => {
        const jobs = [];
        jobs.push((await srv.post('/execute', { async: true, timeout: 20000, code: 'for (;;) await helpers.wait(50);' })).body);
        await sleep(100);
        for (let i = 0; i < 3; i++) jobs.push((await srv.post('/execute', { async: true, code: 'return 1' })).body);
        const full = await srv.post('/execute', { code: 'return 1' });
        assert.equal(full.status, 429);
        assert.match(full.body.error, /queue full/);
        for (const j of jobs.slice().reverse()) await srv.post(`/jobs/${j.jobId}/cancel`);
        for (const j of jobs) await waitJob(j.jobId);
        const capped = await exec('return 1', { timeout: 99999999 });
        assert.equal(capped.timeoutCappedTo, 20000);
    });

    test('#13 watch collects events across calls with a cursor', async () => {
        const w = (await srv.post('/watch', { events: ['console', 'framenavigated', 'httpError'] })).body;
        assert.match(w.watchId, /^w\d+$/);
        await exec(`await page.goto(${J(FIX + '/later-events')}); return 1`);
        await exec(`await page.click('#b'); return 1`);
        await exec(`await page.click('#b'); await page.evaluate(() => fetch('/missing')); return 1`);
        await sleep(200);
        const r1 = (await srv.get(`/watch/${w.watchId}?since=0`)).body;
        const types = r1.events.map(e => e.type);
        assert.ok(types.includes('framenavigated'), J(r1));
        assert.equal(r1.events.filter(e => e.type === 'console' && /^clicked/.test(e.text)).length, 2);
        assert.ok(r1.events.some(e => e.type === 'httpError' && e.status === 404));
        assert.deepEqual(r1.events.map(e => e.seq), r1.events.map((_, i) => i + 1));
        const r2 = (await srv.get(`/watch/${w.watchId}?since=${r1.next}`)).body;
        assert.deepEqual(r2.events, []);
        assert.equal((await srv.del(`/watch/${w.watchId}`)).body.deleted, true);
        assert.equal((await srv.get(`/watch/${w.watchId}`)).status, 404);
    });

    test('#13 the buffer is capped, bad types are rejected, closed tabs are reported', async () => {
        const w = (await srv.post('/watch', { events: ['console'], maxEvents: 3 })).body;
        await exec(`for (let i = 0; i < 5; i++) await page.evaluate(i => console.log('n' + i), i); return 1`);
        await sleep(100);
        const r = (await srv.get(`/watch/${w.watchId}`)).body;
        assert.deepEqual(r.events.map(e => e.text), ['n2', 'n3', 'n4']);
        assert.equal(r.dropped, 2);
        await srv.del(`/watch/${w.watchId}`);
        assert.equal((await srv.post('/watch', { events: ['bogus'] })).status, 400);

        const tab = (await srv.post('/pool/acquire')).body.tabId;
        const tw = (await srv.post('/watch', { tabId: tab, events: ['console'] })).body;
        await srv.del(`/pool/tab/${tab}`);
        await sleep(200);
        assert.equal((await srv.get(`/watch/${tw.watchId}`)).body.closed, true);
        await srv.del(`/watch/${tw.watchId}`);
    });
});

// ── P4: files ───────────────────────────────────────────────────────────────

describe('P4 files', () => {
    test('#14 helpers.download returns the file inline', async () => {
        const r = await exec(`
            await page.goto(${J(FIX + '/dl')});
            return helpers.download(() => page.click('#dl'));`);
        assert.equal(r.success, true, J(r));
        assert.equal(r.result.filename, 'report.csv');
        assert.equal(r.result.bytes, CSV.length);
        assert.equal(Buffer.from(r.result.data, 'base64').toString(), CSV);
    });

    test('#14 a large download becomes an artifact', async () => {
        const r = await exec(`
            await page.goto(${J(FIX + '/dl')});
            return helpers.download(() => page.click('#big'), { inlineMaxBytes: 1024 * 1024 });`);
        assert.equal(r.success, true, J(r));
        assert.equal(r.result.data, undefined);
        assert.equal(r.result.bytes, 2 * 1024 * 1024);
        const a = await srv.get(r.result.artifact.url);
        assert.equal(a.status, 200);
        assert.equal(a.raw.length, 2 * 1024 * 1024);
    });

    test('#15 files sent with the request can be uploaded', async () => {
        const r = await exec(`
            await page.goto(${J(FIX + '/upload')});
            const input = await page.$('#f');
            await input.uploadFile(helpers.files.doc, helpers.files.notes);
            return page.evaluate(async () => Promise.all([...document.querySelector('#f').files]
                .map(async f => [f.name, await f.text()])));`,
        { files: {
            doc: Buffer.from('hello upload').toString('base64'),
            notes: { filename: 'notes.txt', data: Buffer.from('second file').toString('base64') }
        } });
        assert.equal(r.success, true, J(r));
        assert.deepEqual(r.result, [['doc', 'hello upload'], ['notes.txt', 'second file']]);
        assert.equal((await srv.post('/execute', { code: 'return 1', files: ['x'] })).status, 400);
    });

    test('#16 large results are spilled to an artifact', async () => {
        const r = await exec(`return 'x'.repeat(1500000);`);
        assert.equal(r.result.$artifact.startsWith('a'), true, J(r.result));
        assert.equal(r.result.contentType, 'text/plain');
        const a = await srv.get(r.result.url);
        assert.equal(a.raw.length, 1500000);
        const obj = await exec(`return { rows: Array.from({ length: 60000 }, (_, i) => ({ i, s: 'row' })) };`);
        assert.equal(obj.result.contentType, 'application/json');
        const parsed = (await srv.get(obj.result.url)).body;
        assert.equal(parsed.rows.length, 60000);
        assert.equal((await exec('return "small"')).result, 'small');
        assert.equal((await srv.get('/artifacts/nope')).status, 404);
    });
});

// ── P5: robustness ──────────────────────────────────────────────────────────

describe('P5 crash recovery', () => {
    test('#17 a crashed named tab is replaced and reported', async () => {
        await exec(`await page.goto('chrome://crash').catch(() => {}); return 1`, { timeout: 5000, abortGraceMs: 200 });
        await sleep(300);
        const r = await exec(`await page.goto(${J(FIX + '/plain')}); return page.title();`);
        assert.equal(r.success, true, J(r));
        assert.equal(r.result, 'plain');
        assert.equal(r.tabCrashed.page, 'main');
        assert.equal(r.tabCrashed.replaced, true);
        const again = await exec('return 1');
        assert.equal(again.tabCrashed, undefined);
    });

    test('#17 a crashed pool tab is not handed out again', async () => {
        const c = (await srv.post('/pool/execute', { timeout: 5000, abortGraceMs: 200,
            code: `await page.goto('chrome://crash').catch(() => {}); return 1` })).body;
        await sleep(300);
        const crashedTab = c.tabId;
        for (let i = 0; i < 3; i++) {
            const r = (await srv.post('/pool/execute', { code: 'return page.evaluate(() => 1 + 1)' })).body;
            assert.equal(r.result, 2, J(r));
            assert.notEqual(r.tabId, crashedTab);
        }
    });
});
