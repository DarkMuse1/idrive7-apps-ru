'use strict';
/**
 * replay.js - run a staged app on the PC deterministically: virtual time, a seeded Math.random and
 * the car's SOME/IP signals played from JSONL fixtures instead of a car. At the given times the
 * shown screen's ctx.loop function runs once (as preview.js "render") and what the app drew is
 * saved as PNG, with the SHA-256 of its raw RGBA pixels (PNG bytes depend on the zlib version).
 * Same stage, fixtures, settings, seed and times = the same hashes on every run, under Node 8
 * (the head unit's runtime) and current Node alike. Runs with Node 8.7 and newer.
 *
 *   node kit/tools/replay.js <stage> --fixture F.jsonl [--fixture G.jsonl ...] --out DIR
 *        (--at T1,T2,... | --every MS --until MS) [--seed N] [--set key=value ...] [--gpu FILE]
 *        [--name NAME] [--strict] [--verbose]
 *
 *   stage     a staged app: dist-preview/<id> (build.py --preview-only) or dist/<id>
 *   --fixture events to play; several files are merged by time (same time: the order given)
 *   --at      capture times in ms after the app starts (--every MS --until MS: MS, 2*MS, ... UNTIL)
 *   --seed    Math.random seed (default 1)
 *   --set     a setting before the app starts (applied after the fixtures' t = 0 settings)
 *   --gpu     also write the GPU renderer stream (full-screen layout) to FILE, as preview.js does;
 *             the frames are then that recording played back in software
 *   --name    label for the report (default: the last fixture header's "scenario")
 *   --strict  exit 1 if an uncaught exception, an unhandled rejection or a log.error happened
 *
 * Output in DIR: frames/*.png and report.json (frames with their pixel hashes, the demo state and
 * kit/car.js data() at that moment, the signal groups of each kit/car.js Car, every log line,
 * exceptions, unhandled rejections, JS errors the runtime caught and logged as warnings, UDS
 * requests, writes to the car, subscriptions, settings, the fixture headers). DIR/data is the app's
 * data folder, fresh for each run. Exit code: 0, 1 (--strict failed), 2 (usage), 3 (harness error).
 *
 * Fixture (JSONL): a header line {"type":"header", ..., "synthetic": true|false}, then events
 * ordered by t (ms of virtual time):
 *   {"t":0,"type":"available","iface":I,"instance":"1","available":true}   provider up / down
 *   {"t":120,"type":"field","iface":I,"field":F,"value":{...}}   a field's value (optional "instance",
 *        default "1"), notified to its subscribers while the provider is available
 *   {"t":8000,"type":"settings","key":K,"value":V}               as if chosen in the HMI
 *   {"t":0,"type":"error","iface":I,"error":"..."}               watch() / proxy() of I fail from then on
 *   {"t":0,"type":"uds","ecu":N,"request":"22 F4 42","reply":"62 F4 42 31 38","delayMs":20}
 *        from then on that unit answers that request (a later rule for the same unit and request
 *        replaces it) over the diagnostic transport (an interface whose manifest entry has the
 *        method sendTasuRequest), in the frame kit/runtime/diag.js reads: 9 header bytes ([6] =
 *        the unit, the rest 0), then the reply. "replies": [{"delayMs":..,"data":".."}] for several
 *        frames (e.g. 7F 22 78 "pending", then the answer). Functional requests (diag.js ALL) get a
 *        reply from every unit with a rule for them
 *   {"t":5000,"type":"click","name":"BTN_PAGE"}                 a press on an HMI button
 * Events at t = 0 are the state the app starts in: a field event there only sets the value.
 *
 * The app gets the real kit: signals.js (ctx.signals), Settings, Display, themes, canvas. Only the
 * native SOME/IP binding under signals.js is replaced: an interface exists, as on the unit, only
 * when the app's manifest.json lists it (the working copy gets someipInterfaces/*.json made from
 * it, as far as signals.js reads them: a getter per "r" field); an instance is unavailable until an
 * "available" event says otherwise; the diagnostic transport (TASU) has no provider - proxy()
 * rejects - unless a fixture declares it ("no TASU" by default). Nothing here reaches a car, a
 * renderer socket or the network.
 *
 * One clock drives everything: Date (new Date(), Date.now(); the zone is UTC), process.hrtime,
 * performance.now, setTimeout / setInterval / setImmediate and their clear* functions. The run
 * goes event by event; after each callback the promise microtasks run out (on the real
 * setImmediate). An uncaught exception ends the run, as it ends the app on the car. Math.random
 * is seeded, and on Node 8 Array.prototype.sort is made stable as in current Node (stableSort).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const Module = require('module');

// the real clock, before anything is patched: the runner itself works with it
const REAL = { setTimeout: global.setTimeout, setImmediate: global.setImmediate, Date: global.Date, exit: process.exit };
const DEFAULT_EPOCH = Date.UTC(2026, 0, 1, 8, 0, 0);       // wall clock at virtual t = 0 (header "epochMs")
const MONO_BASE_MS = 5000000;                              // hrtime / performance.now at t = 0
const START_STEP_MS = 5000;                                // as mgu.js: the app's start may take this long
const MAX_CALLBACKS = 5000000;
const MAX_IMMEDIATES = 200000;                             // setImmediate callbacks without time passing
const SETTLE_TICKS = 50;                                   // real ticks a frame function may take to finish
// UDS over TASU as kit/runtime/diag.js uses it: the request method, the reply event, the reply frame
const TASU_REQUEST = 'sendTasuRequest', TASU_RESPONSE = 'sendTasuResponse';
const TASU_HEADER = 9, TASU_ECU_AT = 6;
// services that change a control unit's state (ISO 14229-1; 0x04 = SAE J1979 "clear DTCs"):
// reported, as TZ 8 forbids diagnostic writes nobody asked for
const STATE_CHANGING = {
    0x04: 'OBD clear DTCs', 0x11: 'ECUReset', 0x14: 'ClearDiagnosticInformation', 0x28: 'CommunicationControl',
    0x2E: 'WriteDataByIdentifier', 0x2F: 'InputOutputControlByIdentifier', 0x31: 'RoutineControl',
    0x34: 'RequestDownload', 0x36: 'TransferData', 0x37: 'RequestTransferExit', 0x3D: 'WriteMemoryByAddress',
    0x85: 'ControlDTCSetting',
};
const EVENT_NEEDS = { available: ['iface', 'available'], field: ['iface', 'field', 'value'], settings: ['key', 'value'], error: ['iface', 'error'], uds: ['ecu', 'request'], click: ['name'] };
const JS_ERROR = /\b(TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError)\b/;

const USAGE = 'usage: node kit/tools/replay.js <stage> --fixture F.jsonl [--fixture ...] --out DIR (--at T1,T2,... | --every MS --until MS)\n' +
    '       [--seed N] [--set key=value ...] [--gpu FILE] [--name NAME] [--strict] [--verbose]\n';

function usage(msg) {
    process.stderr.write('replay.js: ' + msg + '\n' + USAGE);
    REAL.exit.call(process, 2);
}

function parseArgs(argv) {
    const o = { stage: null, fixtures: [], out: null, at: null, every: null, until: null, seed: 1, sets: [], gpu: null, name: null, strict: false, verbose: false };
    const ms = (s, what) => {
        const n = Number(s);
        if (!(String(s).trim() !== '' && Number.isInteger(n) && n >= 0)) usage(what + ' must be whole milliseconds >= 0, not ' + JSON.stringify(s));
        return n;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => { if (i + 1 >= argv.length) usage(a + ' needs a value'); return argv[++i]; };
        if (a === '--fixture') o.fixtures.push(val());
        else if (a === '--out') o.out = val();
        else if (a === '--at') o.at = val().split(',').map((s) => ms(s, '--at'));
        else if (a === '--every') o.every = ms(val(), '--every');
        else if (a === '--until') o.until = ms(val(), '--until');
        else if (a === '--seed') { o.seed = Number(val()); if (!Number.isInteger(o.seed)) usage('--seed must be a whole number'); }
        else if (a === '--set') o.sets.push(val());
        else if (a === '--gpu') o.gpu = val();
        else if (a === '--name') o.name = val();
        else if (a === '--strict') o.strict = true;
        else if (a === '--verbose') o.verbose = true;
        else if (a.slice(0, 2) === '--') usage('unknown option ' + a);
        else if (!o.stage) o.stage = a;
        else usage('unexpected argument ' + a);
    }
    if (!o.stage || !o.fixtures.length || !o.out) usage('a stage, --fixture and --out are required');
    if (o.at && (o.every !== null || o.until !== null)) usage('use either --at or --every/--until');
    if (!o.at) {
        if (o.every === null || o.until === null || o.every <= 0) usage('give --at T1,T2,... or --every MS --until MS');
        o.at = [];
        for (let t = o.every; t <= o.until; t += o.every) o.at.push(t);
    }
    o.at = o.at.filter((t, i, a) => a.indexOf(t) === i).sort((x, y) => x - y);
    if (!o.at.length) usage('no capture times');
    return o;
}

/* ---------------- fixtures ---------------- */

