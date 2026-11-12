'use strict';
/**
 * layout_retro.js - "Retro": a tribute to the round-dial clusters of the 1980s and 90s. Matte black faces with a
 * thin dark rim, numerals and ticks lit orange the way those clusters glowed at night, long slim red-orange
 * needles over black hub caps, a fuel gauge set into the speedometer, an economy gauge set into the tach (the
 * battery's power on a plug-in hybrid, boost on a petrol or diesel car: Settings > Vehicle), a small coolant
 * gauge between the dials and an amber LCD for the gear, the speed and the drive mode. Built around the
 * KOMBI's dark box like every layout (tools/clearance.js). An original design: no maker's marks or names.
 */
const C = require('./layout_common');

const PALETTES = {
    // the classic orange night lighting
    comfort: {
        bg: '#000000', face0: '#0f0e0d', face1: '#040404', bezel: '#34312e', bezel2: '#0a0909', tick: '#ffb36b', minor: '#c86a2c',
        num: '#ff8a2a', glow: '#ff6a10', red: '#ff2a14', needle: '#ff4a12', hub: '#0b0b0b', accent: '#ff6a10',
        lcdTop: '#120a05', lcdBottom: '#070402', lcdEdge: '#3d2513', text: '#ff9a3c', dim: '#c7865a', track: '#1e120a', ev: '#ffb36b',
        mode: 'COMFORT',
    },
    // a deeper red-orange
    sport: {
        bg: '#000000', face0: '#100c0b', face1: '#040303', bezel: '#36302e', bezel2: '#0a0808', tick: '#ff8d6a', minor: '#c24a2e',
        num: '#ff5e2e', glow: '#ff3a12', red: '#ff1a0c', needle: '#ff3a10', hub: '#0b0a0a', accent: '#ff3a12',
        lcdTop: '#130805', lcdBottom: '#070302', lcdEdge: '#432015', text: '#ff6e3c', dim: '#c77a62', track: '#200e0a', ev: '#ff8d6a',
        mode: 'SPORT',
    },
    // the daytime look: white markings, the orange needles kept
    efficient: {
        bg: '#000000', face0: '#101010', face1: '#040404', bezel: '#3a3a3a', bezel2: '#0b0b0b', tick: '#f4f4f0', minor: '#9a9a96',
        num: '#f4f4f0', glow: '#ffffff', red: '#ff2a14', needle: '#ff4a12', hub: '#0b0b0b', accent: '#ff6a10',
        lcdTop: '#120a05', lcdBottom: '#070402', lcdEdge: '#3a3a3a', text: '#ff9a3c', dim: '#b8b8b2', track: '#1a1a1a', ev: '#f4f4f0',
        mode: 'EFFICIENT',
    },
};
const dialColours = (t) => ({ face0: t.face0, face1: t.face1, bezel: t.bezel, bezel2: t.bezel2, tick: t.tick, minor: t.minor, num: t.num, red: t.red, needle: t.needle, hub: t.hub, accent: t.accent, glow: t.glow });
const lit = (t) => ({ color: [t.text, 1], glow: [t.glow, 0.45] });
const lbl = (t) => ({ color: [t.dim, 1], glow: [t.glow, 0.25] });
const regenTxt = { color: ['#3ddc84', 1], glow: ['#3ddc84', 0.3] };

/* the gauges' look: little glare, a thin dark rim, a soft needle shadow and a faint glass reflection */
const look = (k, glow) => ({ u_look: [glow, 0.15, 0, 0], u_look2: [Math.max(3, Math.round(7 * k)), k, 0.5, 0.8] });

/** A small gauge set into a big one (or standing alone): no numerals, ticks and a red zone, its own needle. */
function small(key, cx, cy, size, scale, arc, value, z) {
    const ks = size / 640;
    return Object.assign({
        key, kind: 'dial', x: cx - size / 2, y: cy - size / 2, w: size, h: size, z: z === undefined ? 5 : z,
        params: Object.assign({ u_scale: scale, u_arc: [arc[0], arc[1], 0, 0], u_needle_dim: [size * 0.4, size * 0.09, Math.max(4, size * 0.04), 2] }, look(ks, 0.6)),
        colors: dialColours, value, max: scale[0], sweep: true,
    });
}

