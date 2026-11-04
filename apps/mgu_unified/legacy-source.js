'use strict';
// Where the separate apps' settings for the one-time import come from.
//  1. data/legacy-import.json, if someone placed it there (kept for manual delivery);
//  2. otherwise the copy the PC installer built into this package (legacy_import_data.js), made from
//     the verified application backup of this car before installation.
// The packaged copy cannot be renamed like the file, so the decision ("applied"/"declined") is kept
// by its id in data/legacy-import.state.json and the same content is not offered again, also after a
// reinstall that carries identical settings. Nothing here changes settings: core.js decides and the
// caller backs up first.
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT = 256 * 1024, KEEP_DONE = 20;
const objectValue = v => !!v && typeof v === 'object' && !Array.isArray(v);

function LegacySource(dataDir, o) {
    const fs = o.fs || require('fs'), Store = o.Store, log = o.log;
    const file = path.join(dataDir, 'legacy-import.json'), stateFile = path.join(dataDir, 'legacy-import.state.json');
    let current = null;
    const state = () => Store.read(stateFile, { log, fallback: { schema: 1, done: [] }, valid: v => objectValue(v) && v.schema === 1 && Array.isArray(v.done) }).value;
    function bundledText() {
        const text = o.bundled ? o.bundled() : null;
        if (text === null || text === undefined) return null;
        if (typeof text !== 'string' || !text || text.length > MAX_TEXT) throw Error('packaged import data is invalid');
        return text;
    }
    return {
        read() {
            current = null;
            if (fs.existsSync(file)) {
                const r = Store.read(file, { log, fallback: null, valid: objectValue });
                if (r.state !== 'ok') throw Error('unreadable');
                current = { kind: 'file' };
                return r.value;
            }
            const text = bundledText();
            if (text === null) return null;
            const value = JSON.parse(text);
            if (!objectValue(value)) throw Error('packaged import data is invalid');
            const id = typeof value.id === 'string' && /^[a-f0-9]{64}$/.test(value.id) ? value.id : crypto.createHash('sha256').update(text).digest('hex');
            if (state().done.some(d => d && d.id === id)) return null;
            current = { kind: 'bundle', id, text };
            return value;
        },
        finish(kind) {
            if (!current) throw Error('nothing was offered');
            const archived = path.join(dataDir, 'legacy-import.' + kind + '-' + Date.now() + '.json');
            if (current.kind === 'file') { fs.renameSync(file, archived); current = null; return; }
            const s = state();
            s.done = s.done.filter(d => d && d.id !== current.id).concat([{ id: current.id, kind, at: Date.now() }]).slice(-KEEP_DONE);
            if (!Store.save(stateFile, s, { log })) throw Error('import decision not saved');
            // A copy of what was offered, for support; the decision above is what counts.
            try { fs.writeFileSync(archived, current.text); } catch (e) { if (log && log.warn) log.warn('legacy import copy: ' + e); }
            current = null;
        }
    };
}

module.exports = LegacySource;
