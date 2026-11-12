'use strict';
/**
 * kwfuse.js - the battery's power without the wait. eDrive Live reads it from the battery unit over diagnostics: a
 * few readings a second at best, each already a read old when it arrives, so a gauge on them alone steps behind the
 * car (Nov 9 2026: "super laggy, not usable"). The car's own signals come many times a second, and some of them move
 * with the battery's power; each is fitted continuously to eDrive Live's readings, and the one that fits best shows:
 *
 *   rel     Efficiencytainment2.statusPowerRelativHybrid: the stock cluster's own power meter, electric drive and
 *           recuperation in % (kW = a x drive% + b x recuperation% + c). Found in the car's catalog, Nov 10 2026.
 *   sport   FES.displaySportPowertrain: the sport display's powertrain power (+ / -; electric only: with the
 *           engine running it is not the battery's). Its unit is not known yet: fitted, whatever it is.
 *   cons    ResetLogic.currentConsumption: the onboard computer's electric consumption now, x the speed (moving only).
 *   wheel   the power at the wheels from the speed and the longitudinal acceleration (mass x the acceleration the
 *           sensor feels, which takes in the slope, plus rolling and air drag, x the speed); electric only.
 *
 * Each model: kW = theta . features, fitted by recursive least squares with forgetting on each eDrive Live reading,
 * against the features at the moment that reading was taken (kept in a short history), so the delay of the read
 * doesn't enter the fit. Its error before each update is averaged; shown: the model with the smallest error among
 * those fitted MIN_FITS times whose signal is fresh, applied to the features now; else the wheels' model; else
 * eDrive Live's reading as it is (the engine running and no car signal fitted). Without a reading in the last
 * STALE_MS nothing is made up: none.
 *
 *   const f = createFuse();
 *   f.sample(t, { speed km/h, gLong g, engineOn });      every car sample (data.js: each data())
 *   f.signal(t, name, value)                            a car signal: 'rel' { drive, recup } %, 'sport' number,
 *                                                       'cons' number (consumption now, the car's unit)
 *   f.measure(tTaken, kw);                              each new eDrive Live reading (the time it was read)
 *   f.now(t) -> { kw, fused, model, measuredKw, measuredAge } | null
 *   f.fit() -> { model, a, b, c, fits, models: { name: { theta, fits, err, rate } } }
 */
const G = 9.80665;
const MASS = 2600;            // kg: a G05 xDrive45e (2510 kg) with a driver and a little more
const CRR = 0.011;            // rolling resistance
const CDA = 0.95;             // m^2: drag area (Cd 0.33 x 2.9 m^2)
const RHO = 1.2;              // kg/m^3
const HIST_MS = 3000;         // the features kept this long, to look up the moment a reading was taken
const STALE_MS = 4000;        // eDrive Live silent this long: nothing shown
const LAMBDA = 0.985;         // forgetting per reading: about the last 60 readings count
const A_TAU_MS = 80;          // the acceleration's smoothing (its sensor is noisy at rest)
const SIG_FRESH_MS = 2500;    // a car signal older than this: not used (some only notify on a change: held that long)
const MIN_FITS = 12;          // readings a car signal's model needs before it shows
const ERR_TAU = 0.9;          // the error's average: about the last 10 readings

/** The power at the wheels (kW, + driving the car): speed km/h, the sensor's longitudinal acceleration in g. */
function wheelKw(speedKmh, gLong) {
    const v = Math.max(0, speedKmh) / 3.6;
    if (v < 0.3) return 0;
    const force = MASS * gLong * G + CRR * MASS * G + 0.5 * RHO * CDA * v * v;
    return force * v / 1000;
}

const isNum = (v) => typeof v === 'number' && isFinite(v);
/* The models: their features from a state (s: { wheel, electric, speed, sig: { name: [t, value] } }, t), the start
 * guess and its uncertainty, the bounds kept. A model's features are null while it can't say. */
const MODELS = {
    rel: {
        feat: (s, t) => { const r = s.sig.rel; return r && t - r[0] < SIG_FRESH_MS ? [r[1].drive || 0, r[1].recup || 0, 1] : null; },
        start: [0.9, -0.6, 1.5], P: [0.05, 0.05, 4],
    },
    sport: {
        feat: (s, t) => { const r = s.sig.sport; return r && s.electric && t - r[0] < SIG_FRESH_MS ? [Math.max(0, r[1]), Math.min(0, r[1]), 1] : null; },
        start: [1 / 0.9, 0.75, 1.5], P: [0.2, 0.2, 4],
    },
    cons: {
        feat: (s, t) => { const r = s.sig.cons; return r && s.speed > 5 && t - r[0] < SIG_FRESH_MS ? [r[1] * s.speed / 100, 1] : null; },
        start: [1, 1.5], P: [0.5, 4],
    },
    wheel: {
        feat: (s) => (s.electric ? [Math.max(0, s.wheel), Math.min(0, s.wheel), 1] : null),
        start: [1 / 0.85, 0.7, 1.5], P: [0.05, 0.05, 4],
        clamp: (th) => { th[0] = Math.min(2, Math.max(1, th[0])); th[1] = Math.min(0.95, Math.max(0.3, th[1])); th[2] = Math.min(15, Math.max(-2, th[2])); },
    },
};
const ORDER = ['rel', 'sport', 'cons', 'wheel'];