/*
 * The economy gauge in the tach (after the fuel-consumption gauges of the era): on a plug-in hybrid the
 * battery's power as the other power gauges, 0 a quarter round, recuperation below it (green) and the power drawn
 * above it, each to the battery's limit (eDrive Live's: layout_common.kwRange; a tick every 20 kW drawn); with
 * Vehicle: ICE the boost (0 to 1.6 bar).
 */
function econDial(o, key, cx, cy, size) {
    if (C.engineFocus(o)) return small(key, cx, cy, size, [100, 25, 12.5, 101], [-110, 110], (d) => C.boostFrac(d) * 100);
    const outN = (d) => Math.ceil(C.kwRange(d).out / 20) * 20;
    return Object.assign(small(key, cx, cy, size, [100, 20, 20, 101], [-110, 110], (d) => (C.isNum(d.kw) ? Math.max(-C.kwRange(d).in, Math.min(outN(d), d.kw)) : 0)), {
        dyn: (d) => ({ u_scale: [outN(d), 20, 20, outN(d) + 1], u_min: [-C.kwRange(d).in], u_zero: [C.KW_ZERO], u_regen: C.REGEN_RGB }),
        range: (d) => [-C.kwRange(d).in, outN(d)],
    });
}

/** The speedometer (with the fuel gauge) or the tach (with the economy gauge), `size` across, centred at cx, cy. */
function dialSet(o, which, cx, size, cy) {
    const k = size / 640, s = which === 'speed' ? C.speedScale(o) : C.rpmScale(o);
    const red = which === 'speed' ? s.max + 1 : s.red;
    // km/h: 14 numerals, most of three figures (mph: 9); at mph's size 100-160 ran together, so smaller and further out
    const dense = which === 'speed' && o.speedUnit === 'kmh';
    const sub = Math.round(176 * k), subY = cy + Math.round(170 * k);
    const subPiece = which === 'speed'
        // fuel: full at the right, empty at the left, the reserve (the last eighth) red; read as 100 - level
        ? small('fuelDial', cx, subY, sub, [100, 25, 12.5, 87.5], [110, -110], (d) => (C.isNum(d.fuelPct) ? 100 - d.fuelPct : 100))
        : econDial(o, 'econDial', cx, subY, sub);
    const subLbl = which === 'speed' ? 'FUEL' : C.engineFocus(o) ? 'BOOST' : 'kW';
    const engineOffKw = (d) => C.electric(o, d);   // the tach reads kW (its unit says so)
    return [
        Object.assign({
            key: which, kind: 'dial', x: cx - size / 2, y: cy - size / 2, w: size, h: size,
            params: Object.assign({ u_scale: [s.max, s.major, s.minor, red], u_arc: [-135, 135, Math.round((dense ? 38 : 56) * k + 2), (dense ? 222 : 204) * k], u_needle_dim: [292 * k, 62 * k, 13 * k, 4] }, look(k, 0.75)),
            colors: dialColours, max: s.max, sweep: true,
            value: which === 'speed' ? (d) => (C.isNum(d.speed) ? C.speedIn(o, d.speed) : 0) : C.tachValue(o), range: which === 'speed' ? undefined : C.tachRange(o, s),
            dyn: which === 'speed' ? undefined : C.tachDyn(o, s, red),
        }),
        // (the small kW gauge is gone while the tach itself reads the battery's power: an electric mode)
        which === 'speed' || C.engineFocus(o) || o.vehicle === 'ice' ? subPiece : Object.assign({}, subPiece, { visible: (d) => !engineOffKw(d) }),
        // the dial's unit (the tach's: the battery's power while the engine is off)
        C.text(which + 'Unit', cx - 130, cy + Math.round(50 * k), 260, Math.max(16, Math.round(25 * k)),
            which === 'speed' ? C.speedUnit(o) : (d) => (engineOffKw(d) ? C.kwText(d) : '1/min x1000'),
            which === 'speed' ? lbl : (t, d) => (engineOffKw(d) ? (C.isNum(d.kw) && d.kw < -0.3 ? regenTxt : lit(t)) : lbl(t)), { tracking: 0.08 }),
        Object.assign(C.text(which + 'SubLbl', cx - 60, subY + Math.round(22 * k), 120, Math.max(13, Math.round(19 * k)), subLbl, lbl, { tracking: 0.12 }),
            which === 'speed' || C.engineFocus(o) || o.vehicle === 'ice' ? {} : { visible: (d) => !engineOffKw(d) }),
    ];
}

