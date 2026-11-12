'use strict';
/**
 * layout_analog_sport.js - "Analog sport": two deep analog dials with satin metal bezels and warm backlit
 * markings, small coolant and oil dials set into them, and a slim display between them with the time and
 * outside temperature, the gear, the digital speed, the fuel and electric ranges and the battery's charge.
 * Built around the KOMBI's dark box (the tach left of it, the ranges right of it). With the map in the centre
 * the speedometer is left of it and a small tach right of it. An original design.
 */
const C = require('./layout_common');

const CY = 362;
const PALETTES = {
    comfort: {
        bg: '#000000', face0: '#17130f', face1: '#060504', bezel: '#d9d4cc', bezel2: '#3a3733', tick: '#fff1e0', minor: '#a88e72',
        num: '#ffb066', glow: '#ff7a1a', red: '#ff3a1a', needle: '#ff4a1c', hub: '#141210', accent: '#ff7a1a',
        lcdTop: '#0c0907', lcdBottom: '#050403', lcdEdge: '#3a3128', text: '#ffb066', dim: '#bfad9b', track: '#1c140c', ev: '#4ab4ff',
    },
    sport: {
        bg: '#000000', face0: '#1a0f0e', face1: '#070404', bezel: '#e0d6d4', bezel2: '#3d3333', tick: '#ffffff', minor: '#b07a72',
        num: '#ff7a5c', glow: '#ff2a1a', red: '#ff2414', needle: '#ff2414', hub: '#161010', accent: '#ff2a1a',
        lcdTop: '#0f0706', lcdBottom: '#060303', lcdEdge: '#4a2a26', text: '#ff7a5c', dim: '#bf9b96', track: '#1f0c0a', ev: '#4ab4ff',
    },
    efficient: {
        bg: '#000000', face0: '#0e1418', face1: '#040608', bezel: '#d0d8dc', bezel2: '#2f3639', tick: '#eaf6ff', minor: '#6f8a99',
        num: '#9fdcff', glow: '#2a9fff', red: '#ff3a1a', needle: '#ff6a1c', hub: '#101416', accent: '#2a9fff',
        lcdTop: '#070b0e', lcdBottom: '#030506', lcdEdge: '#24323a', text: '#9fdcff', dim: '#9dadb6', track: '#0a141a', ev: '#4ab4ff',
    },
};
const dialColours = (t) => ({ face0: t.face0, face1: t.face1, bezel: t.bezel, bezel2: t.bezel2, tick: t.tick, minor: t.minor, num: t.num, red: t.red, needle: t.needle, hub: t.hub, accent: t.accent, glow: t.glow });
const glowText = (t) => ({ color: [t.text, 1], glow: [t.glow, 0.6] });
const lbl = (t) => ({ color: [t.dim, 1], glow: [t.glow, 0.4] });

/*
 * The tach's power meter (a plug-in hybrid's eDrive scale): an inner arc across the top of the tach, zero at
 * twelve o'clock; right of it the power drawn from the battery (blue, to 100 kW), left of it charging and
 * recuperation (green, to 60 kW), one degree a kW. Read with the engine off above all: the rpm needle rests
 * then and the tach's unit reads the power.
 */
const kwNow = (d) => (C.isNum(d.kw) ? d.kw : 0);
const powerTxt = (t, d) => ({ color: [kwNow(d) < -0.3 ? t.regen || '#3ddc84' : t.ev, 1], glow: [t.ev, 0.2] });

