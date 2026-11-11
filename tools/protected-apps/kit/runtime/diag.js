'use strict';
/**
 * UDS over TASU - the head unit's own diagnostic transport, used the same way
 * BMW's ts_diagnostic_service does (its tasuHandler / DTC read controllers):
 *
 *   request : sendTasuRequest{ sourceAddress 0xF2, targetAddress (0xDF = all ECUs),
 *             serviceID, subroutineID 0, udsData = the bytes after the service id }
 *   reply   : event sendTasuResponse{ udsResponse, errorCode }. The frame has a
 *             9-byte header: [2] 0x7F = rejected by the transport (code in [4]),
 *             [6] = address of the ECU that answered, UDS reply from [9] on.
 *
 * A functional (0xDF) request gets one reply per ECU; BMW collects them until
 * nothing arrives for a while. 0x7F xx 0x78 = "response pending" (wait longer).
 *
 * Behaviour as upstream idrive7-apps' kit (origin/main 5389acc), on purpose (customer directive 2026-11-04:
 * every check of the kit as upstream's, proven on real cars; MGU Tools' own stricter rules caused errors on a car):
 *   - every service passes (reading, writing, routines, sessions, security access, clearing); a request the
 *     transport turns away as busy (BUSY / TEMPORARILY_NOT_ACCEPTED) is sent again, opts.maxRetries times
 *     (default 4) after busyMs (or opts.retryBaseMs) x 1, 2, 3, 4; opts.callTimeoutMs the binding's call timeout
 *   - a call that gives no verdict counts as NO_ERROR (upstream); 'transport refused: <verdict>' otherwise
 *   - physical: a frame from the unit asked is the reply, unless the caller's accept(uds) says it is not
 *     (replyTo(sid, data) builds the usual one); its own 7F <sid> 78 waits pendingTimeoutMs (10 s) longer, another
 *     service's 78 is ignored; opts.hardTimeoutMs ends it whatever comes; null when nothing came in time
 *   - functional: this service's replies (0x19: of this sub-function) per unit until nothing came for idleMs (the
 *     first ones idleMs + 2 s, after a 78: 10 s), at most maxMs (25 s); a unit's later final reply replaces an
 *     earlier one; a unit still at 78 maps to that 78 frame
 *   - transport reject / error events are emitted ('tasReject', 'tasError') and end no request
 *
 * MGU Tools' API on top (apps call it; it adds no condition of its own): request() and readAll() (the outcome of a
 * physical / functional request as an object), cbsResetOptions() / armCbsReset() / resetCbs() (Service's CBS
 * reset of the cluster, as upstream Service sends it), clearFaultMemory() / confirmClear() (14 FF FF FF to one
 * unit), parseDtcReply()'s extra fields, isFault(), monoNow(), nrcText(), READ_SERVICES, SERVICE_NAMES,
 * CLEAR_RULES (numbers the Fault Scanner's own flow shows; nothing here enforces them).
 */
const EventEmitter = require('events');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const TESTER = 0xF2;
const ALL = 0xDF;

function toBytes(b) {
    if (!b) return [];
    if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Array.prototype.slice.call(b);
    if (Array.isArray(b)) return b.slice();
    if (b.data) return toBytes(b.data);
    if (typeof b === 'object' && typeof b.length === 'number') return Array.prototype.slice.call(b);
    return [];
}
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');

const NRC = {
    0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported', 0x13: 'bad length',
    0x21: 'busy', 0x22: 'conditions not correct', 0x31: 'out of range', 0x33: 'security access denied',
    0x72: 'programming failure', 0x78: 'pending', 0x7E: 'not supported in session', 0x7F: 'not supported in session',
};
const nrcText = (c) => 'NRC ' + hex(c) + (NRC[c] ? ' ' + NRC[c] : '');
/** Monotonic milliseconds (ages, waits): they do not jump with the head unit's wall clock. */
function monoNow() { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; }

