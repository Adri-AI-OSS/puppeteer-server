#!/usr/bin/env node

/**
 * Puppeteer Server CLI
 *
 * Launches a browser for authentication and starts an HTTP server
 * that accepts code execution requests.
 *
 * Usage:
 *   node index.js [options]
 *
 * Options:
 *   --port, -p       Server port (default: 3000)
 *   --url, -u        Initial URL to open (default: none)
 *   --headless       Run in headless mode (default: false)
 *   --profile, -d    Chrome profile directory (default: .chrome-profile)
 *   --pool           Enable tab pool for concurrent execution
 *   --max-tabs       Maximum tabs in pool (default: 10)
 *   --log-dir        Directory for log files (default: <repo>/logs)
 *   --log-level      debug | info | warn | error (default: info)
 *   --token          Require `Authorization: Bearer <token>` (or $PUPPETEER_SERVER_TOKEN)
 *   --login-url-pattern  Regex: a run ending on a matching URL => sessionExpired
 *   --max-queue, --max-timeout, --result-max-bytes, --job-ttl-ms, --acquire-timeout
 *
 * Examples:
 *   node index.js
 *   node index.js --port 8080 --url https://api.sap.com
 *   node index.js --pool --max-tabs 5
 */

const readline = require('readline');
const net = require('net');
const path = require('path');
const BrowserManager = require('./lib/browser');
const CodeExecutor = require('./lib/executor');
const TabPoolManager = require('./lib/tab-pool');
const Server = require('./lib/server');
const log = require('./lib/logger');

// Tee stdout/stderr from the very first line; it's flushed into the log file
// once the port (and so the file name) is known.
log.installTee();

// Parse command line arguments
function parseArgs(args) {
    const options = {
        port: 3000,
        portExplicit: false,  // true once --port/-p or a positional port is given
        url: null,
        headless: false,
        // `null` => not set on the CLI; main() derives a per-port default so
        // concurrent instances don't collide on Chrome's profile lock.
        profileDir: null,
        enablePool: false,
        maxTabs: 10,
        noPrompt: false,  // Skip "Press ENTER" prompt for autonomous operation
        logDir: process.env.PUPPETEER_SERVER_LOG_DIR || log.DEFAULT_LOG_DIR,
        logLevel: process.env.LOG_LEVEL || 'info',
        token: process.env.PUPPETEER_SERVER_TOKEN || null,
        loginUrlPattern: process.env.PUPPETEER_SERVER_LOGIN_URL_PATTERN || null,
        maxQueue: undefined,
        maxTimeoutMs: undefined,
        resultMaxBytes: undefined,
        jobTtlMs: undefined,
        acquireTimeoutMs: undefined
    };
    const num = (v, flag) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
            console.error(`${flag} expects a positive number, got: ${v}`);
            process.exit(2);
        }
        return n;
    };

    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        switch (arg) {
            case '--port':
            case '-p':
                options.port = parseInt(next) || 3000;
                options.portExplicit = true;
                i++;
                break;
            case '--url':
            case '-u':
                options.url = next;
                i++;
                break;
            case '--headless':
                options.headless = true;
                break;
            case '--profile':
            case '-d':
                options.profileDir = next;
                i++;
                break;
            case '--pool':
                options.enablePool = true;
                break;
            case '--max-tabs':
                options.maxTabs = parseInt(next) || 10;
                i++;
                break;
            case '--no-prompt':
                options.noPrompt = true;
                break;
            case '--log-dir':
                options.logDir = next;
                i++;
                break;
            case '--log-level':
                options.logLevel = next;
                i++;
                break;
            case '--token':
                options.token = next;
                i++;
                break;
            case '--login-url-pattern':
                options.loginUrlPattern = next;
                i++;
                break;
            case '--max-queue':
                options.maxQueue = num(next, arg);
                i++;
                break;
            case '--max-timeout':
                options.maxTimeoutMs = num(next, arg);
                i++;
                break;
            case '--result-max-bytes':
                options.resultMaxBytes = num(next, arg);
                i++;
                break;
            case '--job-ttl-ms':
                options.jobTtlMs = num(next, arg);
                i++;
                break;
            case '--acquire-timeout':
                options.acquireTimeoutMs = num(next, arg);
                i++;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
            default:
                // Collect positional arguments
                if (!arg.startsWith('-')) {
                    positional.push(arg);
                }
        }
    }

    // Handle positional arguments: [port] [url]
    // Support: node index.js 8080 https://example.com
    for (const arg of positional) {
        if (/^\d+$/.test(arg)) {
            options.port = parseInt(arg);
            options.portExplicit = true;
        } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
            options.url = arg;
        }
    }

    return options;
}