module.exports = {
    id: 'retro',
    title: 'Retro',
    palette: (lookId) => PALETTES[lookId] || PALETTES.comfort,
    gearText: C.gearText,
    stripFuel: false,   // (its speedometer has a fuel gauge)

    pieces(o) {
        const gearC = (t, d) => ({ color: [C.gearText(d) === 'R' ? t.red : t.text, 1], glow: [t.glow, 0.55] });
        if (o.centre === 'map') {
            // the speedometer left of the map, a small tach right of it below the dark box; the gear and speed above the box
            const top = C.MAP.y, bot = C.MAP.y + C.MAP.h;
            return C.aroundMap().map((r, i) => C.flat('bg' + i, r.x, r.y, r.w, r.h, 'bg')).concat(
                dialSet(o, 'speed', 208, 404, 360), C.strip(o) ? dialSet(o, 'rpm', 1712, 404, 360) : dialSet(o, 'rpm', 1792, 256, 500), [
                    C.text('clock', 520, top - 76, 200, 34, C.clock, lit),
                    C.text('outside', 1200, top - 76, 200, 34, (d) => C.outsideText(o, d.outside), lit),
                    C.text('gear', 1520, 130, 230, 92, C.gearText, gearC),
                    ...(C.strip(o) ? [] : [C.text('speedDigits', 1520, 224, 230, 32, (d) => C.speedText(o, d) + ' ' + C.speedUnit(o), lit)]),
                ],
                C.readingUp('fuel', 560, bot + 2, 260, 30, (d) => C.distText(o, d.frange), 'FUEL RANGE', lit, lbl),
                C.readingUp('elec', 1100, bot + 2, 300, 30, C.focus.both(o), C.focus.rangeLabel(o), lit, lbl),
            );
        }
        if (C.strip(o) && o.centre !== 'stock') {
            // the car's own bottom strip: the dials centred either side of the middle column, ending above the
            // strip (the speedometer keeps its fuel gauge; the ranges are the strip's)
            return [C.flat('bg', 0, 0, 1920, 720, 'bg')].concat(dialSet(o, 'speed', 452, 600, 328), dialSet(o, 'rpm', 1468, 600, 328), middle(o, 830, 260, gearC, 164, 590, true));   // (its top clear of the camera's cowl: a photo of the car)
        }
        const S = 520, cy = 392, L = 300;
        const stock = o.centre === 'stock', R = stock ? 1256 : 1120, SR = stock ? 296 : S;
        const list = [C.flat('bg', 0, 0, 1920, 720, 'bg')].concat(dialSet(o, 'speed', L, S, cy), dialSet(o, 'rpm', R, SR, cy));
        if (stock) {
            list[0] = C.flat('bg', 0, 0, 566, 720, 'bg');
            list.push(C.flat('bgR', 1104, 0, 816, 720, 'bg'));
        }
        // right of the dark box: the ranges and the charge (or boost and timing)
        const RX = 1672, RW = 216;
        list.push(...C.reading('fuel', RX, 292, RW, 44, (d) => C.distText(o, d.frange), 'FUEL RANGE', lit, lbl),
            ...C.reading('elec', RX, 400, RW, 44, C.focus.range(o), C.focus.rangeLabel(o), lit, lbl),
            C.text('socTxt', RX, 506, RW, 44, C.focus.charge(o), lit),
            C.bar('soc', RX + 8, 562, RW - 16, 16, C.focus.bar(o), (t) => ({ track: t.track, fill0: t.accent, fill1: t.accent, redc: t.red, tip: t.glow, tick: t.dim, num: t.num }), 10));
        if (stock) return list;
        // between the dials: the time and outside temperature, the coolant gauge, and the amber LCD
        return list.concat(middle(o, 574, 278, gearC, 144, 606));
    },
};

