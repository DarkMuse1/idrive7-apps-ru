'use strict';
/**
 * layout_common.js - what the layouts share: units, the gear's text, temperature scales and piece makers
 * (see engine.js for what a piece is).
 */
const KMH_PER_MPH = 1.609344;
const isNum = (v) => typeof v === 'number' && isFinite(v);

const speedIn = (o, kmh) => (o.speedUnit === 'kmh' ? kmh : kmh / KMH_PER_MPH);
const speedUnit = (o) => (o.speedUnit === 'kmh' ? 'km/h' : 'mph');
const tempIn = (o, c) => (o.tempUnit === 'c' ? c : c * 9 / 5 + 32);
const tempText = (o, c) => (isNum(c) ? Math.round(tempIn(o, c)) + '°' : '--');
const speedText = (o, d) => (isNum(d.speed) ? String(Math.round(speedIn(o, d.speed))) : '--');

/** The speed scale for the unit: { max, major, minor }. */
const speedScale = (o) => (o.speedUnit === 'kmh' ? { max: 260, major: 20, minor: 10 } : { max: 160, major: 20, minor: 5 });
/** Engine speed in thousands: the scale's end (5-10) and the red zone's start. */
function rpmScale(o) {
    const max = Math.max(5, Math.min(10, Math.round((o.rpmMax || 8000) / 1000)));
    return { max, major: 1, minor: 0.25, red: Math.max(2, Math.min(max, (o.redline || 7000) / 1000)) };
}
/** A temperature (°C) on a 40-140 °C scale, 0..1. */
const tempFrac = (c) => (isNum(c) ? Math.max(0, Math.min(1, (c - 40) / 100)) : 0);

/** The gear: P R N, or D / S / M (the selector's programme) with the gear number. */
function gearText(d) {
    if (d.stage === 'P' || d.stage === 'R' || d.stage === 'N') return d.stage;
    if (d.gear === -1) return 'R';
    const g = isNum(d.gear) && d.gear > 0 ? String(d.gear) : '';
    const mode = d.mode === 'S' || d.mode === 'M' ? d.mode : 'D';
    return d.stage === 'D' || g || d.mode ? mode + g : '-';
}
/** The selector letter lit in a P R N D row. */
function selectorLit(d) {
    const g = gearText(d);
    return g === '-' ? '' : g === 'P' || g === 'R' || g === 'N' ? g : 'D';
}
/** The drive mode line: the mode as the car names it (data.js FES_MODES), else S / M from the selector, else the
 * colours' name. */
const modeText = (d, t) => {
    if (d && d.driveMode) return d.driveMode;
    if (d && (d.mode === 'S' || d.mode === 'M')) return d.mode === 'M' ? 'MANUAL' : 'SPORT';
    return t.mode;
};
/* the local time (clock.js: the unit's apps run on UTC; the Time zone setting says where the car is) */
const clock = () => require('./clock').hm();

/* ---------- the map window and the extra readings ---------- */

/** Where waze-on-cluster's map (and the stock map) shows on the panel: the native map area (slot 0x100). With
 * the centre set to 'map', a layout leaves this clear and puts nothing over it. */
const MAP = { x: 416, y: 120, w: 1088, h: 480 };
/** Background rectangles round the map window (top, bottom, left, right). */
const aroundMap = () => [
    { x: 0, y: 0, w: 1920, h: MAP.y }, { x: 0, y: MAP.y + MAP.h, w: 1920, h: 720 - MAP.y - MAP.h },
    { x: 0, y: MAP.y, w: MAP.x, h: MAP.h }, { x: MAP.x + MAP.w, y: MAP.y, w: 1920 - MAP.x - MAP.w, h: MAP.h },
];
/** True when a rectangle overlaps the map window. */
const overMap = (r) => r.x < MAP.x + MAP.w && r.x + r.w > MAP.x && r.y < MAP.y + MAP.h && r.y + r.h > MAP.y;