function printHelp() {
    console.log(`
Puppeteer Server - HTTP server for executing Puppeteer code

Usage:
  node index.js [options]

Options:
  --port, -p <port>      Server port. Omit to auto-pick a free port starting
                         at 3000 (lets you run several instances at once); set
                         it to bind that exact port (fails if it's taken).
  --url, -u <url>        Initial URL to open in browser
  --headless             Run browser in headless mode
  --profile, -d <dir>    Chrome profile directory. Defaults to a per-port dir
                         (.chrome-profile/inst-<port>) so concurrent instances
                         don't share a profile; a login persists per port.
  --pool                 Enable tab pool for concurrent execution
  --max-tabs <n>         Maximum tabs in pool (default: 10)
  --no-prompt            Skip "Press ENTER" prompt (for autonomous/CI use)
  --log-dir <dir>        Log directory (default: <repo>/logs, or
                         $PUPPETEER_SERVER_LOG_DIR). Each run writes
                         puppeteer-server_<port>_<UTC ts>.log and updates the
                         puppeteer-server_<port>_latest.log symlink.
  --log-level <level>    debug | info | warn | error (default: info, or $LOG_LEVEL)
  --token <token>        Require "Authorization: Bearer <token>" on every request
                         except GET /health (or $PUPPETEER_SERVER_TOKEN)
  --login-url-pattern <regex>
                         A run that ends on a matching URL is reported as
                         sessionExpired: true (login needs redoing)
  --max-queue <n>        Sequential queue length before 429 (default: 50)
  --max-timeout <ms>     Cap on a request's timeout (default: 600000)
  --result-max-bytes <n> Results larger than this are written to an artifact
                         (GET /artifacts/:id) (default: 5242880)
  --job-ttl-ms <ms>      Keep finished async jobs this long (default: 600000)
  --acquire-timeout <ms> Pool: wait this long for a free tab (default: 30000)
  --help, -h             Show this help message

Examples:
  node index.js
  node index.js --port 8080 --url https://api.sap.com
  node index.js --pool --max-tabs 5

API Endpoints (Legacy - Sequential):
  POST /execute          Execute code and return full result
  POST /run              Execute code and return raw result
  POST /goto             Navigate to URL
  GET  /page             Get current page URL and title
  GET  /content          Get page HTML content
  GET  /screenshot       Take screenshot (PNG)
  GET  /cookies          Get page cookies
  GET  /status           Get queue status
  POST /clear-queue      Clear pending executions and abort the running one
  POST /reconnect        Re-attach to the running Chrome
  POST /ready            Mark the session ready (instead of pressing ENTER)
  GET  /runs[/:id]       Recent runs / one run's code, status, logs, dialogs
  GET  /jobs/:id         Async job status (start with "async": true)
  POST /jobs/:id/cancel  Cancel an async job
  POST /watch            Watch page events across calls (GET/DELETE /watch/:id)
  GET  /artifacts/:id    Large results and downloads
  POST /shutdown         Shutdown server and browser
  GET  /health           Health check

API Endpoints (Pool - Concurrent):
  POST /pool/execute             Execute with auto tab management
  POST /pool/acquire             Acquire a tab manually
  POST /pool/release/:tabId      Release a tab back to pool
  POST /pool/tab/:tabId/execute  Execute on specific tab
  DELETE /pool/tab/:tabId        Close a specific tab
  GET  /pool/status              Get pool status
  GET  /pool/tabs                Get all tabs info
  POST /pool/close-all           Close all tabs
  POST /pool/prune               Prune idle tabs

Example curl commands:
  # Legacy (sequential)
  curl -X POST http://localhost:3000/run \\
    -H "Content-Type: application/json" \\
    -d '{"code": "return await page.title()"}'

  # Pool (concurrent)
  curl -X POST http://localhost:3000/pool/execute \\
    -H "Content-Type: application/json" \\
    -d '{"code": "await page.goto(\\"https://example.com\\"); return page.url();"}'
`);
}

/**
 * Find the first free TCP port at or after `startPort`.
 * Lets the ▶ button be pressed N times without manual --port juggling:
 * the second instance transparently rolls to the next open port.
 */