/** A big dial and the small temperature dial set into it, sized `size`, centred at cx. */
function dialSet(o, which, cx, size, cy) {
    cy = cy === undefined ? CY : cy;
    const k = size / 640, s = which === 'speed' ? C.speedScale(o) : C.rpmScale(o);
    const red = which === 'speed' ? s.max + 1 : s.red;
    // km/h: 14 numerals, most of three figures (mph: 9); at mph's size 100-160 ran together, so smaller and further out
    const dense = which === 'speed' && o.speedUnit === 'kmh';
    const sub = Math.round(176 * k), subDy = Math.round(168 * k), ks = sub / 640;
    const temp = which === 'speed' ? 'coolant' : 'oil', tempRed = which === 'speed' ? 120 : 130;
    const extra = which === 'rpm' && !C.engineFocus(o) ? C.powerMeter(cx, size, cy, lbl, o) : [];   // (Show: Engine: no power meter)
    return extra.concat([
        {
            key: which, kind: 'dial', x: cx - size / 2, y: cy - size / 2, w: size, h: size,
            params: { u_scale: [s.max, s.major, s.minor, red], u_arc: [-135, 135, Math.round((dense ? 32 : 44) * k + 2), (dense ? 230 : 220) * k], u_needle_dim: [283 * k, 50 * k, 17 * k, 5], u_look: [0.9, 0.85, 0, 0], u_look2: [Math.round(16 * k), k, 0.85, 1] },
            colors: dialColours, max: s.max, sweep: true,
            // the tach reads the battery's power in an electric eDrive mode (layout_common.electric)
            value: which === 'speed' ? (d) => (C.isNum(d.speed) ? C.speedIn(o, d.speed) : 0) : C.tachValue(o), range: which === 'speed' ? undefined : C.tachRange(o, s),
            dyn: which === 'speed' ? undefined : C.tachDyn(o, s, red),
        },
        {
            key: temp + 'Dial', kind: 'dial', x: cx - sub / 2, y: cy + subDy - sub / 2, w: sub, h: sub, z: 5,
            params: { u_scale: [100, 50, 12.5, tempRed - 40], u_arc: [-120, 120, 0, 0], u_needle_dim: [62 * sub / 176, 14 * sub / 176, 6, 2.5], u_look: [0.7, 0.85, 0, 0], u_look2: [Math.max(4, Math.round(7 * sub / 176)), ks, 0.6, 0.6] },
            colors: dialColours, value: (d) => (C.isNum(d[temp]) ? Math.max(0, d[temp] - 40) : 0), max: 100, sweep: true,
        },
        // the tach's unit, or with the engine off the battery's power (the power meter below reads it)
        C.text(which + 'Unit', cx - 120, cy + Math.round(50 * k), 240, Math.round(20 * k), which === 'speed' ? C.speedUnit(o)
            : (d) => (C.electric(o, d) ? C.kwText(d) : 'x1000 rpm'), which === 'speed' ? lbl : (t, d) => (C.electric(o, d) ? powerTxt(t, d) : lbl(t)), { tracking: 0.08 }),
        C.text(temp + 'Lbl', cx - 60, cy + subDy + Math.round(26 * k), 120, Math.max(11, Math.round(14 * k)), temp === 'oil' ? 'OIL' : 'COOLANT', lbl, { tracking: 0.16 }),
        // its reading in figures, just under the small dial
        C.text(temp + 'Num', cx - 70, cy + subDy + sub / 2 + Math.round(4 * k), 140, Math.round(26 * k), (d) => C.tempText(o, d[temp]), glowText),
    ]);
}