/*
 * What the cluster's glass shows of the panel (from photos of a G05; the same on every car with this cluster):
 * the top corners are cut on a slant, the camera's cowl covers the top middle, the stock warning lights and
 * the gear's letter sit along the bottom, and while a layout is up the KOMBI leaves a dark box where the stock
 * gear readout was (right of centre). Layouts keep their readings out of these.
 */
const NOTCH = { x: 730, y: 0, w: 460, h: 128 };
/* the KOMBI's own bracket where its gear readout was (measured from a photo of the car: a thick grey bar on
 * top with a slanted left end, a thick bar on the right, a thin line at the bottom, black inside, at about
 * x 1490-1652, y 271-442), with a margin; drawn over us, so kept clear and dressed by boxBezel() */
const GEARBOX_HOLE = { x: 1410, y: 262, w: 252, h: 192 };
/* the bracket's grey (#1e1d21, from the photo against a tile of known colour) */
const BRACKET = '#1e1d21';
/** A bezel in the bracket's own grey behind it, a little larger: its bars merge into it and its black window
 * reads as a recessed screen, not a stray shape. */
const boxBezel = () => ({ key: 'boxBezel', kind: 'panel', x: 1476, y: 258, w: 190, h: 198, params: { u_box: [12, 1.5, 0, 1] },
    colors: () => ({ top: '#232227', bottom: BRACKET, border: '#2e2d33' }) });
/* a second, smaller one at the top right, where the stock eDrive readout sits on a plug-in hybrid */
const EDRIVE_HOLE = { x: 1770, y: 170, w: 150, h: 95 };
/*
 * Settings > Cluster: M car. An M car's KOMBI leaves two more dark boxes in the middle of the panel while a
 * layout is up (its own readouts' places in its M display), measured from one photo of a car showing Digital dash:
 * the photo's perspective fitted to the six tiles' corners (fit within 2 px of the photo, about 4 px here), then
 * the boxes' corners read back. The second box's right and bottom edges were at the tile's edges in the photo,
 * so it may reach further; the holes keep a margin round each (and more to the right and below the second).
 */
const M_BOXES = [{ x: 793, y: 289, w: 246, h: 92 }, { x: 1223, y: 328, w: 171, h: 78 }];
const M_HOLES = [{ x: 778, y: 274, w: 276, h: 122 }, { x: 1208, y: 313, w: 207, h: 113 }];
/** True for an M car (Settings > Cluster) whose boxes show: with the car's own bottom strip (Settings > Bottom
 * strip, the default) the layout ends at y 660 and the KOMBI leaves no boxes, so the layouts keep their own places. */
const mCar = (o) => !!o && o.cluster === 'm' && o.bottomStrip !== 'stock';
/** The KOMBI's dark boxes a layout keeps its readings out of, for this car: the gear box, and an M car's two. */
const holes = (o) => (strip(o) ? [] : [GEARBOX_HOLE, EDRIVE_HOLE].concat(mCar(o) ? M_HOLES : []));
/*
 * Settings > Bottom strip > The car's own (the default): the layout ends at STRIP_Y, the KOMBI's own strip shows
 * below it (its fuel range bottom left, the time, the street, the drive mode and gear, the outside temperature and
 * the electric range bottom right), and the KOMBI's gear bracket and eDrive box don't show: the layouts take their
 * centred places, the ranges' numbers are left to the strip, and the fuel and charge gauges sit above the strip's
 * ranges (stripGauges). 646: 660 just touched the top of the strip's drive mode (photo of the car).
 */
const STRIP_Y = 646;
const strip = (o) => !!o && o.bottomStrip === 'stock';
/** The fuel gauge above the strip's fuel range (bottom left) and the charge above its electric range (bottom
 * right): bars with a word, no numbers (the strip shows the ranges). The charge only on a plug-in hybrid. */
