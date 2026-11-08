/**
 * Artifact store: results and downloads too large to return inline are written
 * to `<log dir>/artifacts/` and served by `GET /artifacts/:id`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

const EXT = {
    'application/json': '.json', 'text/plain': '.txt', 'image/png': '.png', 'image/jpeg': '.jpg',
    'application/pdf': '.pdf', 'application/octet-stream': '.bin'
};

/** Guess a content type from leading bytes. */
function sniff(buf) {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 4 && buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
    return 'application/octet-stream';
}

class ArtifactStore {
    constructor({ dir = null } = {}) {
        this._dir = dir;
        this.items = new Map();   // id -> { id, path, contentType, bytes, name, createdAt, run }
    }

    dir() {
        if (!this._dir) {
            const execFile = log.getExecFilePath();
            const base = execFile ? path.dirname(execFile) : log.DEFAULT_LOG_DIR;
            this._dir = path.join(base, 'artifacts');
        }
        fs.mkdirSync(this._dir, { recursive: true });
        return this._dir;
    }

    newId() {
        return `a${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    }

    /** Write `data` (Buffer or string) as a new artifact. */
    store(data, { contentType, name, run } = {}) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        contentType = contentType || sniff(buf);
        const id = this.newId();
        const file = path.join(this.dir(), id + (EXT[contentType] || '.bin'));
        fs.writeFileSync(file, buf);
        return this._register({ id, path: file, contentType, bytes: buf.length, name, run });
    }

    /** Register an existing file (e.g. a finished download) without copying. */
    registerFile(file, { contentType, name, run } = {}) {
        const bytes = fs.statSync(file).size;
        if (!contentType) {
            const fd = fs.openSync(file, 'r');
            const head = Buffer.alloc(8);
            fs.readSync(fd, head, 0, 8, 0);
            fs.closeSync(fd);
            contentType = sniff(head);
        }
        return this._register({ id: this.newId(), path: file, contentType, bytes, name, run });
    }

    _register(item) {
        item.createdAt = Date.now();
        this.items.set(item.id, item);
        log.info('artifacts', 'stored', { id: item.id, bytes: item.bytes, contentType: item.contentType,
            run: item.run, path: item.path });
        return item;
    }

    get(id) {
        const item = this.items.get(id);
        if (!item || !fs.existsSync(item.path)) return null;
        return item;
    }

    /** The JSON stub returned in place of an inline value. */
    static ref(item) {
        return { $artifact: item.id, bytes: item.bytes, contentType: item.contentType, name: item.name,
            url: `/artifacts/${item.id}`, path: item.path };
    }
}

module.exports = { ArtifactStore, sniff };
