'use strict';
/**
 * layout_modern_wide.js - "Modern wide": no round dials. Two long segmented arcs frame the cluster like
 * brackets (road speed rising on the left, engine speed on the right), the speed and the gear stand large
 * inside them, and the centre holds the time, outside temperature and drive mode, the fuel and electric
 * ranges with the battery's charge and power, and oil and coolant. With the map in the centre the arcs stay
 * at the edges and the readings move to strips above and below the map. Its colours follow the drive mode.
 * An original design.
 */
const C = require('./layout_common');
const carSprite = require('./car_sprite');

/* the arcs: short enough that their ends and numerals clear the glass's slanted top corners */
const R = 520, T = 28, CY = 380;
const LCX = 720, RCX = 1200;
const L_LAYER = { x: 100, y: 80, w: 420, h: 600 };
const R_LAYER = { x: 1400, y: 80, w: 420, h: 600 };

const PALETTES = {
    comfort: {
        bgTop: '#0b1018', bgBottom: '#020305', track: '#121a24', fill0: '#1d5f9e', fill1: '#5cc8ff', tip: '#a8e4ff',
        red: '#ff3b30', tick: '#3b4c5e', num: '#9fb3c8', text: '#f2f7ff', glow: '#3fa6ff', dim: '#a6b0ba', rule: '#1c2a3a', ev: '#4ab4ff',
        mode: 'COMFORT',
        cardTop: '#111b28', cardBottom: '#070b11', cardEdge: '#2a4058', regen: '#3ddc84', road: '#1d5f9e',
    },
    sport: {
        bgTop: '#140909', bgBottom: '#040202', track: '#241414', fill0: '#8a1a14', fill1: '#ff4a30', tip: '#ffb0a0',
        red: '#ffffff', tick: '#5e3b3b', num: '#d8a8a0', text: '#ffffff', glow: '#ff3b2f', dim: '#bca8a4', rule: '#3a1c1c', ev: '#4ab4ff',
        mode: 'SPORT',
        cardTop: '#1f1010', cardBottom: '#0a0505', cardEdge: '#5a2a26', regen: '#3ddc84', road: '#8a1a14',
    },
    efficient: {
        bgTop: '#06120f', bgBottom: '#010403', track: '#0f201c', fill0: '#127a5e', fill1: '#3cf0b8', tip: '#b0ffe6',
        red: '#ff3b30', tick: '#2f5048', num: '#9cc8bc', text: '#effffb', glow: '#22d3a0', dim: '#9eb6b0', rule: '#163a32', ev: '#22d3a0',
        mode: 'EFFICIENT',
        cardTop: '#0c1d19', cardBottom: '#040b09', cardEdge: '#1f4a40', regen: '#5ef2c4', road: '#127a5e',
    },
};
const bandColours = (t) => ({ track: t.track, fill0: t.fill0, fill1: t.fill1, redc: t.red, tip: t.tip, tick: t.tick, num: t.num });
const big = (t) => ({ color: [t.text, 1], glow: [t.glow, 0.45] });
const txt = (t) => ({ color: [t.text, 1], glow: [t.glow, 0.15] });
const evTxt = (t) => ({ color: [t.ev, 1], glow: [t.ev, 0.3] });
const lbl = (t) => ({ color: [t.dim, 1], glow: [t.glow, 0] });
const bg = (key, x, y, w, h) => ({ key, kind: 'panel', x, y, w, h, params: { u_box: [0, 0, 0, 1] }, colors: (t) => ({ top: t.bgTop, bottom: t.bgBottom, border: t.bgBottom }) });

/* ---- the car's own bottom strip, readings in the centre: a new car's cluster ----
 * A textured background with a glow behind the top; the two arcs with a hairline outside each; the speed large
 * in the middle with the road ahead under it (its lane line running with the speed, on the cluster's clock);
 * the drive selector and mode on a chip left of the speed, the gear and engine speed on one right of it; a glass
 * card left with the battery's power, a centre-zero bar (regenerating left, drawing right) and its trend, and one
 * right with oil, coolant, the charge and the gearbox oil, each with its icon. */
