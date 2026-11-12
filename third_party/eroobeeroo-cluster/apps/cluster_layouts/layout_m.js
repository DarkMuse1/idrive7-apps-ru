'use strict';
/**
 * layout_m.js - "M": bimmer-lab's M theme for Cluster Themes (MIT, Copyright (c) 2026 bimmer-lab,
 * github.com/bimmer-lab/apps; traced off a photo of an M8's cluster), as theirs: their shaders (MDASH_FS: the
 * backdrop with its cards, centre line and M stripes; MTACH_FS: the two bowed glass
 * rev blades) with their layout's numbers, and every text where their layout puts it, in their faces (Orbitron
 * Black, Barlow Medium; font.js 'orb'), the size and on the line theirs are (bimmer.js).
 *
 * Fitted to the G05: their time, fuel range, outside temperature and badge along the bottom left out (the car's own
 * strip shows them); the M stripes, the top numerals moved clear of the camera's cowl. With the Waze map their
 * window between the blades (the map drawn there, map_window.js) and their map-up places for the gear and speed; on
 * an M car (its KOMBI's two boxes in the middle) the gear and speed in those places too. Full screen without the
 * car's strip the right-hand setup rows stand clear of the KOMBI's own gear box (above and below it).
 *
 * The gauges are the M8's flat bars, each temperature and the charge in figures too: in the cards the engine's
 * temperatures on the left (coolant, oil; the gearbox's oil on a petrol or diesel car), on the right the battery's
 * power (its first quarter regeneration, green) and temperature on a plug-in hybrid, the boost and torque on a petrol
 * or diesel car (or with Show: Engine); along the bottom, as the M8's fuel gauge, the fuel level left and the charge
 * right (the oil on a petrol or diesel car).
 */
const C = require('./layout_common');
const B = require('./bimmer');

/* their theme (hud_themes.js mdash), following the drive mode (themes.js lookNow) as the M8's does: in comfort
 * theirs (silver glass, the red marker); in a sport mode the blades' glass lit red and the bars' fill warm; in ECO
 * PRO and on electricity alone blue */
const PAL = { bg: '#000000', text: '#eef1f6', fg: '#eef1f6', dim: '#848c98', faint: '#606876', red: '#e2242c', regen: '#3ddc84', glow: '#e2242c', track: '#5c6068', ev: '#4ab4ff',
    mark: '#e2242c', lit: '#dce0ea', fill: '#eef1f6' };
const LOOKS = {
    comfort: {},
    sport: { lit: '#ff4650', mark: '#ff2a2a', fill: '#ffd9db', dim: '#a8868a' },
    efficient: { lit: '#8fcaff', mark: '#4ab4ff', fill: '#d4ecff', dim: '#7f93a8' },
};
const pal = (look) => Object.assign({}, PAL, LOOKS[look] || LOOKS.comfort);
const isNum = C.isNum;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const RPM_MAX = 8000;   // the M8's scale: 0-8

/* their map window ("hole" [705, 165, 510, 275], inset 6) */
const WINDOW = { x: 711, y: 171, w: 498, h: 263 };
/* their rev blades (tach_left / tach_right), each in a layer from just outside its outer edge (the right one clear of
 * the KOMBI's gear box, from x 1410) to the map window's edge */
const BLADE = { x0: 515, w: 196, y: 36, h: 558, y0: 566, y8: 66, ym: 303, xm: 528, kTop: 1.0684, kBot: 0.5434, round: 135, wBot: 52, wTop: 17, wBend: 44 };

/*
 * The gauges, as the M8's coolant and boost bars: an icon over the left end, the unit over the right, the bar
 * (MBAR_FS: a thin track, a thicker fill, red zones, a red start tick), the scale's labels under it. Each one
 * { icon, unit, labels: [[at 0..1 (-1: none), text] x3], value(d) 0..1, zero (where the fill starts), lo / hi (red
 * to, from), neg (the fill's colour below the zero), nums(d) (the labels' numbers now, if they move), read(d) (the
 * reading in figures, beside the icon: red in a red zone) }.
 */
