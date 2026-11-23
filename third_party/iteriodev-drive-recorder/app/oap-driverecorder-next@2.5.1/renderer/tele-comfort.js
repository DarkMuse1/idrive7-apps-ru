'use strict';
/*
 * tele-comfort.js - the Telemetry elements of the Ambient Light and Seats apps (front ends of iteriodev-comfort,
 * 2026-11-07), in a file of their own beside tele-widgets.js / tele-clipgrid.js; wired the same way: gpu.js spreads
 * DRAW / TRY, export.js RUNTIME ships it to the car in renderer/ (Node 8). No builder code.
 *   holdButton    pressed while held: a 'change' on the touch (o.pressed true) and one on the release (false), wherever
 *                 the finger is by then - the app moves a seat in between
 *   hueBar        a colour bar, mode 'hue' (the rainbow) or 'sat' (white to the full colour of o.hue); a touch or a
 *                 drag sets o.value 0-1 (a 'change' each time: the app limits what it sends)
 *   colourSwatch  a colour square with its name under it, the one in use ringed; empty: a free place (a faint +);
 *                 o.colors '#a,#b,…': a scene, drawn as stripes. No touch of its own: its onTap is the app's event
 * The Seats page (2026-11-08, controls placed round a seat picture):
 *   holdPill      two hold ends in a capsule (taller than wide: top / bottom, else left / right): o.pressed 'a' (top /
 *                 left) or 'b' while held, '' after - a 'change' on the touch and on the release, as holdButton
 *   holdRound     a round hold button, its chevron pointing o.angle degrees (0 = up, clockwise): o.pressed while held
 *   dotArc        a dotted arc round the box's bottom-left corner, radius the box's width, o.a0 to o.a1 degrees
 *   memDot        a small round button (a pill when wider than high): o.text, o.set (white: in use; else dim), o.lit
 *                 (amber ring), o.moving (amber with a stop square). No touch of its own: its onTap is the app's event
 * (2026-11-08: the interior picture, cabinMap, is gone - user: the Ambient Light app lists its zones instead)
 */
const { C, T, CAPS, caps, fit } = require('./tele-widgets');
const { withAlpha } = require('./kit/canvas');

const DRAW = {};
const TRY = {};
const clamp01 = (v) => Math.max(0, Math.min(1, +v || 0));
/** h 0-360, s 0-1, v 0-1 -> [r, g, b] 0-255 (as the tool's ambient.js hsv) */
function hsv(h, s, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
    return [f(5), f(3), f(1)];
}

// a chevron pointing ang degrees (0 = up, clockwise), centred on cx, cy, s across
function chev(cv, ang, cx, cy, s, c) {
    const g = ang * Math.PI / 180, d = [Math.sin(g), -Math.cos(g)];
    const a = s / 2, q = [-d[1] * a, d[0] * a], tip = [cx + d[0] * a / 2, cy + d[1] * a / 2];
    cv.polyline([[tip[0] - d[0] * a + q[0], tip[1] - d[1] * a + q[1]], tip, [tip[0] - d[0] * a - q[0], tip[1] - d[1] * a - q[1]]], Math.max(3, s * 0.14), c);
}
const DIRS = { up: 0, right: 90, down: 180, left: 270 };
const arrow = (cv, dir, cx, cy, s, c) => { if (dir in DIRS) chev(cv, DIRS[dir], cx, cy, s, c); };
DRAW.holdButton = (cv, t, b, o) => {
    const off = !!o.disabled, on = !!o.pressed && !off;
    let fg = C.text;
    if (off) { cv.roundRect(b.x, b.y, b.w, b.h, 4, C.track); fg = C.faint; }
    else if (on) { cv.roundRect(b.x, b.y, b.w, b.h, 4, C.accent); fg = C.onAccent; }
    else cv.strokeRoundRect(b.x, b.y, b.w, b.h, 4, 2, C.edge);
    const size = b.h >= 80 ? T.sub : T.cap, s = Math.round(b.h * 0.36), text = String(o.text || '');
    const tw = text ? cv.textWidth(text.toUpperCase(), size, CAPS) : 0, aw = o.arrow ? s : 0, gap = aw && tw ? 16 : 0;
    const x0 = b.x + (b.w - tw - aw - gap) / 2;
    if (aw) arrow(cv, o.arrow, x0 + s / 2, b.y + b.h / 2, s, fg);
    if (tw) caps(cv, text, x0 + aw + gap, b.y + b.h / 2 + size * 0.36, fg, { size });
};
// the touch presses it, the release (anywhere: ScreenApp keeps the element touched until then) lets it go
TRY.holdButton = Object.assign((cv, b, o, p) => { if (p.move) return false; o.pressed = true; },
    { up: (cv, b, o) => { if (!o.pressed) return false; o.pressed = false; } });

