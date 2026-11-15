'use strict';
/*
 * controller.js - the iDrive controller on a renderer screen (screenapp.js ScreenApp.controller; car-portable, Node 8),
 * for cars without a touchscreen (2026-11-12). The app hands over each controller state the car sends (FrontCCU
 * statusRotaryEncoderState, oap-shared/frontccu.js) and a ring moves over the screen's controls:
 *   turn          the next / previous control, in the design's element order; a part each where an element has several
 *                 (a tab, a segment, a hold pill's two ends)
 *   push N / E / S  the nearest control that way (pushed left is the HMI's: back)
 *   press         as a finger on the control: down on the press, up on the release - a tap, or a hold while it is
 *                 pressed (a seat moves while the knob is held down)
 *   bars, sliders a press starts adjusting (amber ring): turning sets the value; a press or a push ends it
 * The first controller use only shows the ring (nothing happens unseen); a touch on the screen hides it again.
 * 2026-11-15 (Drive Recorder, car-apps issue #37): a clip grid's cards are stops each, rows not shown too - the ring
 * scrolls the grid to them (reveal); a video's tap parts (its 2 x 2 cameras, top / bottom, or the whole picture) are
 * stops each, pressed where a finger would; a slider on its own (the viewer's timeline) is adjusted as a row's is.
 */
const E = require('./public/gpu-elements');
const TW = require('./tele-widgets');
const S = require('./store-widgets');
const { Recorder } = require('./kit/record');

// FrontRotaryEncoderPushButton / FrontRotaryEncoderDeflection: by name (the SDK's enums) or as numbers
const PUSH = { KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2, UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15 };
const DEFL = { MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2, NORD_UNWIRKSAM: 3, OST_KURZ_GEDRUECKT: 4,
    OST_LANG_GEDRUECKT: 5, OST_UNWIRKSAM: 6, SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8, SUED_UNWIRKSAM: 9,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11, WEST_UNWIRKSAM: 12, SIGNAL_UNGUELTIG: 15 };
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const num = (v, names) => (typeof v === 'number' ? v : v != null && names[v] != null ? names[v] : 15);
const down = (pb) => pb === 1 || pb === 2;
const RING = '#ffffff', ADJUST = TW.C.accent;

/**
 * A controller state after the one before (null: the first) -> { now, d: knob clicks (+ = clockwise), press, release,
 * tilt: 'N' | 'E' | 'S' | 'W' | null }; null = no controller behind it (all SIGNAL_UNGUELTIG: the VM). The first state
 * is only where things stand (no press, push or turn from it).
 */
function decode(v, last) {
    if (!v) return null;
    const pb = num(v.frontRotaryEncoderPushButton, PUSH), df = num(v.frontRotaryEncoderDeflection, DEFL), k = v.frontRotaryEncoderOperation;
    if (pb === 15 && df === 15) return null;
    const now = { pb, df, k: typeof k === 'number' ? k : null };
    if (!last) return { now, d: 0, press: false, release: false, tilt: null };
    let d = last.k != null && now.k != null ? ((now.k - last.k + 32768) & 0xffff) - 32768 : 0;   // a 16 bit counter
    if (Math.abs(d) > 64) d = 0;                                                               // a reset, not a turn
    return { now, d, press: down(pb) && !down(last.pb), release: down(last.pb) && !down(pb),
        tilt: TILT[df] && TILT[last.df] !== TILT[df] ? TILT[df] : null };
}

const measure = new Recorder(E.DESIGN.w, E.DESIGN.h);              // text widths (the shell's tabs), as drawn
const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const spot = (key, i, kind, r, p) => ({ key, i, kind, r, p: p || mid(r) });

/**
 * The places the ring stops on a screen (its layout: st.components), in order: { key (kept across pages for the tabs:
 * 'tab<i>'), i (element index), kind 'press' | 'value', r (ring box, design px), p (where the press goes) }.
 */