const KW_ZERO = C.KW_ZERO;   // the power: its first quarter regeneration (to the battery's limit), then to its top
/** The power bar's top: eDrive Live's (layout_common.kwRange) up to 20 kW, so its middle label is a round number. */
const barRange = (d) => { const r = C.kwRange(d); return { out: Math.ceil(r.out / 20) * 20, in: r.in }; };
/** The blades' top as a power gauge: three equal steps from the 0 (a quarter up), each a round 10 kW. */
const bladeRange = (d) => { const r = C.kwRange(d); return { out: Math.ceil(r.out / 30) * 30, in: r.in }; };
function gauges(o, engine) {
    const isF = o.tempUnit !== 'c', us = o.speedUnit !== 'kmh';
    const tl = (c) => String(Math.round(C.tempIn(o, c) / 10) * 10), tu = '°' + (isF ? 'F' : 'C');
    const f01 = (v, a, b) => (isNum(v) ? Math.max(0, Math.min(1, (v - a) / (b - a))) : 0);
    // the engine's temperatures: the coolant (70-130 C, hot from 118), the oil (50-150 C, hot from 135), the
    // gearbox oil (40-140 C, hot from 126); each one's reading in figures beside its icon (rd)
    const rd = (k) => (d) => (isNum(d[k]) ? String(Math.round(C.tempIn(o, d[k]))) : '--');
    const coolant = { icon: 'therm', unit: tu, read: rd('coolant'), labels: [[0, tl(70)], [0.5, tl(100)], [1, tl(130)]], value: (d) => f01(d.coolant, 70, 130), zero: 0, lo: -1, hi: 0.8 };
    const oil = { icon: 'oilcan', unit: tu, read: rd('oil'), labels: [[0, tl(50)], [0.5, tl(100)], [1, tl(150)]], value: (d) => f01(d.oil, 50, 150), zero: 0, lo: -1, hi: 0.85 };
    const gearbox = { icon: 'cog', unit: tu, read: rd('gearbox'), labels: [[0, tl(40)], [0.5, tl(90)], [1, tl(140)]], value: (d) => f01(d.gearbox, 40, 140), zero: 0, lo: -1, hi: 0.86 };
    // along the bottom: the fuel (red under an eighth) and the charge in figures too (red under 10%); on a petrol or
    // diesel car the oil there instead, and the gearbox's oil in the card in its place
    const ice = o.vehicle === 'ice';
    // (the fuel's bar reads the range left on it)
    const fuel = { icon: 'fuel', unit: '', read: (d) => (isNum(d.frange) ? C.distText(o, d.frange) : ''), labels: [[0, '0'], [-1, '0'], [1, '1']], value: (d) => (isNum(d.fuelPct) ? clamp01(d.fuelPct / 100) : 0), zero: 0, lo: 0.125, hi: 2 };
    const charge = { icon: 'battery', unit: '%', read: (d) => (isNum(d.soc) ? String(Math.round(d.soc)) : '--'), labels: [[0, '0'], [0.5, '50'], [1, '100']], value: (d) => f01(d.soc, 0, 100), zero: 0, lo: 0.1, hi: 2 };
    const left = ice ? [coolant, gearbox] : [coolant, oil];
    if (engine) {
        const nm = C.torqueUnit(o) === 'kgm';
        return {
            left,
            right: [{ icon: 'turbo', unit: us ? 'psi' : 'bar', labels: us ? [[0, '0'], [0.5, '20'], [1, '40']] : [[0, '0.0'], [0.5, '1.5'], [1, '3.0']],
                value: (d) => (d.engineOn === false || !isNum(d.boostActual) ? 0 : us ? f01(d.boostActual * 14.5038, 0, 40) : f01(d.boostActual, 0, 3)), zero: 0, lo: -1, hi: 2 },
            { icon: 'torque', unit: nm ? 'kgm' : 'Nm', labels: nm ? [[0, '0'], [0.5, '25'], [1, '50']] : [[0, '0'], [0.5, '250'], [1, '500']], value: (d) => f01(d.torque, 0, 500), zero: 0, lo: -1, hi: 2 }],
            bottom: [fuel, ice ? oil : charge],
        };
    }
    return {
        left,
        // eDrive: the battery's power (regenerating left of its 0, green, to the battery's limit; drawn to its top,
        // the battery's limit too: eDrive Live's; numbered 0, half and the top) and its
        // temperature (0-50 C, hot from 45)
        right: [{ icon: 'bolt', unit: 'kW', labels: [[KW_ZERO, '0'], [KW_ZERO + (1 - KW_ZERO) / 2, '50'], [1, '100']], value: (d) => C.kwFrac(d.kw, barRange(d)),
            nums: (d) => [0, barRange(d).out / 2, barRange(d).out], zero: KW_ZERO, lo: -1, hi: 2, neg: 'regen' },
            { icon: 'batteryTemp', unit: tu, read: rd('battTemp'), labels: [[0, tl(0)], [0.5, tl(25)], [1, tl(50)]], value: (d) => f01(d.battTemp, 0, 50), zero: 0, lo: -1, hi: 0.9 }],
        bottom: [fuel, charge],
    };
}
/** One gauge at (x, y), w wide: its icon, its unit and its bar (MBAR_FS, which draws the scale's numbers too: one
 * layer, not three text pieces). */
