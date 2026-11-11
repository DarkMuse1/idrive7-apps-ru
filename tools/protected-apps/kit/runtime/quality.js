'use strict';
/**
 * quality.js - SignalValue and the store that applies the data-quality rules of docs/architecture.md
 * section 2 (TZ 6, 7.4, 8).
 *
 *   const Q = require('./kit/quality');
 *   const store = new Q.Store();
 *   store.define('rpm', { unit: 'rpm', source: 'someip:CDS.statusEngineSpeed2', provider: 'CDS',
 *                         decode: Q.scaled({ factor: 0.25, offset: 0, invalid: 65535 }) });
 *   store.provider('CDS', true);       // the provider's availability (signals.watch opts.onAvailable)
 *   store.put('rpm', raw);             // a raw value as it came from the car
 *   store.get('rpm')                   // -> SignalValue
 *
 *   SignalValue { key, value, unit, source, quality, received_at_monotonic, provenance { raw, scale, reason, profile } }
 *   quality: live | stale | unavailable | invalid | demo
 *
 * Rules (numbered as in architecture.md 2):
 *  1. Zero is a value: a raw value that decodes to 0 is live 0.
 *  2. Invalid is never masked: a sentinel, a value outside the range its config declares, NaN or
 *     Infinity, or a wrong type gives quality invalid and value null. The previous value is neither
 *     kept nor zeroed; the raw value stays in provenance.
 *  3. Unavailable: before the first value, and while the provider has been unavailable from the start.
 *  4. Stale: the provider went away after values had come (they stay stale after it is back, until a
 *     new value arrives), or the signal's stale_ms passed without a new value. stale_ms comes only from
 *     a measured cadence and defaults to null: fields are notified on change, so quiet is not old.
 *  5. Demo is never mixed with live: while demo is on, every value comes from the demo layer with
 *     quality demo (unavailable when the demo doesn't simulate it) and live values are not shown.
 *  6. Computed values take the worst quality of their inputs (computed()).
 *  7. Times are monotonic (kit/clock.js); even a clock that steps back cannot make a time go back.
 * Node 8 compatible (runs on the head unit).
 */
const clock = require('./clock');

/** How bad each quality is: a computed value inherits the worst of its inputs (rule 6). */
const RANK = { live: 0, demo: 1, stale: 2, unavailable: 3, invalid: 4 };
function worst(qualities) {
    let w = 'live';
    (qualities || []).forEach((q) => {
        const r = RANK[q] === undefined ? RANK.invalid : RANK[q];
        if (r > RANK[w]) w = RANK[q] === undefined ? 'invalid' : q;
    });
    return w;
}

const isNum = (x) => typeof x === 'number' && isFinite(x);
const show = (x) => { let s; try { s = JSON.stringify(x); } catch (e) { s = String(x); } s = s === undefined ? String(x) : s; return s.length > 40 ? s.slice(0, 37) + '...' : s; };
/** a decode result for a value that can't be used */
const bad = (reason) => ({ invalid: reason });
function typeProblem(raw) {
    if (typeof raw !== 'number') return 'wrong type (' + (raw === null ? 'null' : typeof raw) + ': ' + show(raw) + ')';
    if (!isFinite(raw)) return 'not a finite number (' + raw + ')';
    return null;
}

/* ---------------- decoders: raw -> { value } or { invalid: reason } ---------------- */

/** A finite number as it is. */
function number(raw) { const why = typeProblem(raw); return why ? bad(why) : { value: raw }; }

/**
 * A scaled number: value = raw * factor + offset. cfg as in car.js SCALE / app.json config.scaling:
 * invalid = the sentinel, invalidFrom = sentinels from there up, min / max = the valid range of the
 * scaled value (only where the config gives one: no range is assumed).
 */
function scaled(cfg) {
    const fn = (raw) => {
        const why = typeProblem(raw);
        if (why) return bad(why);
        if (cfg.invalid !== undefined && raw === cfg.invalid) return bad('sentinel ' + raw);
        if (cfg.invalidFrom !== undefined && raw >= cfg.invalidFrom) return bad('sentinel ' + raw + ' (>= ' + cfg.invalidFrom + ')');
        const v = raw * cfg.factor + (cfg.offset || 0);
        if (!isNum(v)) return bad('scale gives ' + show(v));
        if ((isNum(cfg.min) && v < cfg.min) || (isNum(cfg.max) && v > cfg.max)) return bad('out of range (' + v + ')');
        return { value: v };
    };
    fn.scale = cfg;
    return fn;
}