function hexBytes(s, what) {
    const h = String(s).replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(h)) throw new Error(what + ' is not hex bytes: ' + JSON.stringify(s));
    const out = [];
    for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
    return out;
}

function readFixture(file, index) {
    const text = fs.readFileSync(file, 'utf8');
    let header = null, lastT = 0;
    const events = [];
    text.split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        const where = path.basename(file) + ':' + (i + 1);
        let o;
        try { o = JSON.parse(line); } catch (e) { throw new Error(where + ': not JSON: ' + e.message); }
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(where + ': not an object');
        if (!header) {
            if (o.type !== 'header') throw new Error(where + ': the first line must be {"type":"header", ...}');
            if (typeof o.synthetic !== 'boolean') throw new Error(where + ': the header must say "synthetic": true or false');
            header = o;
            return;
        }
        const need = EVENT_NEEDS[o.type];
        if (!need) throw new Error(where + ': unknown event type ' + JSON.stringify(o.type));
        if (typeof o.t !== 'number' || !isFinite(o.t) || o.t < 0 || Math.floor(o.t) !== o.t) throw new Error(where + ': "t" must be whole ms >= 0');
        if (o.t < lastT) throw new Error(where + ': events must be ordered by t (' + o.t + ' after ' + lastT + ')');
        lastT = o.t;
        need.forEach((k) => { if (!(k in o)) throw new Error(where + ': a ' + o.type + ' event needs "' + k + '"'); });
        if (o.type === 'available' && typeof o.available !== 'boolean') throw new Error(where + ': "available" must be true or false');
        if (o.type === 'click' && o.t === 0) throw new Error(where + ': a click needs t > 0 (at t = 0 the app is not running yet)');
        if (o.instance !== undefined) o.instance = String(o.instance);
        if (o.type === 'uds') {
            if (!Number.isInteger(o.ecu) || o.ecu < 0 || o.ecu > 255) throw new Error(where + ': "ecu" must be a byte');
            o.requestBytes = hexBytes(o.request, where + ' request');
            const replies = o.replies || (o.reply !== undefined ? [{ delayMs: o.delayMs, data: o.reply }] : null);
            if (!Array.isArray(replies) || !replies.length) throw new Error(where + ': a uds event needs "reply" or "replies"');
            o.frames = replies.map((r, k) => ({ delayMs: Math.max(0, Math.floor(Number(r.delayMs) || 0)), bytes: hexBytes(r.data, where + ' reply ' + k) }));
        }
        o.file = index; o.line = i + 1; o.where = where;
        events.push(o);
    });
    if (!header) throw new Error(path.basename(file) + ': empty fixture');
    return { file, header, events, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

/* ---------------- small helpers (Node 8: no recursive mkdir / rm) ---------------- */

function mkdirp(d) {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }      // a parallel run made it meanwhile
}
function rmrf(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n)));
        fs.rmdirSync(p);
    } else fs.unlinkSync(p);
}
function copyDir(src, dst) {
    mkdirp(dst);
    fs.readdirSync(src).forEach((n) => {
        const s = path.join(src, n), d = path.join(dst, n);
        if (fs.statSync(s).isDirectory()) copyDir(s, d);
        else fs.writeFileSync(d, fs.readFileSync(s));
    });
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hex2 = (n) => ('0' + n.toString(16).toUpperCase()).slice(-2);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---------------- virtual time ---------------- */

/** Seeded Math.random (mulberry32): the same numbers on every Node version. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Stable merge sort of a (a new array); cmp(x, y) < 0 puts y first only when it is strictly smaller. */
function mergeSort(a, cmp) {
    let src = a.slice(), dst = new Array(a.length);
    for (let w = 1; w < src.length; w *= 2) {
        for (let lo = 0; lo < src.length; lo += 2 * w) {
            const mid = Math.min(lo + w, src.length), hi = Math.min(lo + 2 * w, src.length);
            let i = lo, j = mid, k = lo;
            while (i < mid && j < hi) dst[k++] = cmp(src[j], src[i]) < 0 ? src[j++] : src[i++];
            while (i < mid) dst[k++] = src[i++];
            while (j < hi) dst[k++] = src[j++];
        }
        const t = src; src = dst; dst = t;
    }
    return src;
}

/**
 * Array.prototype.sort is stable from V8 7.0 (Node 11) on. Node 8 sorts arrays of more than 10
 * elements unstably, so equal elements (kit/car.js's gear clusters, eDrive's byte changes) could come
 * out in another order than under current Node, and the frames with them. Where the native sort is
 * unstable it is replaced by a stable one with the standard's rules (undefined last, holes after).
 * The head unit's Node 8 keeps its own order: this is about replays agreeing with each other.
 */
function stableSort() {
    const probe = [];
    for (let i = 0; i < 100; i++) probe.push({ k: i % 3, i });
    probe.sort((x, y) => x.k - y.k);
    if (probe.every((x, j) => j === 0 || probe[j - 1].k < x.k || probe[j - 1].i < x.i)) return 'native';
    const byString = (x, y) => { const a = String(x), b = String(y); return a < b ? -1 : a > b ? 1 : 0; };
    function sort(cmp) {
        if (cmp !== undefined && typeof cmp !== 'function') throw new TypeError('The comparison function must be either a function or undefined');
        const o = Object(this), len = Math.max(0, Math.min(Math.floor(Number(o.length)) || 0, Number.MAX_SAFE_INTEGER));
        const items = [];
        let undef = 0;
        for (let i = 0; i < len; i++) {
            if (!(i in o)) continue;
            if (o[i] === undefined) undef++; else items.push(o[i]);
        }
        // a comparator that returns NaN counts as "equal", as in the standard
        const c = cmp ? (x, y) => { const r = Number(cmp(x, y)); return r === r ? r : 0; } : byString;
        const sorted = mergeSort(items, c);
        let i = 0;
        for (; i < sorted.length; i++) o[i] = sorted[i];
        for (let u = 0; u < undef; u++) o[i++] = undefined;
        for (; i < len; i++) delete o[i];
        return o;
    }
    Object.defineProperty(Array.prototype, 'sort', { value: sort, writable: true, configurable: true, enumerable: false });
    return 'replaced';
}

/** Timer queue ordered by (time, priority, sequence): one order on every machine. */
class Heap {
    constructor() { this.a = []; }
    static less(x, y) { return x.at !== y.at ? x.at < y.at : x.pri !== y.pri ? x.pri < y.pri : x.seq < y.seq; }
    push(x) {
        const a = this.a;
        a.push(x);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!Heap.less(a[i], a[p])) break;
            const t = a[i]; a[i] = a[p]; a[p] = t; i = p;
        }
    }
    peek() { return this.a[0]; }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && Heap.less(a[l], a[m])) m = l;
                if (r < a.length && Heap.less(a[r], a[m])) m = r;
                if (m === i) break;
                const t = a[i]; a[i] = a[m]; a[m] = t; i = m;
            }
        }
        return top;
    }
}

