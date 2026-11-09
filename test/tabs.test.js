/**
 * Named tabs (docs/DESIGN-2026-11-10-named-tabs.md): per-tab queues (T1), the
 * tab API (T2), one window per tab (T5), isolated tabs (T6) and persistence
 * across reconnects, server restarts and Chrome death (T4).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sleep, startFixture, startServer } = require('./support');

let fixture, FIX, srv, srv2;
const J = JSON.stringify;
const exec = (code, opts) => srv.exec(code, opts);

before(async () => {
    fixture = await startFixture();
    FIX = fixture.url;
    srv = await startServer({
        pool: false,
        args: ['--max-tabs', '3', '--max-queue', '2', '--acquire-timeout', '1500'],
        env: { PUPPETEER_SERVER_TEST_HOOKS: '1' }
    });
});

after(async () => {
    for (const s of [srv2, srv]) if (s) await s.stop();
    if (srv) srv.cleanup();
    if (fixture) fixture.close();
});

async function waitJob(s, jobId, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
        const r = await s.get(`/jobs/${jobId}`);
        if (r.body.status !== 'running') return r.body;
        if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} still running`);
        await sleep(100);
    }
}

async function closeAllAgentTabs(s = srv) {
    for (const t of (await s.get('/tabs')).body) {
        if (t.name !== 'main' && !t.lost) await s.del(`/tabs/${t.name}?force=true`);
    }
}

// ── T2: tab API ─────────────────────────────────────────────────────────────

describe('T2 tab API', () => {
    test('unknown tab names are created on first use and reported', async () => {
        const r = await exec(`await page.goto(${J(FIX + '/plain?crm=1')}); return page.url();`, { tab: 'crm' });
        assert.equal(r.success, true, J(r));
        assert.equal(r.tab, 'crm');
        assert.equal(r.tabId, 'crm');
        assert.equal(r.tabCreated, true);
        const again = await exec('return page.url()', { tab: 'crm' });
        assert.equal(again.result, FIX + '/plain?crm=1');
        assert.equal(again.tabCreated, undefined);
        const main = await exec('return page.url()');
        assert.equal(main.tab, 'main');
        assert.notEqual(main.result, FIX + '/plain?crm=1', 'main is a different tab');
        // pageName is an alias of tab
        assert.equal((await exec('return page.url()', { pageName: 'crm' })).result, FIX + '/plain?crm=1');
    });

    test('GET /tabs, GET /tabs/:name, POST /tabs, DELETE /tabs/:name', async () => {
        const list = (await srv.get('/tabs')).body;
        const crm = list.find(t => t.name === 'crm');
        assert.equal(crm.kind, 'agent');
        assert.equal(crm.url, FIX + '/plain?crm=1');
        assert.equal(crm.title, 'plain');
        assert.equal(crm.busy, false);
        assert.equal(crm.queued, 0);
        assert.equal(typeof crm.expiresAt, 'number');
        assert.equal(list.find(t => t.name === 'main').kind, 'main');
        assert.equal((await srv.get('/tabs/crm')).body.name, 'crm');
        assert.equal((await srv.get('/tabs/nope')).status, 404);

        assert.equal((await srv.post('/tabs', { name: 'crm' })).status, 409);
        assert.equal((await srv.post('/tabs', { name: 'bad name' })).status, 400);
        assert.equal((await srv.post('/tabs', { name: 'new' })).status, 400);
        assert.equal((await srv.post('/execute', { code: 'return 1', tab: 'bad/name' })).status, 400);
        const created = await srv.post('/tabs', { url: FIX + '/plain?made=1' });
        assert.equal(created.status, 201);
        assert.match(created.body.name, /^tab-\d+$/);
        assert.equal(created.body.url, FIX + '/plain?made=1');

        assert.equal((await srv.del('/tabs/main')).status, 409);
        assert.equal((await srv.del(`/tabs/${created.body.name}`)).body.closed, true);
        assert.equal((await srv.get(`/tabs/${created.body.name}`)).status, 404);
    });

    test('a busy tab needs force to be closed', async () => {
        const job = (await srv.post('/execute', { async: true, tab: 'busy', timeout: 20000,
            code: 'for (;;) await helpers.wait(50);' })).body;
        await sleep(300);
        const r = await srv.del('/tabs/busy');
        assert.equal(r.status, 409);
        assert.match(r.body.error, /busy/);
        await srv.post(`/jobs/${job.jobId}/cancel`);
        await waitJob(srv, job.jobId);
        assert.equal((await srv.del('/tabs/busy')).status, 200);
    });

    test('fixed-purpose routes take ?tab=', async () => {
        const g = await srv.post('/goto', { url: FIX + '/cookie', waitUntil: 'load', tab: 'crm' });
        assert.equal(g.body.tab, 'crm');
        assert.equal((await srv.get('/page?tab=crm')).body.result.url, FIX + '/cookie');
        assert.notEqual((await srv.get('/page')).body.result.url, FIX + '/cookie');
        assert.match((await srv.get('/content?tab=crm')).body, /document\.cookie/);
        const shot = await srv.get('/screenshot?tab=crm');
        assert.deepEqual([...shot.raw.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
        assert.ok((await srv.get('/cookies?tab=crm')).body.result.some(c => c.name === 'sess'));
    });

    test('watches and /clear-queue take a tab', async () => {
        const w = (await srv.post('/watch', { tab: 'crm', events: ['console'] })).body;
        assert.equal(w.tab, 'crm');
        await exec(`await page.evaluate(() => console.log('in crm')); return 1`, { tab: 'crm' });
        await exec(`await page.evaluate(() => console.log('in main')); return 1`);
        await sleep(100);
        const ev = (await srv.get(`/watch/${w.watchId}`)).body.events.map(e => e.text);
        assert.deepEqual(ev, ['in crm']);
        await srv.del(`/watch/${w.watchId}`);
        assert.equal((await srv.post('/watch', { tab: 'nope' })).status, 404);
        assert.equal((await srv.post('/clear-queue?tab=nope')).status, 404);
        assert.equal((await srv.post('/clear-queue?tab=crm')).body.tab, 'crm');
    });
});

// ── T1: per-tab queues and limits ───────────────────────────────────────────

describe('T1 queues and limits', () => {
    const slow = 'await helpers.wait(800); return Date.now();';

    test('runs on different tabs run in parallel; runs on one tab are serialized', async () => {
        let t0 = Date.now();
        await Promise.all([exec(slow, { tab: 'p1' }), exec(slow, { tab: 'p2' })]);
        const parallel = Date.now() - t0;
        t0 = Date.now();
        await Promise.all([exec(slow, { tab: 'p1' }), exec(slow, { tab: 'p1' })]);
        const serial = Date.now() - t0;
        assert.ok(parallel < 1400, `two tabs took ${parallel}ms`);
        assert.ok(serial >= 1600, `one tab took ${serial}ms`);
        // Queues are per tab: a busy main doesn't block crm.
        const job = (await srv.post('/execute', { async: true, timeout: 20000, code: 'for (;;) await helpers.wait(50);' })).body;
        await sleep(200);
        const r = await exec('return 1', { tab: 'crm', timeout: 3000 });
        assert.equal(r.result, 1);
        await srv.post(`/jobs/${job.jobId}/cancel`);
        await waitJob(srv, job.jobId);
    });

    test('the queue limit is per tab (429)', async () => {
        const loop = 'for (;;) await helpers.wait(50);';
        const jobs = [(await srv.post('/execute', { async: true, tab: 'p1', timeout: 20000, code: loop })).body];
        await sleep(200);
        for (let i = 0; i < 2; i++) jobs.push((await srv.post('/execute', { async: true, tab: 'p1', code: 'return 1' })).body);
        const full = await srv.post('/execute', { tab: 'p1', code: 'return 1' });
        assert.equal(full.status, 429);
        assert.match(full.body.error, /tab "p1"/);
        assert.equal((await exec('return 2', { tab: 'p2' })).result, 2, 'other tabs unaffected');
        for (const j of jobs.slice().reverse()) await srv.post(`/jobs/${j.jobId}/cancel`);
        for (const j of jobs) await waitJob(srv, j.jobId);
    });

    test('tab: "new" is a throwaway tab, and waits for capacity (503)', async () => {
        await closeAllAgentTabs();
        const n = await exec('return page.url()', { tab: 'new' });
        assert.equal(n.success, true, J(n));
        assert.match(n.tab, /^tab-\d+$/);
        assert.equal((await srv.get('/tabs')).body.some(t => t.name === n.tab), false, 'closed after the run');

        for (const name of ['f1', 'f2', 'f3']) await srv.post('/tabs', { name });   // --max-tabs 3
        const t0 = Date.now();
        const r = await srv.post('/execute', { tab: 'new', code: 'return 1' });
        assert.equal(r.status, 503);
        assert.ok(Date.now() - t0 >= 1400);
        const over = await srv.post('/tabs', { name: 'f4' });
        assert.equal(over.status, 409);
        assert.deepEqual(over.body.idleTabs.sort(), ['f1', 'f2', 'f3']);
        assert.equal((await exec('return 1', { tab: 'f5' })).success, false, 'auto-create also respects the limit');
        await srv.del('/tabs/f1');
        assert.equal((await exec('return 3', { tab: 'new' })).result, 3);
        await closeAllAgentTabs();
    });
});

// ── T5: one window per tab ──────────────────────────────────────────────────

describe('T5 windows', () => {
    const windowId = `const s = await browser.target().createCDPSession();
        const { windowId } = await s.send('Browser.getWindowForTarget', { targetId: page.target()._targetId });
        await s.detach();
        return windowId;`;

    test('each agent tab has its own window', async () => {
        const ids = [];
        for (const tab of ['main', 'w1', 'w2']) ids.push((await exec(windowId, { tab })).result);
        assert.equal(new Set(ids).size, 3, `window ids ${ids}`);
    });

    test('clicks on several tabs at once all complete (headless)', async () => {
        for (const tab of ['w1', 'w2', 'w3']) {
            await exec(`await page.goto(${J(FIX + '/later-events')}); return 1`, { tab });
        }
        const runs = await Promise.all(['w1', 'w2', 'w3'].map(tab =>
            exec(`await page.click('#b'); await page.click('#b'); return '${tab}';`, { tab, timeout: 8000 })));
        assert.deepEqual(runs.map(r => r.success ? r.result : r.error), ['w1', 'w2', 'w3']);
        await closeAllAgentTabs();
    });
});

// ── T6: isolated tabs ───────────────────────────────────────────────────────

describe('T6 isolated tabs', () => {
    test('an isolated tab has its own cookies', async () => {
        await exec(`await page.goto(${J(FIX + '/cookie')}); return 1`);
        const iso = await srv.post('/tabs', { name: 'iso', isolated: true });
        assert.equal(iso.status, 201, J(iso.body));
        assert.equal(iso.body.isolated, true);
        const r = await exec(`await page.goto(${J(FIX + '/plain')});
            await page.evaluate(() => { document.cookie = 'isoonly=1; path=/'; });
            return page.evaluate(() => document.cookie);`, { tab: 'iso' });
        assert.equal(r.result, 'isoonly=1', 'no cookies from main');
        const main = await exec(`await page.goto(${J(FIX + '/plain')}); return page.evaluate(() => document.cookie);`);
        assert.match(main.result, /sess=abc123/);
        assert.doesNotMatch(main.result, /isoonly/);
        await srv.del('/tabs/iso');
    });
});

// ── idle expiry and --tabs-as tabs (separate small server) ──────────────────

describe('expiry and tabs mode', () => {
    test('idle agent tabs expire; main never does; --tabs-as tabs shares a window', async () => {
        const s = await startServer({ pool: false, args: ['--tab-idle-ttl', '2000', '--tabs-as', 'tabs'] });
        try {
            const windowId = `const c = await browser.target().createCDPSession();
                const { windowId } = await c.send('Browser.getWindowForTarget', { targetId: page.target()._targetId });
                return windowId;`;
            const a = await s.exec(windowId, { tab: 'a' });
            const b = await s.exec(windowId, { tab: 'b' });
            assert.equal(a.result, b.result, 'tabs mode: same window');
            await sleep(3500);
            const names = (await s.get('/tabs')).body.map(t => t.name);
            assert.deepEqual(names, ['main']);
            assert.match(s.logText(), /tab closed.*tab=a.*reason="idle expiry"|tab closed.*tab=a .*idle expiry/);
        } finally {
            await s.stop();
            s.cleanup();
        }
    });
});

// ── T4: persistence (runs last; restarts the server) ────────────────────────

describe('T4 persistence', () => {
    const pages = 'return (await browser.pages()).length';

    test('a dropped connection keeps every named tab', async () => {
        await exec(`await page.goto(${J(FIX + '/cookie?crm=1')}); return 1`, { tab: 'crm' });
        await exec(`await page.goto(${J(FIX + '/plain?erp=1')}); return 1`, { tab: 'erp' });
        const reg = JSON.parse(fs.readFileSync(path.join(srv.tmp, 'profile', 'puppeteer-server-tabs.json'), 'utf8'));
        assert.deepEqual(Object.keys(reg.tabs).sort(), ['crm', 'erp', 'main']);
        await srv.post('/__test/drop-connection');
        await sleep(700);
        const r = await exec('return page.url()', { tab: 'crm' });
        assert.equal(r.reconnected.ok, true, J(r));
        assert.equal(r.result, FIX + '/cookie?crm=1');
        assert.equal(r.tabCreated, undefined);
        assert.equal((await exec('return page.url()', { tab: 'erp' })).result, FIX + '/plain?erp=1');
    });

    test('a restarted server re-adopts its named tabs without opening new ones', async () => {
        const before = (await exec(pages)).result;
        await srv.kill();
        srv2 = await startServer({ tmp: srv.tmp, port: srv.port, pool: false,
            args: ['--max-tabs', '3'], env: { PUPPETEER_SERVER_TEST_HOOKS: '1' } });
        const r = await srv2.exec('return page.url()', { tab: 'crm' });
        assert.equal(r.success, true, J(r));
        assert.equal(r.result, FIX + '/cookie?crm=1');
        assert.equal(r.tabCreated, undefined, 'adopted, not created');
        assert.equal((await srv2.exec('return page.url()', { tab: 'erp' })).result, FIX + '/plain?erp=1');
        assert.equal((await srv2.exec(pages)).result, before, 'no extra Chrome tabs');
        assert.match(srv2.logText(), /re-adopted tabs after attach.*adopted=/);
    });

    test('when Chrome dies the registry is reset and the old tabs are reported lost', async () => {
        const pid = Number(require('node:child_process')
            .execFileSync('pgrep', ['-f', '--', `--user-data-dir=${path.join(srv.tmp, 'profile')}`], { encoding: 'utf8' })
            .split('\n').filter(Boolean)
            .find(p => {
                const cmd = require('node:child_process').execFileSync('ps', ['-o', 'command=', '-p', p], { encoding: 'utf8' });
                return !/--type=/.test(cmd);
            }));
        process.kill(pid, 'SIGKILL');
        await sleep(1000);
        const r = await srv2.exec('return 1');
        assert.ok(r.browserRestarted, J(r));
        const tabs = (await srv2.get('/tabs')).body;
        const crm = tabs.find(t => t.name === 'crm');
        assert.equal(crm.lost, true);
        assert.equal(crm.reason, 'browser restarted');
        const again = await srv2.exec('return page.url()', { tab: 'crm' });
        assert.equal(again.tabCreated, true);
    });
});
