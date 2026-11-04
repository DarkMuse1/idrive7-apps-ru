'use strict';
// App-owned mailbox. Desktop uploads a bounded, expiring request over pinned SSH.
// No socket listener, shell commands, diagnostics, UID changes or ACL edits.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./comfort-controller');
const FILES = { report: 'ambient-report.json', request: 'ambient-request.json', intent: 'ambient-intent.json' };
function read(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('Invalid mailbox file');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function durable(file, value) {
    const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.new', data = Buffer.from(JSON.stringify(value));
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') {
        const parent = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
}
function create(directory, transport, options) {
    const file = name => path.join(directory, FILES[name]);
    const nonce = crypto.randomBytes(16).toString('hex');
    let raw = null, rawUtc = null;
    const controller = C.createController({
        get: async field => {
            const result = await transport.get(field);
            raw = JSON.parse(JSON.stringify(result)); rawUtc = Date.now(); return result;
        },
        guardedWrites: transport.guardedWrites === true,
        set: (field, value, lease) => transport.set(field, value, lease),
    }, Object.assign({ supportedProfiles: Array.from({length:12}, (_,i) => i+1) }, options || {}));
    let busy = false, sequence = 0;
    let last = null, writeBlocked = fs.existsSync(file('intent'));
    async function tick() {
        if (busy) return null;
        busy = true;
        try {
        let state = null, failure = null, claimed = null;
        try {
            state = await controller.read();
            if (fs.existsSync(file('request'))) {
                const request = read(file('request'));
                // Claim once, before validating/executing. No replay after a crash.
                fs.unlinkSync(file('request'));
                if (!/^[a-f0-9]{32}$/.test(request.id || '')) throw new Error('Invalid request ID');
                if (fs.existsSync(path.join(directory, 'ambient-result-' + request.id + '.json')))
                    throw new Error('Request already processed');
                const now = Date.now();
                if (request.schema !== 1 || request.nonce !== nonce || request.confirmed !== true ||
                    !Number.isSafeInteger(request.expires) || request.expires < now || request.expires > now + 30000)
                    throw new Error('Request is expired or belongs to another application session');
                claimed = request;
                writeBlocked = writeBlocked || fs.existsSync(file('intent'));
                if (writeBlocked) throw new Error('Previous lighting write is unresolved; no further writes');
                if (JSON.stringify(request.expected) !== JSON.stringify(state)) throw new Error('Lighting state changed since confirmation');
                // Reject invalid changes before creating an intent or calling the setter.
                const change = controller.validate(request.change);
                // Persist a fail-closed intent BEFORE the first possible write.
                writeBlocked = true;
                durable(file('intent'), { schema: 1, id: request.id, nonce, before: state, change, utc: now });
                try {
                    const result = await controller.apply(change);
                    last = { id: request.id, status: result.status, before: state, change: request.change, observed: result.observed };
                    state = result.observed;
                    // Receipt is durable before removing the intent.
                    durable(path.join(directory, 'ambient-result-' + request.id + '.json'), last);
                    if (result.status === 'confirmed' || result.status === 'unchanged') {
                        fs.unlinkSync(file('intent')); writeBlocked = false;
                    }
                } catch (e) {
                    const notSent = e.writeState === 'not-dispatched';
                    last = { id: request.id, nonce, status: notSent ? 'rejected' : 'uncertain',
                        write_state: notSent ? 'not-dispatched' : 'unknown', error: String(e.message || e) };
                    durable(path.join(directory, 'ambient-result-' + request.id + '.json'), last);
                    if (notSent) { fs.unlinkSync(file('intent')); writeBlocked = false; }
                }
            }
        } catch (e) {
            failure = String(e.message || e);
            if (claimed && !writeBlocked) {
                // A session-valid, claimed request was rejected before any intent/write.
                last = { id: claimed.id, nonce, status: 'rejected', write_state: 'not-dispatched', error: failure };
                durable(path.join(directory, 'ambient-result-' + claimed.id + '.json'), last);
            }
        }
            const report = { schema: 1, app: 'ambient_light', version: '0.2.2', nonce,
                sequence: ++sequence, utc: Date.now(), status: failure ? 'error' : 'ready',
                state, raw, raw_utc: rawUtc, error: failure, write_blocked: writeBlocked, last };
            durable(file('report'), report);
            return report;
        } finally { busy = false; }
    }
    return { tick };
}
module.exports = { create, FILES };
