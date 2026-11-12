'use strict';
/**
 * layouts.js - the layouts this app offers, by id. A layout is one file, layout_<id>.js, next to this one
 * (the build ships only top-level .js files); list it here and in app.json's "layout" setting (README.md).
 */
const LAYOUTS = [require('./layout_analog_sport'), require('./layout_digital_round'), require('./layout_modern_wide'), require('./layout_digital_dash'), require('./layout_freedom'), require('./layout_retro'), require('./layout_track'), require('./layout_pulse'), require('./layout_gt3'), require('./layout_m'), require('./layout_sport'), require('./layout_classic')];
/* with Settings > Frame behind the gear box on: the bezel behind the KOMBI's gear bracket (layout_common.boxBezel),
 * just above the backgrounds. Off (the default, from the car: the frame read as a stray grey box) the box sits on
 * the layout's own black background and its black window disappears into it */
const C0 = require('./layout_common');
const { boxBezel, MAP, mCar } = C0;

/*
 * Settings > Cluster: M car. An M car's KOMBI leaves two more dark boxes in the middle of the panel
 * (layout_common.M_HOLES, about x 778-1054 and 1208-1415, y 274-426), drawn over the layout. Each layout moves
 * its readings out of them here, by piece key and centre: { x, y, w, h } replaced, dy added, or squeeze: the
 * piece and everything inside it narrowed into a new x span (a card and its texts). Digital dash does its own
 * (slim tiles, layout_digital_dash.js). The big rev counters of the dial layouts can't move out of the middle:
 * the boxes sit on their faces (tools/clearance.js lists them; test_engine.js allows only those, M_ON_DIAL).
 */
