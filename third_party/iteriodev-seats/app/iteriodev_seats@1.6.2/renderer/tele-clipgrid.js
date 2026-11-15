'use strict';
/*
 * tele-clipgrid.js - the Telemetry clip grid (Drive Recorder 2.2.0, step 9 of the car apps redesign), in a file of its
 * own beside tele-widgets.js (that one is near 500 lines); wired the same way: gpu.js spreads DRAW / TRY, export.js
 * RUNTIME ships it to the car in renderer/ (Node 8). No builder code.
 */
const { vicon } = require('./kit/vicons');
const W = require('./widgets');
const S = require('./store-widgets');                             // the clip grid's geometry, scrolling and taps
const { C, T, caps, hair, fit, empty, videoBox } = require('./tele-widgets');

const DRAW = {};
const TRY = {};

// Drive Recorder's clips: the store's clip grid (store-widgets clipView: columns, rows, the first row shown; its TRY
// scrolls by whole rows and gives a tap as o.sel = id and o.tap { id, part: 'clip', n }) drawn as the Telemetry cards
// (redesign/phase2.js clipCard): the 4:3 picture ('key:<name>', the stand-in until it comes) with its duration, the
// title, two small lines, LOCKED in amber, a hairline; the clip opened last (o.sel) marked with the accent bar. No
// clips: the empty state (o.empty, o.emptyLine) in its place
DRAW.teleClipGrid = (cv, t, b, o) => {
    const v = S.clipView(b, o);
    if (!v.all.length) { if (o.empty) empty(cv, b.x, b.y, b.w, b.h, 'camera', o.empty, o.emptyLine); return; }
    v.all.slice(v.top * v.cols, (v.top + v.n) * v.cols).forEach((it, k) => {
        const x = b.x + (k % v.cols) * (v.cw + v.gap), y = b.y + Math.floor(k / v.cols) * v.rh, h = v.rh - 10;
        const th = h - 30, tw = Math.round(th * 4 / 3), img = it.thumb ? W.picture(it.thumb) : null;
        if (img) cv.image(img, x, y + 10, tw, th, 0); else videoBox(cv, x, y + 10, tw, th, '');
        if (it.dur) {
            const d = String(it.dur), dw = cv.textWidth(d, T.cap, { font: 'num' }) + 24;
            cv.roundRect(x + tw - 10 - dw, y + th - 34, dw, 34, 3, '#000000');
            cv.text(d, x + tw - 10 - dw / 2, y + th - 9, T.cap, C.text, { align: 'center', font: 'num' });
        }
        const tx = x + tw + 24, room = x + v.cw - tx - 8;
        cv.text(fit(cv, String(it.title || ''), room, T.body - 4), tx, y + 50, T.body - 4, C.text);
        if (it.sub) cv.text(fit(cv, String(it.sub), room, T.cap), tx, y + 88, T.cap, C.dim);
        if (it.sub2) cv.text(fit(cv, String(it.sub2), room, T.cap, { font: 'num' }), tx, y + 124, T.cap, C.dim, { font: 'num' });
        if (it.locked) { vicon(cv, 'lock', tx, y + 140, 34, C.accent); caps(cv, 'Locked', tx + 44, y + 166, C.accent); }
        if (o.sel && it.id === o.sel) cv.fillRect(x, y + 10, 5, th, C.accent);
        hair(cv, x, y + h - 2, v.cw);
    });
    if (v.rows > v.n) {                                           // more rows than shown: where the shown ones are
        const sh = b.h * v.n / v.rows;
        cv.fillRect(b.x + b.w - 4, b.y + (b.h - sh) * v.top / Math.max(1, v.rows - v.n), 4, sh, C.faint);
    }
};
TRY.teleClipGrid = S.TRY.clipGrid;

module.exports = { DRAW, TRY };
