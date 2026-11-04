'use strict';
/**
 * car.js - the common driving signals, scaled, with demo fallback.
 *
 *   const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque'], extra);
 *   extra (optional) = { iface: { field: fn } }, more fields on the same watches (one proxy per interface);
 *         or MGU Tools' form { extra, lateralAccel: false (no lateral watch), staleMs: { key: ms } (marks only) }
 *   car.setRedline(rpm) -> the demo drive revs to this rpm (default 7000)
 *   car.data()      -> { rpm, speed, gLong, gLat, coolant, oil, gear, stage, torque, condition, demo, gearGuessed,
 *                        quality: { key: 'live' | 'stale' | 'invalid' | 'unavailable' | 'demo' }, state }
 *   car.onSample(fn, reset) -> fn(data, tMs) on every new speed/rpm/accel sample (also in demo, 20 Hz); tMs is
 *                        kit/clock.js monotonic: only differences mean anything. reset() when live <-> demo switches
 *   car.onUpdate(fn)   -> fn(data) whenever a value, a mark or the source changes (MGU Tools)
 *   car.sample(key)    -> { key, value, quality, source, received_at_monotonic, provenance } (MGU Tools, marks)
 *   car.close()        -> stops the simulator, the subscriptions and the DEMO registration (MGU Tools)
 *
 * Scalings are BMW's own (M Laptimer TypeConverters); an app's app.json
 * "config.scaling" entries override them. The app's app.json "signals" must
 * list the interfaces (see SIGNALS below for the exact entries).
 * Demo: setting "demo" = auto (until the car answers) / on / off.
 * data().stage = the selector position 'P' / 'R' / 'N' / 'D' (gearbox signal), else undefined.
 * data().condition = BMW's vehicle state number ('condition' group; 10 = drive-ready), else undefined.
 *
 * Values and demo exactly as upstream idrive7-apps' kit (customer directive 2026-11-04): the last value the car sent
 * stays until it sends another - a raw value that is invalid (a sentinel, NaN, a struct without the field) changes
 * nothing, and neither does the car going quiet or its provider going away. Negative torque (engine braking) counts
 * as 0. "auto" (and any value but "on" / "off") shows demo data while nothing came from the car 5 s after the start;
 * the simulator runs all the time (20 Hz) so the switch is seamless. data().quality and data().state are marks for
 * apps that show them, never a reason to hide a value: 'stale' = the provider went away after the value came (or it
 * is older than opts.staleMs[key]), 'invalid' = the newest raw value was invalid, 'unavailable' = nothing came yet.
 * While demo data is shown kit/datastate.js has the runtime mark the frames and widgets DEMO (it only labels them).
 */
const Sim = require('./sim');
const clock = require('./clock');
const datastate = require('./datastate');

const SCALE = {
    rpm: { factor: 0.25, offset: 0, invalid: 65535 },
    speed: { factor: 0.015625, offset: 0, invalid: 65535 },
    accel: { factor: 0.002, offset: -65, invalid: 65535 },
    temp: { factor: 1, offset: -48, invalid: 255 },
    // 12 bit, 0.5 Nm per bit with 0 Nm at raw 2047 (negative = engine braking), 4095 = 'no value'
    torque: { factor: 0.5, offset: -1023.5, invalid: 65535, invalidFrom: 4095 },
};
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
// the binding may hand enums over as names or as wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2)
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);
// selector position (statusActualStageDrive): names or wire numbers (P = 1, R = 2, N = 3, D = 4);
// the gear field alone can't tell P from N (both N_OR_P)
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const stageOf = (x) => STAGES[x];
// VehicleCondition.statusConditionVehicle (BMW's vehicle state): names or wire numbers -> number.
// 5 = WOHNEN (living, no ignition), 7 = PRUEFEN_ANALYSE_DIAGNOSE (ignition on), 8 = drive
// readiness starting, 10 = FAHREN (drive-ready / READY, also with the engine off on a hybrid),
// 12 = drive readiness ending; 15 = no value.
const CONDITIONS = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const conditionOf = (x) => { const n = typeof x === 'number' ? x : CONDITIONS[x]; return n >= 1 && n <= 12 ? n : undefined; };
/**
 * DataPowerTrain2.statusGearSelectionDrive: P / R / N and the engaged gear in one enum, names or
 * wire numbers (N = 1, R = 2, P = 3, NP = 4, _1 = 5 ... _9 = 13) -> { stage, gear } or undefined.
 * Some cars never send statusGearboxDrive; this field comes in another event group.
 */