const ICON = { thermo: 0, oil: 1, turbo: 5, battery: 6, car: 10 };
const card = (key, x, y, w, h) => ({ key, kind: 'panel', x, y, w, h, params: { u_box: [22, 1.5, 0.7, 0.92] }, colors: (t) => ({ top: t.cardTop, bottom: t.cardBottom, border: t.cardEdge }) });
const icon = (key, x, y, size, id, colour) => ({ key, kind: 'icon', x, y, w: size, h: size, params: { u_icon: [id], u_line: [0] }, colors: (t, d) => ({ color: [typeof colour === 'function' ? colour(t, d) : t[colour], 1] }) });
/** A straight bar (the band shader's bar mode), from the left or from the right. */
const hbar = (key, x, y, w, h, value, colours, fromRight, segments) => ({ key, kind: 'band', x, y, w, h,
    params: { u_geo: [Math.max(6, h / 2), h / 2, 0, Math.max(4, h * 0.6)], u_span: [fromRight ? -1 : 0, 0, segments || 0, 0.25], u_marks: [0, 0, 0, 0], u_red: [2] },
    colors: colours, value, max: 1, sweep: true });
const kwOf = (d) => (C.isNum(d.kw) ? d.kw : 0);
/** The battery's power on the tach's arc: its top rounded up to 30 kW, so its three marks above the 0 are round. */
const kwN = (d) => { const r = C.kwRange(d); return { out: Math.ceil(r.out / 30) * 30, in: r.in }; };
/* the driving assistant's state as the road shader's uniforms: a distance d metres ahead at depth 1/(1 + d/16) */
const depth = (x) => (typeof x === 'number' && x > 0 ? 1 / (1 + x / 16) : 0);
function roadState(D) {
    if (!D) return { u_dap: [0, 0, 0, 0], u_ldw: [0, 0] };
    return {
        u_dap: [1, D.assist ? 1 : 0, D.acc && D.acc.on ? 1 : 0, D.acc && D.acc.on && D.acc.gap ? D.acc.gap : 0],
        u_ldw: [D.ldw && D.ldw.left ? 1 : 0, D.ldw && D.ldw.right ? 1 : 0],
    };
}
/*
 * The road's motion, every frame (engine.js frame): the distance driven from the speed (the lane dashes go by
 * with the car, standing still when it does), and the cars eased towards where the assistant last put them (its
 * object list comes ~10 times a second: they glide between its updates instead of jumping), in and out of view
 * as they come and go.
 */
function roadMotion() {
    let run = 0;
    const cars = { lead: { d: 0, y: 0, a: 0 }, left: { d: 0, a: 0 }, right: { d: 0, a: 0 } };
    const ease = (c, want, k) => {
        if (want) { c.d = c.a > 0.01 ? c.d + (depth(want.x) - c.d) * k : depth(want.x); if (want.y !== undefined) c.y += ((typeof want.y === 'number' ? want.y / 3.6 : 0) - c.y) * k; }
        c.a += ((want ? 1 : 0) - c.a) * k;
        return c.a > 0.02 ? c.d : 0;
    };
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return (d, dt) => {
        const D = d.dap, kmh = C.isNum(d.speed) ? Math.max(0, d.speed) : 0;
        run = (run + kmh / 3.6 * dt / 1000) % 1200;
        const k = 1 - Math.exp(-dt / 90);
        const L = ease(cars.lead, D && D.lead, k), l = ease(cars.left, D && D.left, k), r = ease(cars.right, D && D.right, k);
        return {
            u_run: [Math.round(run * 100) / 100],
            u_lead: [L > 0 ? 1 : 0, r3(L), r3(cars.lead.y), D && D.lead && D.lead.brake ? 1 : 0],
            u_side: [r3(l), r3(r), D && D.lcw && D.lcw.left ? 1 : 0, D && D.lcw && D.lcw.right ? 1 : 0],
        };
    };
}   // the tach as a power gauge, and the small gauge inside it: kW of battery draw