/** Services that only read (names for logs; the generic calls take every service). */
const READ_SERVICES = Object.freeze({
    0x19: 'ReadDTCInformation', 0x22: 'ReadDataByIdentifier', 0x01: 'OBD current data', 0x06: 'OBD monitor test results',
    0x09: 'OBD vehicle information',
});
/** Names for logs and errors (ISO 14229-1). */
const SERVICE_NAMES = Object.freeze({
    0x10: 'DiagnosticSessionControl', 0x11: 'ECUReset', 0x14: 'ClearDiagnosticInformation', 0x23: 'ReadMemoryByAddress',
    0x24: 'ReadScalingDataByIdentifier', 0x27: 'SecurityAccess', 0x28: 'CommunicationControl', 0x2A: 'ReadDataByPeriodicIdentifier',
    0x2C: 'DynamicallyDefineDataIdentifier', 0x2E: 'WriteDataByIdentifier', 0x2F: 'InputOutputControlByIdentifier',
    0x31: 'RoutineControl', 0x34: 'RequestDownload', 0x35: 'RequestUpload', 0x36: 'TransferData', 0x37: 'RequestTransferExit',
    0x38: 'RequestFileTransfer', 0x3D: 'WriteMemoryByAddress', 0x3E: 'TesterPresent', 0x83: 'AccessTimingParameter',
    0x84: 'SecuredDataTransmission', 0x85: 'ControlDTCSetting', 0x86: 'ResponseOnEvent', 0x87: 'LinkControl',
});
/** The Fault Scanner's clear flow (its own screen, apps/dtc_scanner): the numbers it shows. Not enforced here. */
const CLEAR_RULES = Object.freeze({
    maxScanAgeMs: 180000, reviewMs: 1000, pauseMs: 3000, confirmMs: 15000, speedAgeMs: 5000, idleMs: 60000, timeoutMs: 6000, maxMs: 30000,
});

class Diag extends EventEmitter {
    constructor(signals, log) {
        super();
        this.signals = signals; this.log = log;
        this.p = null; this.available = false; this.error = null;
        this.quiet = false;           // true: don't log every request (apps that poll)
        this.busyMs = 1000;           // pause before a retry when the transport is busy (x 1, 2, 3, 4)
        this.busyLog = true;          // log each busy verdict (false: only count them in .busy)
        this.busy = 0;
    }

    async init() {
        try {
            this.p = await this.signals.proxy(IFACE, INSTANCE);
            await this.signals.on(this.p, 'sendTasuResponse', (v) => this._onResponse(v), this.log);
            await this.signals.onAvailable(this.p, (a) => { this.available = a; this.emit('available', a); });
            this.log.info('TASU proxy ready (available=' + this.available + ')');
        } catch (e) {
            this.error = String(e);
            this.log.warn('TASU: ' + e);
        }
        return this;
    }

    _onResponse(v) {
        const err = v && v.errorCode;
        if (err !== undefined && err !== 'NO_ERROR' && err !== 0) { this.emit('tasError', String(err)); return; }
        const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
        if (b.length >= 5 && b[2] === 0x7F) { this.emit('tasReject', b[4]); return; }
        if (b.length < 10) { this.log.warn('short TASU frame ' + b.map((x) => hex(x)).join('')); return; }
        this.emit('frame', { ecu: b[6], uds: b.slice(9) });
    }

    /**
     * Send one request; resolves with the transport's verdict ('NO_ERROR', 'REQUEST_PENDING', ...).
     * The transport turns requests away while it is still busy with an earlier one (e.g. a second
     * functional request a few seconds after the first: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED), so
     * such a verdict is retried a few times with a growing pause (busyMs x 1, 2, 3, 4: 1, 2, 3, 4 s).
     */
    async send(target, sid, data, opts) {
        if (!this.p) throw new Error(this.error || 'no diagnostic link');
        const d = toBytes(data);
        const maxRetries = opts && opts.maxRetries != null ? opts.maxRetries : 4;
        const callTimeoutMs = opts && opts.callTimeoutMs || 8000;
        const retryBaseMs = opts && opts.retryBaseMs || this.busyMs;
        // (requests that change something are logged also by an app that polls quietly)
        if (!this.quiet || !READ_SERVICES[sid]) this.log.info('UDS -> ' + hex(target) + ': ' + hex(sid) + ' ' + d.map((x) => hex(x)).join(' '));
        for (let attempt = 0; ; attempt++) {
            const r = await this.signals.call(this.p, 'sendTasuRequest', {
                sourceAddress: TESTER, targetAddress: target, serviceID: sid, subroutineID: 0,
                udsDataLength: d.length, udsData: Buffer.from(d), deadlockTime: 0,
            }, callTimeoutMs);
            const v = r && typeof r === 'object' ? (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
            const verdict = v === undefined ? 'NO_ERROR' : String(v);
            if (!/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) || attempt >= maxRetries) return verdict;
            this.busy++;
            if (this.busyLog) this.log.info('transport busy (' + verdict + '), retrying');
            await new Promise((res) => setTimeout(res, retryBaseMs * (attempt + 1)));
        }
    }