function spots(st) {
    const out = [], cs = st.components || [];
    cs.forEach((c, i) => {
        if (!E.interactive(c) || E.greyed(c)) return;
        const o = Object.assign(E.defaults(c.gpu), c.opts || {}), b = E.box(c);
        if (c.gpu === 'teleShell') {                                // the tabs (one tab: nothing to pick)
            const tabs = TW.shellBoxes(measure, b, o);
            if (tabs.length > 1) tabs.forEach((r, j) => out.push(spot(`tab${j}`, i, 'press', r)));
            return;
        }
        if (c.gpu === 'hueBar' || c.gpu === 'teleSlider') { out.push(spot(c.name, i, 'value', b)); return; }
        if (c.gpu === 'teleSeg') {                                  // its segments (equal parts, tele-widgets segAt)
            const n = TW.items(o.items).length;
            for (let j = 0; j < n; j++) out.push(spot(`${c.name}#${j}`, i, 'press', { x: b.x + j * b.w / n, y: b.y, w: b.w / n, h: b.h }));
            return;
        }
        if (c.gpu === 'teleClipGrid') {                             // every card, the rows above / below the shown ones too
            const v = S.clipView(b, o);
            v.all.forEach((it, k) => {
                const row = Math.floor(k / v.cols), x = b.x + (k % v.cols) * (v.cw + v.gap), y = b.y + (row - v.top) * v.rh;
                out.push(Object.assign(spot(`${c.name}#${it.id}`, i, 'press', { x, y: y + 10, w: v.cw, h: v.rh - 22 }), { row, top: v.top, shown: v.n }));
            });
            return;
        }
        if (c.gpu === 'video') {                                    // its tap parts, in the picture as fitted (store-widgets videoPart)
            const a = o.aspect > 0 ? o.aspect : 4 / 3, w = Math.min(b.w, b.h * a), h = w / a, x0 = b.x + (b.w - w) / 2, y0 = b.y + (b.h - h) / 2;
            const n = o.parts === 4 ? 4 : o.parts === 2 ? 2 : 1;
            for (let j = 0; j < n; j++) {
                const r = n === 4 ? { x: x0 + (j % 2) * w / 2, y: y0 + (j >> 1) * h / 2, w: w / 2, h: h / 2 }
                    : n === 2 ? { x: x0, y: y0 + j * h / 2, w, h: h / 2 } : { x: x0, y: y0, w, h };
                out.push(spot(n > 1 ? `${c.name}:${j + 1}` : c.name, i, 'press', r));
            }
            return;
        }
        if (c.gpu === 'holdPill') {                                 // its two ends (top / left first)
            const s = Math.min(b.w, b.h), v = b.h > b.w;
            out.push(spot(`${c.name}#a`, i, 'press', { x: b.x, y: b.y, w: v ? b.w : s, h: v ? s : b.h }),
                spot(`${c.name}#b`, i, 'press', v ? { x: b.x, y: b.y + b.h - s, w: b.w, h: s } : { x: b.x + b.w - s, y: b.y, w: s, h: b.h }));
            return;
        }
        if (c.gpu === 'teleRow' && !c.onTap) {                      // its control (a row that only shows a value: none)
            const P = TW.rowParts(b, o), n = TW.items(o.items).length;
            if (o.control === 'seg') for (let j = 0; j < n; j++) out.push(spot(`${c.name}#${j}`, i, 'press', { x: P.seg.x + j * P.seg.w / n, y: P.seg.y, w: P.seg.w / n, h: P.seg.h }));
            if (o.control === 'toggle') out.push(spot(c.name, i, 'press', P.toggle));
            if (o.control === 'slider') out.push(spot(c.name, i, 'value', { x: P.slider.x - 16, y: b.y + 18, w: b.x + b.w - P.slider.x + 8, h: b.h - 36 }));
            return;
        }
        // a tap (a button, a swatch, a row that picks): a row's press on its label, not on its control; one inside an
        // earlier one doing the same (a swatch on its row) is the same stop
        const tap = JSON.stringify(E.tapAction(c.onTap) || null);
        if (out.some((s) => s.tap === tap && s.kind === 'press' && inside(b, s.r))) return;
        out.push(Object.assign(spot(c.name, i, 'press', b, c.gpu === 'teleRow' ? { x: b.x + 24, y: b.y + b.h / 2 } : null), { tap }));
    });
    return out;
}

/** The nearest stop from `from` toward dir ('N' 'E' 'S' 'W'): one level with it first (boxes overlapping across that
 *  way), else the nearest in that half; null = none that way. */
function toward(list, from, dir) {
    const a = mid(from.r), across = dir === 'E' || dir === 'W', f = from.r;
    let best = null, bd = Infinity;
    list.forEach((s) => {
        const b = mid(s.r), r = s.r, along = dir === 'E' ? b.x - a.x : dir === 'W' ? a.x - b.x : dir === 'S' ? b.y - a.y : a.y - b.y;
        if (s === from || along < 8) return;
        const level = across ? r.y < f.y + f.h && f.y < r.y + r.h : r.x < f.x + f.w && f.x < r.x + r.w;
        const dd = (level ? 0 : 1e6) + along + 3 * (across ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x));
        if (dd < bd) { bd = dd; best = s; }
    });
    return best;
}