/** A value looked up in a table (an enum): fn(raw) -> value, or undefined for an unknown entry (invalid). */
function lookup(fn, what) {
    return (raw) => {
        const v = fn(raw);
        return v === undefined || v === null ? bad('unknown ' + (what || 'value') + ' ' + show(raw)) : { value: v };
    };
}

/* ---------------- the store ---------------- */

class Store {
    /** opts.clock: kit/clock.js (default); opts.profile: the compatibility profile id, when known */
    constructor(opts) {
        opts = opts || {};
        this.clock = opts.clock || clock;
        this.profile = opts.profile || null;
        this.meta = Object.create(null);
        this.samples = Object.create(null);     // live layer: key -> the last sample
        this.providers = Object.create(null);   // name -> { state: 'unknown' | 'up' | 'down', lostSeq, reason }
        this.demo = null;                       // demo layer while demo is on: key -> { value, at }
        this.seq = 0;                           // orders samples against provider losses
        this.last = -Infinity;
    }

    /** meta: { unit, source, provider, stale_ms (null: no age limit), decode (default: a finite number) } */
    define(key, meta) {
        meta = meta || {};
        this.meta[key] = {
            unit: meta.unit || null, source: meta.source || null, provider: meta.provider || null,
            stale_ms: isNum(meta.stale_ms) && meta.stale_ms > 0 ? meta.stale_ms : null,
            decode: meta.decode || number, scale: meta.scale || (meta.decode && meta.decode.scale) || null,
        };
        if (this.meta[key].provider) this._provider(this.meta[key].provider);
        return this;
    }
    keys() { return Object.keys(this.meta); }
    has(key) { return !!this.meta[key]; }

    /** Monotonic now (rule 7): never earlier than a time already handed out. */
    now() { const t = this.clock.now(); if (t > this.last) this.last = t; return this.last; }

    /**
     * A raw value from the car. decode: for a signal that comes in more than one encoding (e.g. the
     * gear from two fields), the decoder of this one; default the signal's. Returns the SignalValue.
     */
    put(key, raw, decode) {
        const m = this.meta[key];
        if (!m) throw new Error('quality: unknown signal ' + key);
        let d;
        try { d = (decode || m.decode)(raw); } catch (e) { d = bad('decode failed: ' + e.message); }
        if (!d || (d.invalid === undefined && d.value === undefined)) d = bad('no value decoded from ' + show(raw));
        const p = m.provider ? this.providers[m.provider] : null;
        this.samples[key] = {
            value: d.invalid === undefined ? d.value : null, invalid: d.invalid === undefined ? null : d.invalid,
            raw, at: this.now(), seq: ++this.seq,
            whileDown: !!(p && p.state === 'down'),         // came while the provider was reported gone
        };
        return this.get(key);
    }

    /** A provider's availability changed (reason: why it isn't there, e.g. a subscribe error). */
    provider(name, available, reason) {
        const p = this._provider(name);
        if (available) { p.state = 'up'; p.reason = null; return; }
        if (p.state !== 'down') p.lostSeq = ++this.seq;     // everything received so far is from before the loss
        p.state = 'down';
        if (reason) p.reason = reason;
    }
    providerState(name) { return this.providers[name] ? this.providers[name].state : 'unknown'; }
    _provider(name) { return this.providers[name] || (this.providers[name] = { state: 'unknown', lostSeq: 0, reason: null }); }

    /** Has any value (valid or not) come from the car? */
    received() { return Object.keys(this.samples).length > 0; }

    /* demo layer (rule 5) */
    setDemo(on) { this.demo = on ? Object.create(null) : null; }
    isDemo() { return !!this.demo; }
    /** Simulated values { key: value } at monotonic time `at` (default now); ignored while demo is off. */
    putDemo(values, at) {
        if (!this.demo) return;
        const t = isNum(at) ? at : this.now();
        Object.keys(values || {}).forEach((k) => { if (this.meta[k]) this.demo[k] = { value: values[k], at: t }; });
    }

    /** The SignalValue shown now: demo while demo is on, else the car's. */
    get(key) { return this.demo ? this._demo(key) : this.getLive(key); }