    _check(verdict) {
        if (verdict !== 'NO_ERROR' && verdict !== 'REQUEST_PENDING' && verdict !== '0' && verdict !== '1') throw new Error('transport refused: ' + verdict);
    }

    /**
     * Functional request to all ECUs. Resolves with Map(ecu -> final UDS reply)
     * once no reply arrived for idleMs (BMW waits up to 10 s per reply).
     */
    async functional(sid, data, opts) {
        return (await this._functional(sid, data, opts)).replies;
    }
    /** functional() with how it ended: { replies, ended: 'idle' | 'deadline', verdict } */
    async _functional(sid, data, opts) {
        const idleMs = (opts && opts.idleMs) || 4000, maxMs = (opts && opts.maxMs) || 25000;
        const d = toBytes(data);
        const replies = new Map();
        let idle, hard, onFrame, onErr, finish, kick, verdict = null;
        const done = new Promise((resolve) => {
            finish = (ended) => { clearTimeout(idle); clearTimeout(hard); this.removeListener('frame', onFrame); this.removeListener('tasError', onErr); resolve({ replies, ended, verdict }); };
            kick = (ms) => { clearTimeout(idle); idle = setTimeout(() => finish('idle'), ms); };
            onFrame = (f) => {
                // every app gets every frame: only this service's answer (or refusal) is a reply
                if (f.uds[0] !== sid + 0x40 && !(f.uds[0] === 0x7F && f.uds[1] === sid)) return;
                if (sid === 0x19 && f.uds[0] === 0x59 && f.uds[1] !== d[0]) return;   // 0x19 echoes its sub-function
                const pending = f.uds[0] === 0x7F && f.uds[2] === 0x78;
                if (!pending || !replies.has(f.ecu)) replies.set(f.ecu, f.uds);
                if (opts && opts.onReply && !pending) opts.onReply(f.ecu, replies.size);
                kick(pending ? 10000 : idleMs);
            };
            onErr = (e) => this.log.warn('TASU error during scan: ' + e);
            this.on('frame', onFrame); this.on('tasError', onErr);
        });
        try { verdict = await this.send(ALL, sid, d); this._check(verdict); } catch (e) { finish('failed'); throw e; }
        // timers from when the transport took the request (send() may have waited for it)
        if (!idle) kick(idleMs + 2000);          // first replies can take a moment
        hard = setTimeout(() => finish('deadline'), maxMs);
        return done;
    }