const M_ON_DIAL = ['rpm', 'rpmUnit', 'rpmArc', 'kwDraw', 'kwRegen', 'kwLbl', 'rpmRim', 'tachR', 'nr2', 'nr4'];
const shiftAll = (keys, dy) => keys.reduce((m, k) => { m[k] = { dy }; return m; }, {});
const M_MOVES = {
    pulse: {
        // the speed up between the cowl and the boxes; its unit, the drive mode and the rpm in one row below them
        info: { speedDigits: { y: 128, h: 146 }, speedUnit: { y: 432, h: 28 }, mode: { x: 200, y: 434, w: 440, h: 26 }, rpmDigits: { y: 430, h: 30 }, gear: { y: 186, h: 230 } },
    },
    track: { info: {
        // the gear card below the boxes, the drive mode above them; the right column's tiles stacked below
        gearCard: { y: 432, h: 208 }, gear: { y: 438, h: 140 }, rpm: { y: 580, h: 34 }, rpmLbl: { y: 618, h: 16 }, mode: { y: 226, h: 26 },
        boostCard: { y: 432, h: 100 }, boostLbl: { y: 442 }, boost: { y: 466, h: 55 },
        powerCard: { y: 542, h: 100 }, powerLbl: { y: 552 }, power: { y: 576, h: 55 },
    } },
    modern_wide: {
        // the centre column's readings under the boxes (the charge bar left out: no room), the gear below the right box
        info: { fuel: { y: 432 }, fuelLbl: { y: 482 }, elec: { y: 432 }, elecLbl: { y: 482 }, soc: { y: 508 }, socLbl: { y: 549 }, kw: { y: 508 }, kwLbl: { y: 549 },
            oil: { y: 578, h: 36 }, oilLbl: { y: 619, h: 18 }, coolant: { y: 578, h: 36 }, coolantLbl: { y: 619, h: 18 },
            gear: { y: 432, h: 120 }, rpmDigits: { y: 556 }, '-soc': 'band' },
        stock: { gear: { y: 432, h: 120 }, rpmDigits: { y: 556 } },
    },
    freedom: {
        // the speed to the left (where the gear was), the gear to the right under the banner
        info: { speedDigits: { x: 150, y: 186, w: 300, h: 150 }, speedUnit: { x: 150, y: 338, w: 300, h: 22 }, clock: { y: 376 }, outside: { y: 376 },
            gear: { x: 1680, y: 268, w: 220, h: 140 } },
        stock: { gear: { x: 1680, y: 268, w: 220, h: 140 } },
    },
    digital_dash: {
        // with the stock centre: the left column a little narrower, the right column's last two below the box
        stock: Object.assign(shiftAll(['oil', 'coolant', 'gearbox'].reduce((a, id) => a.concat(['c_' + id + 'V', 'c_' + id + 'L']), []), 0),
            ['oil', 'coolant', 'gearbox'].reduce((m, id) => { m['c_' + id + 'V'] = { w: 290 }; m['c_' + id + 'L'] = { w: 290 }; return m; }, {}),
            shiftAll(['c_railI', 'c_railV', 'c_railL', 'c_battI', 'c_battV', 'c_battL'], 110), shiftAll(['c_boostI', 'c_boostV', 'c_boostL'], 110)),
    },
    // the display between the dials narrowed clear of the left box
    analog_sport: { info: { lcd: { squeeze: [584, 186] } } },
    digital_round: { info: { card: { squeeze: [584, 186] } } },
    retro: { info: { coolantDial: { dx: -32 } } },
};
function mMoves(L, o, list) {
    const m = (M_MOVES[L.id] || {})[o.centre || 'info'];
    if (!m) return list;
    // leave out first ('-key': kind), so a key two pieces share (a bar and its text) moves the one left
    let out = list.filter((p) => m['-' + p.key] !== p.kind);
    Object.keys(m).filter((k) => k[0] !== '-').forEach((k) => {
        const mv = m[k];
        const p = out.find((q) => q.key === k);
        if (!p) return;
        if (mv.squeeze) {
            const [nx, nw] = mv.squeeze, ox = p.x, ow = p.w, f = nw / ow;
            out = out.map((q) => (q === p || (q.x >= ox && q.x + q.w <= ox + ow && q.y >= p.y && q.y + q.h <= p.y + p.h && q.kind !== 'bg' && !/^bg/.test(q.key))
                ? Object.assign({}, q, { x: Math.round(nx + (q.x - ox) * f), w: Math.round(q.w * f) }) : q));
            return;
        }
        const n = Object.assign({}, p);
        ['x', 'y', 'w', 'h'].forEach((a) => { if (mv[a] !== undefined) n[a] = mv[a]; });
        if (mv.dy) n.y += mv.dy;
        if (mv.dx) n.x += mv.dx;
        out[out.indexOf(p)] = n;
    });
    return out;
}

/*
 * Settings > Bottom strip > The car's own (the default; layout_common.STRIP_Y, found on cars by thatgrayg22): the
 * layout ends above the KOMBI's own strip (gear, drive mode, ranges, time, street, outside temperature, warnings),
 * and the KOMBI leaves none of its boxes. Each layout takes its centred places there itself (C.strip(o)); here
 * its range numbers are left out (the strip shows both), the fuel and charge gauges go above the strip's ranges,
 * and anything still reaching below the line is cut short (backgrounds), moved up (a small piece) or left out
 * (wholly below). Bigger pieces (a dial's arc open at the bottom) stay.
 */
const CUT_Y = C0.STRIP_Y;
/* Below the layout, to BG_Y, a black band over the stock dials' edges and the separator the KOMBI draws above its
 * strip (seen at 646 on the car); over the strip's drive mode and gear (x BG_NOTCH) only to BG_NOTCH_Y, short of
 * their tops at 660 (to 662 clipped them; a notch the band's whole height showed the separator's grey line, and
 * reached past the gear on the right: from a photo of the car, 2026-11-09). */
