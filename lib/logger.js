/**
 * Logger
 *
 * - Structured, timestamped lines: `[ISO] LEVEL [scope] message key=value ...`
 * - Per-request context via AsyncLocalStorage, so every line emitted while
 *   serving a request (executor, browser, tab pool) carries its `req=` id.
 * - File capture modelled on adri-agents dev-scripts (service_runner.sh):
 *   `<logDir>/puppeteer-server_<port>_<UTC ts>.log` plus a
 *   `puppeteer-server_<port>_latest.log` symlink. All stdout/stderr output is
 *   tee'd into the file (including console.* from anywhere and the startup
 *   banner); output produced before the file is opened is buffered and flushed.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');

const SERVICE = 'puppeteer-server';
const DEFAULT_LOG_DIR = path.resolve(__dirname, '..', 'logs');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const als = new AsyncLocalStorage();
let minLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

// ─── stdout/stderr tee ─────────────────────────────────────────────────────

let fileStream = null;
let logFilePath = null;
let pending = [];          // chunks written before the file was opened
const PENDING_LIMIT = 5000;
let teeInstalled = false;

function installTee() {
    if (teeInstalled) return;
    teeInstalled = true;
    for (const stream of [process.stdout, process.stderr]) {
        const orig = stream.write.bind(stream);
        stream.write = (chunk, encoding, cb) => {
            try {
                if (fileStream) {
                    fileStream.write(chunk, typeof encoding === 'string' ? encoding : undefined);
                } else if (pending.length < PENDING_LIMIT) {
                    pending.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : String(chunk));
                }
            } catch { /* never let logging break the process */ }
            return orig(chunk, encoding, cb);
        };
    }
}

/**
 * Open the log file for this instance and flush buffered output into it.
 * @returns {string} absolute path of the log file
 */
function openLogFile({ dir = DEFAULT_LOG_DIR, port } = {}) {
    installTee();
    dir = path.resolve(dir);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const stem = port ? `${SERVICE}_${port}` : SERVICE;
    logFilePath = path.join(dir, `${stem}_${ts}.log`);
    fileStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    for (const chunk of pending) fileStream.write(chunk);
    pending = [];

    const latest = path.join(dir, `${stem}_latest.log`);
    try {
        try { fs.unlinkSync(latest); } catch { /* not there */ }
        fs.symlinkSync(logFilePath, latest);
    } catch (err) {
        logger.warn('logger', 'could not update latest symlink', { latest, error: err.message });
    }
    return logFilePath;
}

function getLogFilePath() {
    return logFilePath;
}

// ─── formatting ────────────────────────────────────────────────────────────

function fmtValue(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (v instanceof Error) v = v.message;
    if (typeof v === 'string') {
        return /^[^\s"=]+$/.test(v) && v.length > 0 ? v : JSON.stringify(v);
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return util.inspect(v, { depth: 2, breakLength: Infinity }); }
}

function write(level, scope, msg, fields = {}) {
    if (LEVELS[level] < minLevel) return;
    const ctx = als.getStore();
    const all = ctx && ctx.reqId && fields.req === undefined ? { req: ctx.reqId, ...fields } : fields;
    let stack = null;
    const parts = [];
    for (const [k, v] of Object.entries(all)) {
        if (v === undefined) continue;
        if (k === 'stack') { stack = v; continue; }
        parts.push(`${k}=${fmtValue(v)}`);
    }
    let line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    if (parts.length) line += ' ' + parts.join(' ');
    if (stack) line += '\n    ' + String(stack).split('\n').slice(1, 8).map(s => s.trim()).join('\n    ');
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

const logger = {
    debug: (scope, msg, fields) => write('debug', scope, msg, fields),
    info: (scope, msg, fields) => write('info', scope, msg, fields),
    warn: (scope, msg, fields) => write('warn', scope, msg, fields),
    error: (scope, msg, fields) => write('error', scope, msg, fields),
    setLevel(level) {
        if (LEVELS[level]) minLevel = LEVELS[level];
    },
    /** Run `fn` with request context (reqId etc.) visible to all nested logs. */
    withContext(ctx, fn) {
        return als.run(ctx, fn);
    },
    context() {
        return als.getStore() || null;
    },
    openLogFile,
    getLogFilePath,
    installTee
};

/** One-line, length-capped preview of user code / payloads for logs. */
function preview(text, max = 300) {
    if (text == null) return text;
    const s = String(text).replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

/** Approximate serialized size of a value, in bytes. */
function sizeOf(value) {
    if (value == null) return 0;
    if (Buffer.isBuffer(value)) return value.length;
    if (typeof value === 'string') return Buffer.byteLength(value);
    try { return Buffer.byteLength(JSON.stringify(value)); } catch { return -1; }
}

module.exports = logger;
module.exports.preview = preview;
module.exports.sizeOf = sizeOf;
module.exports.DEFAULT_LOG_DIR = DEFAULT_LOG_DIR;