function createModel(def) {
    const n = def.start.length;
    const m = { def, theta: def.start.slice(), P: def.P.map((p, i) => def.P.map((q, j) => (i === j ? p : 0))), fits: 0, err: null };
    m.predict = (x) => x.reduce((a, v, i) => a + v * m.theta[i], 0);
    m.update = (x, kw) => {
        const e = kw - m.predict(x);
        m.err = m.err === null ? Math.abs(e) : ERR_TAU * m.err + (1 - ERR_TAU) * Math.abs(e);
        const Px = m.P.map((r) => r.reduce((a, v, j) => a + v * x[j], 0));
        const den = LAMBDA + x.reduce((a, v, i) => a + v * Px[i], 0);
        const K = Px.map((v) => v / den);
        m.theta = m.theta.map((v, i) => v + K[i] * e);
        m.P = m.P.map((r, i) => r.map((v, j) => (v - K[i] * Px[j]) / LAMBDA));
        for (let i = 0; i < n; i++) if (!isFinite(m.theta[i])) { m.theta = def.start.slice(); break; }
        if (def.clamp) def.clamp(m.theta);
        m.fits++;
    };
    return m;
}

function createFuse() {
    const models = {};
    ORDER.forEach((k) => { models[k] = createModel(MODELS[k]); });
    const hist = [];                                    // [t, state]
    const sig = {}, rate = {};                          // name -> [t, value]; name -> [arrival times, last 10 s]
    let aAvg = null, aT = 0, meas = null, measT = 0, last = null;

    const state = (t) => ({ wheel: last ? last.wheel : 0, electric: !!(last && last.electric), speed: last ? last.speed : 0, sig: Object.assign({}, sig), t });
    function push(t) {
        hist.push([t, state(t)]);
        while (hist.length > 2 && t - hist[0][0] > HIST_MS) hist.shift();
    }
    function sample(t, s) {
        if (!s || !isNum(s.speed) || !isNum(s.gLong)) return;
        aAvg = aAvg === null ? s.gLong : aAvg + (s.gLong - aAvg) * (1 - Math.exp(-Math.max(1, t - aT) / A_TAU_MS));
        aT = t;
        last = { wheel: wheelKw(s.speed, aAvg), electric: s.engineOn === false, speed: s.speed };
        push(t);
    }
    function signal(t, name, v) {
        if (!MODELS[name] || v === null || v === undefined) return;
        sig[name] = [t, v];
        const r = rate[name] = rate[name] || [];
        r.push(t);
        while (r.length && t - r[0] > 10000) r.shift();
        push(t);
    }
    /** The state at time t from the history (the nearest at or before it). */
    function at(t) {
        for (let i = hist.length - 1; i >= 0; i--) if (hist[i][0] <= t) return hist[i][1];
        return hist[0] ? hist[0][1] : null;
    }
    function measure(tTaken, kw) {
        if (!isNum(kw)) return;
        meas = kw; measT = tTaken;
        const s = at(tTaken);
        if (!s) return;
        ORDER.forEach((k) => { const x = MODELS[k].feat(s, tTaken); if (x) models[k].update(x, kw); });
    }
    /** The model shown now: the best fitted car signal that is fresh, else the wheels' when electric. */
    function pick(s, t) {
        let best = null;
        ['rel', 'sport', 'cons'].forEach((k) => {
            const m = models[k], x = MODELS[k].feat(s, t);
            if (x && m.fits >= MIN_FITS && (!best || m.err < best.m.err)) best = { k, m, x };
        });
        const w = models.wheel, wx = MODELS.wheel.feat(s, t);
        // (the wheels' model only when clearly better: a car signal of the battery's own power is preferred)
        if (wx && (!best || (w.err !== null && w.fits >= MIN_FITS && w.err < best.m.err * 0.6))) best = { k: 'wheel', m: w, x: wx };
        return best;
    }
    function now(t) {
        if (meas === null || t - measT > STALE_MS) return null;
        const s = state(t);
        const quiet = !last || t - (hist.length ? hist[hist.length - 1][0] : 0) > 1000;
        const b = quiet ? null : pick(s, t);
        if (!b) return { kw: meas, fused: false, model: null, measuredKw: meas, measuredAge: t - measT };
        return { kw: b.m.predict(b.x), fused: true, model: b.k, measuredKw: meas, measuredAge: t - measT };
    }
    function fit() {
        const s = state(Date.now()), b = last ? pick(s, s.t) : null;
        const w = models.wheel.theta;
        const out = { model: b ? b.k : null, a: w[0], b: w[1], c: w[2], fits: models.wheel.fits, models: {} };
        ORDER.forEach((k) => {
            const m = models[k];
            out.models[k] = { theta: m.theta.map((v) => Math.round(v * 1000) / 1000), fits: m.fits, err: m.err === null ? null : Math.round(m.err * 100) / 100,
                rate: k === 'wheel' ? null : Math.round(((rate[k] || []).length / 10) * 10) / 10, last: sig[k] ? sig[k][1] : null };
        });
        return out;
    }
    return { sample, signal, measure, now, fit };
}

module.exports = { createFuse, wheelKw, MASS, MODELS };