function gauge(T, key, x, y, w, g) {
    const fg = B.role('fg'), sg = B.smallGlyphs('orb', 'm_scale');
    const nums = g.labels.map((l) => Number(l[1])), dec = g.labels.some((l) => /\./.test(l[1])) ? 1 : 0;
    const readC = (t, d) => ({ color: [(g.hi < 1 && g.value(d) >= g.hi) || (g.lo > 0 && g.value(d) <= g.lo) ? t.red : t.fg, 1], glow: [t.fg, 0] });
    return [B.icon(key + 'Icon', x - 4, y - 6, 38, 36, g.icon, 'fg')].concat(g.read ? [T(key + 'Read', [x + 46, y - 4, 170, 32], 'm_unit', g.read, readC, 'left')] : [],
        g.unit ? [T(key + 'Unit', [x + w - 90, y - 4, 90, 32], 'm_unit', g.unit, fg, 'right')] : [], [
        { key, kind: 'mbar', x: x - 6, y: y + 30, w: w + 10, h: 34 + sg.h + 2,
            params: { u_zero: [g.zero], u_zones: [g.lo, g.hi, 0, 0], u_marks: g.labels.map((l) => l[0]).concat([-1]).slice(0, 4),
                u_lab: nums.concat([dec]), u_glyph: sg.glyph, u_glyph2: sg.glyph2, u_labH: [sg.h] },
            colors: (t) => ({ fill: t.fill, neg: t[g.neg || 'ev'], track: t.track, redc: t.red }),
            dyn: g.nums ? (d) => ({ u_lab: g.nums(d).concat([dec]) }) : undefined,
            value: g.value, max: 1, sweep: true }]);
}