function selectionOf(x) {
    const n = typeof x === 'number' ? x : { N: 1, R: 2, P: 3, NP: 4 }[x] || (/^_\d$/.test(String(x)) ? 4 + Number(String(x).slice(1)) : undefined);
    if (n === 1) return { stage: 'N', gear: 0 };
    if (n === 2) return { stage: 'R', gear: -1 };
    if (n === 3) return { stage: 'P', gear: 0 };
    if (n === 4) return { stage: undefined, gear: 0 };              // N or P, not told apart
    if (n >= 5 && n <= 13) return { stage: 'D', gear: n - 4 };
    return undefined;                                               // initialising / invalid
}

// app.json "signals" entries per group (copy into the app)
const SIGNALS = {
    rpm: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2'],
    temps: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature'],
    speed: ['de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2'],
    accel: ['de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', 'statusLateralAccelerationMassCenter'],
    gear: ['de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', 'DataPowerTrain2'],
    torque: ['de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2'],
    condition: ['de.bmw.infrastructure.VehicleCondition', 'VehicleCondition'],
};

/**
 * Learns the gearbox from rpm/speed ratios (one cluster per gear) so a gear
 * can be shown even when the car doesn't publish statusGearboxDrive.
 */
class GearGuess {
    constructor() { this.cl = []; }
    feed(rpm, kmh) {
        if (!(rpm > 1100 && kmh > 8)) return null;
        const k = rpm / kmh;
        let c = this.cl.find((x) => Math.abs(x.k - k) / x.k < 0.05);
        if (!c) { if (this.cl.length > 24) this.cl.sort((a, b) => b.n - a.n).pop(); c = { k, n: 0 }; this.cl.push(c); }
        c.n++; c.k += (k - c.k) / Math.min(c.n, 50);
        const gears = this.cl.filter((x) => x.n > 30).sort((a, b) => b.k - a.k);
        const i = gears.findIndex((x) => Math.abs(x.k - k) / x.k < 0.05);
        return i < 0 ? null : i + 1;
    }
}

/** The third argument: upstream's map of more fields, or MGU Tools' { extra, lateralAccel, staleMs }. */
const OPTS = ['extra', 'lateralAccel', 'staleMs'];
function optsOf(x) {
    if (!x || typeof x !== 'object') return { extra: {} };
    const keys = Object.keys(x);
    if (keys.some((k) => OPTS.indexOf(k) >= 0) && !keys.some((k) => k.indexOf('.') >= 0)) {
        return { extra: x.extra || {}, lateralAccel: x.lateralAccel, staleMs: x.staleMs || {} };
    }
    return { extra: x, staleMs: {} };
}
let instances = 0;

