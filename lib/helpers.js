/**
 * `helpers` object given to executed snippets.
 *
 * `page` is the run's abortable page proxy: sleeps and polls stop when the run
 * aborts. Also provides file transfer: `helpers.files` (uploads sent with the
 * request) and `helpers.download()`.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { ArtifactStore } = require('./artifacts');
const { rootConnection, browserSend } = require('./cdp');

const DEFAULT_DOWNLOAD_INLINE_MAX = 5 * 1024 * 1024;

// Browser.setDownloadBehavior is browser-wide: serialize downloads.
let downloadLock = Promise.resolve();

function safeName(name) {
    const base = path.basename(String(name || 'download')).replace(/[^\w.\- ()]/g, '_');
    return base || 'download';
}

function createHelpers(page, scope, { rawBrowser, files = {}, artifacts } = {}) {
    const sleep = (ms) => new Promise((resolve, reject) => {
        if (scope.aborted) return reject(scope.signal.reason);
        const t = setTimeout(() => { scope.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(t); reject(scope.signal.reason); };
        scope.signal.addEventListener('abort', onAbort, { once: true });
    });

    /**
     * Run `trigger` (e.g. `() => page.click('#export')`) and wait for the
     * download it starts. Returns { filename, bytes, path, data? } where `data`
     * is base64 when the file is at most `inlineMaxBytes`; larger files are
     * registered as artifacts (`artifact` = GET /artifacts/:id).
     */
    async function download(trigger, { timeout = 60000, inlineMaxBytes = DEFAULT_DOWNLOAD_INLINE_MAX } = {}) {
        scope.check();
        if (typeof trigger !== 'function') throw new Error('helpers.download(trigger): trigger must be a function');
        const release = await new Promise(resolve => {
            const prev = downloadLock;
            let done;
            downloadLock = new Promise(r => { done = r; });
            prev.then(() => resolve(done));
        });
        const dir = path.join(artifacts.dir(), 'downloads', `run-${scope.run}-${Date.now()}`);
        fs.mkdirSync(dir, { recursive: true });
        const conn = await rootConnection(rawBrowser);
        let begin = null;
        const onBegin = e => { if (!begin) begin = e; };
        let onProgress;
        try {
            const finished = new Promise((resolve, reject) => {
                onProgress = e => {
                    if (!begin || e.guid !== begin.guid) return;
                    if (e.state === 'completed') resolve(e);
                    else if (e.state === 'canceled') reject(new Error(`download canceled: ${begin.suggestedFilename}`));
                };
            });
            conn.on('Browser.downloadWillBegin', onBegin);
            conn.on('Browser.downloadProgress', onProgress);
            await conn.send('Browser.setDownloadBehavior', {
                behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true
            });
            await trigger();
            let timer;
            const onAbort = () => {};
            await Promise.race([
                finished,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(
                        begin ? `download did not finish within ${timeout}ms` : `no download started within ${timeout}ms`)),
                    timeout);
                }),
                new Promise((_, reject) => {
                    if (scope.aborted) return reject(scope.signal.reason);
                    scope.signal.addEventListener('abort', () => reject(scope.signal.reason), { once: true });
                })
            ]).finally(() => { clearTimeout(timer); scope.signal.removeEventListener('abort', onAbort); });

            const filename = begin.suggestedFilename || 'download';
            const finalPath = path.join(dir, safeName(filename));
            fs.renameSync(path.join(dir, begin.guid), finalPath);
            const bytes = fs.statSync(finalPath).size;
            log.info('exec', 'download finished', { run: scope.run, filename, bytes, path: finalPath });
            const out = { filename, bytes, url: begin.url, path: finalPath };
            if (bytes <= inlineMaxBytes) {
                out.data = fs.readFileSync(finalPath).toString('base64');
            } else {
                out.artifact = ArtifactStore.ref(artifacts.registerFile(finalPath, { name: filename, run: scope.run }));
            }
            return out;
        } finally {
            conn.off('Browser.downloadWillBegin', onBegin);
            if (onProgress) conn.off('Browser.downloadProgress', onProgress);
            await conn.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
            release();
        }
    }

    return {
        // Aborted when the run times out or is cancelled.
        signal: scope.signal,

        // Throws if the run has been aborted: call it in long loops.
        checkAborted: () => scope.check(),

        // Local paths of files sent with the request (`files`), for uploadFile().
        files,

        download,

        // Browser-level CDP command (Target.*, Browser.*, ...) without opening
        // a session on browser.target() (detaching one breaks Puppeteer 21).
        cdp: (method, params) => { scope.check(); return browserSend(rawBrowser, method, params); },

        // Wait for a specified time (rejects if the run is aborted)
        wait: sleep,

        // Smart wait: polls until condition is true or maxWait reached
        waitUntil: async (conditionFn, maxWaitMs = 8000, pollIntervalMs = 500) => {
            const startTime = Date.now();
            while (Date.now() - startTime < maxWaitMs) {
                try {
                    const ready = await conditionFn();
                    if (ready) return true;
                } catch {
                    // Condition threw, keep waiting (unless the run was aborted)
                    scope.check();
                }
                await sleep(pollIntervalMs);
            }
            return false;
        },

        // Wait for page content to be ready (smart wait with early exit)
        waitForContent: async (options = {}) => {
            const {
                maxWaitMs = 8000,
                pollIntervalMs = 500,
                minContentLength = 2000,
                noLoadingText = true
            } = options;

            const startTime = Date.now();
            while (Date.now() - startTime < maxWaitMs) {
                const ready = await page.evaluate((minLen, checkLoading) => {
                    const text = document.body?.innerText || '';
                    const hasEnoughContent = text.length > minLen;
                    const isLoading = checkLoading && text.includes('Loading') && text.length < 5000;
                    return hasEnoughContent && !isLoading;
                }, minContentLength, noLoadingText);

                if (ready) return true;
                await sleep(pollIntervalMs);
            }
            return false;
        },

        // Safe text extraction
        getText: async (selector) => {
            try {
                const element = await page.$(selector);
                if (!element) return null;
                return page.evaluate(el => el.textContent, element);
            } catch {
                scope.check();
                return null;
            }
        },

        // Safe attribute extraction
        getAttr: async (selector, attr) => {
            try {
                const element = await page.$(selector);
                if (!element) return null;
                return page.evaluate((el, a) => el.getAttribute(a), element, attr);
            } catch {
                scope.check();
                return null;
            }
        },

        // Extract all matching elements' text
        getAllText: async (selector) => page.$$eval(selector, els => els.map(el => el.textContent)),

        // Check if element exists
        exists: async (selector) => (await page.$(selector)) !== null,

        // Wait for selector with custom timeout
        waitFor: async (selector, timeout = 10000) => {
            try {
                await page.waitForSelector(selector, { timeout });
                return true;
            } catch {
                scope.check();
                return false;
            }
        },

        // Get current URL
        getUrl: () => page.url(),

        // Get page title
        getTitle: async () => page.title(),

        // Extract JSON from page (useful for API responses)
        getJson: async () => {
            const content = await page.evaluate(() => document.body.innerText);
            try {
                return JSON.parse(content);
            } catch {
                scope.check();
                return null;
            }
        },

        // Take screenshot and return as base64
        screenshot: async (options = {}) => page.screenshot({ encoding: 'base64', ...options })
    };
}

module.exports = { createHelpers };