    /**
     * Physical request to one ECU; resolves with its UDS reply (null on timeout).
     * accept(uds) (optional) skips replies that aren't ours - another app may be
     * talking to the same ECU at the same time.
     * opts: send()'s (maxRetries, callTimeoutMs, retryBaseMs), pendingTimeoutMs (after this request's 78, 10 s),
     * hardTimeoutMs (from now, whatever comes); maxMs (MGU Tools: from when the transport took it, if given).
     */
    async physical(target, sid, data, timeoutMs, accept, opts) {
        return (await this._physical(target, sid, data, timeoutMs, accept, opts)).uds;
    }
    /** physical() with { uds, verdict, pending: a 78 of this request came } */
    async _physical(target, sid, data, timeoutMs, accept, opts) {
        let t, hardTimer, maxTimer, onFrame, finish, done = false, pending = false, verdict = null;
        const got = new Promise((resolve) => {
            finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(t); clearTimeout(hardTimer); clearTimeout(maxTimer);
                this.removeListener('frame', onFrame); resolve({ uds: v, verdict, pending });
            };
            onFrame = (f) => {
                if (f.ecu !== target) return;
                if (f.uds[0] === 0x7F && f.uds[2] === 0x78) {      // response pending: never the reply itself
                    if (f.uds[1] !== sid) return;                       // another request's (another app's) 78
                    pending = true;
                    clearTimeout(t);
                    t = setTimeout(() => finish(null), opts && opts.pendingTimeoutMs || 10000);
                    return;
                }
                if (accept && !accept(f.uds)) return;
                finish(f.uds);
            };
            this.on('frame', onFrame);
            if (opts && opts.hardTimeoutMs) hardTimer = setTimeout(() => finish(null), opts.hardTimeoutMs);
        });
        try { verdict = await this.send(target, sid, data, opts); this._check(verdict); } catch (e) { finish(null); throw e; }
        if (!done && !t) t = setTimeout(() => finish(null), timeoutMs || 4000); // from when the transport took it
        if (!done && opts && opts.maxMs > 0) maxTimer = setTimeout(() => finish(null), opts.maxMs);
        return got;
    }

    /**
     * One request to one control unit with its outcome; never rejects:
     *   { ok, uds, nrc, outcome: 'reply' | 'negative' | 'timeout' | 'refused' | 'failed', why, pending, verdict }
     * o = { timeoutMs (default 4 s), accept(uds), and physical()'s opts }. As physical(), nothing more.
     */
    async request(target, sid, data, o) {
        o = o || {};
        let r;
        try { r = await this._physical(target, sid, data, o.timeoutMs || 4000, o.accept || null, o); } catch (e) {
            const why = String((e && e.message) || e);
            return { ok: false, uds: null, nrc: null, outcome: /^transport refused/.test(why) ? 'refused' : 'failed', why, pending: false, verdict: null };
        }
        const u = r.uds, neg = !!u && u[0] === 0x7F;
        return {
            ok: !!u && !neg, uds: u || null, nrc: neg ? u[2] : null, outcome: !u ? 'timeout' : neg ? 'negative' : 'reply',
            why: !u ? (r.pending ? 'no final reply (still "response pending")' : 'no reply') : neg ? nrcText(u[2]) : '', pending: r.pending, verdict: r.verdict,
        };
    }

    /**
     * Functional request to all units with how it ended (as functional(), nothing more):
     *   { replies: Map(unit -> its final reply, positive or negative), pending: [units at 78 when it ended],
     *     ended: 'idle' | 'deadline', why, verdict }. Throws when the request could not be sent.
     */
    async readAll(sid, data, opts) {
        const r = await this._functional(sid, data, opts);
        const replies = new Map(), pending = [];
        r.replies.forEach((u, ecu) => { if (u[0] === 0x7F && u[2] === 0x78) pending.push(ecu); else replies.set(ecu, u); });
        return { replies, pending, ended: r.ended, why: '', verdict: r.verdict };
    }

    /* ---------- Service: the cluster's CBS reset (as upstream Service sends it) ---------- */

    /** The cluster's resettable CBS items (22 1002): { items: [03 / 64 the cluster allows now], at }. */
    async cbsResetOptions() {
        const r = await this.request(CBS_ECU, 0x22, [0x10, 0x02], { timeoutMs: 5000, accept: replyTo(0x22, [0x10, 0x02]) });
        const u = r.uds;
        if (!r.ok || !u || u[0] !== 0x62) throw refusal('CBS_NOT_AVAILABLE', 'CBS reset list unavailable: ' + (r.why || 'invalid reply'));
        const ids = [];
        for (let i = 3; i + 3 <= u.length; i += 3) if ((u[i] === 0x03 || u[i] === 0x64) && u[i + 1] === 0 && ids.indexOf(u[i]) < 0) ids.push(u[i]);
        return Object.freeze({ items: Object.freeze(ids), at: monoNow() });
    }
    /** The app confirmed the reset of item (its own two presses): what resetCbs() takes. */
    armCbsReset(offer, item) {
        return Object.freeze({ item, issued: monoNow() });
    }
    /** 2E 1001 for item, as upstream Service sends it; resolves with request()'s outcome. */
    async resetCbs(item, confirmation) {
        const it = item != null ? item : confirmation && confirmation.item;
        const data = [0x10, 0x01, 0x01, it, 0x64, 0x1F, 0x80, 0x00, 0x0F, 0xFF, 0x0F, 0x3F, 0xFF, 0x00];
        return this.request(CBS_ECU, 0x2E, data, { timeoutMs: 6000, hardTimeoutMs: 30000, accept: replyTo(0x2E, [0x10, 0x01]) });
    }

    /* ---------- the Fault Scanner's clear of one unit ---------- */

    /** 14 FF FF FF to unit; { unit, ok, outcome, uds, nrc, why, verdict, pending } (bounded at CLEAR_RULES.maxMs). */
    async clearFaultMemory(unit, confirmation) {
        void confirmation;
        const r = await this.request(unit, 0x14, [0xFF, 0xFF, 0xFF], { timeoutMs: CLEAR_RULES.timeoutMs, hardTimeoutMs: CLEAR_RULES.maxMs, accept: replyTo(0x14, []) });
        this.log.info('clear ' + hex(unit) + ': ' + (r.ok ? 'cleared' : r.outcome + (r.why ? ' (' + r.why + ')' : '')) + ', verdict ' + r.verdict);
        return { unit, ok: r.ok, outcome: r.outcome, uds: r.uds, nrc: r.nrc, why: r.why, verdict: r.verdict, pending: r.pending };
    }
}