module.exports = {
    id: 'analog_sport',
    title: 'Analog sport',
    palette: (lookId) => PALETTES[lookId] || PALETTES.comfort,
    gearText: C.gearText,

    /*
     * Built around what the glass and the KOMBI keep (layout_common: the camera's cowl, the dark box where the
     * stock gear readout was, the eDrive box, the slanted corners, the warning lights along the bottom; checked
     * by tools/clearance.js): the tach sits left of the dark box, never under it.
     */
    pieces(o) {
        const gearC = (t, d) => ({ color: [C.gearText(d) === 'R' ? t.red : t.text, 1], glow: [t.glow, 0.5] });
        const elecTxt = (t) => ({ color: [t.ev, 1], glow: [t.ev, 0.3] });
        if (o.centre === 'map') {
            // the speedometer left of the map; a small tach right of the map and the dark box; the gear and speed
            // in the free corner above the box; the ranges in the strip under the map, above the warning lights
            const top = C.MAP.y, bot = C.MAP.y + C.MAP.h;
            return C.aroundMap().map((r, i) => C.flat('bg' + i, r.x, r.y, r.w, r.h, 'bg')).concat(
                dialSet(o, 'speed', 208, 404, 360), C.strip(o) ? dialSet(o, 'rpm', 1712, 404, 360) : dialSet(o, 'rpm', 1792, 256, 500), [
                    C.text('clock', 520, top - 76, 200, 34, C.clock, glowText),
                    C.text('outside', 1200, top - 76, 200, 34, (d) => C.outsideText(o, d.outside), glowText),
                    C.text('gear', 1520, 130, 230, 92, C.gearText, gearC),
                    ...(C.strip(o) ? [] : [C.text('speedDigits', 1520, 224, 230, 32, (d) => C.speedText(o, d) + ' ' + C.speedUnit(o), glowText)]),
                ],
                C.readingUp('fuel', 560, bot + 2, 260, 30, (d) => C.distText(o, d.frange), 'FUEL RANGE', glowText, lbl),
                C.readingUp('elec', 1100, bot + 2, 300, 30, C.focus.both(o), C.focus.rangeLabel(o), C.engineFocus(o) ? glowText : elecTxt, lbl),
            );
        }
        if (C.strip(o) && o.centre !== 'stock') {
            // the car's own bottom strip (layout_common.STRIP_Y): no boxes to keep clear of, so the dials stand
            // centred either side of the display as first drawn, sized to end above the strip; the ranges are
            // the strip's, the fuel and charge gauges above them (layouts.js)
            const SS = 600, scy = 328, X = 830, W = 260, Y = 164, H = 440;   // (its top clear of the camera's cowl: a photo of the car)
            return [C.flat('bg', 0, 0, 1920, 720, 'bg')].concat(dialSet(o, 'speed', 452, SS, scy), dialSet(o, 'rpm', 1468, SS, scy), centreDisplay(o, X, Y, W, H, gearC, elecTxt, true));
        }
        // the speedometer left; with the stock centre the tach between it and the dark box, else full size left
        // of the box with the slim display between the dials; the ranges right of the box
        const S = 520, cy = 392, L = 300;
        const stock = o.centre === 'stock', R = stock ? 1256 : 1120, SR = stock ? 296 : S;
        const list = [C.flat('bg', 0, 0, 1920, 720, 'bg')].concat(dialSet(o, 'speed', L, S, cy), dialSet(o, 'rpm', R, SR, cy));
        if (stock) {
            list[0] = C.flat('bg', 0, 0, 566, 720, 'bg');
            list.push(C.flat('bgR', 1104, 0, 816, 720, 'bg'));
        }
        // right of the dark box: the ranges and the charge
        const RX = 1672, RW = 216;
        list.push(...C.reading('fuel', RX, 292, RW, 44, (d) => C.distText(o, d.frange), 'FUEL RANGE', glowText, lbl),
            ...C.reading('elec', RX, 400, RW, 44, C.focus.range(o), C.focus.rangeLabel(o), C.engineFocus(o) ? glowText : elecTxt, lbl),
            C.text('socTxt', RX, 506, RW, 44, C.focus.charge(o), C.engineFocus(o) ? glowText : elecTxt),
            C.bar('soc', RX + 8, 562, RW - 16, 16, C.focus.bar(o), (t) => ({ track: t.track, fill0: C.engineFocus(o) ? t.accent : t.ev, fill1: C.engineFocus(o) ? t.accent : t.ev, redc: t.red, tip: t.glow, tick: t.dim, num: t.num }), 16));
        if (stock) return list;
        // the slim display between the dials (below the camera's cowl, above the warning lights)
        return list.concat(centreDisplay(o, 574, 140, 278, 470, gearC, elecTxt));
    },
};