DRAW.hueBar = (cv, t, b, o) => {
    const n = 72, y = b.y + 10, h = b.h - 20, sw = b.w / n, off = !!o.disabled;
    for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n, x = b.x + i * sw;
        cv.fillRect(x, y, i === n - 1 ? b.x + b.w - x : sw + 1, h, o.mode === 'sat' ? hsv(+o.hue || 0, f, 1) : hsv(f * 360, 1, 1));
    }
    if (off) cv.fillRect(b.x, y, b.w, h, [0, 0, 0, 160]);
    const x = b.x + clamp01(o.value) * b.w;
    cv.roundRect(x - 9, b.y, 18, b.h, 4, '#000000');
    cv.roundRect(x - 6, b.y + 3, 12, b.h - 6, 3, off ? C.dim : '#ffffff');
};
TRY.hueBar = Object.assign((cv, b, o, p) => { o.value = Math.round(clamp01((p.x - b.x) / b.w) * 1000) / 1000; }, { drag: true });

DRAW.colourSwatch = (cv, t, b, o) => {
    const sh = o.label ? b.h - 44 : b.h, cs = String(o.colors || '').split(',').filter(Boolean);
    const paint = (x, y, w, h, r) => {                             // one colour, or a scene's colours side by side
        if (cs.length < 2) return cv.roundRect(x, y, w, h, r, o.color || cs[0] || '#ffffff');
        cs.forEach((c, i) => cv.fillRect(x + Math.round(i * w / cs.length), y, Math.round((i + 1) * w / cs.length) - Math.round(i * w / cs.length), h, c));
    };
    if (o.empty) {
        const cx = b.x + b.w / 2, cy = b.y + sh / 2, a = Math.min(b.w, sh) * 0.18;
        cv.strokeRoundRect(b.x, b.y, b.w, sh, 6, 2, C.edge);
        cv.line(cx - a, cy, cx + a, cy, 4, C.faint); cv.line(cx, cy - a, cx, cy + a, 4, C.faint);
    } else if (o.selected) {                                       // ringed: the colour inside the ring
        cv.strokeRoundRect(b.x, b.y, b.w, sh, 8, 4, C.accent);
        paint(b.x + 9, b.y + 9, b.w - 18, sh - 18, 4);
    } else paint(b.x, b.y, b.w, sh, 6);
    if (o.disabled && !o.empty) cv.fillRect(b.x, b.y, b.w, sh, [0, 0, 0, 160]);
    if (o.label) cv.text(fit(cv, o.label, b.w, T.cap), b.x + b.w / 2, b.y + b.h - 10, T.cap, o.selected ? C.text : C.dim, { align: 'center' });
};

// ---- the Seats page ----------------------------------------------------------------------------------------------
const PAD = '#1b2129';                                             // a control's face on the seat picture
DRAW.holdPill = (cv, t, b, o) => {
    const v = b.h > b.w, r = Math.min(b.w, b.h) / 2, off = !!o.disabled, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const a = v ? [cx, b.y + r] : [b.x + r, cy], z = v ? [cx, b.y + b.h - r] : [b.x + b.w - r, cy];
    cv.line(a[0], a[1], z[0], z[1], 2 * r, withAlpha('#000000', 0.55));
    cv.line(a[0], a[1], z[0], z[1], 2 * r - 4, off ? C.track : PAD);
    const held = off ? '' : o.pressed;
    if (held === 'a' || held === 'b') { const e = held === 'a' ? a : z; cv.circle(e[0], e[1], r - 2, C.accent); }
    if (v) cv.line(cx - r * 0.5, cy, cx + r * 0.5, cy, 2, withAlpha('#ffffff', 0.18)); else cv.line(cx, cy - r * 0.5, cx, cy + r * 0.5, 2, withAlpha('#ffffff', 0.18));
    const fg = (end) => (held === end ? C.onAccent : off ? C.faint : C.text);
    chev(cv, v ? 0 : 270, a[0], a[1], r * 0.65, fg('a'));
    chev(cv, v ? 180 : 90, z[0], z[1], r * 0.65, fg('b'));
};
// the touch holds the end it is on, the release (anywhere) lets it go
TRY.holdPill = Object.assign((cv, b, o, p) => {
    if (p.move) return false;
    o.pressed = (b.h > b.w ? p.y < b.y + b.h / 2 : p.x < b.x + b.w / 2) ? 'a' : 'b';
}, { up: (cv, b, o) => { if (!o.pressed) return false; o.pressed = ''; } });

