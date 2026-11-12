'use strict';
/**
 * layout_pulse.js - "Pulse": made for the car's own bottom strip (the layout ends at y 660). The speed stands
 * large in the middle, under the camera's cowl, with the gear beside it; one long segmented bar under them is the
 * engine speed, running nearly the panel's width and turning red at the redline. A slim row of readings sits
 * along the bottom (oil, coolant, fuel and electric range, charge, power), the time and outside temperature in
 * the top corners. Its colours follow the
 * drive mode. An original design.
 */
const C = require('./layout_common');

const PALETTES = {
    comfort: {
        bgTop: '#0a0f16', bgBottom: '#020305', track: '#141c26', fill0: '#2b6fd6', fill1: '#7fd0ff', tip: '#d8f2ff',
        red: '#ff4038', tick: '#3a4a5c', num: '#93a7bc', text: '#f4f8ff', glow: '#4aa8ff', dim: '#8d99a6', rule: '#1b2836', ev: '#4ab4ff',
        mode: 'COMFORT',
    },
    sport: {
        bgTop: '#130808', bgBottom: '#040202', track: '#261515', fill0: '#c2410c', fill1: '#ffb020', tip: '#fff1c8',
        red: '#ff2a2a', tick: '#5a3a30', num: '#d6b0a0', text: '#ffffff', glow: '#ff7a1a', dim: '#b8a49c', rule: '#3a1d16', ev: '#4ab4ff',
        mode: 'SPORT',
    },
    efficient: {
        bgTop: '#05110e', bgBottom: '#010403', track: '#10221d', fill0: '#0f8a68', fill1: '#5ef2c4', tip: '#d4fff1',
        red: '#ff4038', tick: '#2c4d45', num: '#98c4b8', text: '#effffa', glow: '#2ad6a6', dim: '#93aba5', rule: '#153a31', ev: '#2ad6a6',
        mode: 'EFFICIENT',
    },
};
const big = (t) => ({ color: [t.text, 1], glow: [t.glow, 0.5] });
const txt = (t) => ({ color: [t.text, 1], glow: [t.glow, 0.12] });
const evTxt = (t) => ({ color: [t.ev, 1], glow: [t.ev, 0.3] });
const lbl = (t) => ({ color: [t.dim, 1], glow: [t.glow, 0] });
const accent = (t) => ({ color: [t.glow, 1], glow: [t.glow, 0.6] });
const bg = (key, x, y, w, h) => ({ key, kind: 'panel', x, y, w, h, params: { u_box: [0, 0, 0, 1] }, colors: (t) => ({ top: t.bgTop, bottom: t.bgBottom, border: t.bgBottom }) });
const hotC = (k, lim) => (t, d) => ({ color: [C.isNum(d[k]) && d[k] >= lim ? '#ff3b30' : t.text, 1], glow: [t.glow, 0] });
const gearC = (t, d) => ({ color: [C.gearText(d) === 'R' ? '#ff3b30' : t.text, 1], glow: [t.glow, 0.5] });
const rpmTxt = (d) => (C.isNum(d.rpm) ? Math.round(d.rpm / 50) * 50 + ' RPM' : '-- RPM');

/** The engine speed as a long segmented bar, red from the redline. */
function rpmBar(o, key, x, y, w, h, segments) {
    const r = C.rpmScale(o);
    return { key, kind: 'band', x, y, w, h,
        params: { u_geo: [6, h / 2, 0, Math.max(6, h - 10)], u_span: [0, 0, segments, 0.28], u_marks: [0, 0, 0, 0], u_red: [r.red / r.max] },
        colors: (t) => ({ track: t.track, fill0: t.fill0, fill1: t.fill1, redc: t.red, tip: t.tip, tick: t.tick, num: t.num }),
        value: (d) => (C.isNum(d.rpm) ? d.rpm / 1000 / r.max : 0), max: 1, sweep: true };
}
/** A reading with its label above it, both large: label lh px, a 2 px gap, then the value h px. */
const up = (key, x, y, w, h, value, label, colors, lh) => [
    C.text(key + 'Lbl', x, y, w, lh || 22, label, lbl, { tracking: 0.12 }),
    C.text(key, x, y + (lh || 22) + 2, w, h, value, colors),
];
const socBar = (o, key, x, y, w, h) => C.bar(key, x, y, w, h, C.focus.bar(o), (t) => {
    const f = C.engineFocus(o) ? t.fill1 : t.ev;
    return { track: t.track, fill0: f, fill1: f, redc: t.red, tip: t.tip, tick: t.dim, num: t.num };
}, 20);

