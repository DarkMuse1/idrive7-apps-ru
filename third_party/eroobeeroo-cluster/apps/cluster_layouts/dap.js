'use strict';
/**
 * dap.js - what the car's driving assistant (Driving Assistant Professional) knows, for Modern wide's road: the
 * cruise control's state, its set speed and gap; whether the steering assist is holding the lane; lane departure
 * and lane change (blind spot) warnings; and the vehicles around (the one the cruise control follows, the nearest
 * in each lane beside). All from the services the car's own assisted driving view is built from, which this G05's
 * head unit carries (de.bmw.dass.*), read only.
 *
 * Not yet seen on a car: the units of the positions, the set speed and the cruise states are the catalog's types
 * only. Every source's first values and one a minute go to the log ('dap raw ...'), and the scales are in
 * config.dap (posScale: metres a unit of an object's x and y; setSpeed: 'display' as sent, or 'kmh'), so they can
 * be set from a drive's log without a new build.
 *
 * state(): { valid, acc: { on, set, gap }, assist, ldw: { left, right }, lcw: { left, right },
 *            lead: { x, y, brake } | null, left: { x } | null, right: { x } | null, at }
 * x metres ahead, y metres to the left; lanes from the car's own lane assignment.
 */
const S_IBVIP = 'de.bmw.dass.AssistedDrivingViewFunctionInput';
const S_LAT = 'de.bmw.dass.pad.communication.AssistedDrivingViewLateralFunctionInput';
const S_LCA = 'de.bmw.dass.driverassistanceapplications.AssistedDrivingViewLateralCollisionAvoidance';
const S_OBJ = 'de.bmw.dass.pad.communication.ObjectListSuAAR';
const SERVICES = { [S_IBVIP]: 'assistedDrivingViewFunctionInputIbVip', [S_LAT]: 'lateralFunctionInputAssistedDrivingView',
    [S_LCA]: 'assistedDrivingViewLcaInput', [S_OBJ]: 'suAARObjectList' };

