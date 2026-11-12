'use strict';
/**
 * layout_gt3.js - "GT3": a race dash. After bimmer-lab's GT3 theme for Cluster Themes (MIT, Copyright (c) 2026
 * bimmer-lab, github.com/bimmer-lab/apps): its arrangement and its shift scoring (theirs ported from
 * cauliflowermossgrape's Redline app, MIT), redrawn with this app's engine (every piece a shader on the cluster's own
 * GPU, the readings sent as numbers), fitted to the G05's glass and the car's own bottom strip, and made for a
 * plug-in hybrid.
 *
 * Eighteen round shift lights over a segmented rev bar along the top; a big gear in a framed centre with the
 * coolant and oil under it; on the left the speed, the engine speed (OFF in an electric drive) and the tyres
 * (pressure and temperature at each corner, from the car's tyre monitor); on the right the battery's power (boost
 * on a petrol or diesel car, or with Show: Engine), the charge (the shift point on a petrol or diesel car) and the
 * last upshift with its grade: EARLY, SPOT ON, LATE, COLD REV or LIMITER.
 */
const C = require('./layout_common');

const PALETTES = {
    comfort: { accent: '#ffb000', glow: '#ffb000' },
    sport: { accent: '#ff3326', glow: '#ff3326' },
    efficient: { accent: '#35e08a', glow: '#35e08a' },
};
const BASE = {
    bg: '#000000', text: '#ffffff', dim: '#8c949e', track: '#16191d', red: '#ff2a1f', ev: '#4ab4ff', regen: '#3ddc84',
    tileTop: '#101317', tileBottom: '#07080a', tileEdge: '#30363e', off: '#15181c', green: '#2fe06b', yellow: '#ffc400', blue: '#3a8cff',
    num: '#ffffff', tip: '#ffffff', cold: '#5ab0ff',
};
const pal = (lookId) => Object.assign({}, BASE, PALETTES[lookId] || PALETTES.comfort);

const white = (t) => ({ color: [t.text, 1], glow: [t.glow, 0.1] });
const lbl = (t) => ({ color: [t.dim, 1], glow: [t.glow, 0] });
const acc = (t) => ({ color: [t.accent, 1], glow: [t.glow, 0.35] });
const isNum = C.isNum;

/* ---------- shift scoring (bimmer-lab's shift_score.js, after cauliflowermossgrape's Redline; MIT) ----------
 * The shift point is the red line less 300 rpm, pulled down to 4500 rpm with the oil at 30 C and climbing to it as
 * the oil reaches 80 C. Each upshift (the gear one higher) is graded on the highest rpm in the 0.6 s before it:
 * LIMITER within 60 rpm of the red line, EARLY 250 under the shift point, LATE 200 over it (COLD REV while the oil
 * is cold), else SPOT ON. Shifts under 2500 rpm aren't graded. */
const SHIFT_BEFORE = 300, WARM_OIL = 80, COLD_LIMIT = 4500;
function shiftPoint(o, oil) {
    const n = Math.max(2500, C.rpmScale(o).red * 1000 - SHIFT_BEFORE);
    if (!isNum(oil) || oil >= WARM_OIL) return { rpm: n, cold: false };
    const cold = Math.min(COLD_LIMIT, n), f = Math.max(0, Math.min(1, (oil - 30) / (WARM_OIL - 30)));
    return { rpm: Math.round((cold + (n - cold) * f) / 50) * 50, cold: true };
}
const score = { recent: [], lastGear: null, last: null, at: 0 };
function sample(o, d) {
    const now = Date.now();
    if (now - score.at < 10 || !isNum(d.rpm) || d.demo) return;
    score.at = now;
    const r = score.recent;
    r.push([now, d.rpm]);
    while (r.length && now - r[0][0] > 1200) r.shift();
    const g = d.gear;
    if (isNum(g) && g > 0 && isNum(score.lastGear) && score.lastGear > 0 && g === score.lastGear + 1) {
        const win = r.filter((x) => now - x[0] < 600), rpm = win.length ? Math.max.apply(null, win.map((x) => x[1])) : 0;
        if (rpm > 2500) {
            const sp = shiftPoint(o, d.oil), red = C.rpmScale(o).red * 1000;
            score.last = { from: score.lastGear, to: g, rpm: Math.round(rpm),
                verdict: rpm >= red - 60 ? 'LIMITER' : rpm < sp.rpm - 250 ? 'EARLY' : rpm > sp.rpm + 200 ? (sp.cold ? 'COLD REV' : 'LATE') : 'SPOT ON' };
        }
    }
    if (isNum(g)) score.lastGear = g;
}
const verdictC = (t) => {
    const v = score.last && score.last.verdict;
    const c = v === 'SPOT ON' ? t.green : v === 'EARLY' ? t.cold : v === 'LATE' || v === 'COLD REV' ? t.yellow : v === 'LIMITER' ? t.red : t.dim;
    return { color: [c, 1], glow: [c, 0.3] };
};