// (the notch's left end at 1196: from 1236 the band still covered the top of the E of ELECTRIC INDIVIDUAL, the longest
// drive mode, car photo Nov 9 2026)
const BG_Y = 662, BG_NOTCH = [1196, 1424], BG_NOTCH_Y = 658;
const stripOn = (o) => C0.strip(o);
const blackBand = () => [[0, BG_NOTCH[0], BG_Y], [BG_NOTCH[0], BG_NOTCH[1], BG_NOTCH_Y], [BG_NOTCH[1], 1920, BG_Y]].map(([x0, x1, y1], i) =>
    ({ key: 'bgBand' + i, kind: 'flat', x: x0, y: CUT_Y, w: x1 - x0, h: y1 - CUT_Y, colors: () => ({ color: ['#000000', 1] }) }));
function bottomCut(list) {
    const out = [];
    list.forEach((p) => {
        if (p.y >= CUT_Y) return;
        if (p.y + p.h <= CUT_Y) return out.push(p);
        if (p.kind === 'flat' || p.kind === 'panel' || p.kind === 'flag' || p.kind === 'bg' || /^bg/.test(p.key)) return out.push(Object.assign({}, p, { h: CUT_Y - p.y }));
        if (p.h <= 80) return out.push(Object.assign({}, p, { y: CUT_Y - p.h }));
        out.push(p);
    });
    return out;
}

LAYOUTS.forEach((L) => {
    const own = L.pieces;
    L.pieces = (o) => {
        // over the car's own strip there is no dark box to work round: the stock centre content shows in the
        // map's window, so the layout takes the same form as with the map (its window left clear for it)
        const oo = stripOn(o) && o.centre === 'stock' ? Object.assign({}, o, { centre: 'map' }) : o;
        let list = (own(oo) || []).slice();
        if (mCar(o)) list = mMoves(L, o, list);
        if (stripOn(o)) {
            list = list.filter((p) => !C0.STRIP_DROP.test(p.key));
            // the strip shows the gear and the drive mode: no second drive mode, and no second gear but in the
            // layouts made round a big gear (L.stripGear: Track, Pulse, Digital dash); the others fill its place
            list = list.filter((p) => !/^(sel[PRND]?|mode|selChip)$/.test(p.key) && (L.stripGear || !/^(gear|gearCard|gearChip)$/.test(p.key)));
            // the strip shows the time and the outside temperature: their places get the battery's temperature
            // (intake air on a petrol or diesel car) and the gearbox oil's
            // (each only where the layout doesn't show it already)
            const has = (re) => list.some((p) => re.test(p.key));
            const hasGbox = has(/^gbox$/), hasBatt = o.vehicle !== 'ice' && !C0.engineFocus(o) && has(/^(battT|c_battV|batt)$/);
            list = list.filter((p) => !((p.key === 'outside' && hasGbox) || (p.key === 'clock' && hasBatt)))
                .map((p) => (p.key === 'clock' ? Object.assign({}, p, { text: C0.stripInfoA(o) }) : p.key === 'outside' ? Object.assign({}, p, { text: C0.stripInfoB(o) }) : p));
            // the gauges above everything but the backgrounds
            // (only with the readings in the centre: with the map or the stock centre the side columns reach
            // down to the strip, and keep their own charge and fuel bars)
            if (!L.ownStripGauges && (o.centre || 'info') === 'info') list = list.concat(C0.stripGauges(o, { fuel: L.stripFuel !== false }));
            list = bottomCut(list);
            // the band goes in with the backgrounds (under everything)
            let i = 0;
            while (i < list.length && /^bg/.test(list[i].key)) i++;
            list.splice(i, 0, ...blackBand());
            return list;   // (no frame for the gear box: the KOMBI shows none over the strip)
        }
        if (!o || o.boxBezel !== true) return list;
        let i = 0;
        while (i < list.length && /^bg/.test(list[i].key)) i++;
        const b = boxBezel();
        // with the map: from the map's right edge (the map's own picture runs under the bracket's left end)
        if (o && o.centre === 'map') { const r = b.x + b.w; b.x = MAP.x + MAP.w; b.w = r - b.x; }
        list.splice(i, 0, b);
        return list;
    };
});
const byId = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
module.exports = { LAYOUTS, byId, M_MOVES, M_ON_DIAL, CUT_Y, BG_Y, BG_NOTCH, BG_NOTCH_Y, bottomCut };
