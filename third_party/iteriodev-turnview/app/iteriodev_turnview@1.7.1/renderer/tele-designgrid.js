'use strict';
/*
 * tele-designgrid.js - the design picker of Iterio's Clusters 0.3.0 (owner-approved mockups 2026-11-20:
 * analysis/licensing/app-mockups/round2 + round3), in a file of its own beside tele-widgets.js; wired the same way:
 * gpu.js spreads DRAW / TRY, export.js RUNTIME ships it to the car in renderer/ (Node 8). No builder code.
 *
 * Cards 4 a row (210 high): the picture top left with the gear beside it in the card's top-right corner, the name and
 * its small line at the bottom; Off (item.off) has the back arrow and no gear. Not ready (item.state downloading /
 * checking / waiting / failed): the picture dimmed, a labelled bar under it, the gear greyed (item.gearOff). The finger
 * scrolls it in pixels (o.scroll); rows cut at the edges are clipped (the renderer's clip, and a mask in the screen's
 * background for the software path, so the grid goes first on its screen); a scroll bar on the right while it scrolls.
 * A tap: the event <name>:<id> (the card) or <name>:<id>/gear (its gear: the card's top-right corner; nothing while
 * greyed). o.items = [{ id, title, sub, pic ('key:<name>' | data URI), state, progress 0-1, selected, gearOff, off }].
 */
const { withAlpha } = require('./kit/canvas');
const { vicon } = require('./kit/vicons');
const W = require('./widgets');
const { C, T, caps, fit } = require('./tele-widgets');

const G = { cols: 4, gap: 20, rowGap: 14, ch: 210, pad: 16, gear: 52, lane: 16, slop: 16 };
const BUSY = { downloading: C.accent, checking: C.info, waiting: C.faint, failed: C.crit };

function view(b, o) {
    const items = Array.isArray(o.items) ? o.items : [];
    const cw = (b.w - G.lane - (G.cols - 1) * G.gap) / G.cols, pitch = G.ch + G.rowGap;
    const content = Math.max(0, Math.ceil(items.length / G.cols) * pitch - G.rowGap), max = Math.max(0, content - b.h);
    return { items, cw, pitch, content, max, scroll: Math.max(0, Math.min(max, +o.scroll || 0)) };
}
const cardAt = (b, v, i) => ({ x: b.x + (i % G.cols) * (v.cw + G.gap), y: b.y + Math.floor(i / G.cols) * v.pitch - v.scroll, w: v.cw, h: G.ch });
function parts(c) {                        // the picture (8:3) and the gear beside it, top right
    const tw = c.w - 2 * G.pad - G.gear - 12, th = Math.round(tw * 3 / 8);
    return { pic: { x: c.x + G.pad, y: c.y + G.pad, w: tw, h: th }, gear: { x: c.x + c.w - G.pad - G.gear, y: c.y + G.pad, w: G.gear, h: th } };
}

function card(cv, c, it) {
    const on = !!it.selected;
    cv.fillRect(c.x, c.y, c.w, c.h, on ? withAlpha(C.accent, 0.1) : C.panel);
    cv.strokeRoundRect(c.x, c.y, c.w, c.h, 4, 2, on ? C.accent : C.edge);
    if (it.off) vicon(cv, 'back', c.x + 24, c.y + 22, 56, on ? C.accent : C.text);
    else {
        const P = parts(c), img = it.pic ? W.picture(it.pic) : null, busy = BUSY[it.state];
        if (img) cv.image(img, P.pic.x, P.pic.y, P.pic.w, P.pic.h, 8);
        else { cv.roundRect(P.pic.x, P.pic.y, P.pic.w, P.pic.h, 8, C.track); vicon(cv, 'display', P.pic.x + P.pic.w / 2 - 18, P.pic.y + P.pic.h / 2 - 18, 36, C.faint); }
        if (busy) {
            cv.roundRect(P.pic.x, P.pic.y, P.pic.w, P.pic.h, 8, withAlpha('#000000', 0.69));
            const f = it.state === 'downloading' ? Math.max(0, Math.min(1, +it.progress || 0)) : it.state === 'waiting' ? 0 : 1;
            const label = it.state === 'downloading' ? (on ? 'Picked' : 'Downloading') : it.state === 'checking' ? 'Checking' : it.state === 'failed' ? 'Failed' : 'Waiting';
            const x = c.x + G.pad, w = c.w - 2 * G.pad, y = c.y + 104;
            caps(cv, label, x, y, C.dim);
            if (it.state === 'downloading') cv.text(`${Math.round(f * 100)} %`, x + w, y, T.cap, C.text, { align: 'right', font: 'num' });
            cv.fillRect(x, y + 18, w, 12, C.track); cv.fillRect(x, y + 18, w * f, 12, busy);
        }
        const g = P.gear, off = !!it.gearOff;
        if (off) cv.roundRect(g.x, g.y, g.w, g.h, 4, C.track); else cv.strokeRoundRect(g.x, g.y, g.w, g.h, 4, 2, C.edge);
        vicon(cv, 'gear', g.x + (g.w - 29) / 2, g.y + (g.h - 29) / 2, 29, off ? C.faint : C.text);
    }
    cv.text(fit(cv, String(it.title || ''), c.w - 48, T.body - 6), c.x + 24, c.y + c.h - 52, T.body - 6, C.text);
    if (it.sub) cv.text(fit(cv, String(it.sub), c.w - 48, T.cap), c.x + 24, c.y + c.h - 20, T.cap, C.dim);
}