/* ---------- pieces ---------- */
/** A framed box with its label in a strip along the top. */
function box(key, x, y, w, h, label) {
    return [
        { key: key + 'Box', kind: 'panel', x, y, w, h, params: { u_box: [6, 2, 0.25, 1] }, colors: (t) => ({ top: t.tileTop, bottom: t.tileBottom, border: t.tileEdge }) },
        C.flat(key + 'Head', x + 2, y + 2, w - 4, 26, 'tileEdge'),
        C.text(key + 'Lbl', x + 14, y + 6, w - 28, 18, label, white, { align: 0, tracking: 0.12 }),
    ];
}
/** The shift lights: lit from 3000 rpm (or 2500 under the shift point, whichever is higher), full at the shift
 * point, all of them flashing there. */
function lights(o, x, y, w, h) {
    return {
        key: 'lights', kind: 'leds', x, y, w, h, max: 1,
        value: (d) => { const at = shiftPoint(o, d.oil).rpm, from = Math.max(3000, at - 2500); return isNum(d.rpm) ? Math.max(0, Math.min(1, (d.rpm - from) / (at - from))) : 0; },
        params: { u_count: [18], u_soft: [0], u_shape: [0] },
        dyn: (d) => ({ u_flash: [isNum(d.rpm) && d.rpm >= shiftPoint(o, d.oil).rpm ? 1 : 0] }),
        colors: (t) => ({ off: t.off, green: t.green, yellow: t.yellow, red: t.red }),
    };
}
function revBar(o, x, y, w, h) {
    const r = C.rpmScale(o);
    return { key: 'revs', kind: 'band', x, y, w, h,
        params: { u_geo: [4, h / 2, 0, Math.max(4, h - 6)], u_span: [0, 0, 52, 0.28], u_marks: [0, 0, 0, 0], u_red: [r.red / r.max], u_soft: [1] },
        colors: (t) => ({ track: t.track, fill0: t.text, fill1: t.accent, redc: t.red, tip: t.accent, tick: t.dim, num: t.num }),
        value: (d) => (isNum(d.rpm) ? d.rpm / 1000 / r.max : 0), max: 1, sweep: true };
}
const pressIn = (o, bar) => (o.speedUnit === 'kmh' ? bar.toFixed(1) : String(Math.round(bar * 14.5038)));
/** The four tyres in a box: pressure, large, and temperature at each corner. */
function tyres(o, x, y, w, h) {
    const cw = (w - 28) / 2, rh = (h - 34) / 2;
    const cell = (k, i) => {
        const cx = x + 14 + (i % 2) * cw, cy = y + 32 + Math.floor(i / 2) * rh;
        return [
            C.text('tyre' + k, cx, cy, cw * 0.55, rh - 4, (d) => (d.tyres && isNum(d.tyres.p[k]) ? pressIn(o, d.tyres.p[k]) : '--'), white, { align: i % 2 ? 1 : 0 }),
            C.text('tyreT' + k, i % 2 ? cx : cx + cw * 0.55, cy + rh * 0.3, cw * 0.45 - 6, rh * 0.55, (d) => (d.tyres && isNum(d.tyres.t[k]) ? C.tempText(o, d.tyres.t[k]) : ''), lbl, { align: i % 2 ? 0 : 1 }),
        ];
    };
    return [].concat(box('tyres', x, y, w, h, 'TYRES ' + (o.speedUnit === 'kmh' ? 'BAR' : 'PSI')), ...['FL', 'FR', 'RL', 'RR'].map((k, i) => {
        const c = cell(k, i);
        // (the right column's pressure right-aligned, its temperature to the left of it)
        if (i % 2) { c[0] = Object.assign({}, c[0], { x: x + w - 14 - cw * 0.55 }); c[1] = Object.assign({}, c[1], { x: x + w / 2 + 4 }); }
        return c;
    }));
}