module.exports = {
    id: 'm',
    title: 'M',
    font: 'orb',
    stripGear: true,    // (the gear is its centre: kept over the car's own strip)
    stripFuel: false,   // (its own fuel bar)
    mapWindow: WINDOW,
    speedGauge: false,  // (the speed in figures only, as theirs)
    gearNumber: true,   // (the gear's number, as the M8's)
    ownStripGauges: true,   // (the fuel and the charge are its own bars along the bottom: none of the strip's)
    palette: pal,
    gearText: C.gearText,

    pieces(o) {
        const strip = C.strip(o), map = o.centre === 'map', stock = o.centre === 'stock' && !strip, mcar = C.mCar(o);
        const engine = C.engineFocus(o) || o.vehicle === 'ice', us = o.speedUnit !== 'kmh';
        const [redFrom, orange] = B.redMarks(o, RPM_MAX);
        const T = (key, box, font, txt, colors, align) => B.text('orb', key, box, font, txt, colors, align);
        const fg = B.role('fg'), dim = B.role('dim'), faint = B.role('faint');
        // the gauges, as the M8's (its coolant and boost bars, left): engine left, eDrive right, fuel and charge below
        const G = gauges(o, engine);
        const rows = strip ? [222, 324] : [104, 462];   // (the right ones; full screen above and below the KOMBI's gear box, y 262-454)
        // the background: black (with the map, round its window; the stock centre, round its area)
        const W2 = WINDOW, around = [{ x: 0, y: 0, w: 1920, h: W2.y }, { x: 0, y: W2.y + W2.h, w: 1920, h: 720 - W2.y - W2.h },
            { x: 0, y: W2.y, w: W2.x, h: W2.h }, { x: W2.x + W2.w, y: W2.y, w: 1920 - W2.x - W2.w, h: W2.h }];
        const list = map ? around.map((r, i) => C.flat('bg' + i, r.x, r.y, r.w, r.h, 'bg'))
            : stock ? [C.flat('bgL', 0, 0, 566, 720, 'bg'), C.flat('bgR', 1104, 0, 816, 720, 'bg')] : [C.flat('bg', 0, 0, 1920, 720, 'bg')];
        /*
         * The backdrop's parts (MDASH_FS), each in its own small layer, never one over the whole panel: theirs in one
         * full-screen layer restarted the cluster on the car (twice). The cards, the centre line and the stripes;
         * over the background (a flat, z -100).
         */
        const md = { u_card: [170, 536, 186, 48], u_cardTop: [0.00130995, -1.417868, 468.53], u_cardCutR: [700, 106.2, 565.9], u_cardFill: [0.055],
            u_blade: [528, 303, 1.0684, 0.5434], u_bladeB: [135, 15], u_line: [742, 376, 1181, 55], u_mark: [926, 150, 1.2] };
        const part = (key, n, x, y, w, h, extra) => Object.assign({ key, kind: 'mdash', x, y, w, h, z: -90, params: Object.assign({ u_part: [n], u_off: [x, y] }, md),
            colors: (t) => ({ red: t.red }) }, extra || {});
        list.push(part('cardL', 1, 160, 78, 492, 466), part('cardR', 1, 1268, 78, 492, 466));
        // (with the map the centre line and the stripes would be under its window: left out)
        if (!map) list.push(part('centreLine', 2, 734, 366, 456, 22), part('mStripes', 4, 918, 144, 84, 36));
        // the rev blades: the engine speed, eased by the engine; in an electric drive (layout_common.electric) the
        // battery's power, as Sport's ePower: 0 a quarter up (the 2000 mark), regeneration below it in green to the
        // battery's limit, the power drawn above it to the blades' top (bladeRange)
        const elec = (d) => C.electric(o, d);
        const blade = (key, right) => ({
            key, kind: 'mtach', x: right ? 1920 - BLADE.x0 - BLADE.w : BLADE.x0, y: BLADE.y, w: BLADE.w, h: BLADE.h,
            params: { u_side: [right ? 1 : -1], u_geoA: [BLADE.y0 - BLADE.y, BLADE.y8 - BLADE.y, BLADE.ym - BLADE.y, BLADE.xm - BLADE.x0],
                u_geoB: [BLADE.kTop, BLADE.kBot, BLADE.round], u_wid: [BLADE.wBot, BLADE.wTop, BLADE.wBend], u_ticks: [RPM_MAX / 1000],
                u_orange: [orange], u_redFrom: [redFrom], u_zero: [0] },
            colors: (t, d) => ({ red: t.red, regen: t.regen, lit: t.lit, mark: !elec(d) ? t.mark : isNum(d.kw) && d.kw < -0.3 ? t.regen : t.ev }),
            dyn: (d) => (elec(d) ? { u_shiftNow: [0], u_zero: [KW_ZERO], u_orange: [2], u_redFrom: [2] }
                : { u_shiftNow: [B.shiftNow(o, d) ? 1 : 0], u_zero: [0], u_orange: [orange], u_redFrom: [redFrom] }),
            value: (d) => (elec(d) ? C.kwFrac(d.kw, bladeRange(d)) : isNum(d.rpm) ? clamp01(d.rpm / RPM_MAX) : 0), max: 1, sweep: true,
        });
        list.push(blade('tachL', false), blade('tachR', true));
        // the blades' numerals, every 2000 as the M8's, on the blades' inner side (their places' curve; the top one
        // kept clear of the camera's cowl, x 730-1190 above y 128, its box reaching out from the cowl). In an electric
        // drive in kW: the regeneration's limit (green) at the foot, then 0 and a third of the top each
        const num = (i) => (d) => {
            if (!elec(d)) return String(i * 2);
            const r = bladeRange(d);
            return String(i === 0 ? Math.round(r.in) : Math.round((i - 1) * r.out / 3));
        };
        const numC = (i) => (t, d) => ({ color: [i === 0 && elec(d) ? t.regen : t.fg, 1], glow: [t.fg, 0] });
        [[0, 693, 547], [1, 659, 422], [2, 653, 297], [3, 675, 172], [4, 712, 47]].forEach(([i, cx, y]) => {
            const n = i * 2, w = i === 4 ? 30 : 60, top = i === 4 ? { visible: (d) => !elec(d) } : {};
            list.push(Object.assign(T('nl' + n, [cx - w / 2, y, w, 38], 'm_num', num(i), numC(i), 'center'), top),
                Object.assign(T('nr' + n, [1920 - cx - w / 2, y, w, 38], 'm_num', num(i), numC(i), 'center'), top));
        });
        // (the power's top, three figures: over the blades' tips, clear of the cowl)
        if (o.vehicle !== 'ice' && !C.engineFocus(o)) {
            list.push(Object.assign(T('nlTop', [644, 10, 84, 38], 'm_num', num(4), numC(4), 'center'), { visible: elec }),
                Object.assign(T('nrTop', [1192, 10, 84, 38], 'm_num', num(4), numC(4), 'center'), { visible: elec }));
        }
        list.push(T('rpmUnit', [1252, 602, 160, 29], 'm_tiny', (d) => (elec(d) ? 'kW' : '1/min x1000'), dim, 'left'));   // (under the right blade's foot)
        // the gear and the speed: in the middle, or (the map, an M car's boxes) their map-up places
        // the gear: its number (P, R, N as letters), the shift programme's stack beside it, as the M8's
        const gearNum = (d) => { const g = C.gearText(d); return /^[DSM]\d+$/.test(g) ? g.slice(1) : g; };
        const gearC = (t, d) => ({ color: [B.shiftNow(o, d) ? t.red : t.fg, 1], glow: [t.fg, 0] });
        const stack = (x, y, z) => Object.assign(B.icon('gearStack', x, y, z, z, 'stack', 'fg'), { visible: (d) => /^[DSM]\d*$/.test(C.gearText(d)) });
        if (!stock) {
            if (map || mcar) {
                list.push(T('gear', [710, 450, 230, 117], 'm_gear', gearNum, gearC, 'right'), stack(944, 512, 54),
                    T('speedDigits', [1006, 467, 203, 82], 'm_speed', (d) => C.speedText(o, d), fg, 'left'),
                    T('speedUnit', [1006, 549, 108, 29], 'm_tiny', C.speedUnit(o), dim, 'left'));
            } else {
                list.push(T('gear', [700, 246, 520, 117], 'm_gear', gearNum, gearC, 'center'), stack(1014, 290, 54),
                    T('speedDigits', [700, 400, 520, 82], 'm_speed', (d) => C.speedText(o, d), fg, 'center'),
                    T('speedUnit', [1111, 409, 97, 29], 'm_tiny', C.speedUnit(o), dim, 'left'));
            }
        }
        // the gauges in the cards: engine left (x 300), eDrive right (x 1420)
        G.left.forEach((g, i) => list.push(...gauge(T, 'gl' + i, 300, [222, 324][i], 200, g)));
        G.right.forEach((g, i) => list.push(...gauge(T, 'gr' + i, 1420, rows[i], 200, g)));
        // the flat bars along the bottom, under the cards: the fuel left, the charge right (full screen lower, clear of
        // the right card's gauge over the KOMBI's gear box, and outside the warning lights, x 560-1520 from y 652)
        const bot = strip ? { x: 120, y: 556, w: 340 } : { x: 90, y: 590, w: 300 };
        G.bottom.forEach((g, i) => list.push(...gauge(T, i ? 'chargeBar' : 'fuelBar', i ? 1920 - bot.x - bot.w : bot.x, bot.y, bot.w, g)));
        if (stock) return list.filter((p) => p.kind === 'mtach' || /^card/.test(p.key) || p.x + p.w <= 566 || p.x >= 1104);
        return list;
    },
};