function findFreePort(startPort, host = 'localhost', maxTries = 100) {
    return new Promise((resolve, reject) => {
        let port = startPort;
        const tryPort = () => {
            if (port - startPort >= maxTries) {
                reject(new Error(`No free port found in range ${startPort}-${startPort + maxTries}`));
                return;
            }
            const tester = net.createServer();
            tester.once('error', err => {
                tester.close();
                if (err.code === 'EADDRINUSE') {
                    port++;
                    tryPort();
                } else {
                    reject(err);
                }
            });
            tester.once('listening', () => {
                tester.close(() => resolve(port));
            });
            tester.listen(port, host);
        };
        tryPort();
    });
}

function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        rl.close();
    };
    const answer = new Promise(resolve => {
        rl.question(question, a => {
            close();
            resolve(a);
        });
        // stdin ended (e.g. not a TTY): wait for POST /ready instead.
        rl.on('close', () => { if (!closed) closed = true; });
    });
    return { answer, close };
}

/**
 * Process-level diagnostics: crashes, signals, exit, and wall-clock jumps
 * (system sleep / event-loop stalls), which otherwise leave no trace.
 */
function installProcessLogging() {
    process.on('uncaughtException', err => {
        log.error('process', 'uncaughtException', { error: err.message, stack: err.stack });
    });
    process.on('unhandledRejection', reason => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        log.error('process', 'unhandledRejection', { error: err.message, stack: err.stack });
    });
    process.on('warning', w => log.warn('process', 'node warning', { name: w.name, warning: w.message }));
    process.on('exit', code => log.info('process', 'exit', { code, uptimeSec: Math.round(process.uptime()) }));

    const TICK_MS = 15000;
    let last = Date.now();
    setInterval(() => {
        const now = Date.now();
        const gap = now - last - TICK_MS;
        if (gap > 30000) {
            log.warn('process', 'clock jumped — system sleep or event-loop stall', {
                gapSec: Math.round(gap / 1000),
                from: new Date(last).toISOString()
            });
        }
        last = now;
    }, TICK_MS).unref();
}