class Car {
    constructor(ctx, groups, extra) {
        const o = optsOf(extra);
        groups = groups || [];
        this.ctx = ctx; this.log = ctx.log;
        const over = (ctx.spec && ctx.spec.config && ctx.spec.config.scaling) || {};
        this.S = Object.assign({}, SCALE, over);
        this.live = {}; this.received = false; this.lastCar = 0; this.listeners = []; this.updateListeners = [];
        this.sim = new Sim(); this.simData = this.sim.sample();
        this.demoActive = false; this.guess = new GearGuess(); this.closed = false;
        this.demoSource = 'car' + (++instances);
        // marks only (data().quality): key -> { quality: 'live' | 'invalid', at, raw }; iface -> 'up' | 'down' | 'error'
        this.marks = {}; this.providers = {}; this.keyIface = {}; this.keySource = {}; this.staleMs = o.staleMs;
        const sc = (k, raw) => {
            const c = this.S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid || (c.invalidFrom !== undefined && raw >= c.invalidFrom)) return null;
            return raw * c.factor + (c.offset || 0);
        };
        const put = (k, v, tick, raw) => {
            if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) { this._mark(k, 'invalid', raw); return; }
            this.live[k] = v; this.received = true; this.lastCar = clock.now();
            this._mark(k, 'live', raw);
            // learned gear while driving; nothing at a standstill - the guess can't tell P, N or D
            // there, and "N" shown in park or in D was wrong
            if (k === 'rpm' || k === 'speed') { const g = this.guess.feed(this.live.rpm, this.live.speed); if (g !== null || this.live.speed < 3) this.guessed = this.live.speed < 3 ? undefined : g; }
            if (tick && !this.demoActive) this._emit(this.live, this.lastCar);
            this._updated();
        };
        const watches = {};
        const add = (iface, field, fn, keys) => {
            (watches[iface] = watches[iface] || {})[field] = fn;
            (keys || []).forEach((k) => { this.keyIface[k] = iface; this.keySource[k] = 'someip:' + iface.split('.').pop() + '.' + field; });
        };
        const CDS = 'de.bmw.infotainment.vehicle.CDS', CDS2 = 'de.bmw.infotainment.vehicle.CDS2', VI = 'de.bmw.infrastructure.VehicleInformation';
        if (groups.includes('rpm')) add(CDS, 'statusEngineSpeed2', (v) => put('rpm', sc('rpm', v && v.actualValueRPMEngineCrankshaft), true, v && v.actualValueRPMEngineCrankshaft), ['rpm']);
        if (groups.includes('temps')) {
            add(CDS, 'statusEngineTemperature', (v) => {
                put('coolant', sc('temp', v && v.temperatureEngineDrive), false, v && v.temperatureEngineDrive);
                put('oil', sc('temp', v && v.temperatureEngineOilDrive), false, v && v.temperatureEngineOilDrive);
            }, ['coolant', 'oil']);
        }
        if (groups.includes('speed')) add('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', (v) => put('speed', sc('speed', v && v.speedVehicleCentreOfGravity), true, v && v.speedVehicleCentreOfGravity), ['speed']);
        if (groups.includes('accel')) {
            add(CDS2, 'statusLongitudinalAccelerationMassCenter', (v) => {
                const raw = v && v.longitudinalAccelerationCentreOfGravity, a = sc('accel', raw);
                put('gLong', a === null ? null : a / 9.80665, true, raw);
            }, ['gLong']);
            // (MGU Tools: an app that reads no lateral g can leave the watch out, lateralAccel: false)
            if (o.lateralAccel !== false) {
                add(CDS2, 'statusLateralAccelerationMassCenter', (v) => {
                    const raw = v && v.lateralAccelerationCentreOfGravity, a = sc('accel', raw);
                    put('gLat', a === null ? null : a / 9.80665, false, raw);
                }, ['gLat']);
            }
        }
        if (groups.includes('gear')) {
            add(VI, 'statusGearboxDrive', (v) => {
                const g = gearOf(v && v.statusActualGearDrive), s = stageOf(v && v.statusActualStageDrive);
                if (s !== undefined) put('stage', s);
                if (g !== undefined) put('gear', g);
            }, ['gear', 'stage']);
            const selSeen = [];
            add(VI, 'DataPowerTrain2', (v) => {
                const raw = v && v.statusGearSelectionDrive, sel = selectionOf(raw);
                if (selSeen.length < 12 && selSeen.indexOf(String(raw)) < 0) { selSeen.push(String(raw)); this.log.info('gear selection: ' + JSON.stringify(raw)); }
                if (!sel) return;
                if (sel.stage !== undefined) put('stage', sel.stage);
                put('gear', sel.gear);
            });
        }
        if (groups.includes('condition')) add('de.bmw.infrastructure.VehicleCondition', 'VehicleCondition', (v) => put('condition', conditionOf(v && v.statusConditionVehicle), false, v && v.statusConditionVehicle), ['condition']);
        // negative torque (engine braking while the rpm falls) counts as 0
        if (groups.includes('torque')) {
            add('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', (v) => {
                const raw = v && v.actualValueTorqueCrankshaft, tq = sc('torque', raw);
                put('torque', tq === null ? null : Math.max(0, tq), false, raw);
            }, ['torque']);
        }
        Object.keys(o.extra || {}).forEach((iface) => Object.keys(o.extra[iface]).forEach((f) => add(iface, f, o.extra[iface][f])));
        this.keys = Object.keys(this.keyIface);
        // a parked car sends nothing new for minutes (fields are notified on change), so "no data for
        // a while" doesn't mean "no car": once a signal's provider is there, stay on live data
        this.subs = [];
        this.t0 = clock.now();
        Object.keys(watches).forEach((iface) => {
            const name = iface.split('.').pop();
            // (onAvailable: the marks only)
            Promise.resolve(ctx.signals.watch(iface, '1', watches[iface], this.log, { onAvailable: (up) => this._provider(iface, up ? 'up' : 'down') }))
                .then((s) => {
                    if (this.closed) { if (s && s.shutdown) s.shutdown(); return; }
                    this.subs.push(s);
                    if (s.error) this._provider(iface, 'error');
                    else if (s.available) this._provider(iface, 'up');
                    this.log.info('signal ' + name + (s.error ? ' error: ' + s.error : ' subscribed'));
                }, (e) => { this._provider(iface, 'error'); this.log.warn('signal ' + name + ': ' + e); });
        });

        // demo feed (20 Hz) - also keeps the sim warm so switching is seamless. On a busy or
        // slow CPU the timer fires late; replay every missed 50 ms step (up to 3 s) with its own
        // timestamp, so timers, dyno and brake maths see the same data on any machine.
        let simT = clock.now();
        this.simTimer = clock.setInterval(() => {
            if (this.closed) return;
            const now = clock.now();
            if (now - simT > 3000) simT = now - 3000;
            const d = this._checkDemo();
            while (simT + 50 <= now) {
                simT += 50;
                this.simData = this.sim.sample(simT);
                if (d) this._emit(this.simData, simT);
            }
        }, 50);
        // (the setting's change applies at once, not only at the next tick)
        if (ctx.settings && typeof ctx.settings.onChange === 'function') ctx.settings.onChange((k) => { if (k === 'demo' && !this.closed) this._checkDemo(); });
    }

    /** Has the car answered: a value arrived, or a signal's provider is available. */
    carPresent() { return this.received || this.subs.some((s) => s.available); }

    _wantDemo() {
        const m = this.ctx.settings && this.ctx.settings.get('demo');
        return m === 'on' || (m !== 'off' && !this.carPresent() && clock.now() - this.t0 > 5000);
    }
    /** demo on or off as the setting and the car say; the switch resets the listeners and marks the frames */
    _checkDemo() {
        const d = this._wantDemo();
        if (d !== this.demoActive) {
            this.demoActive = d;
            datastate.setDemo(this.demoSource, d);
            this.log.info(d ? 'demo data on' : 'live car data');
            this.listeners.forEach((l) => { if (l.reset) { try { l.reset(); } catch (e) { this.log.warn('reset: ' + e); } } });
            this._updated();
        }
        return d;
    }

    data() {
        const src = this.demoActive ? this.simData : this.live;
        const d = Object.assign({}, src, { demo: this.demoActive });
        if (d.gear === undefined && !this.demoActive) { d.gear = this.guessed; d.gearGuessed = true; }
        d.quality = this._quality();
        d.state = this._state();
        return d;
    }

    /** fn(data, tMs) per sample; fn.reset() (optional) when the source switches live<->demo. */
    onSample(fn, reset) { this.listeners.push({ fn, reset }); }
    /** fn(data) whenever a value, a mark or the source changes (MGU Tools). */
    onUpdate(fn) { this.updateListeners.push(fn); }
    /** The demo drive's rev limit (the app's redline). */
    setRedline(rpm) { this.sim.setRedline(rpm); }

    /* ---------- marks (data().quality, state, sample()): they never hide a value ---------- */
    _mark(k, quality, raw) { this.marks[k] = { quality, at: clock.now(), raw: raw === undefined ? null : raw }; if (quality !== 'live') this._updated(); }
    _provider(iface, st) { if (this.closed || this.providers[iface] === st) return; this.providers[iface] = st; this._updated(); }
    _qualityOf(k) {
        if (this.demoActive) return 'demo';
        const m = this.marks[k];
        if (k === 'gear' && !m && this.guessed !== undefined) return 'live';
        if (!m) return 'unavailable';
        const lost = this.providers[this.keyIface[k]] === 'down' || this.providers[this.keyIface[k]] === 'error';
        const old = this.staleMs && this.staleMs[k] > 0 && clock.now() - m.at > this.staleMs[k];
        if (m.quality === 'live' && (lost || old)) return 'stale';
        return m.quality;
    }
    _quality() { const q = {}; this.keys.forEach((k) => { q[k] = this._qualityOf(k); }); return q; }
    /** connecting: no provider answered yet; waiting: one did, no value yet; live; stale: a value's provider went; demo */
    _state() {
        if (this.demoActive) return 'demo';
        const q = this.keys.map((k) => this._qualityOf(k));
        if (q.indexOf('stale') >= 0) return 'stale';
        if (q.indexOf('live') >= 0 || q.indexOf('invalid') >= 0) return 'live';
        return Object.keys(this.providers).some((i) => this.providers[i] === 'up') ? 'waiting' : 'connecting';
    }
    /** key's value with its mark: { key, value, quality, source, received_at_monotonic, provenance: { raw } } */
    sample(key) {
        const d = this.data(), m = this.marks[key];
        return {
            key, value: d[key] === undefined ? null : d[key], quality: this._qualityOf(key),
            source: this.demoActive ? 'demo' : this.keySource[key] || (key === 'gear' ? 'computed:gearGuess' : null),
            received_at_monotonic: m ? m.at : null, provenance: { raw: m ? m.raw : null },
        };
    }

    _updated() {
        if (this.closed || !this.updateListeners.length) return;
        const data = this.data();
        this.updateListeners.forEach((fn) => { try { fn(data); } catch (e) { this.log.warn('update: ' + e); } });
    }

    _emit(d, t) {
        const data = Object.assign({}, d, { demo: this.demoActive, quality: this._quality(), state: this._state() });
        this.listeners.forEach((l) => { try { l.fn(data, t); } catch (e) { this.log.warn('sample: ' + e); } });
    }

    /** Stops the simulator and the subscriptions; no more samples or updates (MGU Tools). */
    close() {
        if (this.closed) return;
        this.closed = true;
        this.updateListeners.length = 0;
        if (this.simTimer) { clock.clearInterval(this.simTimer); this.simTimer = null; }
        this.subs.forEach((s) => { try { if (s.shutdown) s.shutdown(); } catch (e) { /* closing anyway */ } });
        datastate.setDemo(this.demoSource, false);
    }
}

Car.SIGNALS = SIGNALS;
Car.SCALE = SCALE;
Car.GearGuess = GearGuess;
Car.selectionOf = selectionOf;
Car.conditionOf = conditionOf;
module.exports = Car;