/* the enums the binding may hand over as names or numbers (the catalog's values) */
const LSA_ACTIVE = /FOLLOW|HOO_|LANECHANGEASSISTANT|EMERGENCYSTOPASSISTANT|ACTIVE_CONTROL/;
const LSA_NUM_ACTIVE = [5, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const LANE = { NEXTLEFT: 2, LEFT: 1, LEFT_EGO: 0.5, EGO_LEFT: 0.5, EGO: 0, EGO_RIGHT: -0.5, RIGHT_EGO: -0.5, RIGHT: -1, NEXTRIGHT: -2,
    LEFT_NEXTLEFT: 1.5, NEXTLEFT_LEFT: 1.5, RIGHT_NEXTRIGHT: -1.5, NEXTRIGHT_RIGHT: -1.5 };
const LANE_NUM = { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: 1.5, 7: 1.5, 8: 0.5, 9: 0.5, 10: -1.5, 11: -1.5, 12: -0.5, 13: -0.5 };
const DIR = { NO_WARNING: 0, WARNING_LEFT: 1, WARNING_RIGHT: 2, WARNING_BOTH_SIDES: 3 };

const isNum = (v) => typeof v === 'number' && isFinite(v);
const name = (v) => (v && typeof v === 'object' ? (v.name !== undefined ? v.name : v.value) : v);
/** The first value under `key` however deep the binding wraps it. */
function one(v, key, depth) {
    if (!v || typeof v !== 'object' || (depth || 0) > 6) return undefined;
    if (key in v) return v[key];
    for (const k of Object.keys(v)) { const r = one(v[k], key, (depth || 0) + 1); if (r !== undefined) return r; }
    return undefined;
}
/** Every object entry (has objectID) however the list arrives. */
function objects(v, out, depth) {
    out = out || [];
    if (Array.isArray(v)) v.forEach((e) => objects(e, out, (depth || 0) + 1));
    else if (v && typeof v === 'object' && (depth || 0) < 6) {
        if ('objectID' in v && v.objectPosition) out.push(v);
        else Object.keys(v).forEach((k) => objects(v[k], out, (depth || 0) + 1));
    }
    return out;
}
const laneOf = (v) => { const n = name(v); return typeof n === 'string' ? (n in LANE ? LANE[n] : null) : isNum(n) ? (n in LANE_NUM ? LANE_NUM[n] : null) : null; };
const dirOf = (v) => { const n = name(v); return typeof n === 'string' ? DIR[n] || 0 : isNum(n) ? n : 0; };
const warnOn = (v) => { const n = name(v); return typeof n === 'string' ? /WARNING/.test(n) && !/^NO_/.test(n) : isNum(n) && n > 0; };

/** Decoders, exported for the tests. cfg: config.dap. */
function decodeIbVip(v, cfg) {
    const g = (k) => one(v, k);
    const set = g('assistedDrivingViewDispXcc'), state = g('assistedDrivingViewStateXcc'), gap = g('assistedDrivingViewDispGapChoice');
    const setOk = isNum(set) && set > 0 && set < 400;
    return {
        on: isNum(state) ? state > 0 && setOk : setOk,
        set: setOk ? set : null,
        gap: isNum(gap) && gap >= 1 && gap <= 6 ? gap : null,
        target: g('assistedDrivingViewACCTargetObjectId'),
        raw: { state, sub: g('assistedDrivingViewSubStateXcc'), set, gap, dist: g('assistedDrivingViewACCTargetDistance'), sld: g('assistedDrivingViewDispSLD') },
    };
}
function decodeLateral(v) {
    const s = name(one(v, 'lsaState'));
    return typeof s === 'string' ? LSA_ACTIVE.test(s) : isNum(s) ? LSA_NUM_ACTIVE.indexOf(s) >= 0 : false;
}
function decodeLca(v) {
    const ldw = dirOf(one(v, 'directionLaneDepartureWarning'));
    return { ldw: { left: ldw === 1 || ldw === 3, right: ldw === 2 || ldw === 3 },
        lcw: { left: warnOn(one(v, 'statusLaneChangeWarningLeft')), right: warnOn(one(v, 'statusLaneChangeWarningRight')) } };
}
/** The object list as { id, x, y, lane, brake } with x, y in metres (cfg.posScale a unit). */
function decodeObjects(v, cfg) {
    const k = cfg && isNum(cfg.posScale) ? cfg.posScale : 0.01;
    return objects(v).map((o) => {
        const p = o.objectPosition || {}, pr = o.objectPrediction || {}, props = o.objectProperties || {};
        const brake = name(props.brakeLight);
        return { id: o.objectID, x: isNum(p.x) ? p.x * k : null, y: isNum(p.y) ? p.y * k : null, lane: laneOf(pr.laneAssignment),
            brake: typeof brake === 'string' ? /ON/.test(brake) : brake === 2 || brake === 3 };
    }).filter((o) => isNum(o.x) && o.x > 0 && o.x < 200);
}
/** The picture's cars from the list: the one followed (the cruise target, else the nearest in the lane), the
 * nearest in each lane beside (up to 60 m ahead, or level with the car). */
function pick(list, target) {
    const ego = list.filter((o) => o.lane === 0 || (o.lane === null && isNum(o.y) && Math.abs(o.y) < 1.6));
    const lead = (isNum(target) && target > 0 && list.find((o) => o.id === target)) || ego.sort((a, b) => a.x - b.x)[0] || null;
    const side = (s) => list.filter((o) => (o.lane === s || (o.lane === null && isNum(o.y) && o.y * s > 1.8 && o.y * s < 5.4)) && o.x < 60).sort((a, b) => a.x - b.x)[0] || null;
    return { lead, left: side(1), right: side(-1) };
}

function startDap(ctx, log, opts) {
    const cfg = (ctx.spec && ctx.spec.config && ctx.spec.config.dap) || {};
    const st = { valid: false, acc: { on: false, set: null, gap: null }, assist: false, ldw: { left: false, right: false }, lcw: { left: false, right: false },
        lead: null, left: null, right: null, at: 0, target: null };
    const seen = {}, rawLogT = {};
    const raw = (src, v) => {
        seen[src] = (seen[src] || 0) + 1;
        if (seen[src] <= 3 || Date.now() - (rawLogT[src] || 0) > 60000) { rawLogT[src] = Date.now(); log.info('dap raw ' + src + ': ' + JSON.stringify(v).slice(0, 700)); }
    };
    const fresh = () => { st.valid = true; st.at = Date.now(); };
    const on = {
        [S_IBVIP]: (v) => { raw('ibvip', v); const a = decodeIbVip(v, cfg); st.acc = { on: a.on, set: a.set, gap: a.gap }; st.target = a.target; fresh(); },
        [S_LAT]: (v) => { raw('lateral', v); st.assist = decodeLateral(v); fresh(); },
        [S_LCA]: (v) => { raw('lca', v); const l = decodeLca(v); st.ldw = l.ldw; st.lcw = l.lcw; fresh(); },
        [S_OBJ]: (v) => { raw('objects', v); const p = pick(decodeObjects(v, cfg), st.target); st.lead = p.lead; st.left = p.left; st.right = p.right; fresh(); },
    };
    const status = {};
    Object.keys(SERVICES).forEach((iface) => {
        ctx.signals.watch(iface, '1', { [SERVICES[iface]]: on[iface] }, log)
            .then((s) => { status[iface.split('.').pop()] = s.error ? 'error: ' + s.error : 'subscribed'; })
            .catch((e) => { status[iface.split('.').pop()] = 'error: ' + e; });
    });
    return {
        /** The state, or nothing once nothing has come for 3 s (the assistant's events stop with it). */
        state() { return st.valid && Date.now() - st.at < 3000 ? st : null; },
        status: () => Object.assign({ seen }, status),
        enabled: () => !opts || !opts.enabled || opts.enabled(),
    };
}

/** For the previews and demo data: a car followed at 38 m with the cruise set and the steering assist on. */
const DEMO = { valid: true, acc: { on: true, set: 70, gap: 3 }, assist: true, ldw: { left: false, right: false }, lcw: { left: false, right: true },
    lead: { x: 38, y: 0.2, brake: false }, left: { x: 22 }, right: { x: 6 }, at: 0 };

module.exports = { startDap, decodeIbVip, decodeLateral, decodeLca, decodeObjects, pick, SERVICES, DEMO };