const CBS_ECU = 0x60;
function refusal(code, message) { const e = new Error(message); e.code = code; return e; }

/** What the Fault Scanner's clear flow confirmed (the units listed): clearFaultMemory()'s second argument. */
function confirmClear(ev) {
    const units = ev && Array.isArray(ev.units) ? ev.units.slice() : [];
    return Object.freeze({ units: Object.freeze(units), issued: monoNow() });
}

// Request bytes a positive reply echoes after sid + 0x40: sub-function (10 / 11 / 27), DID (22 / 2E), DID + control
// parameter (2F: 6F 60FD 03 .. is OPEN's answer, not OEM's 6F 60FD 00), sub-function + RID (31).
const ECHO = { 0x10: 1, 0x11: 1, 0x27: 1, 0x22: 2, 0x2E: 2, 0x2F: 3, 0x31: 3 };
/** accept(uds) for physical(): every app gets every frame from the ECU (car_vitals polls the DME), so
 * only this request's positive reply with its echo, or a refusal of this service, is the answer. */
function replyTo(sid, data) {
    const echo = toBytes(data).slice(0, ECHO[sid] || 0);
    return (u) => !!u && ((u[0] === sid + 0x40 && echo.every((b, i) => u[i + 1] === b)) || (u[0] === 0x7F && u[1] === sid));
}

/**
 * ISO 14229-1 status bits: 0 testFailed, 1 testFailedThisOperationCycle, 2 pendingDTC, 3 confirmedDTC,
 * 4 testNotCompletedSinceLastClear, 5 testFailedSinceLastClear, 6 testNotCompletedThisOperationCycle,
 * 7 warningIndicatorRequested. An entry with only bits 4 / 6 records no failure (a test not run yet).
 */
const FAILURE_BITS = 0xAF;              // every status bit but 4 and 6
function isFault(status) { return (status & FAILURE_BITS) !== 0; }

/**
 * Parse a 0x19 reply. params = the request bytes after 0x19 (e.g. [0x02, 0x0C]).
 * The DTC records start after the echoed request bytes + availability mask,
 * i.e. at 1 + params.length (BMW: offset 10 + params/2 in the full frame).
 * { ok, nrc, dtcs } as upstream (every entry of the reply), and for information: state ('ok' | 'negative' |
 * 'unexpected' | 'none'), why, notFaults (the entries with only bits 4 / 6: isFault), partial (bytes after the last
 * whole entry).
 */
function parseDtcReply(uds, params) {
    if (!uds || !uds.length) return { ok: false, nrc: null, dtcs: [], state: 'none', why: 'no reply', notFaults: [], partial: false };
    if (uds[0] === 0x7F) {
        return { ok: false, nrc: uds[2], dtcs: [], state: 'negative', notFaults: [], partial: false,
            why: uds[2] === 0x78 ? 'still busy (response pending) when the scan ended' : 'refused: ' + nrcText(uds[2]) };
    }
    if (uds[0] !== 0x59 || uds[1] !== params[0]) return { ok: false, nrc: null, dtcs: [], state: 'unexpected', why: 'not a reply to this request', notFaults: [], partial: false };
    const out = [], start = 1 + params.length;
    for (let i = start; i + 4 <= uds.length; i += 4) {
        out.push({ code: hex(((uds[i] << 16) | (uds[i + 1] << 8) | uds[i + 2]) >>> 0, 6), status: uds[i + 3] });
    }
    return { ok: true, nrc: null, dtcs: out, state: 'ok', why: '', notFaults: out.filter((x) => !isFault(x.status)),
        partial: uds.length > start && (uds.length - start) % 4 !== 0 };
}

/** ISO 14229 DTC status byte -> the label we show + severity. */
function statusInfo(b) {
    if (b & 0x01) return { label: 'ACTIVE', sev: 'crit' };
    if (b & 0x80) return { label: 'WARNING LAMP', sev: 'crit' };
    if (b & 0x04) return { label: 'PENDING', sev: 'warn' };
    if (b & 0x08) return { label: 'STORED', sev: 'warn' };
    return { label: 'HISTORY', sev: 'dim' };
}

module.exports = {
    Diag, parseDtcReply, statusInfo, toBytes, hex, NRC, ALL, replyTo,
    isFault, READ_SERVICES, SERVICE_NAMES, CLEAR_RULES, confirmClear, monoNow, nrcText,
};
