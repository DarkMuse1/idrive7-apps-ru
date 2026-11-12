'use strict';
/**
 * layout_classic.js - "Classic M": the round dials of BMW's M cars of the late 2000s, drawn after a photo of an E92
 * M3's cluster at night (E9X_FS): black faces, a ring of cool white-blue light round each scale (open across the
 * bottom), white bars, dots and numerals, thin glowing red needles over dark
 * hubs, the fuel gauge across the speedometer's foot and the oil temperature across the tach's, and the amber
 * display between them. In an electric drive the tach reads the battery's power in kW, regeneration in green below
 * its 0 (a quarter round), as the other layouts' power gauges. An original drawing, every piece a shader on the
 * cluster's own GPU.
 *
 * Nothing shows the time, the outside temperature or the fuel range (the car's own bottom strip does): the amber
 * display shows the battery's power (boost on a petrol or diesel car, or with Show: Engine), the gear and the speed,
 * and the charge (the coolant).
 */
const C = require('./layout_common');
const B = require('./bimmer');

const PAL = {
    bg: '#000000', face: '#050506', ring: '#b9c4ff', ring2: '#5d63c8', bezel: '#2a2a2f', tick: '#f2f2f2', needle: '#ff3a1c', red: '#ff3a12',
    text: '#f2f2f2', dim: '#9a9aa4', amber: '#ff6a1a', amberDim: '#c0501a', lcd0: '#2c0e04', lcd1: '#160602', lcdEdge: '#6a2a0e', lcdRule: '#5a2410', regen: '#3ddc84', glow: '#ff6a1a',
};
const pal = () => Object.assign({}, PAL);
const isNum = C.isNum;
const white = (t) => ({ color: [t.text, 1], glow: [t.text, 0] });
const dim = (t) => ({ color: [t.dim, 1], glow: [t.dim, 0] });
const amber = (t) => ({ color: [t.amber, 1], glow: [t.amber, 0.35] });
const amberDim = (t) => ({ color: [t.amberDim, 1], glow: [t.amber, 0.2] });
const dir = (a) => [Math.sin(a * Math.PI / 180), -Math.cos(a * Math.PI / 180)];
const A0 = -134, A1 = 134;     // the sweep (the photo's: 0 at about eight o'clock, the end at about four)
const SUB = [232, 128];        // the small gauges' sweep round their pivot (empty at the left, full at the right)