function newCar(o, arcs, gearC, rpmTxt) {
    const engine = C.engineFocus(o), sc = C.speedScale(o);
    const hair = arcs.filter((a) => a.key !== 'pwrArc').map((a) => Object.assign({}, a, {
        key: a.key + 'Hair', z: -1, dyn: undefined,
        params: Object.assign({}, a.params, { u_geo: [a.params.u_geo[0], a.params.u_geo[1], a.params.u_geo[2] + 30, 3], u_span: [a.params.u_span[0], a.params.u_span[1], 0, 0], u_marks: [0, 0, 0, 0], u_red: [2] }),
        colors: (t) => ({ track: t.rule, fill0: t.fill1, fill1: t.tip, redc: t.red, tip: t.tip, tick: t.tick, num: t.num }),
    }));
    const L = { x: 330, y: 340, w: 300, h: 262 }, R = { x: 1290, y: 340, w: 300, h: 262 };
    const cell = (i, id, ic, value, label, colour) => {
        const cx = R.x + 12 + (i % 2) * 144, cy = R.y + 14 + Math.floor(i / 2) * 124;
        return [icon(id + 'Ic', cx + 6, cy + 6, 30, ic, 'glow'),
            C.text(id, cx, cy + 40, 132, 46, value, colour || txt, { align: 0 }),
            C.text(id + 'Lbl', cx + 2, cy + 90, 132, 16, label, lbl, { align: 0, tracking: 0.14 })];
    };
    return [
        { key: 'bgTex', kind: 'bg', x: 0, y: 0, w: 1920, h: 720, params: { u_look: [1, 0.55, 0.75, 24], u_feather: [0] }, colors: (t) => ({ top: t.bgTop, bottom: t.bgBottom, accent: t.glow }) },
        // the road ahead as the driving assistant sees it (dap.js: d.dap; without it, the lanes and the car alone)
        { key: 'road', kind: 'road', x: 650, y: 346, w: 620, h: 296, value: (d) => (C.isNum(d.speed) ? Math.min(1, C.speedIn(o, d.speed) / sc.max) : 0), max: 1,
            colors: (t) => ({ line: t.tip, glow: t.glow, surface: t.road, assist: t.regen, acc: t.glow, warn: '#ff9f0a', car: '#8d9aa8', ego: '#dfe7ef' }),
            dyn: (d) => roadState(d.dap), frame: roadMotion(), textures: { u_cars: carSprite }, params: { u_anchor: [carSprite().anchor.cx, carSprite().anchor.bottom, carSprite().anchor.width, 0] } },
        // the cruise control's set speed and the steering assist, at the top of the road while they're on
        C.text('accSet', 660, 350, 200, 26, (d) => (d.dap && d.dap.acc && d.dap.acc.on && C.isNum(d.dap.acc.set) ? 'SET ' + d.dap.acc.set : ''), (t) => ({ color: [t.glow, 1], glow: [t.glow, 0.5] }), { align: 0 }),
        C.text('assistOn', 1060, 350, 200, 26, (d) => (d.dap && d.dap.assist ? 'ASSIST' : ''), (t) => ({ color: [t.regen, 1], glow: [t.regen, 0.5] }), { align: 1, tracking: 0.14 }),
    ].concat(hair, arcs, [
        // the top: the time and the outside temperature, inside the glass's slanted corners
        C.text('clock', 330, 136, 240, 42, C.clock, txt, { align: 0 }),
        // (the right: the engine speed, or ENGINE OFF; the gear and the drive mode are the car's own strip's)
        C.text('rpmDigits', 1350, 136, 240, 42, rpmTxt, txt, { align: 1 }),
        // the speed, large, in the middle
        C.text('speedDigits', 700, 140, 520, 176, (d) => C.speedText(o, d), big),
        C.text('speedUnit', 700, 314, 520, 24, C.speedUnit(o), lbl, { tracking: 0.3 }),
        // left card: the battery's power (or the engine's torque), a centre-zero bar and its trend
        card('powerCard', L.x, L.y, L.w, L.h),
        C.text('kwLbl', L.x + 20, L.y + 16, L.w - 40, 18, C.focus.powerLabel(o, true), lbl, { align: 0, tracking: 0.14 }),
        C.text('kwNow', L.x + 18, L.y + 40, L.w - 36, 58, C.focus.power(o),
            engine ? txt : (t, d) => ({ color: [kwOf(d) < -0.3 ? t.regen : t.text, 1], glow: [kwOf(d) < -0.3 ? t.regen : t.glow, 0.3] }), { align: 0 }),
    ], engine ? [hbar('pwrBar', L.x + 20, L.y + 112, L.w - 40, 14, C.focus.torqueFrac, (t) => ({ track: t.track, fill0: t.fill0, fill1: t.fill1, redc: t.red, tip: t.tip, tick: t.dim, num: t.num }), false, 24)] : [
        // as the other power gauges: 0 a quarter along, regenerating fills left of it, drawing right, each to the
        // battery's limit (eDrive Live's: layout_common.kwRange)
        hbar('regenBar', L.x + 20, L.y + 112, (L.w - 44) / 4, 14, (d) => Math.max(0, Math.min(1, -kwOf(d) / C.kwRange(d).in)), (t) => ({ track: t.track, fill0: t.regen, fill1: t.regen, redc: t.red, tip: t.regen, tick: t.dim, num: t.num }), true, 4),
        hbar('drawBar', L.x + 24 + (L.w - 44) / 4, L.y + 112, (L.w - 44) * 3 / 4, 14, (d) => Math.max(0, Math.min(1, kwOf(d) / C.kwRange(d).out)), (t) => ({ track: t.track, fill0: t.fill0, fill1: t.fill1, redc: t.red, tip: t.tip, tick: t.dim, num: t.num }), false, 15),
        C.flat('pwrZero', L.x + 21 + (L.w - 44) / 4, L.y + 106, 2, 26, 'tip'),
    ], [
        { key: 'pwrTrend', kind: 'spark', x: L.x + 16, y: L.y + 146, w: L.w - 32, h: 96, every: 2000,
            sample: engine ? (d) => (C.isNum(d.torque) ? Math.max(0, Math.min(1, d.torque / 450)) : -1) : (d) => (C.isNum(d.kw) ? C.kwFrac(d.kw, C.kwRange(d)) : -1),
            colors: (t) => ({ line: t.fill1, fill: t.fill0 }) },
        // right card: oil, coolant, the charge (or boost) and the gearbox oil
        card('infoCard', R.x, R.y, R.w, R.h),
        C.flat('infoRuleV', R.x + R.w / 2, R.y + 18, 1, R.h - 36, 'cardEdge'),
        C.flat('infoRuleH', R.x + 18, R.y + R.h / 2, R.w - 36, 1, 'cardEdge'),
    ],
    cell(0, 'oil', ICON.oil, (d) => C.tempText(o, d.oil), 'OIL'),
    cell(1, 'coolant', ICON.thermo, (d) => C.tempText(o, d.coolant), 'COOLANT'),
    cell(2, 'soc', engine ? ICON.turbo : ICON.battery, C.focus.charge(o), C.focus.chargeLabel(o), engine ? txt : evTxt),
    cell(3, 'gbox', ICON.thermo, (d) => C.tempText(o, d.gearbox), 'GEARBOX'));
}