function stripGauges(o, opts) {
    const lab = (t) => ({ color: [t.dim || '#9aa4ae', 1], glow: [t.glow || '#000000', 0] });
    const fuelC = (t) => ({ track: t.track || '#1a1a1a', fill0: t.text || t.tick || '#e8e8e8', fill1: t.text || t.tick || '#e8e8e8', redc: t.red || '#ff3b30', tip: t.text || '#ffffff', tick: t.dim || '#888888', num: t.num || '#888888' });
    const evC = (t) => ({ track: t.track || '#1a1a1a', fill0: t.ev || '#4ab4ff', fill1: t.ev || '#4ab4ff', redc: t.red || '#ff3b30', tip: t.ev || '#4ab4ff', tick: t.dim || '#888888', num: t.num || '#888888' });
    const out = opts && opts.fuel === false ? [] : [
        // each with its level in % beside its name (the strip under it shows the range)
        text('stripFuelLbl', 96, 598, 220, 16, (d) => 'FUEL' + (isNum(d.fuelPct) ? '  ' + Math.round(d.fuelPct) + '%' : ''), lab, { align: 0, tracking: 0.18 }),
        bar('stripFuel', 90, 618, 250, 16, (d) => (isNum(d.fuelPct) ? d.fuelPct / 100 : 0), fuelC, 16),
    ];
    if (o.vehicle !== 'ice') out.push(
        text('stripSocLbl', 1610, 598, 220, 16, (d) => (isNum(d.soc) ? Math.round(d.soc) + '%  ' : '') + 'CHARGE', lab, { align: 1, tracking: 0.18 }),
        bar('stripSoc', 1580, 618, 250, 16, (d) => (isNum(d.soc) ? d.soc / 100 : 0), evC, 16));
    return out;
}
/** The layout's own range readings (keys) left out with the strip: it shows both ranges. */
const STRIP_DROP = /^(fuel|elec|frange|erange|range2)(Lbl)?$|^erangeL$/;

/*
 * A plug-in hybrid in an electric eDrive mode (ELECTRIC, ELECTRIC INDIVIDUAL; the car's drive mode, data.js
 * driveMode), or, before the car has named its mode, with the engine off: the analog layouts' tachs read the
 * battery's power instead (tachDyn, below). In HYBRID, SPORT, BATTERY CONTROL and the rest they are tachs, with a small
 * power gauge inside. Never with Show: Engine or on a petrol or diesel car.
 */
const electric = (o, d) => !engineFocus(o) && !!o && o.vehicle !== 'ice' && !!d
    && (typeof d.driveMode === 'string' && d.driveMode ? /ELECTRIC/.test(d.driveMode) : d.engineOn === false);
/*
 * The power gauges: 0 a quarter along (KW_ZERO), the battery's power drawn above it to the gauge's top, the
 * regeneration below it to its start, each side on its own scale. The ends are eDrive Live's (the battery's
 * discharge and charge limits, data.js kwOut / kwIn), else 100 and 35 kW.
 */
const KW_ZERO = 0.25;
const KW_FLOOR = -500;                  // (a dial's lowest value passed on: the engine's clamp; the gauge clamps itself)
const REGEN_RGB = [0.24, 0.86, 0.52];   // (#3ddc84, the layouts' regeneration green)
/** The gauge's ends now: { out, in } kW. */
const kwRange = (d) => ({ out: d && isNum(d.kwOut) && d.kwOut >= 20 ? d.kwOut : 100, in: d && isNum(d.kwIn) && d.kwIn >= 5 ? d.kwIn : 35 });
/** kW as a place along a power gauge (0..1, 0 kW at z). */
const kwFrac = (kw, r, z) => {
    const zz = isNum(z) ? z : KW_ZERO;
    if (!isNum(kw)) return zz;
    return kw >= 0 ? zz + (1 - zz) * Math.min(1, kw / r.out) : zz * (1 - Math.min(1, -kw / r.in));
};
/** A round scale for out kW: { max, major, minor }, its numerals every major (4-5 of them). */
function kwDialScale(out) {
    const major = [20, 25, 40, 50].find((m) => Math.ceil(out / m) <= 5) || 100;
    return { max: Math.ceil(out / major) * major, major, minor: major / 5 };
}
/** A tach dial's dyn, value and range: kW in an electric mode (0 a quarter round), else the engine speed
 * (s: rpmScale(o), red where it is). */