module.exports = {
    id: 'pulse',
    stripGear: true,   // (the gear beside the speed: kept over the car's own strip too)
    title: 'Pulse',
    palette: (lookId) => PALETTES[lookId] || PALETTES.comfort,
    gearText: C.gearText,

    pieces(o) {
        const eTxt = C.engineFocus(o) ? txt : evTxt;
        if (o.centre === 'map') {
            // the speed on the left of the map's window, the gear on the right
            // (past the KOMBI's gear box); the engine speed along under the window
            const bot = C.MAP.y + C.MAP.h;
            return C.aroundMap().map((b, i) => bg('bg' + i, b.x, b.y, b.w, b.h)).concat([
                C.text('clock', 110, 176, 290, 44, C.clock, txt),
                C.text('speedDigits', 30, 236, 380, 160, (d) => C.speedText(o, d), big),
                C.text('speedUnit', 30, 400, 380, 28, C.speedUnit(o), lbl, { tracking: 0.25 }),
                C.text('outside', 110, 450, 290, 44, (d) => C.outsideText(o, d.outside), txt),
                C.text('gear', 1666, 286, 244, 150, C.gearText, gearC),
                C.text('mode', 1666, 440, 244, 26, C.modeText, accent, { tracking: 0.25 }),
                rpmBar(o, 'rpmBar', C.MAP.x, bot + 10, C.MAP.w, 30, 48),
            ],
            up('fuel', 20, 510, 190, 40, (d) => C.distText(o, d.frange), 'FUEL', txt, 20),
            up('elec', 215, 510, 195, 40, C.focus.range(o), C.focus.rangeLabel(o), eTxt, 20),
            up('oil', 1510, 500, 200, 40, (d) => C.tempText(o, d.oil), 'OIL', hotC('oil', 130), 20),
            up('coolant', 1710, 500, 200, 40, (d) => C.tempText(o, d.coolant), 'COOLANT', hotC('coolant', 118), 20),
            up('kw', 1510, 576, 200, 40, C.focus.power(o), C.focus.powerLabel(o), txt, 20),
            up('soc', 1710, 576, 200, 40, C.focus.charge(o), C.focus.chargeLabel(o), eTxt, 20));
        }
        if (o.centre === 'stock') {
            // the stock centre between two panels: the speed and its bar on the left, the gear and readings on the right
            return [bg('bg', 0, 0, 640, 720), bg('bgR', 1280, 0, 640, 720),
                C.text('clock', 230, 140, 190, 46, C.clock, txt),
                C.text('outside', 420, 140, 190, 46, (d) => C.outsideText(o, d.outside), txt),
                C.text('speedDigits', 130, 200, 490, 200, (d) => C.speedText(o, d), big),
                C.text('speedUnit', 130, 404, 490, 28, C.speedUnit(o), lbl, { tracking: 0.25 }),
                rpmBar(o, 'rpmBar', 110, 446, 520, 30, 24),
                C.text('rpmDigits', 110, 482, 520, 26, rpmTxt, lbl, { tracking: 0.12 }),
                C.text('gear', 1666, 270, 244, 170, C.gearText, gearC),
                C.text('mode', 1666, 444, 244, 26, C.modeText, accent, { tracking: 0.25 }),
            ].concat(
                up('oil', 110, 540, 250, 48, (d) => C.tempText(o, d.oil), 'OIL', hotC('oil', 130)),
                up('coolant', 380, 540, 250, 48, (d) => C.tempText(o, d.coolant), 'COOLANT', hotC('coolant', 118)),
                up('fuel', 1290, 480, 310, 48, (d) => C.distText(o, d.frange), 'FUEL RANGE', txt),
                up('elec', 1600, 480, 310, 48, C.focus.range(o), C.focus.rangeLabel(o), eTxt),
                up('kw', 1290, 570, 310, 48, C.focus.power(o), C.focus.powerLabel(o), txt),
                up('soc', 1600, 570, 310, 48, C.focus.charge(o), C.focus.chargeLabel(o), eTxt));
        }
        if (C.strip(o)) {
            // over the car's own strip (it shows the gear, the drive mode, the ranges, the time and the outside
            // temperature): the speed large in the middle, the battery's power and the engine speed either side of
            // it at the same height, the engine speed's bar under all three, one row of readings along the bottom
            const kwC = C.engineFocus(o) ? txt : (t, d) => ({ color: [C.isNum(d.kw) && d.kw < -0.3 ? t.regen : t.text, 1], glow: [t.glow, 0] });
            const rpmNum = (d) => (d.engineOn === false ? 'OFF' : C.isNum(d.rpm) ? String(Math.round(d.rpm / 50) * 50) : '--');
            // (the gear stays: the layout is made round it and the speed)
            return [bg('bg', 0, 0, 1920, 720),
                C.text('speedDigits', 690, 150, 540, 274, (d) => C.speedText(o, d), big),
                C.text('speedUnit', 690, 424, 540, 30, C.speedUnit(o), lbl, { tracking: 0.3 }),
                C.text('gear', 360, 176, 330, 230, C.gearText, gearC),
                rpmBar(o, 'rpmBar', 200, 474, 1520, 34, 64),
            ].concat(
                up('rpmNum', 1250, 272, 340, 96, rpmNum, 'ENGINE RPM', txt, 24),
                up('oil', 250, 526, 236, 64, (d) => C.tempText(o, d.oil), 'OIL', hotC('oil', 130), 24),
                up('coolant', 488, 526, 236, 64, (d) => C.tempText(o, d.coolant), 'COOLANT', hotC('coolant', 118), 24),
                up('kw', 726, 526, 236, 64, C.focus.power(o), C.focus.powerLabel(o), kwC, 24),
                up('soc', 964, 526, 236, 64, C.focus.charge(o), C.focus.chargeLabel(o), eTxt, 24),
                C.engineFocus(o) || o.vehicle === 'ice' ? up('iat', 1202, 526, 236, 64, (d) => C.tempText(o, d.iat), 'INTAKE', txt, 24)
                    : up('battT', 1202, 526, 236, 64, (d) => C.tempText(o, d.battTemp), 'BATTERY', eTxt, 24),
                up('gbox', 1440, 526, 236, 64, (d) => C.tempText(o, d.gearbox), 'GEARBOX', txt, 24));
        }
        return [bg('bg', 0, 0, 1920, 720),
            // the time and outside temperature in the top corners, inside the glass's slant
            C.text('clock', 280, 128, 260, 54, C.clock, txt),
            C.text('outside', 1380, 128, 260, 54, (d) => C.outsideText(o, d.outside), txt),
            C.text('mode', 740, 132, 440, 30, C.modeText, accent, { tracking: 0.3 }),
            // the speed, large, in the middle; the gear to its left (the KOMBI's gear box is on the right)
            C.text('speedDigits', 690, 166, 540, 274, (d) => C.speedText(o, d), big),
            C.text('speedUnit', 690, 440, 540, 30, C.speedUnit(o), lbl, { tracking: 0.3 }),
            C.text('gear', 360, 196, 330, 230, C.gearText, gearC),
            C.text('rpmDigits', 1226, 320, 180, 32, rpmTxt, lbl, { tracking: 0.06 }),
            // the engine speed: one long bar under it all
            rpmBar(o, 'rpmBar', 200, 482, 1520, 34, 64),
        ].concat(C.strip(o) ? [].concat(
            // the car's own bottom strip shows the ranges, and the fuel and charge gauges sit above them in the
            // corners: four readings between them
            up('oil', 340, 534, 300, 64, (d) => C.tempText(o, d.oil), 'OIL', hotC('oil', 130), 24),
            up('coolant', 650, 534, 300, 64, (d) => C.tempText(o, d.coolant), 'COOLANT', hotC('coolant', 118), 24),
            up('soc', 960, 534, 300, 64, C.focus.charge(o), C.focus.chargeLabel(o), eTxt, 24),
            up('kw', 1270, 534, 300, 64, C.focus.power(o), C.focus.powerLabel(o), txt, 24)) : [].concat(
            // one row along the bottom, the charge bar under its charge
            up('oil', 200, 534, 250, 64, (d) => C.tempText(o, d.oil), 'OIL', hotC('oil', 130), 24),
            up('coolant', 454, 534, 250, 64, (d) => C.tempText(o, d.coolant), 'COOLANT', hotC('coolant', 118), 24),
            up('fuel', 708, 534, 250, 64, (d) => C.distText(o, d.frange), 'FUEL RANGE', txt, 24),
            up('elec', 962, 534, 250, 64, C.focus.range(o), C.focus.rangeLabel(o), eTxt, 24),
            up('soc', 1216, 534, 250, 64, C.focus.charge(o), C.focus.chargeLabel(o), eTxt, 24),
            [socBar(o, 'socBar', 1256, 634, 170, 14)],
            up('kw', 1470, 534, 250, 64, C.focus.power(o), C.focus.powerLabel(o), txt, 24)));
    },
};