DRAW.holdRound = (cv, t, b, o) => {
    const r = Math.min(b.w, b.h) / 2, cx = b.x + b.w / 2, cy = b.y + b.h / 2, off = !!o.disabled, on = !!o.pressed && !off;
    cv.circle(cx, cy, r, withAlpha('#000000', 0.55));
    cv.circle(cx, cy, r - 4, on ? C.accent : off ? C.track : PAD);
    chev(cv, +o.angle || 0, cx, cy, r * 0.6, on ? C.onAccent : off ? C.faint : C.text);
};
TRY.holdRound = TRY.holdButton;

DRAW.dotArc = (cv, t, b, o) => {
    const R = b.w, cx = b.x, cy = b.y + b.h, a0 = +o.a0 || 0, a1 = o.a1 == null ? 90 : +o.a1;
    const n = Math.max(2, Math.round(Math.abs(a1 - a0) * Math.PI / 180 * R / 14));
    for (let i = 0; i <= n; i++) {
        const g = (a0 + (a1 - a0) * i / n) * Math.PI / 180;
        cv.circle(cx + Math.sin(g) * R, cy - Math.cos(g) * R, 2.4, withAlpha('#ffffff', 0.5));
    }
};

DRAW.memDot = (cv, t, b, o) => {
    const r = b.h / 2;
    if (o.moving) {
        const s = b.h * 0.3;
        cv.roundRect(b.x, b.y, b.w, b.h, r, C.accent);
        return cv.roundRect(b.x + (b.w - s) / 2, b.y + (b.h - s) / 2, s, s, 3, C.onAccent);
    }
    const lit = !!o.lit, set = !!o.set && !o.disabled;
    cv.roundRect(b.x, b.y, b.w, b.h, r, PAD);
    cv.strokeRoundRect(b.x, b.y, b.w, b.h, r, lit ? 3 : 2, lit ? C.accent : set ? '#3a414c' : C.edge);
    const size = b.h >= 76 ? 27 : 24, text = String(o.text || ''), tw = cv.textWidth(text.toUpperCase(), size, CAPS);
    caps(cv, text, b.x + (b.w - tw) / 2, b.y + b.h / 2 + size * 0.36, lit ? C.accent : set ? C.text : C.faint, { size });
};

module.exports = { DRAW, TRY, hsv };

if (require.main === module) {
    const assert = require('assert');
    const v = { x: 0, y: 0, w: 80, h: 120 }, h = { x: 0, y: 0, w: 150, h: 80 }, o = { pressed: '' };
    assert.strictEqual(TRY.holdPill(null, v, o, { x: 40, y: 20 }), undefined); assert.strictEqual(o.pressed, 'a', 'the top end');
    assert.strictEqual(TRY.holdPill.up(null, v, o), undefined); assert.strictEqual(o.pressed, '', 'let go');
    assert.strictEqual(TRY.holdPill.up(null, v, o), false, 'a release with nothing held: no change');
    TRY.holdPill(null, v, o, { x: 40, y: 100 }); assert.strictEqual(o.pressed, 'b', 'the bottom end');
    TRY.holdPill(null, h, o, { x: 20, y: 40 }); assert.strictEqual(o.pressed, 'a', 'a wide one: the left end');
    TRY.holdPill(null, h, o, { x: 130, y: 40 }); assert.strictEqual(o.pressed, 'b', 'the right end');
    assert.strictEqual(TRY.holdPill(null, v, o, { x: 40, y: 20, move: true }), false, 'a drag: no change');
    console.log('tele-comfort ok');
}