const tachDyn = (o, s, red) => (d) => {
    if (!electric(o, d)) return { u_scale: [s.max, s.major, s.minor, red], u_min: [0], u_zero: [0], u_regen: REGEN_RGB };
    const r = kwRange(d), k = kwDialScale(r.out);
    return { u_scale: [k.max, k.major, k.minor, k.max + 1], u_min: [-r.in], u_zero: [KW_ZERO], u_regen: REGEN_RGB };
};
const tachValue = (o) => (d) => {
    if (!electric(o, d)) return isNum(d.rpm) ? d.rpm / 1000 : 0;
    const r = kwRange(d);
    return isNum(d.kw) ? Math.max(-r.in, Math.min(kwDialScale(r.out).max, d.kw)) : 0;
};
const tachRange = (o, s) => (d) => (electric(o, d) ? [-kwRange(d).in, kwDialScale(kwRange(d).out).max] : [0, s.max]);
/* The readings put where the time and outside temperature were, with the car's own bottom strip (which shows
 * both): the battery's temperature (a plug-in hybrid; intake air on a petrol or diesel car) and the gearbox oil's. */
const stripInfoA = (o) => (o.vehicle === 'ice' || engineFocus(o)
    ? (d) => 'INTAKE ' + tempText(o, d.iat) : (d) => 'BATT ' + tempText(o, d.battTemp));
const stripInfoB = (o) => (d) => 'GEARBOX ' + tempText(o, d.gearbox);

/*
 * A tach's power meter (a plug-in hybrid's eDrive scale): an inner arc across the top of the tach, 0 a quarter
 * along it (40 degrees left of twelve o'clock); right of it the power drawn from the battery (blue, 120 degrees, to
 * the battery's limit), left of it charging and recuperation (green, 40 degrees, to its limit): eDrive Live's ends
 * (kwRange), numbered in round steps. lbl: the label's colours.
 */
function powerMeter(cx, size, cy, lbl, o) {
    const k = size / 640, r = Math.round(150 * k), th = Math.max(8, Math.round(12 * k)), half = r + th + Math.round(22 * k);
    const box = { x: cx - half, y: cy - half, w: half * 2, h: half };     // the top half around the dial's centre
    // (each side's end rounded: the power drawn to 20 kW, in 4 marks; the regeneration to 10 kW, in 2)
    const outN = (d) => Math.ceil(kwRange(d).out / 20) * 20, inN = (d) => Math.ceil(kwRange(d).in / 10) * 10;
    const arc = (key, a0, a1, value, colour, marks, end) => ({
        key, kind: 'band', x: box.x, y: box.y, w: box.w, h: box.h + th, z: 2,
        params: { u_geo: [half, half, r, th], u_span: [a0, a1, 0, 0], u_marks: [marks, 25, Math.round(19 * k), -Math.round(24 * k)], u_red: [2] },
        colors: (t) => ({ track: t.track, fill0: colour(t), fill1: colour(t), redc: t.red, tip: colour(t), tick: t.dim, num: t.num }),
        dyn: (d) => ({ u_marks: [marks, end(d) / marks, Math.round(19 * k), -Math.round(24 * k)] }),
        value, max: 1, sweep: true,
        // (gone while the dial itself reads the battery's power: an electric mode)
        visible: o ? (d) => !electric(o, d) : undefined,
    });
    return [
        arc('kwDraw', -40, 80, (d) => Math.max(0, Math.min(1, (isNum(d.kw) ? d.kw : 0) / outN(d))), (t) => t.ev, 4, outN),
        arc('kwRegen', -40, -80, (d) => Math.max(0, Math.min(1, -(isNum(d.kw) ? d.kw : 0) / inN(d))), (t) => t.regen || '#3ddc84', 2, inN),
        Object.assign(text('kwLbl', cx - 40, cy - r + Math.round(46 * k), 80, Math.round(20 * k), 'kW', lbl, { tracking: 0.04 }), o ? { visible: (d) => !electric(o, d) } : {}),
    ];
}