/** A dial (speed or rpm) at (cx, cy), size across, with its labels. */
function dial(o, which, cx, cy, size) {
    const R = size / 2, k = size / 600, kmh = o.speedUnit === 'kmh', rs = C.rpmScale(o);
    const speed = which === 'speed';
    const sc = speed ? (kmh ? [330, 30, 10, 5] : [200, 20, 10, 5]) : [rs.max, 1, 1, 0.5];
    const red = speed ? sc[0] + 1 : rs.red;
    /* the tach in an electric drive (layout_common.electric): the battery's power, as the other layouts' power gauges:
     * 0 a quarter round, regeneration below it (the ring green) to the battery's limit, the power drawn above it to
     * its limit, numbered in round steps (eDrive Live's ends: kwRange, kwDialScale) */
    const elec = (d) => !speed && C.electric(o, d);
    const kwS = (d) => C.kwDialScale(C.kwRange(d).out);
    const subv = (d) => (speed ? [isNum(d.fuelPct) ? Math.round(Math.max(0, Math.min(1, d.fuelPct / 100)) * 200) / 200 : 0]
        : [isNum(d.oil) ? Math.round(Math.max(0, Math.min(1, (d.oil - 50) / 100)) * 200) / 200 : 0]);
    const out = [{
        key: which, kind: 'e9x', x: cx - R, y: cy - R, w: size, h: size,
        params: {
            u_scale: sc, u_arc: [A0, A1, red, speed ? (kmh ? 0.105 : 0.122) : 0.14],
            u_sub: [SUB[0], SUB[1], 2, 2], u_min: [0], u_zero: [0], u_regen: C.REGEN_RGB,
        },
        colors: (t) => ({ face: t.face, ring: t.ring, ring2: t.ring2, bezel: t.bezel, tick: t.tick, needle: t.needle, red: t.red }),
        value: speed ? (d) => (isNum(d.speed) ? C.speedIn(o, d.speed) : 0)
            : (d) => (elec(d) ? (isNum(d.kw) ? Math.max(-C.kwRange(d).in, Math.min(kwS(d).max, d.kw)) : 0) : isNum(d.rpm) ? d.rpm / 1000 : 0),
        max: sc[0], sweep: true,
        range: speed ? undefined : (d) => (elec(d) ? [-C.kwRange(d).in, kwS(d).max] : [0, sc[0]]),
        dyn: speed ? (d) => ({ u_subv: subv(d) })
            : (d) => (elec(d) ? { u_subv: subv(d), u_scale: [kwS(d).max, kwS(d).major, kwS(d).major, kwS(d).major / 2], u_arc: [A0, A1, kwS(d).max + 1, 0.14], u_min: [-C.kwRange(d).in], u_zero: [C.KW_ZERO] }
                : { u_subv: subv(d), u_scale: sc, u_arc: [A0, A1, red, 0.14], u_min: [0], u_zero: [0] }),
    }];
    // the small gauge's labels round its pivot (0.42 R below the centre): either end and the middle
    const pv = [cx, cy + 0.42 * R], lr = 0.47 * R, h = Math.round(30 * k);
    const at = (a, r) => { const u = dir(a); return [pv[0] + u[0] * r, pv[1] + u[1] * r]; };
    const lab = (key, a, r, txt, w) => { const [x, y] = at(a, r); return C.text(key, Math.round(x - w / 2), Math.round(y - h / 2), w, h, txt, white); };
    const tl = (c) => String(Math.round(C.tempIn(o, c) / 10) * 10);
    const labels = speed ? ['0', '1/2', '1'] : [tl(50), tl(100), tl(150)];
    out.push(lab(which + 'Sub0', SUB[0] + 4, lr, labels[0], Math.round(70 * k)), lab(which + 'Sub1', 180, lr * 1.04, labels[1], Math.round(70 * k)),
        lab(which + 'Sub2', SUB[1] - 4, lr, labels[2], Math.round(70 * k)));
    if (speed) {
        // (the icon above the small needle's pivot, clear of its sweep; the unit under the top numerals, as the tach's)
        out.push(B.icon('fuelIcon', Math.round(cx - 14 * k), Math.round(pv[1] - 0.17 * R), Math.round(28 * k), Math.round(28 * k), 'fuel', 'dim'),
            C.text('speedUnit', Math.round(cx - 0.4 * R), Math.round(cy - 0.45 * R), Math.round(0.8 * R), Math.round(22 * k), kmh ? 'km/h' : 'mph', white));
    } else {
        out.push(B.icon('oilIcon', Math.round(cx - 34 * k), Math.round(pv[1] - 0.17 * R), Math.round(34 * k), Math.round(24 * k), 'oilcan', 'dim'),
            C.text('oilUnit', Math.round(cx + 2 * k), Math.round(pv[1] - 0.17 * R), Math.round(40 * k), Math.round(22 * k), '°' + (o.tempUnit === 'c' ? 'C' : 'F'), white, { align: 0 }),
            C.text('rpmUnit', Math.round(cx - 0.4 * R), Math.round(cy - 0.45 * R), Math.round(0.8 * R), Math.round(22 * k), (d) => (elec(d) ? 'kW' : '1/min x 1000'), white));
    }
    return out;
}

/**
 * The amber display between the dials, one LCD as the E9x's: along the top the battery's power (the boost) with its
 * label, and the gear at the right (gear: not over the car's own strip, which shows it); the speed large in the
 * middle with its unit; the charge (the coolant) along the bottom; thin amber rules between. The M tricolour over it.
 * X, Y, W, H: the LCD's box.
 */