/** Between the dials, from y top to bottom: the time and outside temperature, the coolant gauge, and the amber
 * LCD with the gear, the speed and the drive mode. */
function middle(o, X, W, gearC, top, bottom, stripped) {
    const mid = X + W / 2, ly = bottom - 206, gy = top + Math.round((ly - top) / 2) + 16;
    const head = [
        C.text('clock', X + 8, top, (W - 22) / 2, 36, C.clock, lit, { align: 0 }),
        C.text('outside', X + W / 2 + 3, top, (W - 22) / 2, 36, (d) => C.outsideText(o, d.outside), lit, { align: 1 }),
        small('coolantDial', mid, gy, 184, [100, 25, 12.5, 80], [-110, 110], (d) => (C.isNum(d.coolant) ? Math.max(0, d.coolant - 40) : 0), 2),
        C.text('coolantLbl', mid - 60, gy + 26, 120, 19, 'TEMP', lbl, { tracking: 0.14 }),
        C.text('coolantNum', mid - 60, gy + 50, 120, 24, (d) => C.tempText(o, d.coolant), lit),   // (in figures)
        { key: 'lcd', kind: 'panel', x: X + 10, y: ly, w: W - 20, h: 206, params: { u_box: [10, 2, 0.4, 1] }, colors: (t) => ({ top: t.lcdTop, bottom: t.lcdBottom, border: t.lcdEdge }) },
    ];
    // over the car's own strip (it shows the gear and the drive mode): the LCD is the digital speed, large
    if (stripped) return head.concat([
        C.text('speedDigits', X + 10, ly + 26, W - 20, 120, (d) => C.speedText(o, d), lit),
        C.text('speedDigitsUnit', X + 10, ly + 156, W - 20, 24, C.speedUnit(o), lbl, { tracking: 0.12 }),
    ]);
    return [
        C.text('clock', X + 8, top, (W - 22) / 2, 36, C.clock, lit, { align: 0 }),
        C.text('outside', X + W / 2 + 3, top, (W - 22) / 2, 36, (d) => C.outsideText(o, d.outside), lit, { align: 1 }),
        // coolant: cold left, hot right, red from 120 °C (a 40-140 °C scale)
        small('coolantDial', mid, gy, 184, [100, 25, 12.5, 80], [-110, 110], (d) => (C.isNum(d.coolant) ? Math.max(0, d.coolant - 40) : 0), 2),
        C.text('coolantLbl', mid - 60, gy + 26, 120, 19, 'TEMP', lbl, { tracking: 0.14 }),
        C.text('coolantNum', mid - 60, gy + 50, 120, 24, (d) => C.tempText(o, d.coolant), lit),   // (in figures)
        { key: 'lcd', kind: 'panel', x: X + 10, y: ly, w: W - 20, h: 206, params: { u_box: [10, 2, 0.4, 1] }, colors: (t) => ({ top: t.lcdTop, bottom: t.lcdBottom, border: t.lcdEdge }) },
        C.text('gear', X + 10, ly + 12, W - 20, 100, C.gearText, gearC),
        C.text('speedDigits', X + 10, ly + 118, W / 2 + 26, 46, (d) => C.speedText(o, d), lit, { align: 1 }),
        C.text('speedDigitsUnit', mid + 44, ly + 138, 80, 22, C.speedUnit(o), lbl, { align: 0, tracking: 0.08 }),
        C.text('mode', X + 10, ly + 168, W - 20, 26, C.modeText, lbl, { tracking: 0.16 }),
    ];
}
