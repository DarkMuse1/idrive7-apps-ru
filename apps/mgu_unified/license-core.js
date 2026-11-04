'use strict';
// Offline licence VERIFIER for the unified app, mirroring licensing/license_core.py (the issuer).
// Same contract: ECDSA P-256 / SHA-256 over the canonical JSON of the payload (sorted keys, compact).
// Only PUBLIC keys live here, by key id (kid); the private key stays with the issuer, never in a client.
// Verification is fully offline. Binding (pc / vin) is a list of SHA-256 hashes of normalised
// identifiers, so the licence file never discloses a raw VIN or machine id. Nothing from the MGU
// Manager licence is reused or bypassed; no activation server, no network.
// Node 8 compatible: verification only (crypto.createVerify); key generation and signing stay in Python.
const crypto = require('crypto');

const PRODUCT = 'mgu-tools';
const SCHEMA = 1;
const BINDINGS = ['none', 'pc', 'vin'];
const MAX_BYTES = 16384;

function unb64u(text) {
    if (typeof text !== 'string' || !text || text.length > 4096) throw new Error('bad base64');
    var s = text.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

// Byte-for-byte equal to Python json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False).
function canonical(value) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (typeof value === 'object') {
        var keys = Object.keys(value).sort();
        return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonical(value[k]); }).join(',') + '}';
    }
    throw new Error('non-serialisable value');
}

function sha256hex(text) { return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'); }

// Hash of a normalised identifier: VIN upper-case without spaces (17 chars); any other id trimmed.
function bindingHash(kind, value) {
    var v;
    if (kind === 'vin') { v = String(value).replace(/\s+/g, '').toUpperCase(); if (v.length !== 17) throw new Error('VIN must have 17 characters'); }
    else { v = String(value).trim(); if (!v) throw new Error('empty identifier'); }
    return sha256hex(kind + ':' + v);
}

function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

function validatePayload(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('payload is not an object');
    var need = ['binding', 'expires_at', 'features', 'issued_at', 'license_id', 'licensee', 'not_before', 'product', 'schema'];
    var have = Object.keys(p).sort();
    if (have.length !== need.length || have.some(function (k, i) { return k !== need[i]; })) throw new Error('unexpected or missing fields');
    if (p.schema !== SCHEMA || p.product !== PRODUCT) throw new Error('wrong schema or product');
    if (typeof p.license_id !== 'string' || p.license_id.length < 8 || p.license_id.length > 64) throw new Error('bad licence id');
    if (typeof p.licensee !== 'string' || p.licensee.length < 1 || p.licensee.length > 120) throw new Error('bad licensee');
    if (!isInt(p.issued_at) || p.issued_at < 0) throw new Error('bad issued_at');
    if (!isInt(p.not_before) || p.not_before < 0) throw new Error('bad not_before');
    if (p.expires_at !== null && (!isInt(p.expires_at) || p.expires_at <= p.not_before)) throw new Error('bad expires_at');
    if (!Array.isArray(p.features) || p.features.length > 32 || !p.features.every(function (f) { return typeof f === 'string' && f; })) throw new Error('bad features');
    var b = p.binding;
    if (!b || typeof b !== 'object' || Array.isArray(b) || BINDINGS.indexOf(b.type) < 0) throw new Error('bad binding');
    var bk = Object.keys(b).sort();
    if (bk.length !== 2 || bk[0] !== 'hashes' || bk[1] !== 'type') throw new Error('bad binding');
    if (!Array.isArray(b.hashes) || b.hashes.length > 8 || !b.hashes.every(function (h) { return typeof h === 'string' && h.length === 64; })) throw new Error('bad binding hashes');
    if ((b.type === 'none') !== (b.hashes.length === 0)) throw new Error('binding type and hashes disagree');
    return p;
}

// pemByKid: { kid: "-----BEGIN PUBLIC KEY----- ..." }. Rejects anything that is not a PEM public key.
function loadKeys(pemByKid) {
    var keys = {};
    Object.keys(pemByKid || {}).forEach(function (kid) {
        var pem = pemByKid[kid];
        if (typeof pem !== 'string' || pem.indexOf('BEGIN PUBLIC KEY') < 0) throw new Error('public key ' + kid + ' is not a PEM public key');
        keys[kid] = pem;
    });
    return keys;
}

// Result: { valid, reason, claims }. reason is one of:
// ok | malformed | unknown-key | bad-signature | not-yet-valid | expired | binding-mismatch | clock-rollback.
// bound: { pc: [hash,...], vin: [hash,...] } current identifiers. lastSeen: newest epoch-seconds this client saw.
function verify(text, publicKeys, now, bound, lastSeen) {
    var payload;
    try {
        if ((typeof text !== 'string' && !Buffer.isBuffer(text)) || text.length > MAX_BYTES) return { valid: false, reason: 'malformed', claims: null };
        var doc = JSON.parse(text);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { valid: false, reason: 'malformed', claims: null };
        var dk = Object.keys(doc).sort();
        if (dk.length !== 3 || dk[0] !== 'kid' || dk[1] !== 'payload' || dk[2] !== 'sig') return { valid: false, reason: 'malformed', claims: null };
        var pem = typeof doc.kid === 'string' ? publicKeys[doc.kid] : undefined;
        if (!pem) return { valid: false, reason: 'unknown-key', claims: null };
        payload = validatePayload(doc.payload);
        var verifier = crypto.createVerify('sha256');
        verifier.update(Buffer.from(canonical(payload), 'utf8'));
        if (!verifier.verify(pem, unb64u(doc.sig))) return { valid: false, reason: 'bad-signature', claims: null };
    } catch (e) {
        return { valid: false, reason: 'malformed', claims: null };
    }
    if (typeof lastSeen === 'number' && now + 300 < lastSeen) return { valid: false, reason: 'clock-rollback', claims: payload };
    if (now < payload.not_before) return { valid: false, reason: 'not-yet-valid', claims: payload };
    if (payload.expires_at !== null && now >= payload.expires_at) return { valid: false, reason: 'expired', claims: payload };
    var b = payload.binding;
    if (b.type !== 'none') {
        var mine = (bound && bound[b.type]) || [];
        if (!b.hashes.some(function (h) { return mine.indexOf(h) >= 0; })) return { valid: false, reason: 'binding-mismatch', claims: payload };
    }
    return { valid: true, reason: 'ok', claims: payload };
}

// Client policy hook. 'observe' (current default, per LICENSING_CONTRACT.md): never blocks, only reports.
// 'enforce' is a future, customer-approved policy and only gates the listed features.
function decide(result, mode) {
    if (mode === undefined || mode === 'observe') return { blocked: false, report: result.reason };
    if (mode === 'enforce') return { blocked: !result.valid, report: result.reason };
    throw new Error('unknown mode');
}

module.exports = { PRODUCT: PRODUCT, SCHEMA: SCHEMA, BINDINGS: BINDINGS, MAX_BYTES: MAX_BYTES,
    canonical: canonical, bindingHash: bindingHash, validatePayload: validatePayload,
    loadKeys: loadKeys, verify: verify, decide: decide };