function makeClock(epochMs, seed, onError) {
    const clock = { now: 0, heap: new Heap(), immediates: [], seq: 0, ids: 0, byId: new Map(), callbacks: 0 };
    const nowMs = () => epochMs + clock.now;

    class VTimer {
        constructor(e) { this._entry = e; }
        ref() { return this; }
        unref() { return this; }
        hasRef() { return true; }
        refresh() {
            const e = this._entry;
            if (!e.cancelled) { e.cancelled = true; clock.byId.delete(e.id); schedule(e.fn, e.args, e.delay, e.repeat > 0, this); }
            return this;
        }
        close() { cancel(this); return this; }
    }
    VTimer.prototype[Symbol.toPrimitive] = function () { return this._entry.id; };

    function schedule(fn, args, delay, repeat, handle) {
        const e = { id: ++clock.ids, at: clock.now + delay, pri: 0, seq: ++clock.seq, fn, args, delay, repeat: repeat ? delay : 0, cancelled: false };
        e.handle = handle || new VTimer(e);
        e.handle._entry = e;
        clock.heap.push(e);
        clock.byId.set(e.id, e);
        return e;
    }
    // as Node: a delay that is not a number from 1 to 2^31-1 is 1 ms
    const delayOf = (d) => { d = Number(d); return d >= 1 && d <= 2147483647 ? Math.floor(d) : 1; };
    const checkFn = (fn) => { if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function'); };
    function cancel(t) {
        if (t === null || t === undefined) return;
        const e = t._entry || clock.byId.get(Number(t));
        if (e) { e.cancelled = true; clock.byId.delete(e.id); }
    }
    function vSetTimeout(fn, ms) { checkFn(fn); return schedule(fn, Array.prototype.slice.call(arguments, 2), delayOf(ms), false).handle; }
    function vSetInterval(fn, ms) { checkFn(fn); return schedule(fn, Array.prototype.slice.call(arguments, 2), delayOf(ms), true).handle; }
    vSetTimeout[util.promisify.custom] = (ms, value) => new Promise((res) => vSetTimeout(res, ms, value));
    function vSetImmediate(fn) {
        checkFn(fn);
        const e = { fn, args: Array.prototype.slice.call(arguments, 1), cancelled: false };
        e.handle = { _immediate: e, ref() { return this; }, unref() { return this; }, hasRef() { return true; } };
        clock.immediates.push(e);
        return e.handle;
    }
    vSetImmediate[util.promisify.custom] = (value) => new Promise((res) => vSetImmediate(res, value));
    function vClearImmediate(h) { if (h && h._immediate) h._immediate.cancelled = true; }

    // Date: virtual "now"; the zone is UTC (local getters, setters and texts are the UTC ones), so
    // a frame never depends on the PC's time zone or its ICU version
    const RealDate = REAL.Date;
    const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;      // no zone: local time in JS
    const parse = (s) => RealDate.parse(typeof s === 'string' && ISO_LOCAL.test(s.trim()) ? s.trim() + 'Z' : s);
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const valid = (d) => !isNaN(RealDate.prototype.getTime.call(d));
    const dateStr = (d) => DAYS[d.getUTCDay()] + ' ' + MONTHS[d.getUTCMonth()] + ' ' + p2(d.getUTCDate()) + ' ' + d.getUTCFullYear();
    const timeStr = (d) => p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
    const fullStr = (d) => (valid(d) ? dateStr(d) + ' ' + timeStr(d) + ' GMT+0000 (UTC)' : 'Invalid Date');
    function VDate() {
        if (!new.target) return fullStr(new RealDate(nowMs()));
        const n = arguments.length, a0 = arguments[0];
        const args = n === 0 ? [nowMs()] : n === 1 ? [typeof a0 === 'string' ? parse(a0) : a0] : [RealDate.UTC.apply(null, arguments)];
        return Reflect.construct(RealDate, args, new.target);
    }
    VDate.prototype = Object.create(RealDate.prototype, { constructor: { value: VDate, writable: true, configurable: true } });
    VDate.now = nowMs;
    VDate.UTC = RealDate.UTC;
    VDate.parse = parse;
    ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds'].forEach((k) => {
        const get = RealDate.prototype['getUTC' + k], set = RealDate.prototype['setUTC' + k];
        VDate.prototype['get' + k] = function () { return get.call(this); };
        if (set) VDate.prototype['set' + k] = function () { return set.apply(this, arguments); };
    });
    // fixed formats: ICU's (toLocale*) differ between Node versions
    Object.assign(VDate.prototype, {
        getTimezoneOffset() { return 0; },
        toString() { return fullStr(this); },
        toDateString() { return valid(this) ? dateStr(this) : 'Invalid Date'; },
        toTimeString() { return valid(this) ? timeStr(this) + ' GMT+0000 (UTC)' : 'Invalid Date'; },
        toLocaleString() { return valid(this) ? this.toISOString().slice(0, 19).replace('T', ' ') : 'Invalid Date'; },
        toLocaleDateString() { return valid(this) ? this.toISOString().slice(0, 10) : 'Invalid Date'; },
        toLocaleTimeString() { return valid(this) ? timeStr(this) : 'Invalid Date'; },
    });

    function vHrtime(prev) {
        const ns = (MONO_BASE_MS + clock.now) * 1e6;
        let s = Math.floor(ns / 1e9), n = ns - s * 1e9;
        if (prev) {
            s -= prev[0]; n -= prev[1];
            if (n < 0) { s--; n += 1e9; }
        }
        return [s, n];
    }
    if (typeof BigInt === 'function') vHrtime.bigint = () => BigInt(MONO_BASE_MS + clock.now) * BigInt(1000000);

    clock.install = function () {
        const timers = require('timers');
        const fns = {
            setTimeout: vSetTimeout, clearTimeout: cancel, setInterval: vSetInterval, clearInterval: cancel,
            setImmediate: vSetImmediate, clearImmediate: vClearImmediate,
        };
        Object.keys(fns).forEach((k) => { global[k] = fns[k]; timers[k] = fns[k]; });
        global.Date = VDate;
        Math.random = mulberry32(seed);
        process.hrtime = vHrtime;
        const perf = [];
        try { perf.push(require('perf_hooks').performance); } catch (e) { /* Node without perf_hooks */ }
        if (global.performance && perf.indexOf(global.performance) < 0) perf.push(global.performance);
        perf.forEach((p) => { try { p.now = () => MONO_BASE_MS + clock.now; } catch (e) { /* read-only */ } });
    };

    /** A harness event (fixture event, capture) at t: pri 0 runs with the app's timers, pri 1 after them. */
    clock.at = (t, pri, run) => clock.heap.push({ at: t, pri, seq: ++clock.seq, run, cancelled: false });
    clock.after = (ms, run) => clock.at(clock.now + ms, 0, run);
    clock.flush = () => new Promise((res) => REAL.setImmediate(res));

    /** Run everything due up to tEnd, one callback at a time; microtasks run out after each. */
    clock.runUntil = async function (tEnd, stopped) {
        let burst = 0;
        for (;;) {
            if (stopped()) return;
            if (clock.immediates.length) {
                const im = clock.immediates.shift();
                if (!im.cancelled) {
                    if (++burst > MAX_IMMEDIATES) { onError(new Error('more than ' + MAX_IMMEDIATES + ' setImmediate callbacks without time passing'), 'runaway'); return; }
                    invoke(im.fn, im.handle, im.args, 'setImmediate');
                    await clock.flush();
                }
                continue;
            }
            burst = 0;
            const e = clock.heap.peek();
            if (!e || e.at > tEnd) break;
            clock.heap.pop();
            if (e.cancelled) continue;
            if (++clock.callbacks > MAX_CALLBACKS) { onError(new Error('more than ' + MAX_CALLBACKS + ' callbacks'), 'runaway'); return; }
            clock.now = e.at;
            if (e.run) {
                await e.run();
            } else {
                if (e.repeat) { e.at = clock.now + e.repeat; e.seq = ++clock.seq; clock.heap.push(e); } else clock.byId.delete(e.id);
                invoke(e.fn, e.handle, e.args, e.repeat ? 'setInterval' : 'setTimeout');
            }
            await clock.flush();
        }
        if (!stopped() && clock.now < tEnd) clock.now = tEnd;
    };
    /** Run the setImmediate callbacks due now (they take no virtual time), microtasks after each. */
    clock.immediatesNow = async function () {
        for (let n = 0; clock.immediates.length && n < MAX_IMMEDIATES;) {
            const im = clock.immediates.shift();
            if (im.cancelled) continue;
            n++;
            invoke(im.fn, im.handle, im.args, 'setImmediate');
            await clock.flush();
        }
    };
    function invoke(fn, self, args, what) {
        try { fn.apply(self, args); } catch (e) { onError(e, what); }
    }
    clock.pending = () => clock.heap.a.filter((e) => !e.cancelled && !e.run).length;
    return clock;
}