const DRAW = {};
const TRY = {};
DRAW.designGrid = (cv, t, b, o) => {
    const v = view(b, o);
    if (cv.clip) cv.clip(b.x, b.y, b.w, b.h);
    v.items.forEach((it, i) => { const c = cardAt(b, v, i); if (c.y < b.y + b.h && c.y + c.h > b.y) card(cv, c, it); });
    if (cv.noclip) cv.noclip();
    // the software path ignores clip: the cut rows' rest masked in the screen's background (inside the app area only)
    const a = o.area || { y: 0, h: 1e5 }, bg = o.bg || '#000000', top = Math.max(a.y, b.y - G.ch), bottom = Math.min(a.y + a.h, b.y + b.h + G.ch);
    if (v.scroll > 0 && top < b.y) cv.fillRect(b.x - 2, top, b.w + 4, b.y - top, bg);
    if (v.scroll < v.max && bottom > b.y + b.h) cv.fillRect(b.x - 2, b.y + b.h, b.w + 4, bottom - b.y - b.h, bg);
    if (v.max > 0) {                       // the scroll bar: where the rows in view are
        const h = Math.max(40, b.h * b.h / v.content);
        cv.fillRect(b.x + b.w - 4, b.y, 4, b.h, C.track);
        cv.fillRect(b.x + b.w - 4, b.y + (b.h - h) * v.scroll / v.max, 4, h, C.dim);
    }
};

// the finger: a drag scrolls (pixels), a release without one taps the card under it, or its gear (the corner around it)
let drag = null;
TRY.designGrid = Object.assign((cv, b, o, p) => {
    const v = view(b, o);
    if (!p.move) { drag = { y0: p.y, s0: v.scroll, moved: false }; return false; }
    if (!drag) return false;
    const dy = p.y - drag.y0;
    if (!drag.moved && Math.abs(dy) < G.slop) return false;
    drag.moved = true;
    const s = Math.round(Math.max(0, Math.min(v.max, drag.s0 - dy)));
    if (s === v.scroll) return false;
    o.scroll = s;
}, { drag: true, up: (cv, b, o, p) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || p.y < b.y || p.y >= b.y + b.h) return false;
    const v = view(b, o), col = Math.floor((p.x - b.x) / (v.cw + G.gap)), row = Math.floor((p.y - b.y + v.scroll) / v.pitch);
    const i = row * G.cols + col, it = col >= 0 && col < G.cols ? v.items[i] : null;
    if (!it) return false;
    const c = cardAt(b, v, i);
    if (p.x >= c.x + c.w || p.y >= c.y + c.h) return false;            // the gap between cards
    const g = parts(c).gear;
    if (!it.off && p.x >= g.x - 12 && p.y < g.y + g.h + 8) return it.gearOff ? false : { part: `${it.id}/gear` };
    return { part: String(it.id) };
} });

module.exports = { DRAW, TRY, view, cardAt, parts, G };