/** A grid card off the rows shown: the first row to show so it is in; null = shown (or not a grid card). */
function reveal(s) {
    if (s.row == null || (s.row >= s.top && s.row < s.top + s.shown)) return null;
    return s.row < s.top ? s.row : s.row - s.shown + 1;
}

/** Turn a bar / slider (element c) by d clicks: a hue bar 1/72 a click (5 degrees), a slider o.step or 1/20 of its range. */
function adjust(c, d) {
    const o = Object.assign(E.defaults(c.gpu), c.opts || {});
    let v;
    if (c.gpu === 'hueBar') v = Math.round(Math.max(0, Math.min(1, (+o.value || 0) + d / 72)) * 1000) / 1000;
    else {
        const k = Math.pow(10, Math.max(0, Math.min(6, o.decimals | 0))), step = +o.step || Math.max(1 / k, Math.round((o.max - o.min) / 20 * k) / k);
        v = Math.round(Math.max(o.min, Math.min(o.max, (+o.value || 0) + d * step)) * k) / k;
    }
    if (v === o.value) return false;
    o.value = v;
    c.opts = o;
    return true;
}

/** The ring round stop s on a recording (white; amber while adjusting). */
function ring(rec, s, adjusting) {
    const r = s.r, pad = 8;
    rec.strokeRoundRect(r.x - pad, r.y - pad, r.w + 2 * pad, r.h + 2 * pad, 10, adjusting ? 6 : 4, adjusting ? ADJUST : RING);
}

module.exports = { decode, spots, toward, adjust, ring, reveal };