function display(o, X, Y, W, H, gear) {
    const engine = C.engineFocus(o) || o.vehicle === 'ice';
    const k = H / 372;                                   // (laid out for 372 high)
    const at = (y) => Y + Math.round(y * k), hh = (h) => Math.round(h * k);
    const hS = Math.min(hh(150), Math.round(W * 0.46));   // the speed's height: as large as the width takes 3 figures
    const out = [
        // the M tricolour over the display, as on the E9x M3's dials
        { key: 'mStripes', kind: 'mdash', x: X + W / 2 - 40, y: Y - 44, w: 84, h: 34, z: -90, params: { u_part: [4], u_off: [X + W / 2 - 40, Y - 44], u_mark: [X + W / 2 - 34, Y - 40, 1.2] }, colors: (t) => ({ red: t.red }) },
        { key: 'lcd', kind: 'panel', x: X, y: Y, w: W, h: H, params: { u_box: [16, 3, 0.12, 1] }, colors: (t) => ({ top: t.lcd0, bottom: t.lcd1, border: t.lcdEdge }) },
        C.text('kwNow', X + 18, at(16), gear ? W - 110 : W - 36, hh(44), C.focus.power(o), amber, { align: gear ? 0 : 0.5 }),
        C.text('kwNowLbl', X + 18, at(64), W - 36, hh(17), C.focus.powerLabel(o, true), amberDim, { align: gear ? 0 : 0.5, tracking: 0.1 }),
        Object.assign(C.flat('lcdRule0', X + 16, at(96), W - 32, 2, 'lcdRule'), { z: 1 }),
        C.text('speedDigits', X + 10, at(102) + Math.round((hh(150) - hS) / 2), W - 20, hS, (d) => C.speedText(o, d), amber),
        C.text('speedDigitsUnit', X + 10, at(252), W - 20, hh(24), C.speedUnit(o), amberDim, { tracking: 0.2 }),
        Object.assign(C.flat('lcdRule1', X + 16, at(290), W - 32, 2, 'lcdRule'), { z: 1 }),
        C.text('socTxt', X + 14, at(302), W - 28, hh(46), engine ? (d) => 'COOLANT ' + C.tempText(o, d.coolant) : (d) => 'CHARGE ' + C.socText(d), amber),
    ];
    if (gear) out.push(C.text('gear', X + W - 92, at(14), 74, hh(66), C.gearText, (t, d) => (C.gearText(d) === 'R' ? { color: [t.red, 1], glow: [t.red, 0.3] } : amber(t)), { align: 1 }));
    return out;
}

module.exports = {
    id: 'classic',
    title: 'Classic M',
    stripFuel: false,   // (its own fuel gauge, in the speedometer)
    ownStripGauges: true,   // (the charge in its amber display: none of the strip's bars)
    palette: pal,
    gearText: C.gearText,

    pieces(o) {
        const strip = C.strip(o);
        if (o.centre === 'map') {
            // the speedometer left of the map, the tach right of it (full screen smaller, right of the KOMBI's box)
            const list = C.aroundMap().map((r, i) => C.flat('bg' + i, r.x, r.y, r.w, r.h, 'bg')).concat(dial(o, 'speed', 208, 360, 404));
            if (strip) return list.concat(dial(o, 'rpm', 1712, 360, 404));
            return list.concat(dial(o, 'rpm', 1792, 500, 256), [C.text('gear', 1520, 130, 230, 92, C.gearText, amber)]);
        }
        if (strip && o.centre !== 'stock') {
            // the car's own bottom strip (the default): the two dials either side of the amber display, above the strip
            return [C.flat('bg', 0, 0, 1920, 720, 'bg')].concat(dial(o, 'speed', 468, 326, 600), dial(o, 'rpm', 1452, 326, 600), display(o, 796, 236, 328, 380, false));
        }
        // full screen: the speedometer left, the tach left of the KOMBI's dark box (with the stock centre: small,
        // between them), the display between; right of the box the electric range and the charge
        const stock = o.centre === 'stock', S = 520, cy = 392;
        const list = [C.flat('bg', 0, 0, stock ? 566 : 1920, 720, 'bg')].concat(dial(o, 'speed', 300, cy, S), stock ? dial(o, 'rpm', 1256, cy, 296) : dial(o, 'rpm', 1120, cy, S));
        if (stock) list.push(C.flat('bgR', 1104, 0, 816, 720, 'bg'));
        const RX = 1672, RW = 216, elec = (t) => (C.engineFocus(o) ? amber(t) : { color: ['#4ab4ff', 1], glow: ['#4ab4ff', 0.3] });
        list.push(...C.reading('elec', RX, 330, RW, 44, C.focus.range(o), C.focus.rangeLabel(o), elec, dim),
            C.text('socRight', RX, 446, RW, 44, C.focus.charge(o), elec));
        if (stock) return list;
        // (an M car's KOMBI leaves a box at x 778-1054 from y 274: the display narrower, left of it)
        return list.concat(C.mCar(o) ? display(o, 584, 214, 186, 420, true) : display(o, 574, 214, 278, 420, true));
    },
};