/** The slim display between the dials: the time and outside temperature, the gear, the digital speed, the
 * battery's power. */
function centreDisplay(o, X, Y, W, H, gearC, elecTxt, stripped) {
    const sy = H / 470;   // its rows spread to its height
    if (stripped) {
        // over the car's own strip, which shows the gear and the drive mode: the digital speed takes the gear's
        // place, large, and the battery's power below it
        return [
            { key: 'lcd', kind: 'panel', x: X, y: Y, w: W, h: H, params: { u_box: [20, 2, 0.5, 1] }, colors: (t) => ({ top: t.lcdTop, bottom: t.lcdBottom, border: t.lcdEdge }) },
            C.text('clock', X + 16, Y + 18, (W - 38) / 2, 30, C.clock, glowText, { align: 0 }),
            C.text('outside', X + W / 2 + 3, Y + 18, (W - 38) / 2, 30, (d) => C.outsideText(o, d.outside), glowText, { align: 1 }),
            C.flat('rule1', X + 24, Y + Math.round(62 * sy), W - 48, 2, 'lcdEdge'),
            C.text('speedDigits', X, Y + Math.round(104 * sy), W, 140, (d) => C.speedText(o, d), glowText),
            C.text('speedDigitsUnit', X, Y + Math.round(254 * sy), W, 22, C.speedUnit(o), lbl, { tracking: 0.12 }),
            C.flat('rule2', X + 24, Y + Math.round(312 * sy), W - 48, 2, 'lcdEdge'),
            C.text('kwNow', X, Y + Math.round(338 * sy), W, 54, C.focus.power(o), (t, d) => (C.engineFocus(o) ? glowText(t) : C.isNum(d.kw) && d.kw < -0.3 ? { color: ['#3ddc84', 1], glow: ['#3ddc84', 0.3] } : elecTxt(t))),
            C.text('kwNowLbl', X, Y + Math.round(400 * sy), W, 18, C.focus.powerLabel(o, true), lbl, { tracking: 0.1 }),
        ];
    }
    return [
        { key: 'lcd', kind: 'panel', x: X, y: Y, w: W, h: H, params: { u_box: [20, 2, 0.5, 1] }, colors: (t) => ({ top: t.lcdTop, bottom: t.lcdBottom, border: t.lcdEdge }) },
        C.text('clock', X + 16, Y + 18, (W - 38) / 2, 30, C.clock, glowText, { align: 0 }),
        C.text('outside', X + W / 2 + 3, Y + 18, (W - 38) / 2, 30, (d) => C.outsideText(o, d.outside), glowText, { align: 1 }),
        C.flat('rule1', X + 24, Y + Math.round(62 * sy), W - 48, 2, 'lcdEdge'),
        C.text('gear', X, Y + Math.round(82 * sy), W, 130, C.gearText, gearC),
        C.text('speedDigits', X, Y + Math.round(236 * sy), W, 72, (d) => C.speedText(o, d), glowText),
        C.text('speedDigitsUnit', X, Y + Math.round(314 * sy), W, 22, C.speedUnit(o), lbl, { tracking: 0.12 }),
        C.flat('rule2', X + 24, Y + Math.round(356 * sy), W - 48, 2, 'lcdEdge'),
        C.text('kwNow', X, Y + Math.round(376 * sy), W, 40, C.focus.power(o), (t, d) => (C.engineFocus(o) ? glowText(t) : C.isNum(d.kw) && d.kw < -0.3 ? { color: ['#3ddc84', 1], glow: ['#3ddc84', 0.3] } : elecTxt(t))),
        C.text('kwNowLbl', X, Y + Math.round(422 * sy), W, 18, C.focus.powerLabel(o, true), lbl, { tracking: 0.1 }),
    ];
}