/* the stock warning lights and the fallback gear letter along the bottom middle */
const TELLTALES = { x: 560, y: 652, w: 960, h: 68 };
/** Rectangles covering r but not hole: r itself when they don't meet, else up to four around the hole (the
 * background drawn around the KOMBI's dark box, so nothing of ours sits under it). */
function cut(r, hole) {
    const hx = Math.max(r.x, hole.x), hy = Math.max(r.y, hole.y), hx2 = Math.min(r.x + r.w, hole.x + hole.w), hy2 = Math.min(r.y + r.h, hole.y + hole.h);
    if (hx >= hx2 || hy >= hy2) return [r];
    return [
        { x: r.x, y: r.y, w: r.w, h: hy - r.y },                       // above
        { x: r.x, y: hy2, w: r.w, h: r.y + r.h - hy2 },                // below
        { x: r.x, y: hy, w: hx - r.x, h: hy2 - hy },                   // left
        { x: hx2, y: hy, w: r.x + r.w - hx2, h: hy2 - hy },            // right
    ].filter((q) => q.w > 0 && q.h > 0);
}
/** True when a point is inside the glass's slanted top corners (hidden). */
const inCorner = (x, y) => y < 217 - 0.55 * Math.min(x, 1920 - x);

/** A distance in km as the speed unit wants it: '312 MI', '502 KM', or '--'. */
const distText = (o, km) => (isNum(km) ? Math.round(o.speedUnit === 'kmh' ? km : km / KMH_PER_MPH) + (o.speedUnit === 'kmh' ? ' km' : ' mi') : '--');
/** The electric range: '~31 MI' when it is the estimate from the charge (data.js), else as distText. */
const erangeText = (o, d) => (isNum(d.erange) && d.erangeEst ? '~' : '') + distText(o, d.erange);
/*
 * Settings > Vehicle: a plug-in hybrid (o.vehicle 'phev', the eDrive readings) or a petrol or diesel car
 * ('ice'). With ICE the layouts trade their eDrive readings for the engine's: battery power -> engine torque, charge -> ignition timing, electric range -> boost, the charge bar
 * -> boost against its target. Each helper takes o and gives the reading for the choice.
 */
const engineFocus = (o) => !!o && (o.vehicle === 'ice' || o.focus === 'engine');
const boostIn = (o, bar0) => (o.speedUnit === 'kmh' ? bar0 : bar0 * 14.5038);
const boostText = (o, d) => (d.engineOn === false ? 'OFF' : isNum(d.boostActual)
    ? (o.speedUnit === 'kmh' ? boostIn(o, d.boostActual).toFixed(2) + ' bar' : boostIn(o, d.boostActual).toFixed(1) + ' psi') : '--');
