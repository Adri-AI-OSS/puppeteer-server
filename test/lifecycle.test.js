/**
 * Lifecycle integration tests (docs/PLAN-2026-11-09-next-features.md):
 *   #21 bearer token, #20 POST /ready, #1 auto-reconnect after a dropped CDP
 *   connection and re-attach after a server restart, #18 Chrome death.
 *
 * One Chrome profile is shared across the steps, so the tests run in order.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sleep, startFixture, startServer, chromePidsFor } = require('./support');
const path = require('node:path');

const TOKEN = 's3cret-token';
let fixture, FIX, srv, srv2;
const J = JSON.stringify;

before(async () => {
    fixture = await startFixture();
    FIX = fixture.url;
    srv = await startServer({
        prompt: true, pool: false, token: TOKEN,
        args: ['--token', TOKEN], env: { PUPPETEER_SERVER_TEST_HOOKS: '1' }
    });
});

after(async () => {
    for (const s of [srv2, srv]) if (s) await s.stop();
    if (srv) srv.cleanup();
    if (fixture) fixture.close();
});

describe('lifecycle', () => {
    test('#21 token: /health is open, everything else needs the bearer token', async () => {
        const health = await fetch(`${srv.base}/health`);
        assert.equal(health.status, 200);
        assert.equal((await health.json()).auth, 'token');
        const none = await fetch(`${srv.base}/status`);
        assert.equal(none.status, 401);
        const wrong = await fetch(`${srv.base}/execute`, {
            method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
            body: J({ code: 'return 1' })
        });
        assert.equal(wrong.status, 401);
        const alt = await fetch(`${srv.base}/status`, { headers: { 'x-auth-token': TOKEN } });
        assert.equal(alt.status, 200);
        assert.equal((await srv.get('/status')).status, 200);
    });

    test('#20 POST /ready marks the session ready without pressing ENTER', async () => {
        const before = (await srv.get('/health')).body;
        assert.equal(before.ready, false);
        assert.ok(!srv.output.includes('Server is running!'));
        const r = await srv.post('/ready');
        assert.equal(r.body.ready, true);
        assert.equal(r.body.readyInfo.source, 'POST /ready');
        await srv.waitForOutput('Server is running!', 10000);
        const after = (await srv.get('/health')).body;
        assert.equal(after.ready, true);
        assert.equal((await srv.post('/ready')).body.already, true);
        assert.equal((await srv.exec('return 1 + 1')).result, 2);
    });

    test('#1 a dropped CDP connection is repaired on the next request; session kept', async () => {
        const set = await srv.exec(`await page.goto(${J(FIX + '/cookie')}); return page.evaluate(() => document.cookie);`);
        assert.match(set.result, /sess=abc123/);
        const drop = await srv.post('/__test/drop-connection');
        assert.equal(drop.body.dropped, true);
        await sleep(700);    // disconnect handler runs
        assert.equal((await srv.get('/health')).body.browser, false);
        const r = await srv.exec('return { url: page.url(), cookie: await page.evaluate(() => document.cookie) }');
        assert.equal(r.success, true, J(r));
        assert.equal(r.result.url, FIX + '/cookie', 'same tab adopted');
        assert.match(r.result.cookie, /sess=abc123/, 'session cookie survived');
        assert.equal(r.reconnected.ok, true);
        assert.equal(r.browserRestarted, undefined);
        assert.match(srv.logText(), /CDP disconnected unexpectedly.*closeCode=1006/);
    });

    test('#18 Chrome death: next request relaunches and reports browserRestarted', async () => {
        const pid = (await srv.get('/health')).body.browserInfo.chromePid;
        assert.ok(pid, 'server launched Chrome itself');
        process.kill(pid, 'SIGKILL');
        await sleep(1000);
        const r = await srv.exec(`await page.goto(${J(FIX + '/plain')});
            return { cookie: await page.evaluate(() => document.cookie), title: await page.title() };`);
        assert.equal(r.success, true, J(r));
        assert.equal(r.result.title, 'plain');
        assert.ok(r.browserRestarted, J(r));
        assert.match(r.browserRestarted.note, /Session-only cookies/);
        assert.doesNotMatch(r.result.cookie, /sess=abc123/, 'session-only cookie is gone with the old Chrome');
        assert.notEqual((await srv.get('/health')).body.browserInfo.chromePid, pid);
    });

    test('#1 restarting the server re-attaches to the running Chrome', async () => {
        await srv.exec(`await page.goto(${J(FIX + '/cookie?restart=1')}); return 1`);
        const profile = path.join(srv.tmp, 'profile');
        const chromeBefore = chromePidsFor(profile);
        assert.ok(chromeBefore.length > 0);
        await srv.kill();                                   // like a crash: Chrome survives
        await sleep(500);
        assert.ok(chromePidsFor(profile).length > 0, 'Chrome survived the server');

        srv2 = await startServer({ tmp: srv.tmp, port: srv.port, token: TOKEN, pool: false,
            args: ['--token', TOKEN] });
        const r = await srv2.exec('return { url: page.url(), cookie: await page.evaluate(() => document.cookie) }');
        assert.equal(r.success, true, J(r));
        assert.equal(r.result.url, FIX + '/cookie?restart=1');
        assert.match(r.result.cookie, /sess=abc123/, 'session cookie kept across the server restart');
        assert.match(srv2.logText(), /re-attached to existing Chrome/);
        assert.deepEqual(chromePidsFor(profile).sort(), chromeBefore.sort(), 'no new Chrome launched');
    });
});