async function main() {
    const args = process.argv.slice(2);
    const options = parseArgs(args);
    log.setLevel(options.logLevel);
    installProcessLogging();

    console.log('='.repeat(60));
    console.log('  Puppeteer Server');
    console.log('='.repeat(60));
    console.log();

    // Two port modes:
    //   - explicit (--port / positional): honor it exactly, fail if taken.
    //   - default: auto-pick a free port so the ▶ button works N times.
    // Either way the bind in server.start() is the authoritative reservation —
    // a probe alone can race a sibling across the slow Chrome-launch window.
    const requestedPort = options.port;
    const profileExplicit = options.profileDir != null;
    if (!options.portExplicit) {
        options.port = await findFreePort(requestedPort);
    }

    // Initialize components. The Chrome profile dir is deliberately derived
    // AFTER the port is bound (below), so two instances that probed the same
    // free port still end up on distinct ports AND distinct profiles.
    console.log('Initializing browser manager...');
    const browserManager = new BrowserManager({
        headless: options.headless,
        profileDir: options.profileDir  // null unless --profile given; set post-bind
    });

    // Initialize tab pool if enabled
    let tabPoolManager = null;
    if (options.enablePool) {
        console.log(`Initializing tab pool (max ${options.maxTabs} tabs)...`);
        tabPoolManager = new TabPoolManager(browserManager, {
            maxTabs: options.maxTabs,
            acquireTimeoutMs: options.acquireTimeoutMs
        });
    }

    const executor = new CodeExecutor(browserManager, tabPoolManager, {
        maxQueue: options.maxQueue,
        maxTimeoutMs: options.maxTimeoutMs,
        resultMaxBytes: options.resultMaxBytes,
        loginUrlPattern: options.loginUrlPattern
    });
    const server = new Server(executor, browserManager, {
        port: options.port,
        tabPoolManager,
        token: options.token,
        jobTtlMs: options.jobTtlMs
    });

    // Reserve the port FIRST — app.listen is the only race-free reservation.
    // The browser and its per-port profile come after, so concurrent launches
    // can't collide on either the port or Chrome's SingletonLock. Only auto-bump
    // when the port wasn't explicitly requested.
    try {
        await server.start({ autoBump: !options.portExplicit });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            console.error(`\nPort ${requestedPort} is already in use. ` +
                `Pass a different --port, or omit --port to auto-pick a free one.`);
            process.exit(1);
        }
        throw err;
    }
    options.port = server.options.port;  // authoritative bound port
    const logFile = log.openLogFile({ dir: options.logDir, port: options.port });
    log.info('server', 'starting', {
        pid: process.pid, node: process.version, port: options.port,
        cwd: process.cwd(), args: process.argv.slice(2).join(' ')
    });
    console.log(`Log file: ${logFile}`);
    console.log(`Executions (full code): ${log.getExecFilePath()}`);
    if (options.port !== requestedPort) {
        console.log(`Port ${requestedPort} unavailable — bound ${options.port} instead.`);
    }

    // Per-port profile dir when --profile wasn't given: unique per instance so
    // concurrent instances don't fight over Chrome's SingletonLock, yet stable
    // across restarts on the same port so a login persists for that instance.
    if (!profileExplicit) {
        browserManager.options.profileDir = path.join('.chrome-profile', `inst-${options.port}`);
    }
    console.log(`Chrome profile: ${browserManager.options.profileDir}`);

    // Launch browser
    console.log('Launching browser...');
    try {
        await browserManager.launch();
    } catch (err) {
        log.error('server', 'could not start browser', { error: err.message, stack: err.stack });
        throw err;
    }

    // Navigate to initial URL if provided
    const page = await browserManager.getPage('main');
    if (options.url) {
        log.info('server', 'navigating to initial URL', { url: options.url });
        try {
            await page.goto(options.url, { waitUntil: 'networkidle2', timeout: 60000 });
        } catch (err) {
            // A slow SSO page shouldn't take the whole server down.
            log.warn('server', 'initial navigation did not settle', { url: options.url, error: err.message });
        }
    }

    // Wait for user to login (unless --no-prompt is set). The HTTP port is
    // already bound; this just gates the "ready" banner below so the caller
    // waits for an authenticated session before driving the browser.
    if (!options.noPrompt) {
        console.log();
        console.log('-'.repeat(60));
        console.log('Browser is open. Please log in if authentication is required.');
        console.log(`(Or, from another process: POST http://localhost:${options.port}/ready)`);
        console.log('-'.repeat(60));
        const question = askQuestion('Press ENTER when the session is ready...');
        const source = await Promise.race([
            question.answer.then(() => 'terminal (ENTER)'),
            server.whenReady()
        ]);
        question.close();
        server.markReady(source);
    } else {
        console.log();
        console.log('--no-prompt mode: session ready immediately...');
        server.markReady('--no-prompt');
    }

    console.log();
    console.log('='.repeat(60));
    console.log('  Server is running!');
    console.log('='.repeat(60));
    console.log();
    console.log('Legacy Endpoints (Sequential):');
    console.log(`  POST http://localhost:${options.port}/execute  - Execute code (full response)`);
    console.log(`  POST http://localhost:${options.port}/run      - Execute code (raw result)`);
    console.log(`  POST http://localhost:${options.port}/goto     - Navigate to URL`);
    console.log(`  GET  http://localhost:${options.port}/page     - Get current page info`);

    if (options.enablePool) {
        console.log();
        console.log('Pool Endpoints (Concurrent):');
        console.log(`  POST http://localhost:${options.port}/pool/execute     - Execute with auto tab`);
        console.log(`  POST http://localhost:${options.port}/pool/acquire     - Acquire a tab`);
        console.log(`  POST http://localhost:${options.port}/pool/release/:id - Release a tab`);
        console.log(`  GET  http://localhost:${options.port}/pool/status      - Pool status`);
    }

    console.log();
    console.log('Example:');
    console.log(`  curl -X POST http://localhost:${options.port}/run \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"code": "return await page.title()"}'`);
    console.log();
    console.log('Press Ctrl+C to stop the server');
    console.log(`Logs: ${logFile}`);
    console.log(`Executions (full code): ${log.getExecFilePath()}`);
    console.log();
    log.info('server', 'ready', { port: options.port, pool: options.enablePool });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        log.warn('process', 'SIGINT received; shutting down');
        await server.stop();
    });

    process.on('SIGTERM', async () => {
        log.warn('process', 'SIGTERM received; shutting down');
        await server.stop();
    });
}

main().catch(err => {
    log.error('process', 'fatal error', { error: err.message, stack: err.stack });
    process.exit(1);
});