/* ---------------- the run ---------------- */

async function main() {
    const opt = parseArgs(process.argv.slice(2));
    const stage = path.resolve(opt.stage);
    const out = path.resolve(opt.out);
    const srcDir = path.join(stage, 'source');
    if (!fs.existsSync(path.join(srcDir, 'javascript', 'app.js'))) usage(stage + ' is not a staged app (no source/javascript/app.js)');
    const rel = path.relative(stage, out);
    // (on another drive path.relative gives an absolute path: outside too)
    if (rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..')) usage('--out must be outside the stage');

    let fixtures;
    try { fixtures = opt.fixtures.map((f, i) => readFixture(path.resolve(f), i)); } catch (e) { usage(e.message); }
    const events = [];
    fixtures.forEach((fx) => fx.events.forEach((ev) => events.push(ev)));
    events.sort((a, b) => a.t - b.t || a.file - b.file || a.line - b.line);
    const epochs = fixtures.map((fx) => fx.header.epochMs).filter((x) => x !== undefined);
    if (epochs.some((x) => x !== epochs[0])) usage('the fixtures disagree on "epochMs"');
    const epochMs = epochs.length ? epochs[0] : DEFAULT_EPOCH;
    if (!Number.isInteger(epochMs) || epochMs <= 0) usage('header "epochMs" must be a positive whole number');

    const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
    const proxies = manifest.proxies || {};
    const entry = (iface) => (own(proxies, iface) ? proxies[iface] : undefined);
    const listed = (iface, k, name) => { const e = entry(iface); return e === '*' || !!(e && Array.isArray(e[k]) && e[k].indexOf(name) >= 0); };
    const flagsOf = (iface, f) => { const e = entry(iface); return e === '*' ? 'rsw' : e && e.attributes && typeof e.attributes[f] === 'string' ? e.attributes[f] : ''; };
    // the diagnostic transport: an interface the app may send UDS requests on and get replies from
    const transports = Object.keys(proxies).filter((i) => proxies[i] !== '*' && listed(i, 'methods', TASU_REQUEST) && listed(i, 'broadcasts', TASU_RESPONSE));

    // output: frames + report; the app's data folder is fresh for every run
    const framesDir = path.join(out, 'frames'), dataDir = path.join(out, 'data');
    mkdirp(out);
    rmrf(framesDir); rmrf(dataDir);
    mkdirp(framesDir); mkdirp(dataDir);
    try { fs.unlinkSync(path.join(out, 'report.json')); } catch (e) { /* first run */ }

    // a private working copy of the app. On the unit the installer makes someipInterfaces/ from
    // manifest.json with BMW's generator; here they are made from the manifest as far as
    // kit/runtime/signals.js reads them (a getter for each "r" field)
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-replay-'));
    copyDir(srcDir, path.join(work, 'source'));
    mkdirp(path.join(work, 'someipInterfaces'));
    Object.keys(proxies).forEach((iface) => {
        const e = proxies[iface], fields = {};
        Object.keys((e && e.attributes) || {}).forEach((f) => {
            const fl = String(e.attributes[f]);
            fields[f] = { getter: fl.indexOf('r') >= 0, notifier: fl.indexOf('s') >= 0, setter: fl.indexOf('w') >= 0 };
        });
        const cfg = { comment: 'made by kit/tools/replay.js from manifest.json - not the unit\'s interface config', interface: iface, fields };
        fs.writeFileSync(path.join(work, 'someipInterfaces', iface.replace(/\./g, '_') + '.json'), JSON.stringify(cfg, null, 1));
    });
    const kitDir = path.join(work, 'source', 'javascript', 'kit');
    const spec = JSON.parse(fs.readFileSync(path.join(kitDir, 'app-spec.json'), 'utf8'));
    const mainScreen = (spec.screens && spec.screens[0] && spec.screens[0].name) || 'MAIN';

    /* ---------- report ---------- */
    const lastHeader = fixtures[fixtures.length - 1].header;
    const report = {
        tool: 'kit/tools/replay.js', format: 2,
        app: { id: spec.id, version: spec.version, title: spec.title }, stage: opt.stage,
        scenario: opt.name || lastHeader.scenario || path.basename(opt.fixtures[opt.fixtures.length - 1]),
        fixtures: fixtures.map((fx, i) => ({ file: opt.fixtures[i], sha256: fx.sha256, header: fx.header })),
        synthetic: fixtures.every((fx) => fx.header.synthetic === true),
        seed: opt.seed, epochMs, times: opt.at, gpu: !!opt.gpu, node: process.version,
        runtime: { node: process.version, v8: process.versions.v8, sort: null },
        settings: { initial: null, changes: [], final: null },
        // kit/car.js instances: the signal groups each was made with (frames[].data is the first one's data())
        cars: [],
        frames: [], logs: [], exceptions: [], unhandledRejections: [], caughtErrors: [],
        uds: { transports, requests: [], stateChanging: [] }, writes: [],
        signals: { proxies: {}, subscriptions: {}, refused: {}, fieldEvents: { delivered: 0, unwatched: {}, dropped: {} } },
        end: null, strict: null,
    };
    let fatal = null;
    const here = __dirname;
    const clean = (s) => String(s).split(work).join('<app>').split(dataDir).join('<data>').split(here).join('<kit/tools>');
    const say = (s) => { if (opt.verbose) process.stdout.write(s + '\n'); };
    const count = (o, k) => { o[k] = (o[k] || 0) + 1; };

    const clock = makeClock(epochMs, opt.seed, (e, what) => uncaught(e, what));
    function uncaught(e, what) {
        const msg = clean(e && e.stack ? e.stack : String(e));
        report.exceptions.push({ t: clock.now, in: what, error: msg });
        say('[' + clock.now + '] UNCAUGHT (' + what + ') ' + msg);
        // on the car mgu.js logs it and the app exits: the run ends here too
        if (!fatal) fatal = { t: clock.now, error: msg.split('\n')[0] };
    }

    const text = (args) => clean(Array.prototype.map.call(args, (x) => {
        if (x && x.stack) return x.stack;
        if (typeof x === 'object') { try { return JSON.stringify(x); } catch (e) { return String(x); } }
        return String(x);
    }).join(' '));
    const log = {};
    ['error', 'warn', 'info', 'debug'].forEach((lvl) => {
        log[lvl] = function () {
            const msg = text(arguments);
            report.logs.push({ t: clock.now, level: lvl, message: msg });
            // an exception the runtime caught and only logged (e.g. a signal handler that threw)
            if (lvl === 'warn' && JS_ERROR.test(msg)) report.caughtErrors.push({ t: clock.now, message: msg });
            say('[' + clock.now + '] ' + lvl + ' ' + msg);
        };
    });
    ['log', 'info', 'warn', 'error'].forEach((k) => {
        console[k] = function () { report.logs.push({ t: clock.now, level: 'console.' + k, message: clean(util.format.apply(util, arguments)) }); };
    });

    clock.install();
    report.runtime.sort = stableSort();
    process.on('unhandledRejection', (e) => {
        const msg = clean(e && e.stack ? e.stack : String(e));
        report.unhandledRejections.push({ t: clock.now, error: msg });
        say('[' + clock.now + '] UNHANDLED REJECTION ' + msg);
    });
    process.on('uncaughtException', (e) => uncaught(e, 'process'));
    // an app that ends its own process: recorded like a crash, the run stops
    process.exit = (code) => { throw new Error('the app called process.exit(' + (code === undefined ? '' : code) + ')'); };

    // the renderer: a stream file with --gpu, else a socket that is never there
    delete process.env.MGU_RENDERER;
    process.env.MGU_RENDERD_SOCKET = path.join(work, 'no-renderd.sock');
    if (opt.gpu) process.env.MGU_RENDERD_FILE = path.resolve(opt.gpu);
    else delete process.env.MGU_RENDERD_FILE;

    /* ---------- the car: SOME/IP providers as the fixtures say ---------- */
    const providers = new Map(), ifaceErrors = {}, udsRules = new Map(), declared = {};
    events.forEach((ev) => { if (ev.type === 'available') declared[ev.iface + '#' + (ev.instance || '1')] = true; });
    function provider(iface, instance) {
        const k = iface + '#' + instance;
        let p = providers.get(k);
        if (!p) { p = { iface, instance, available: false, values: {}, avl: [], subs: [] }; providers.set(k, p); }
        return p;
    }
    function setAvailable(p, on) {
        if (p.available === on) return;
        p.available = on;
        p.avl.slice().forEach((fn) => fn(on));
    }
    function notify(p, name, value) {
        const subs = p.subs.filter((s) => s.name === name);
        subs.forEach((s) => s.fn(clone(value)));
        return subs.length;
    }
    const udsKey = (ecu, bytes) => ecu + ':' + bytes.map(hex2).join(' ');
    let ALL = null;                                       // diag.js: the functional address (all units)
    function sendUds(p, params) {
        const target = Number(params.targetAddress), sid = Number(params.serviceID);
        const data = Array.prototype.slice.call(params.udsData || []);
        const req = [sid].concat(data);
        const r = { t: clock.now, target, sid, data: data.map(hex2).join(' ') };
        report.uds.requests.push(r);
        if (own(STATE_CHANGING, sid)) report.uds.stateChanging.push(Object.assign({ service: STATE_CHANGING[sid] }, r));
        udsRules.forEach((rule) => {
            if (rule.ecu !== target && target !== ALL) return;
            if (udsKey(rule.ecu, rule.requestBytes) !== udsKey(rule.ecu, req)) return;
            rule.frames.forEach((f) => {
                const head = [];
                for (let i = 0; i < TASU_HEADER; i++) head.push(i === TASU_ECU_AT ? rule.ecu : 0);
                clock.after(f.delayMs, () => {
                    if (p.available) notify(p, TASU_RESPONSE, { udsResponse: Buffer.from(head.concat(f.bytes)), errorCode: 'NO_ERROR' });
                    return Promise.resolve();
                });
            });
        });
    }
    const rejectLater = (ms, err) => new Promise((res, rej) => clock.after(ms, () => { rej(err); return Promise.resolve(); }));
    // stands in for the head unit's native "someip" module under kit/runtime/signals.js
    const someip = {
        buildProxy(cfg, instance) {
            const iface = cfg && cfg.interface;
            instance = String(instance);
            count(report.signals.proxies, iface + '#' + instance);
            if (ifaceErrors[iface]) return Promise.reject(new Error(ifaceErrors[iface]));
            if (transports.indexOf(iface) >= 0 && !declared[iface + '#' + instance]) {
                return Promise.reject(new Error('replay: no provider of ' + iface + ' (no TASU in this fixture)'));
            }
            const p = provider(iface, instance);
            const mine = { avl: [], subs: [] };
            const px = {
                init: () => Promise.resolve(),
                isAvailable: () => p.available,
                subscribeToAvailability(fn) { const w = (on) => fn(on); mine.avl.push(w); p.avl.push(w); },
                subscribe(o) {
                    const name = o && o.name;
                    if (!flagsOf(iface, name) && !listed(iface, 'broadcasts', name)) {
                        // the unit's interface config has only what the manifest lists: refused there too
                        count(report.signals.refused, iface + '.' + name);
                        throw new Error('replay: ' + name + ' is not a field or broadcast of ' + iface + ' in the app\'s manifest.json');
                    }
                    const s = { name, fn: o.onReceive };
                    mine.subs.push(s); p.subs.push(s);
                    count(report.signals.subscriptions, iface + '.' + name);
                    return Promise.resolve();
                },
                getValue(f, ms) {
                    if (!p.available) return Promise.reject(new Error('replay: ' + iface + ' not available'));
                    if (!own(p.values, f)) return rejectLater(ms || 5000, new Error('replay: no value of ' + f + ' in the fixture'));
                    return Promise.resolve(clone(p.values[f]));
                },
                setValue(f, value, ms) {
                    report.writes.push({ t: clock.now, iface, field: f, value: clone(value) });
                    if (flagsOf(iface, f).indexOf('w') < 0) return Promise.reject(new Error('replay: ' + f + ' has no setter ("w" in app.json)'));
                    return p.available ? Promise.resolve() : rejectLater(ms || 5000, new Error('replay: ' + iface + ' not available'));
                },
                callMethod(method, params, ms) {
                    if (!listed(iface, 'methods', method)) return Promise.reject(new Error('replay: ' + method + ' is not a method of ' + iface + ' in the app\'s manifest.json'));
                    if (!p.available) return rejectLater(ms || 5000, new Error('replay: ' + iface + ' not available'));
                    if (method === TASU_REQUEST && transports.indexOf(iface) >= 0) {
                        sendUds(p, params || {});
                        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
                    }
                    return rejectLater(ms || 5000, new Error('replay: no answer to ' + method + ' in the fixtures'));
                },
                shutdown() {
                    p.avl = p.avl.filter((w) => mine.avl.indexOf(w) < 0);
                    p.subs = p.subs.filter((s) => mine.subs.indexOf(s) < 0);
                },
            };
            return Promise.resolve(px);
        },
    };

    /* ---------- the app's own world: settings, UI, display ---------- */
    const Settings = (() => {
        // the real Settings class, without loading mgu.js (it needs BMW's SDK) - as preview.js does
        const src = fs.readFileSync(path.join(kitDir, 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
        const m = src.match(/class Settings[\s\S]*?\n}\n/);
        if (!m) throw new Error('no Settings class in kit/mgu.js');
        return new Function('fs', 'path', 'DATA_DIR', 'log', m[0] + '\nreturn Settings;')(fs, path, dataDir, log);
    })();
    const settings = new Settings(spec.settings);
    const schema = spec.settings || [];
    function settingValue(key, v, where) {
        const s = schema.find((x) => x.key === key);
        if (!s) throw new Error(where + ': ' + spec.id + ' has no setting ' + JSON.stringify(key));
        const options = s.type === 'choice' ? (s.options || []).map((o) => o[0]) : s.type === 'number' ? s.steps : s.type === 'bool' ? [true, false] : null;
        if (options && options.length) {
            if (options.indexOf(v) >= 0) return v;
            if (options.indexOf(String(v)) >= 0) return String(v);
            throw new Error(where + ': ' + JSON.stringify(v) + ' is not a value of ' + key + ' (' + options.map((x) => JSON.stringify(x)).join(', ') + ')');
        }
        return v;
    }
    const cliSets = [];
    try {
        events.filter((ev) => ev.type === 'settings').forEach((ev) => { ev.value = settingValue(ev.key, ev.value, ev.where); });
        opt.sets.forEach((kv) => {
            const i = kv.indexOf('=');
            if (i < 1) throw new Error('--set wants key=value, not ' + kv);
            const raw = kv.slice(i + 1), num = Number(raw);
            const v = raw === 'true' ? true : raw === 'false' ? false : raw.trim() !== '' && !isNaN(num) ? num : raw;
            cliSets.push({ key: kv.slice(0, i), value: settingValue(kv.slice(0, i), v, '--set') });
        });
    } catch (e) { usage(e.message); }

    // t = 0: the state the app starts in
    events.filter((ev) => ev.t === 0).forEach((ev) => {
        if (ev.type === 'available') provider(ev.iface, ev.instance || '1').available = ev.available;
        else if (ev.type === 'field') provider(ev.iface, ev.instance || '1').values[ev.field] = clone(ev.value);
        else if (ev.type === 'settings') settings.values[ev.key] = ev.value;
        else if (ev.type === 'error') ifaceErrors[ev.iface] = String(ev.error);
        else if (ev.type === 'uds') udsRules.set(udsKey(ev.ecu, ev.requestBytes), ev);
    });
    cliSets.forEach((kv) => { settings.values[kv.key] = kv.value; });
    report.settings.initial = clone(settings.values);

    const handlers = {}, loops = {}, visible = {}, focus = {}, visHandlers = [], focusHandlers = [];
    let shown = mainScreen;
    const images = {};
    let pushes = 0, badges = [];
    const softImage = (name, cv) => {
        images[name] = { cv, t: clock.now, n: ++pushes, badges: badges.slice() };
        return Promise.resolve();
    };
    // the HMI side of mgu.js's Ui, as far as apps and the display use it
    const ui = {
        rhmi: null, display: null, timing: { png: 0, push: 0 },
        comp: () => null,
        image(name, img) { return ui.display.present(name, img, softImage); },
        text(name, txt, row, cell) {
            if (!row && (!cell || cell === 'Text')) ui.display.label(name, txt);
            return Promise.resolve();
        },
        cells: () => Promise.resolve(), selected: () => Promise.resolve(), rows: () => Promise.resolve(),
        visible: () => Promise.resolve(), enabled: () => Promise.resolve(), checked: () => Promise.resolve(),
        onClick(name, fn) { handlers[name] = fn; },
        open(name) { show(name); return Promise.resolve(); },
        close(name) { if (name === shown) show(mainScreen); return Promise.resolve(); },
        isVisible: (name) => !!visible[name],
        hasFocus: (name) => focus[name] !== false,
        onVisible(fn) { visHandlers.push(fn); },
        onFocus(fn) { focusHandlers.push(fn); },
        _setVisible(name, on) {
            if (!!visible[name] === on) return;
            visible[name] = on;
            if (on) focus[name] = true;
            visHandlers.forEach((fn) => { try { fn(name, on); } catch (e) { log.error(e); } });
        },
        _setFocus(name, on) {
            if (ui.hasFocus(name) === on) return;
            focus[name] = on;
            focusHandlers.forEach((fn) => { try { fn(name, on); } catch (e) { log.error(e); } });
        },
        _invalidate() {},
    };
    function show(name) {
        if (name === shown && visible[name]) return;
        const was = shown;
        shown = name;
        ui._setVisible(was, false);
        ui._setVisible(name, true);
    }

    const realLoad = Module._load;
    let fakeMgu = null;
    Module._load = function (request) {
        if (request === 'someip') return someip;
        if (request === './kit/mgu' || /kit[\\/]mgu$/.test(request)) return fakeMgu;
        return realLoad.apply(this, arguments);
    };
    const themes = require(path.join(kitDir, 'themes'));
    const Display = require(path.join(kitDir, 'display')).Display;
    const Canvas = require(path.join(kitDir, 'canvas')).Canvas;
    const play = require(path.join(kitDir, 'record')).play;
    const signals = require(path.join(kitDir, 'signals'));
    ALL = require(path.join(kitDir, 'diag')).ALL;
    // what the app shows as "DEMO": the badges it hands to the page frame
    const G = require(path.join(kitDir, 'gauges'));
    const realFrame = G.frame;
    G.frame = function (cv, t, tabs, sel, b) {
        badges = (Array.isArray(b) ? b : []).filter((x) => x && x.text).map((x) => String(x.text));
        return realFrame.apply(this, arguments);
    };
    // the demo state of kit/car.js instances (data().demo), seen from outside
    const cars = [];
    const carFile = require.resolve(path.join(kitDir, 'car'));
    const RealCar = require(carFile);
    class TrackedCar extends RealCar {
        constructor(ctx, groups, opts) {
            super(ctx, groups, opts);
            cars.push(this);
            report.cars.push({ groups: Array.isArray(groups) ? groups.slice() : [] });
        }
    }
    require.cache[carFile].exports = TrackedCar;

    const themeFn = () => themes.theme(settings.get('theme'));
    const display = new Display(ui, log, spec, settings, themeFn);
    ui.display = display;
    if (opt.gpu) {
        // every captured frame goes to the stream, also an unchanged one (as preview.js)
        const send = display._send.bind(display);
        display._send = (n, o, s) => send(n, o, s, true);
    }
    const WIDGETS = [{ spawnId: 1, big: false, size: 1, visible: true }, { spawnId: 2, big: true, size: 2, visible: true }];
    let widgetFn = null;
    const ctx = {
        app: null, ui, settings, log, spec, dataDir, display, signals,
        theme: themeFn,
        controller: { grab(on) { display.grab(on); }, onInput(fn) { display.onCcu = fn; } },
        // as mgu.js: the renderer 2.x screen API (display.js); no renderer with touch routing here (software, or
        // the --gpu stream file), so the kit does not run the screen and tabs, taps and scrolling never reach them
        onTab(fn) { display.onTab = fn; },
        onTap(fn) { display.onTap = fn; },
        sheet: (sh) => display.openSheet(sh),
        hideButton(id) { display.hideButton(id); },
        onScroll(fn) { display.onScroll = fn; },
        onLayout(fn) { display.onLayout(fn); },
        canvas: (w, h) => display.canvas(w, h),
        // the screen's frame function: replay calls it at the capture times (as preview.js "render")
        loop(name, fps, fn) { loops[name] = fn; return { stop() { if (loops[name] === fn) delete loops[name]; }, kick() {} }; },
        // home-screen widget: one small and one big placed, as preview.js
        widget: spec.startWidget ? {
            ready: true, active: () => true, instances: () => WIDGETS.map((w) => Object.assign({}, w)),
            onChange() {}, onTap() {}, set: () => Promise.resolve(), image: () => Promise.resolve(),
            loop(fps, fn) { widgetFn = fn; },
        } : null,
    };
    let started = null;
    fakeMgu = {
        log, Settings, SPEC: spec,
        run(impl) {
            // as mgu.js: a start that fails is logged, it does not end the app
            started = Promise.resolve().then(() => impl && impl.start && impl.start(ctx)).then(() => ctx, (e) => { log.error('app start', e); return ctx; });
            return started;
        },
    };

    /* ---------- events ---------- */
    function applyEvent(ev) {
        if (ev.type === 'available') setAvailable(provider(ev.iface, ev.instance || '1'), ev.available);
        else if (ev.type === 'field') {
            const p = provider(ev.iface, ev.instance || '1'), key = ev.iface + '.' + ev.field;
            p.values[ev.field] = clone(ev.value);
            if (!p.available) { count(report.signals.fieldEvents.dropped, key); return; }
            if (notify(p, ev.field, ev.value)) report.signals.fieldEvents.delivered++;
            else count(report.signals.fieldEvents.unwatched, key);
        } else if (ev.type === 'settings') {
            report.settings.changes.push({ t: clock.now, key: ev.key, value: ev.value });
            settings.set(ev.key, ev.value);
        } else if (ev.type === 'error') ifaceErrors[ev.iface] = String(ev.error);
        else if (ev.type === 'uds') udsRules.set(udsKey(ev.ecu, ev.requestBytes), ev);
        else if (ev.type === 'click') {
            const fn = handlers[ev.name];
            if (!fn) { log.warn('replay: no click handler for ' + ev.name); return; }
            // as mgu.js Ui.onClick
            log.info('click ' + ev.name);
            Promise.resolve().then(() => fn({ row: ev.row || 0 })).catch((e) => log.error('click ' + ev.name, e));
        }
    }
    events.filter((ev) => ev.t > 0).forEach((ev) => clock.at(ev.t, 0, () => {
        // a callback the native binding made threw: on the car that is an uncaught exception
        try { applyEvent(ev); } catch (e) { uncaught(e, ev.type + ' event ' + ev.where); }
        return Promise.resolve();
    }));

    /**
     * Run a draw function to the end (its promise chain), on the real setImmediate. What it waits
     * for on setImmediate (kit/signals.js's native calls) takes no virtual time, so it runs here
     * too; only a wait on a timer leaves the frame for later (noted in the report).
     */
    async function settle(fn) {
        let done = false, err = null, value;
        Promise.resolve().then(fn).then((v) => { done = true; value = v; }, (e) => { done = true; err = e || new Error('rejected'); });
        for (let i = 0; i < SETTLE_TICKS && !done; i++) {
            await clock.flush();
            if (!done) await clock.immediatesNow();
        }
        return { done, err, value };
    }
    const graphicOf = (name) => {
        const s = (spec.screens || []).find((x) => x.name === name);
        return s ? s.graphic || s.name + '_GFX' : name + '_GFX';
    };
    function saveFrame(t, component, cv, extra) {
        const file = 'frames/t' + ('000000000' + t).slice(-9) + '-' + component.toLowerCase() + '.png';
        fs.writeFileSync(path.join(out, file), cv.png());
        return Object.assign({ t, component, file, pixelSha256: sha256(Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length)), width: cv.w, height: cv.h }, extra);
    }
    async function capture(t) {
        const screen = shown, comp = graphicOf(screen), before = images[comp] && images[comp].n;
        const notes = [];
        if (loops[screen]) {
            const r = await settle(loops[screen]);
            if (r.err) log.error('loop ' + screen, r.err);              // as mgu.js
            if (!r.done) notes.push('the screen\'s frame function had not finished');
        } else notes.push('no frame function for ' + screen);
        const demo = require(path.join(kitDir, 'datastate')).isDemo();
        // what kit/car.js hands the app as current (apps without a Car: null)
        const data = cars.length ? clone(cars[0].data()) : null;
        let img = images[comp];
        if (opt.gpu && display.app && display.active()) {
            // the GPU recording (the app's part; header and bar are in screen pixels and skipped)
            const cv = display._softFrame(display.app);
            img = { cv, t: clock.now, n: img ? img.n : 0, badges: img ? img.badges : badges.slice(), source: 'gpu' };
        }
        if (img) {
            report.frames.push(saveFrame(t, comp, img.cv, { screen, source: img.source || 'software', drawnAt: img.t, newImage: img.n !== before, demo, data, badges: img.badges, notes }));
        } else report.frames.push({ t, component: comp, screen, file: null, pixelSha256: null, demo, data, badges: [], notes: notes.concat(['nothing drawn yet']) });
        if (widgetFn) {
            for (const w of WIDGETS) {
                const r = await settle(() => widgetFn(Object.assign({}, w)));
                const name = 'widget_' + (w.big ? 'big' : 'small');
                if (r.err) { log.error('widget draw', r.err); continue; }           // as mgu.js
                if (r.value && r.value.d) report.frames.push(saveFrame(t, name, r.value, { screen: 'widget', source: 'software', demo, badges: [], notes: r.done ? [] : ['not finished'] }));
                else report.frames.push({ t, component: name, screen: 'widget', file: null, pixelSha256: null, demo, badges: [], notes: ['no picture'] });
            }
        }
    }
    opt.at.forEach((t) => clock.at(t, 1, () => capture(t)));

    /* ---------- start ---------- */
    say('replay ' + spec.id + ' ' + spec.version + ' with ' + opt.fixtures.map((f) => path.basename(f)).join(' + ') + ', seed ' + opt.seed);
    try {
        require(path.join(work, 'source', 'javascript', 'app.js'));
    } catch (e) { uncaught(e, 'loading app.js'); }
    let opened = false;
    const openMain = () => { if (!opened && !fatal) { opened = true; ui._setVisible(shown, true); } };
    if (started) {
        // as mgu.js: the entry point opens the main screen once start is done, or after 5 s
        started.then(() => clock.at(clock.now, 0, () => { openMain(); return Promise.resolve(); }));
        clock.after(START_STEP_MS, () => {
            if (!opened) { log.warn('app start still pending after ' + START_STEP_MS + ' ms, continuing'); openMain(); }
            return Promise.resolve();
        });
    } else if (!fatal) log.error('replay: app.js never called mgu.run()');
    await clock.flush();
    await clock.runUntil(opt.at[opt.at.length - 1], () => !!fatal);

    /* ---------- report ---------- */
    report.settings.final = clone(settings.values);
    report.end = { t: clock.now, stoppedEarly: fatal, timersPending: clock.pending() };
    const reasons = [];
    report.exceptions.forEach((e) => reasons.push('uncaught exception at ' + e.t + ' ms (' + e.in + '): ' + e.error.split('\n')[0]));
    report.unhandledRejections.forEach((e) => reasons.push('unhandled rejection at ' + e.t + ' ms: ' + e.error.split('\n')[0]));
    report.logs.filter((l) => l.level === 'error').forEach((l) => reasons.push('log.error at ' + l.t + ' ms: ' + l.message.split('\n')[0]));
    report.strict = { enabled: opt.strict, failed: reasons.length > 0, reasons };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
    try { rmrf(work); } catch (e) { /* a file still open: left in the temp folder */ }
    const n = (lvl) => report.logs.filter((l) => l.level === lvl).length;
    process.stdout.write('replay ' + spec.id + ' / ' + report.scenario + ': ' + report.frames.length + ' frames, ' + n('error') + ' errors, ' +
        n('warn') + ' warnings, ' + report.exceptions.length + ' uncaught, ' + report.unhandledRejections.length + ' unhandled rejections' +
        (fatal ? ', stopped at ' + fatal.t + ' ms' : '') + ' -> ' + path.join(out, 'report.json') + '\n');
    if (opt.strict) reasons.forEach((r) => process.stdout.write('  strict: ' + r + '\n'));
    return opt.strict && reasons.length ? 1 : 0;
}

main().then((code) => {
    // the app's virtual timers keep nothing alive; anything real it opened must not either
    process.exitCode = code;
    REAL.setTimeout(() => REAL.exit.call(process, code), 2000).unref();
}, (e) => {
    process.stderr.write('replay.js: ' + (e && e.stack ? e.stack : e) + '\n');
    REAL.exit.call(process, 3);
});