if (require.main === module) {
    const assert = require('assert');
    const st = (pb, df, k) => ({ frontRotaryEncoderPushButton: pb, frontRotaryEncoderDeflection: df, frontRotaryEncoderOperation: k });
    assert.strictEqual(decode(st('SIGNAL_UNGUELTIG', 'SIGNAL_UNGUELTIG', 65535), null), null, 'no controller');
    let e = decode(st('KEINE_BETAETIGUNG', 'MITTELSTELLUNG', 65530), null);
    assert.deepStrictEqual([e.d, e.press, e.tilt], [0, false, null], 'the first state: where things stand');
    e = decode(st(0, 0, 3), e.now); assert.strictEqual(e.d, 9, 'the counter wraps at 16 bits');
    e = decode(st(0, 0, 1), e.now); assert.strictEqual(e.d, -2, 'turned back');
    e = decode(st(0, 0, 40000), e.now); assert.strictEqual(e.d, 0, 'a jump is a reset');
    e = decode(st('DREHGEBER_KURZ_GEDRUECKT', 0, 40000), e.now); assert(e.press && !e.release, 'press');
    e = decode(st('DREHGEBER_LANG_GEDRUECKT', 0, 40000), e.now); assert(!e.press && !e.release, 'held');
    e = decode(st(0, 0, 40000), e.now); assert(e.release, 'release');
    e = decode(st(0, 'SUED_KURZ_GEDRUECKT', 40000), e.now); assert.strictEqual(e.tilt, 'S', 'pushed down');
    e = decode(st(0, 'SUED_LANG_GEDRUECKT', 40000), e.now); assert.strictEqual(e.tilt, null, 'still pushed: once');
    const screen = { components: [
        { name: 'menu', gpu: 'teleShell', x: 0, y: 76, w: 2880, h: 172, opts: { app: 'Seats', tabs: 'Seats, Settings' } },
        { name: 'pick', gpu: 'teleRow', x: 40, y: 300, w: 540, h: 104, opts: { label: 'Doors', control: 'seg', items: 'All, Own, Car' }, onTap: 'event:pick' },
        { name: 'sw', gpu: 'colourSwatch', x: 300, y: 320, w: 64, h: 64, opts: {}, onTap: 'event:pick' },
        { name: 'side', gpu: 'teleRow', x: 1240, y: 300, w: 760, h: 104, opts: { label: 'Side', control: 'seg', items: 'Left, Right' } },
        { name: 'show', gpu: 'teleRow', x: 1240, y: 404, w: 760, h: 104, opts: { label: 'Status', control: 'value', text: 'ok' } },
        { name: 'bright', gpu: 'teleRow', x: 1240, y: 508, w: 760, h: 104, opts: { label: 'Bright', control: 'slider', min: 5, max: 100, value: 50 } },
        { name: 'hold', gpu: 'holdPill', x: 600, y: 600, w: 80, h: 120, opts: {} },
        { name: 'off', gpu: 'teleButton', x: 2080, y: 600, w: 300, h: 96, opts: { text: 'Go', disabled: true }, onTap: 'event:go' },
    ] };
    const L = spots(screen);
    assert.deepStrictEqual(L.map((s) => s.key), ['tab0', 'tab1', 'pick', 'side#0', 'side#1', 'bright', 'hold#a', 'hold#b'],
        'tabs, a picking row once (its swatch the same stop), segments, the slider, the pill\'s ends; no value row, no greyed button');
    assert(L[2].p.x < 100, 'a picking row is pressed on its label, not its segments');
    assert.strictEqual(toward(L, L[2], 'E').key, 'side#0', 'pushed right: the nearest that way');
    assert.strictEqual(toward(L, L[6], 'S').key, 'hold#b', 'pushed down from the top end');
    assert.strictEqual(toward(L, L[0], 'N'), null, 'nothing above the tabs');
    const br = screen.components[5];
    assert(adjust(br, 1) && br.opts.value === 55, 'a slider: 1/20 of its range a click');
    adjust(br, 100); assert.strictEqual(br.opts.value, 100, 'up to its max');
    assert.strictEqual(adjust(br, 1), false, 'no further');
    const hue = { name: 'hue', gpu: 'hueBar', opts: { value: 0.5 } };
    adjust(hue, -36); assert.strictEqual(hue.opts.value, 0, 'a hue bar: 5 degrees a click, down to 0');
    // Drive Recorder (issue #37): 7 clips in 3 columns, 2 rows shown; the video's 2 x 2; the timeline
    const items = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `c${n}`, title: `Clip ${n}` }));
    const dr = { components: [
        { name: 'filter', gpu: 'teleSeg', x: 40, y: 248, w: 420, h: 72, opts: { items: 'All, Locked', sel: 0 } },
        { name: 'grid', gpu: 'teleClipGrid', x: 40, y: 344, w: 2800, h: 472, opts: { cols: 3, rowH: 236, top: 0, items } },
        { name: 'video', gpu: 'video', x: 40, y: 248, w: 597, h: 448, opts: { parts: 4, aspect: 4 / 3 } },
        { name: 'timeline', gpu: 'teleSlider', x: 160, y: 720, w: 277, h: 96, opts: { min: 0, max: 30, value: 11, step: 1 } },
    ] };
    const D = spots(dr);
    assert.deepStrictEqual(D.map((s) => s.key), ['filter#0', 'filter#1', 'grid#c1', 'grid#c2', 'grid#c3', 'grid#c4', 'grid#c5', 'grid#c6', 'grid#c7',
        'video:1', 'video:2', 'video:3', 'video:4', 'timeline'], 'every card (the third row too), the four cameras, the timeline');
    assert.deepStrictEqual([reveal(D[2]), reveal(D[7]), reveal(D[8])], [null, null, 1], 'the third row: scroll one row down');
    dr.components[1].opts.top = 1;
    const D1 = spots(dr);
    assert.deepStrictEqual([reveal(D1[2]), reveal(D1[8])], [0, null], 'scrolled: the first row back up, the third shown');
    assert(D1[8].r.y >= 344 && D1[8].r.y < 344 + 472, 'a card in a shown row sits in the grid');
    const go = Object.assign({}, dr.components[1].opts), gb = { x: 40, y: 344, w: 2800, h: 472 };
    S.TRY.clipGrid(null, gb, go, D1[8].p); S.TRY.clipGrid.up(null, gb, go, D1[8].p);
    assert.strictEqual(go.sel, 'c7', 'its press point taps that card');
    assert(D[9].r.x === 40 && D[10].r.x > D[9].r.x && D[11].r.y > D[9].r.y, 'the cameras: top left, top right, bottom left');
    const vp = (s) => S.TRY.video.up(null, dr.components[2], dr.components[2].opts, s.p).part;
    assert.deepStrictEqual(D.slice(9, 13).map(vp), [1, 2, 3, 4], 'each camera stop presses its part');
    dr.components[2].opts.parts = 0;
    assert.deepStrictEqual(spots(dr).filter((s) => s.i === 2).map((s) => s.key), ['video'], 'one camera enlarged: the picture is one stop');
    const tl = dr.components[3];
    assert(D[13].kind === 'value' && adjust(tl, 1) && tl.opts.value === 12, 'the timeline: adjusted, its step (1 s) a click');
    console.log('controller ok');
}
