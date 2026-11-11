'use strict';
/**
 * store.js - JSON files that survive a crash or a power cut: settings, records, saved runs
 * (RT-06, AA-PERSIST-NONATOMIC).
 *
 *   const store = require('./kit/store');
 *   const runs = store.load(file, { log, fallback: { runs: [] }, valid: (v) => !!v && Array.isArray(v.runs) });
 *   store.save(file, runs, { log });        // true once it is on disk
 *
 * save() / write() put the data in a temporary file next to the target, flush it to disk and rename
 * it over the target, so the file is always the old or the new version - never half written.
 * load() moves a file that doesn't parse, or that opts.valid rejects, aside as <file>.corrupt-1
 * (earlier ones become -2 and -3; the newest three are kept) and logs it, instead of starting over
 * silently and overwriting it with the next save. A temporary file left by a crash between write and
 * rename is removed (and logged): the target still holds the last complete version.
 * read() is load() telling what happened: { value, state: 'ok' | 'missing' | 'quarantined' |
 * 'unreadable', aside, reason }. Failures are logged, never thrown. Node 8 compatible (head unit).
 */
const fs = require('fs');
const path = require('path');

const KEEP_ASIDE = 3;
const warn = (log, msg) => { if (log && log.warn) log.warn(msg); };
// If recovery could not preserve the original, defaults must not overwrite it.
// A successful read (or a confirmed missing file) permits saving again.
const blockedWrites = new Set();

/** Best effort: make the rename itself durable (not possible everywhere, e.g. on Windows). */
function syncDir(dir) {
    let fd = null;
    try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { /* the rename is atomic all the same */ }
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* nothing to do */ } }
}

/** Write text to file atomically. Returns true when it is there, false (logged) when not. */
function write(file, text, opts) {
    const log = opts && opts.log, tmp = file + '.tmp';
    if (blockedWrites.has(path.resolve(file))) {
        warn(log, 'save ' + path.basename(file) + ': original could not be read or preserved; read it successfully before saving');
        return false;
    }
    let fd = null;
    try {
        const buf = Buffer.from(String(text), 'utf8');
        fd = fs.openSync(tmp, 'w');
        for (let off = 0; off < buf.length;) {
            const n = fs.writeSync(fd, buf, off, buf.length - off);
            if (!(n > 0)) throw new Error('write made no progress');
            off += n;
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, file);
    } catch (e) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* failing already */ } }
        try { fs.unlinkSync(tmp); } catch (e2) { /* not there */ }
        warn(log, 'save ' + path.basename(file) + ': ' + e);
        return false;
    }
    syncDir(path.dirname(file));
    return true;
}

/** JSON.stringify(value, null, opts.indent) written atomically. */
function save(file, value, opts) {
    let text;
    try { text = JSON.stringify(value, null, opts && opts.indent); } catch (e) { text = undefined; }
    if (text === undefined) { warn(opts && opts.log, 'save ' + path.basename(file) + ': value cannot be stored as JSON'); return false; }
    return write(file, text, opts);
}

/** Move a corrupt file aside as .corrupt-1, shifting older copies; returns the new name or null. */
function quarantine(file, log) {
    const aside = (n) => file + '.corrupt-' + n;
    try {
        try { fs.unlinkSync(aside(KEEP_ASIDE)); } catch (e) { /* fewer copies so far */ }
        for (let n = KEEP_ASIDE - 1; n >= 1; n--) { try { fs.renameSync(aside(n), aside(n + 1)); } catch (e) { /* no copy n */ } }
        fs.renameSync(file, aside(1));
        return aside(1);
    } catch (e) {
        warn(log, 'could not move ' + path.basename(file) + ' aside: ' + e);
        return null;
    }
}

function read(file, opts) {
    opts = opts || {};
    const log = opts.log, fallback = opts.fallback === undefined ? null : opts.fallback, tmp = file + '.tmp';
    if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch (e) { /* it is ignored anyway */ }
        warn(log, path.basename(file) + ': removed an unfinished save (a crash between write and rename); the last complete version is kept');
    }
    let text;
    const key = path.resolve(file);
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') { blockedWrites.delete(key); return { value: fallback, state: 'missing' }; }
        blockedWrites.add(key);
        warn(log, 'read ' + path.basename(file) + ': ' + e);
        return { value: fallback, state: 'unreadable', reason: String(e) };
    }
    let value, reason = null;
    try { value = JSON.parse(text); } catch (e) { reason = 'not valid JSON (' + e.message + ')'; }
    if (reason === null && opts.valid) {
        let ok = false;
        try { ok = !!opts.valid(value); } catch (e) { ok = false; }
        if (!ok) reason = 'not what it should contain';
    }
    if (reason === null) { blockedWrites.delete(key); return { value, state: 'ok' }; }
    const aside = quarantine(file, log);
    if (aside) blockedWrites.delete(key); else blockedWrites.add(key);
    warn(log, path.basename(file) + ' is ' + reason + ': ' + (aside ? 'moved aside as ' + path.basename(aside) : 'left in place') + ', starting from defaults');
    return { value: fallback, state: 'quarantined', aside, reason };
}

/** The stored value, or opts.fallback when there is none or it was corrupt (see read()). */
function load(file, opts) { return read(file, opts).value; }

module.exports = { load, read, save, write, KEEP_ASIDE };