module.exports = {
    id: 'gt3',
    title: 'GT3',
    stripGear: true,   // (the big gear is the layout's centre: kept over the car's own strip too)
    palette: pal,
    gearText: C.gearText,

    pieces(o) {
        // (the stock centre: its window left clear as the map's)
        const engine = C.engineFocus(o), ice = o.vehicle === 'ice', strip = C.strip(o), map = o.centre === 'map' || o.centre === 'stock';
        const kmh = o.speedUnit === 'kmh';
        // the side columns: left of the centre (or the map), and right of it; full screen the right one keeps
        // clear of the dark box the KOMBI leaves (x 1410-1662) and its eDrive box (top right)
        const L = { x: 110, w: 290 }, R = strip ? { x: 1520, w: 290 } : { x: 1672, w: 226 };
        const top = strip ? 262 : 300, bottom = strip ? 586 : 640;
        const h1 = Math.round((bottom - top) * 0.34), h2 = Math.round((bottom - top) * 0.22), gap = 10, h3 = bottom - top - h1 - h2 - 2 * gap;
        const y2 = top + h1 + gap, y3 = y2 + h2 + gap;
        const rpmNow = (d) => (C.electric(o, d) || d.engineOn === false ? 'OFF' : isNum(d.rpm) ? String(Math.round(d.rpm / 50) * 50) : '--');
        const hot = (k, lim) => (t, d) => ({ color: [isNum(d[k]) && d[k] >= lim ? t.red : t.text, 1], glow: [t.glow, 0.1] });
        const kwC = (t, d) => ({ color: [isNum(d.kw) && d.kw < -0.3 ? t.regen : t.ev, 1], glow: [t.ev, 0.2] });
        const power = engine || ice
            ? { label: kmh ? 'BOOST BAR' : 'BOOST PSI', value: (d) => (d.engineOn === false ? 'OFF' : isNum(d.boostActual) ? (kmh ? d.boostActual.toFixed(2) : (d.boostActual * 14.5038).toFixed(1)) : '--'), c: white }
            : { label: 'BATTERY KW', value: (d) => (isNum(d.kw) ? (Math.abs(d.kw) < 10 ? d.kw.toFixed(1) : String(Math.round(d.kw))) : '--'), c: kwC };
        const second = ice || engine
            ? { label: 'SHIFT AT', value: (d) => String(shiftPoint(o, d.oil).rpm), c: (t, d) => (shiftPoint(o, d.oil).cold ? { color: [t.cold, 1], glow: [t.cold, 0.2] } : acc(t)) }
            : { label: 'CHARGE', value: (d) => (isNum(d.soc) ? Math.round(d.soc) + '%' : '--'), c: (t) => ({ color: [t.ev, 1], glow: [t.ev, 0.2] }) };
        const list = [C.flat('bg', 0, 0, 1920, 720, 'bg')];
        if (map) {
            // with the map: around its window, the rev bar under it, the gear and temperatures where the tyres
            // and the last shift were
            // (full screen with the stock centre: its own area, x 566-1104, left as the other layouts leave it)
            const around = o.centre === 'stock' && !strip ? [{ x: 0, y: 0, w: 566, h: 720 }, { x: 1104, y: 0, w: 816, h: 720 }] : C.aroundMap();
            list.splice(0, 1, ...around.map((b, i) => C.flat('bg' + i, b.x, b.y, b.w, b.h, 'bg')));
            if (o.centre === 'map') list.push(revBar(o, C.MAP.x, C.MAP.y + C.MAP.h + 8, C.MAP.w, 26));   // (the stock centre: nothing under it)
        } else {
            // under the camera's cowl and inside the glass's slanted corners: the lights, the rev bar, its scale
            list.push(lights(o, 470, 170, 980, 40), C.text('shiftLbl', 330, 180, 120, 22, 'SHIFT', lbl, { align: 1, tracking: 0.14 }),
                revBar(o, 440, 218, 1040, 30), C.text('revsLbl', 1490, 222, 150, 22, 'RPM', lbl, { align: 0, tracking: 0.14 }));
            // the centre: the gear, huge, and the coolant and oil under it
            // (an M car's two boxes sit in the middle full screen: the centre starts under them)
            const GX = 540, GW = 840, GY = C.mCar(o) ? 432 : top, GH = (strip ? 636 : 640) - GY;
            list.push(...box('gear', GX, GY, GW, GH, 'GEAR'),
                C.text('gear', GX, GY + 40, GW, GH - 140, C.gearText, (t, d) => ({ color: [C.gearText(d) === 'R' ? t.red : isNum(d.rpm) && d.rpm >= shiftPoint(o, d.oil).rpm ? t.red : t.text, 1], glow: [t.glow, 0.3] })),
                C.flat('gearRule', GX + 40, GY + GH - 96, GW - 80, 2, 'tileEdge'),
                C.text('coolantLbl', GX + 40, GY + GH - 84, 340, 18, 'COOLANT', lbl, { align: 0, tracking: 0.12 }),
                C.text('coolant', GX + 40, GY + GH - 62, 340, 50, (d) => C.tempText(o, d.coolant), hot('coolant', 118), { align: 0 }),
                C.text('oilLbl', GX + GW - 380, GY + GH - 84, 340, 18, 'OIL', lbl, { align: 1, tracking: 0.12 }),
                C.text('oil', GX + GW - 380, GY + GH - 62, 340, 50, (d) => C.tempText(o, d.oil), hot('oil', 130), { align: 1 }));
        }
        // left: the speed, the engine speed, the tyres (with the map: the gear)
        list.push(...box('speedB', L.x, top, L.w, h1, 'SPEED ' + C.speedUnit(o).toUpperCase()),
            C.text('speedDigits', L.x + 14, top + 36, L.w - 28, h1 - 46, (d) => C.speedText(o, d), white, { align: 1 }),
            ...box('rpmB', L.x, y2, L.w, h2, 'RPM'),
            C.text('rpmNow', L.x + 14, y2 + 32, L.w - 28, h2 - 38, rpmNow, (t, d) => ({ color: [isNum(d.rpm) && d.rpm >= shiftPoint(o, d.oil).rpm ? t.red : t.text, 1], glow: [t.glow, 0.1] }), { align: 1 }));
        if (map) list.push(...box('mgear', L.x, y3, L.w, h3, 'GEAR'), C.text('gear', L.x + 14, y3 + 32, L.w - 28, h3 - 38, C.gearText, white));
        else list.push(...tyres(o, L.x, y3, L.w, h3));
        // right: the battery's power (boost), the charge (shift point), the last shift (with the map: the temperatures)
        list.push(...box('powerB', R.x, top, R.w, h1, power.label),
            C.text('power', R.x + 14, top + 36, R.w - 28, h1 - 46, power.value, power.c, { align: 1 }),
            ...box('secondB', R.x, y2, R.w, h2, second.label),
            C.text('second', R.x + 14, y2 + 32, R.w - 28, h2 - 38, second.value, second.c, { align: 1 }));
        if (map) {
            list.push(...box('temps', R.x, y3, R.w, h3, 'COOLANT  ·  OIL'),
                C.text('coolant', R.x + 14, y3 + 34, (R.w - 28) / 2, h3 - 42, (d) => C.tempText(o, d.coolant), hot('coolant', 118), { align: 0 }),
                C.text('oil', R.x + R.w / 2, y3 + 34, (R.w - 28) / 2, h3 - 42, (d) => C.tempText(o, d.oil), hot('oil', 130), { align: 1 }));
        } else {
            list.push(...box('lastB', R.x, y3, R.w, h3, 'LAST SHIFT'),
                C.text('lastGears', R.x + R.w - 120, y3 + 6, 106, 18, () => (score.last ? score.last.from + '-' + score.last.to : ''), lbl, { align: 1 }),
                C.text('lastRpm', R.x + 14, y3 + 36, R.w * 0.45, h3 - 46, (d) => { sample(o, d); return score.last ? String(score.last.rpm) : '--'; }, verdictC, { align: 0 }),
                C.text('verdict', R.x + R.w * 0.45, y3 + 44, R.w * 0.55 - 14, (h3 - 46) * 0.6, () => (score.last ? score.last.verdict : ''), verdictC, { align: 1, tracking: 0.06 }));
        }
        return list;
    },
    /** (for the tests) */
    _shift: { shiftPoint, sample, score },
};