module.exports = {
    id: 'modern_wide',
    title: 'Modern wide',
    dap: true,          // (its road: the driving assistant's view, dap.js)
    palette: (lookId) => PALETTES[lookId] || PALETTES.comfort,
    gearText: C.gearText,

    pieces(o) {
        const s = C.speedScale(o), r = C.rpmScale(o);
        // a plug-in hybrid (Show: eDrive): the tach turns into the battery's power gauge while the engine is off
        // (in an electric eDrive mode, layout_common.electric; the tach and a small power gauge in the others)
        const ev = !C.engineFocus(o) && o.vehicle !== 'ice', evOff = (d) => C.electric(o, d);
        // with the car's own bottom strip the arcs end higher, clear of it and of the fuel and charge gauges
        // above its ranges (their low ends 6 degrees shorter, their circle 20 px higher)
        const strip = C.strip(o), cy = strip ? CY - 20 : CY, lo = strip ? 112 : 118;
        const arcs = [
            {
                // road speed: up the left, the circle's centre to the right of the layer
                key: 'speedArc', kind: 'band', x: L_LAYER.x, y: L_LAYER.y, w: L_LAYER.w, h: L_LAYER.h,
                params: { u_geo: [LCX - L_LAYER.x, cy - L_LAYER.y, R, T], u_span: [-lo, -62, 44, 0.3], u_marks: [s.max / s.major, s.major, 22, 44], u_red: [2] },
                colors: bandColours, value: (d) => (C.isNum(d.speed) ? C.speedIn(o, d.speed) / s.max : 0), max: 1, sweep: true,
            },
            {
                // engine speed up the right; on a plug-in hybrid with the engine off, the battery's power instead
                // as the other power gauges (0 a quarter up, regeneration below it in green, each side to the
                // battery's limit: kwRange; its numerals and colour changed by dyn), the engine speed back as soon
                // as it runs
                key: 'rpmArc', kind: 'band', x: R_LAYER.x, y: R_LAYER.y, w: R_LAYER.w, h: R_LAYER.h,
                params: { u_geo: [RCX - R_LAYER.x, cy - R_LAYER.y, R, T], u_span: [lo, 62, 44, 0.3], u_marks: [r.max, 1, 22, 44], u_red: [r.red / r.max], u_zero: [0] },
                colors: (t, d) => (evOff(d) ? Object.assign(bandColours(t), { fill0: t.road, fill1: t.ev, tip: kwOf(d) < -0.3 ? t.regen : t.tip, neg: t.regen }) : Object.assign(bandColours(t), { neg: t.regen })),
                value: (d) => (evOff(d) ? C.kwFrac(d.kw, kwN(d)) : C.isNum(d.rpm) ? d.rpm / 1000 / r.max : 0), max: 1, sweep: true,
                dyn: (d) => (evOff(d) ? { u_marks: [3, kwN(d).out / 3, 22, 44], u_red: [2], u_zero: [C.KW_ZERO] } : { u_marks: [r.max, 1, 22, 44], u_red: [r.red / r.max], u_zero: [0] }),
            },
        ];
        // inside the tach, a small power gauge while the engine runs (the battery's draw, and its recuperation in
        // green); gone with the engine off, the tach itself then reading the power
        if (ev && strip) arcs.push({   // (full screen it would reach into the KOMBI's gear box)
            key: 'pwrArc', kind: 'band', x: R_LAYER.x, y: R_LAYER.y, w: R_LAYER.w, h: R_LAYER.h,
            // (as the other power gauges: 0 a quarter up, regeneration below it in green)
            params: { u_geo: [RCX - R_LAYER.x, cy - R_LAYER.y, R - 52, 10], u_span: [lo, 62, 30, 0.3], u_marks: [0, 0, 0, 0], u_red: [2], u_zero: [C.KW_ZERO] },
            colors: (t, d) => ({ track: t.track, fill0: t.road, fill1: t.ev, redc: t.red, tip: kwOf(d) < -0.3 ? t.regen : t.tip, tick: t.tick, num: t.num, neg: t.regen }),
            value: (d) => C.kwFrac(d.kw, C.kwRange(d)), max: 1, sweep: true,
            visible: (d) => !evOff(d),   // (gone while the arc itself reads the battery's power)
        });
        const gearC = (t, d) => ({ color: [C.gearText(d) === 'R' ? '#ff3b30' : t.text, 1], glow: [t.glow, 0.45] });
        const rpmTxt = (d) => (evOff(d) ? 'ENGINE OFF' : C.isNum(d.rpm) ? Math.round(d.rpm / 50) * 50 + ' RPM' : '-- RPM');
        const hotC = (k, lim) => (t, d) => ({ color: [C.isNum(d[k]) && d[k] >= lim ? '#ff3b30' : t.text, 1], glow: [t.glow, 0] });
        if (o.centre === 'map') {
            // the arcs bulge out to x ~200 / ~1720; the speed and gear sit between them and the map
            const bot = C.MAP.y + C.MAP.h;
            return C.aroundMap().map((b, i) => bg('bg' + i, b.x, b.y, b.w, b.h)).concat(arcs, [
                // (the gear above the dark box the KOMBI leaves right of centre, its rpm and mode below it)
                C.text('speedDigits', 228, 160, 186, 110, (d) => C.speedText(o, d), big),
                C.text('speedUnit', 228, 280, 186, 20, C.speedUnit(o), lbl, { tracking: 0.2 }),
                C.text('clock', 228, 440, 186, 30, C.clock, txt),
                C.text('outside', 228, 480, 186, 30, (d) => C.outsideText(o, d.outside), txt),
                C.text('gear', 1506, 158, 186, 100, C.gearText, gearC),
                C.text('rpmDigits', 1506, 460, 186, 20, rpmTxt, lbl, { tracking: 0.1 }),
                C.text('mode', 1506, 482, 186, 18, C.modeText, (t) => ({ color: [t.glow, 1], glow: [t.glow, 0.6] }), { tracking: 0.25 }),
            ],
            C.readingUp('fuel', 440, bot + 2, 220, 30, (d) => C.distText(o, d.frange), 'FUEL RANGE', txt, lbl),
            C.readingUp('elec', 670, bot + 2, 220, 30, C.focus.both(o), C.focus.rangeLabel(o), C.engineFocus(o) ? txt : evTxt, lbl),
            C.readingUp('oil', 900, bot + 2, 160, 30, (d) => C.tempText(o, d.oil), 'OIL', hotC('oil', 130), lbl),
            C.readingUp('coolant', 1070, bot + 2, 160, 30, (d) => C.tempText(o, d.coolant), 'COOLANT', hotC('coolant', 118), lbl));
        }
        const list = [bg('bg', 0, 0, 1920, 720)].concat(arcs, [
            // the gear stays left of the dark box the KOMBI leaves where its own gear readout was
            C.text('speedDigits', 470, 270, 300, 140, (d) => C.speedText(o, d), big),
            C.text('speedUnit', 470, 420, 300, 22, C.speedUnit(o), lbl, { tracking: 0.2 }),
            C.text('gear', 1150, 270, 260, 140, C.gearText, gearC),
            C.text('rpmDigits', 1150, 420, 260, 22, rpmTxt, lbl, { tracking: 0.12 }),
        ]);
        if (strip && (o.centre || 'info') === 'info') return newCar(o, arcs, gearC, rpmTxt);
        if (o.centre === 'stock') {
            list[0] = bg('bg', 0, 0, 760, 720);
            list.splice(1, 0, bg('bgR', 1160, 0, 760, 720));
            return list;
        }
        return list.concat([
            // below the camera's cowl, which covers the top middle
            C.text('clock', 790, 140, 170, 38, C.clock, txt),
            C.text('outside', 960, 140, 170, 38, (d) => C.outsideText(o, d.outside), txt),
            C.text('mode', 780, 190, 360, 18, C.modeText, (t) => ({ color: [t.glow, 1], glow: [t.glow, 0.6] }), { tracking: 0.3 }),
            C.flat('rule1', 860, 222, 200, 2, 'rule'),
        ],
        C.reading('fuel', 780, 240, 180, 44, (d) => C.distText(o, d.frange), 'FUEL RANGE', txt, lbl),
        C.reading('elec', 960, 240, 180, 44, C.focus.range(o), C.focus.rangeLabel(o), C.engineFocus(o) ? txt : evTxt, lbl),
        [C.bar('soc', 800, 340, 320, 22, C.focus.bar(o), (t) => ({ track: t.track, fill0: C.engineFocus(o) ? t.fill1 || t.accent : t.ev, fill1: C.engineFocus(o) ? t.fill1 || t.accent : t.ev, redc: t.red, tip: t.tip, tick: t.dim, num: t.num }), 24)],
        C.reading('soc', 800, 376, 160, 36, C.focus.charge(o), C.focus.chargeLabel(o), C.engineFocus(o) ? txt : evTxt, lbl),
        C.reading('kw', 960, 376, 160, 36, C.focus.power(o), C.focus.powerLabel(o), txt, lbl),
        [C.flat('rule2', 800, 474, 320, 2, 'rule')],
        C.reading('oil', 790, 494, 160, 44, (d) => C.tempText(o, d.oil), 'OIL', hotC('oil', 130), lbl),
        C.reading('coolant', 970, 494, 160, 44, (d) => C.tempText(o, d.coolant), 'COOLANT', hotC('coolant', 118), lbl));
    },
};