/** Engine torque (Nm) in Settings > Torque unit: Nm, or kgm (to a tenth). */
const torqueKgm = (o) => !!o && o.torqueUnit === 'kgm';
const torqueNum = (o, nm) => (!isNum(nm) ? '--' : torqueKgm(o) ? (nm / 9.80665).toFixed(1) : String(Math.round(nm)));
const torqueUnit = (o) => (torqueKgm(o) ? 'kgm' : 'Nm');
const torqueText = (o) => (d) => (isNum(d.torque) ? torqueNum(o, d.torque) + ' ' + torqueUnit(o) : '--');
const timingText = (d) => (isNum(d.timing) ? d.timing.toFixed(1) + '°' : '--');
/** Boost (bar over atmosphere) 0..1.6 as 0..1. */
const boostFrac = (d) => (d.engineOn === false || !isNum(d.boostActual) ? 0 : Math.max(0, Math.min(1, d.boostActual / 1.6)));
const focus = {
    power: (o) => (engineFocus(o) ? torqueText(o) : kwText),
    powerLabel: (o, long) => (engineFocus(o) ? (long ? 'ENGINE TORQUE' : 'TORQUE') : (long ? 'BATTERY POWER' : 'POWER')),
    /** 0..1 for the power bar: torque to 450 Nm, or none (the eDrive layouts draw their own centre-zero bar) */
    torqueFrac: (d) => (isNum(d.torque) ? Math.max(0, Math.min(1, d.torque / 450)) : 0),
    charge: (o) => (engineFocus(o) ? timingText : socText),
    chargeLabel: (o) => (engineFocus(o) ? 'TIMING' : 'CHARGE'),
    range: (o) => (engineFocus(o) ? (d) => boostText(o, d) : (d) => erangeText(o, d)),
    rangeLabel: (o) => (engineFocus(o) ? 'BOOST' : 'ELECTRIC'),
    /** the electric range and charge on one line, or the boost and timing */
    both: (o) => (engineFocus(o) ? (d) => boostText(o, d) + '  ' + timingText(d) : (d) => erangeText(o, d) + '  ' + socText(d)),
    bar: (o) => (engineFocus(o) ? boostFrac : (d) => (isNum(d.soc) ? d.soc / 100 : 0)),
    /** what the engine readings need read from the engine unit */
    needs: (o) => (engineFocus(o) ? ['boostActual', 'boostTarget', 'timing', 'hpfp'] : []),
};
/** Outside temperature with its unit letter: '48°F'. */
const outsideText = (o, c) => (isNum(c) ? Math.round(tempIn(o, c)) + '°' + (o.tempUnit === 'c' ? 'C' : 'F') : '--');
const socText = (d) => (isNum(d.soc) ? Math.round(d.soc) + '%' : '--');
const kwText = (d) => (isNum(d.kw) ? (d.kw > 0.05 ? '+' : '') + (Math.abs(d.kw) < 10 ? d.kw.toFixed(1) : Math.round(d.kw)) + ' kW' : '--');

/** A reading with its label under it: two text pieces. */
function reading(key, x, y, w, h, value, label, colors, labelColors) {
    return [
        text(key, x, y, w, h, value, colors),
        text(key + 'Lbl', x, y + h + Math.round(h * 0.14), w, Math.max(18, Math.round(h * 0.4)), label, labelColors, { tracking: 0.12 }),
    ];
}
/** A reading with its label above it (where the row must end above the warning lights): label 16 px, then the
 * value h high. */
function readingUp(key, x, y, w, h, value, label, colors, labelColors) {
    return [
        text(key + 'Lbl', x, y, w, 16, label, labelColors, { tracking: 0.1 }),
        text(key, x, y + 18, w, h, value, colors),
    ];
}
/** A straight bar (band shader in bar mode): value(d) 0..1. */
function bar(key, x, y, w, h, value, colors, segments) {
    return { key, kind: 'band', x, y, w, h, params: { u_geo: [4, h / 2, 0, Math.max(4, h - 8)], u_span: [0, 0, segments || 0, 0.25], u_marks: [0, 0, 0, 0], u_red: [2] },
        colors, value, max: 1, sweep: true };
}

/** A text piece. */
const text = (key, x, y, w, h, txt, colors, extra) => Object.assign({ key, kind: 'text', x, y, w, h, text: txt, colors, align: 0.5 }, extra || {});
/** A flat rectangle. */
const flat = (key, x, y, w, h, colour) => ({ key, kind: 'flat', x, y, w, h, colors: (t, d) => ({ color: [typeof colour === 'function' ? colour(t, d) : t[colour], 1] }) });

module.exports = {
    isNum, speedIn, speedUnit, tempIn, tempText, speedText, speedScale, rpmScale, tempFrac, gearText, selectorLit, clock, modeText, text, flat,
    STRIP_Y, strip, stripGauges, STRIP_DROP, electric, KW_ZERO, KW_FLOOR, REGEN_RGB, kwRange, kwFrac, kwDialScale, powerMeter, tachDyn, tachValue, tachRange, stripInfoA, stripInfoB, MAP, aroundMap, overMap, cut, NOTCH, GEARBOX_HOLE, boxBezel, EDRIVE_HOLE, M_BOXES, M_HOLES, mCar, holes, TELLTALES, inCorner, distText, erangeText, outsideText, socText, kwText, reading, readingUp, bar, engineFocus, focus, boostText, torqueText, torqueNum, torqueUnit, timingText, boostFrac,
};