    /** The car's SignalValue, also while demo is on (for the runtime's own bookkeeping). */
    getLive(key) {
        const m = this.meta[key];
        if (!m) return this._value({}, key, null, 'unavailable', null, null, 'not a known signal');
        const s = this.samples[key], p = m.provider ? this.providers[m.provider] : null;
        if (!s) {
            let why = 'no value yet';
            if (p && p.state === 'down') why = 'provider unavailable' + (p.reason ? ' (' + p.reason + ')' : '');
            else if (p && p.state === 'up') why = 'waiting for the first value';
            return this._value(m, key, null, 'unavailable', null, null, why);
        }
        let quality = s.invalid ? 'invalid' : 'live', why = s.invalid;
        if (s.whileDown || (p && p.lostSeq > s.seq)) {
            quality = 'stale';
            why = 'provider lost' + (p && p.reason ? ' (' + p.reason + ')' : '') + (s.invalid ? '; the last value was invalid: ' + s.invalid : '');
        } else if (m.stale_ms !== null) {
            const age = this.now() - s.at;
            if (age > m.stale_ms) {
                quality = 'stale';
                why = 'no new value for ' + Math.round(age) + ' ms (limit ' + m.stale_ms + ' ms)' + (s.invalid ? '; the last value was invalid: ' + s.invalid : '');
            }
        }
        // stale keeps the last value (null if that one was invalid); invalid never shows one
        return this._value(m, key, quality === 'invalid' ? null : s.value, quality, s.at, s.raw, why);
    }

    _demo(key) {
        const m = this.meta[key] || {}, d = this.demo[key];
        const ok = d && d.value !== null && d.value !== undefined && !(typeof d.value === 'number' && !isFinite(d.value));
        return {
            key, value: ok ? d.value : null, unit: m.unit || null, source: 'demo', quality: ok ? 'demo' : 'unavailable',
            received_at_monotonic: d ? d.at : null,
            provenance: { raw: d ? d.value : null, scale: null, reason: ok ? 'simulated' : 'not simulated', profile: this.profile },
        };
    }

    _value(m, key, value, quality, at, raw, reason) {
        return {
            key, value, unit: m.unit || null, source: m.source || null, quality, received_at_monotonic: at,
            provenance: { raw: raw === undefined ? null : raw, scale: m.scale || null, reason: reason || null, profile: this.profile },
        };
    }

    /** { values: { key: value shown now, or null }, quality: { key: quality } } for keys (default: all). */
    snapshot(keys) {
        const out = { values: {}, quality: {} };
        (keys || this.keys()).forEach((k) => {
            const s = this.get(k);
            out.quality[k] = s.quality;
            out.values[k] = s.quality === 'live' || s.quality === 'demo' ? s.value : null;
        });
        return out;
    }
}

/**
 * A value computed from other SignalValues (rule 6): the worst quality of the inputs. The value is
 * fn(...input values) when every input has a value - from the last values when one is stale - and
 * null otherwise; a result that is not a finite number is invalid.
 */
function computed(key, inputs, fn, meta) {
    meta = meta || {};
    const q = worst(inputs.map((s) => s.quality));
    const ats = inputs.map((s) => s.received_at_monotonic).filter(isNum);
    const out = { key, unit: meta.unit || null, source: 'computed:' + key, received_at_monotonic: ats.length ? Math.min.apply(null, ats) : null };
    const prov = (reason) => ({ raw: inputs.map((s) => s.value), scale: null, reason, profile: meta.profile || null, inputs: inputs.map((s) => s.key) });
    const decided = inputs.find((s) => s.quality === q);
    const why = decided && q !== 'live' ? decided.key + ': ' + (decided.provenance && decided.provenance.reason) : null;
    if (q === 'unavailable' || q === 'invalid' || !inputs.every((s) => s.value !== null && s.value !== undefined)) {
        return Object.assign(out, { value: null, quality: q === 'live' || q === 'demo' ? 'unavailable' : q, provenance: prov(why || 'an input has no value') });
    }
    let v;
    try { v = fn.apply(null, inputs.map((s) => s.value)); } catch (e) { v = undefined; }
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) {
        return Object.assign(out, { value: null, quality: 'invalid', provenance: prov('computed value is ' + show(v)) });
    }
    return Object.assign(out, { value: v, quality: q, provenance: prov(why) });
}

const QUALITIES = Object.keys(RANK);

module.exports = { Store, computed, worst, scaled, lookup, number, QUALITIES, RANK };
