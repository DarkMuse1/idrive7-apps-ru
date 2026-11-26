'use strict';
/*
 * tele-widgets.js - the Telemetry design of the car apps (redesign approved 2026-11-04, spec
 * docs/superpowers/specs/2026-11-04-car-apps-telemetry-redesign-design.md) as renderer elements. Same contract as
 * widgets.js: DRAW[type](cv, t, b, o) on a kit canvas / recorder (t, the kit theme, is not used: one fixed palette),
 * TRY[type](cv, b, o, p) for touch (gpu.js touchElement). No builder code: shipped to the car in renderer/ (Node 8).
 * Looks moved from the approved mock-ups (scripts/hmi-tools/redesign/tele.js, ds.js, phase2.js, features.js).
 */
const { withAlpha } = require('./kit/canvas');
const { vicon } = require('./kit/vicons');
const W = require('./widgets');
const S = require('./store-widgets');                             // the video list's geometry, scrolling and taps

const C = {
    bg: '#000000', panel: '#0b0d10', edge: '#22272f', track: '#16191e', text: '#f2f2f2', dim: '#8b9099', faint: '#4a4f57',
    accent: '#ffb020', onAccent: '#000000', ok: '#5bd68a', warn: '#ffb020', crit: '#ff3b30', info: '#7fc4ff', credit: '#6b7280',
};
const T = { display: 150, big: 96, value: 64, title: 44, body: 34, sub: 27, cap: 24, credit: 22 };
const CAPS = { font: 'bold', spacing: 2 };
const CREDIT = 'Developed by IterioDev and RobertNisipeanu';
// the shell's rows inside its box (box top = the app area's top): header, hairline, page line; content starts at h
const SHELL = { id8: { pad: 40, top: 20, hair: 80, sub: 128, h: 172 }, id7: { pad: 32, top: 14, hair: 74, sub: 118, h: 154 } };

const isNum = (x) => typeof x === 'number' && isFinite(x);
const col = (c, d) => (c && C[c] ? C[c] : typeof c === 'string' && c[0] === '#' ? c : d);   // a tele token name or '#rrggbb', else d
const up = (s) => String(s == null ? '' : s).toUpperCase();
const dp = (d) => Math.max(0, Math.min(20, d | 0));              // decimals for toFixed (Node 8 takes 0..20 only)
const caps = (cv, s, x, y, c, o) => cv.text(up(s), x, y, (o && o.size) || T.cap, c || C.dim, Object.assign({}, CAPS, o || {}));
const capsW = (cv, s, size) => cv.textWidth(up(s), size || T.cap, CAPS);
const hair = (cv, x, y, w, c) => cv.fillRect(x, y, w, 2, c || C.edge);
const vhair = (cv, x, y, h, c) => cv.fillRect(x, y, 2, h, c || C.edge);
const split = (s, sep) => String(s || '').split(sep).map((x) => x.trim());
// "a | b | c" lines -> [[a, b, c]]; an array (from the app) as it is
const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n').filter((l) => l.trim()).map((l) => split(l, '|')));
const items = (v) => (Array.isArray(v) ? v : split(v, ',').filter(Boolean));
const fracOf = (o) => (isNum(o.value) && o.max > o.min ? Math.max(0, Math.min(1, (o.value - o.min) / (o.max - o.min))) : 0);

function fit(cv, s, w, size, o) {                         // cut to a width, with an ellipsis
    s = String(s); if (cv.textWidth(s, size, o) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '…', size, o) > w) s = s.slice(0, -1);
    return s + '…';
}

function value(cv, x, y, v, unit, size, color, align) {        // big number + unit, y = baseline
    const uw = unit ? cv.textWidth(' ' + unit, T.sub) : 0;
    if (align === 'right') {
        cv.text(String(v), x - uw, y, size, color || C.text, { font: 'num', align: 'right' });
        if (unit) cv.text(' ' + unit, x, y, T.sub, C.dim, { align: 'right' });
    } else {
        const vw = cv.textWidth(String(v), size, { font: 'num' });
        cv.text(String(v), x, y, size, color || C.text, { font: 'num' });
        if (unit) cv.text(' ' + unit, x + vw, y, T.sub, C.dim);
    }
}
function chip(cv, xr, y, text, color) {                          // right edge xr; returns its left edge
    const w = cv.textWidth(text, T.cap) + 64, h = 46;
    cv.roundRect(xr - w, y, w, h, 4, withAlpha(color, 0.16));
    cv.circle(xr - w + 24, y + h / 2, 7, color);
    cv.text(text, xr - w + 40, y + 32, T.cap, color);
    return xr - w;
}
// "text|colour; text|colour" or [[text, colour]] -> chips from the right edge
const chipList = (v) => (Array.isArray(v) ? v : split(v, ';').filter(Boolean).map((s) => split(s, '|')));
function chips(cv, xr, y, v) { let x = xr; chipList(v).forEach(([t, c]) => { x = chip(cv, x, y, t, col(c, C.dim)) - 14; }); }
function progress(cv, x, y, w, f, left, right, color) {
    if (left) caps(cv, left, x, y, C.dim);
    if (right) cv.text(right, x + w, y, T.cap, C.text, { align: 'right', font: 'num' });
    cv.fillRect(x, y + 18, w, 12, C.track); cv.fillRect(x, y + 18, w * f, 12, color || C.accent);
}
function empty(cv, x, y, w, h, icon, head, line, color) {         // an empty or finished state, centred
    const cx = x + w / 2, cy = y + h / 2;
    if (icon) vicon(cv, icon, cx - 36, cy - 110, 72, color || C.faint);
    caps(cv, head, cx, cy + 10, color || C.text, { align: 'center', size: T.body });
    if (line) cv.text(line, cx, cy + 60, T.sub, C.dim, { align: 'center' });
}
function kv(cv, x, y, w, rows, rh) {                              // rows [[key, value, colour]] on hairlines
    rows.forEach(([k, v, c], i) => {
        const yy = y + i * rh, key = String(k);
        cv.text(key, x, yy + rh / 2 + 10, T.sub, C.dim);
        // the value in what the key leaves: a long one is cut, not drawn over the key (Drive Recorder on iDrive 7)
        const room = w - (key ? cv.textWidth(key, T.sub) + 24 : 0);
        cv.text(fit(cv, v == null ? '' : v, room, T.sub, { font: 'num' }), x + w, yy + rh / 2 + 10, T.sub, col(c, C.text), { align: 'right', font: 'num' });
        hair(cv, x, yy + rh - 2, w);
    });
}
// columns "Label:share:align, ..." or [[label, share, align]]; rows [[cell or [cell, colour]]]
const colList = (v) => (Array.isArray(v) ? v : items(v).map((s) => { const p = s.split(':'); return [p[0], +p[1] || 1, p[2] || 'left']; }));
function table(cv, x, y, w, cols, rows, rh) {
    const tot = cols.reduce((a, c) => a + c[1], 0);
    let cx = x; const xs = cols.map((c) => { const s = cx; cx += w * c[1] / tot; return s; });
    const at = (i, c) => (c[2] === 'right' ? xs[i] + w * c[1] / tot : xs[i]);
    cols.forEach((c, i) => caps(cv, c[0], at(i, c), y + 30, C.dim, { align: c[2] || 'left' }));
    hair(cv, x, y + 48, w);
    rows.forEach((r, j) => {
        const yy = y + 50 + j * rh;
        cols.forEach((c, i) => {
            const v = r[i], txt = Array.isArray(v) ? v[0] : v == null ? '' : String(v), cc = Array.isArray(v) ? col(v[1], C.text) : C.text;
            cv.text(txt, at(i, c), yy + rh / 2 + 11, T.body - 4, cc, { align: c[2] || 'left', font: i ? 'num' : 'label' });
        });
        hair(cv, x, yy + rh - 2, w);
    });
}

const nums = (v) => (Array.isArray(v) ? v.map(Number) : split(v, ',').filter((x) => x !== '').map(Number));
function spark(cv, x, y, w, h, vals, lo, hi, color, fill) {
    if (vals.length < 2 || !(hi > lo)) return;
    const P = vals.map((v, i) => [x + w * i / (vals.length - 1), y + h - h * (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)]);
    if (fill) cv.fillUnder(P, y + h, withAlpha(color, 0.14));
    cv.polyline(P, 3, color);
    const e = P[P.length - 1]; cv.circle(e[0], e[1], 7, color);
}
function trend(cv, x, y, w, h, o) {                               // value with its last minutes
    hair(cv, x, y, w); caps(cv, o.label, x, y + 40, C.dim);
    value(cv, x, y + 112, o.value, o.unit, 72);
    const lg = items(o.legend);
    if (lg.length === 2) { caps(cv, lg[0], x + w, y + 40, C.accent, { align: 'right' }); caps(cv, lg[1], x + w - capsW(cv, lg[0]) - 32, y + 40, C.text, { align: 'right' }); }
    const sy = y + 132, sh = h - 132 - 44;
    hair(cv, x, sy + sh, w, '#14171c');
    spark(cv, x, sy, w, sh, nums(o.points), o.lo, o.hi, C.accent, true);
    if (o.points2) spark(cv, x, sy, w, sh, nums(o.points2), o.lo, o.hi, C.text, false);
    if (o.foot) cv.text(o.foot, x, y + h - 8, T.cap, C.dim);
}
// points [[x, y]] or "x:y, x:y"
const pairs = (v) => (Array.isArray(v) ? v : items(v).map((s) => s.split(':').map(Number)));
function chart(cv, x, y, w, h, pts, o) {
    // x from xMin (default 0) to xMax; a right-hand axis when y2Max > 0 (Drag Timer's Power run: hp left, Nm right)
    const x0 = isNum(o.xMin) ? o.xMin : 0, xr = isNum(o.xMax) ? o.xMax - x0 : NaN, two = isNum(o.y2Max) && o.y2Max > 0;
    const kx = xr > 0 ? w / xr : 0, ky = isNum(o.yMax) && o.yMax > 0 ? h / o.yMax : 0, ky2 = two ? h / o.y2Max : 0;   // 0: all on the axis
    const px = (v) => x + kx * (v - x0), py = (v, k) => y + h - (k === undefined ? ky : k) * v;
    // at most 50 ticks a side, tick i at i * step (no added-up float steps), its label rounded
    const xs = o.xStep > 0 ? Math.max(o.xStep, xr / 50) : 0, ys = o.yStep > 0 ? Math.max(o.yStep, o.yMax / 50) : 0, lbl = (v) => String(Math.round(v * 1e6) / 1e6);
    const y2s = two && o.y2Step > 0 ? Math.max(o.y2Step, o.y2Max / 50) : 0;
    for (let i = 0; isNum(ys) && ys > 0 && i * ys <= o.yMax + ys / 1e6; i++) {
        const v = i * ys; hair(cv, x, py(v), w, i ? '#14171c' : C.edge); cv.text(lbl(v), x - 12, py(v) + 8, T.cap - 2, two ? C.accent : C.faint, { align: 'right', font: 'num' });
    }
    for (let i = 0; y2s > 0 && i * y2s <= o.y2Max + y2s / 1e6; i++) cv.text(lbl(i * y2s), x + w + 12, py(i * y2s, ky2) + 8, T.cap - 2, C.text, { font: 'num' });
    for (let i = 0; isNum(xs) && xs > 0 && i * xs <= xr + xs / 1e6; i++) {
        const v = x0 + i * xs, end = Math.abs(v - o.xMax) < xs / 1e6;
        cv.text(lbl(v) + (end && o.xUnit ? ' ' + o.xUnit : ''), px(v), y + h + 32, T.cap - 2, C.faint, { align: end ? 'right' : 'center', font: 'num' });
    }
    if (o.yUnit) caps(cv, o.yUnit, x, y - 14, two ? C.accent : C.dim);
    if (two && o.y2Unit) caps(cv, o.y2Unit, x + w, y - 14, C.text, { align: 'right' });
    // the app's other lines, under the main one: [{ points, color, axis (2: the right-hand one), width, dot }]
    (Array.isArray(o.series) ? o.series : []).filter(Boolean).forEach((s) => {
        const P = pairs(s.points || []).map(([a, v]) => [px(a), py(v, s.axis === 2 ? ky2 : ky)]), c = col(s.color, C.dim);
        if (P.length >= 2) cv.polyline(P, s.width || 2, c);
        if (s.dot && P.length) cv.circle(P[P.length - 1][0], P[P.length - 1][1], 9, c);
    });
    if (pts.length < 2) return;
    const P = pts.map(([a, v]) => [px(a), py(v)]);
    cv.fillUnder(P, y + h, withAlpha(C.accent, 0.16));
    cv.polyline(P, 4, C.accent);
    const e = P[P.length - 1]; cv.circle(e[0], e[1], 9, C.accent);
}
function barTile(cv, x, y, w, h, o) {                              // label, value, flat bar with red zone and ticks
    hair(cv, x, y, w); caps(cv, o.label, x, y + 42, C.dim);
    const none = !isNum(o.value), vs = o.big || (h > 200 ? 92 : h > 160 ? 68 : 56), uw = cv.textWidth(' ' + o.unit, T.sub);
    const lim = isNum(o.limit) ? o.limit : Infinity;              // no limit (null): no red zone
    const vy = y + vs * 0.9 + 6, over = !none && o.value >= lim;
    cv.text(none ? '--' : o.value.toFixed(dp(o.dec)), x + w - uw, vy, vs, none ? C.dim : over ? C.crit : C.text, { align: 'right', font: 'num' });
    cv.text(' ' + o.unit, x + w, vy, T.sub, C.dim, { align: 'right' });
    const by = vy + 22, bh = Math.max(24, y + h - by - (o.ticks ? 50 : 24)), th = Math.min(bh, 26), ty = by + (bh - th) / 2;
    const f = (v) => (o.max > o.min ? Math.max(0, Math.min(1, (v - o.min) / (o.max - o.min))) : 0);
    cv.fillRect(x, ty, w, th, C.track);
    cv.fillRect(x + w * f(lim), ty, w * (1 - f(lim)), th, withAlpha(C.crit, 0.45));
    if (!none) { cv.fillRect(x, ty, w * f(o.value), th, over ? C.crit : C.accent); cv.fillRect(x + w * f(o.value) - 2, ty - 10, 4, th + 20, '#ffffff'); }
    if (isNum(o.peak)) cv.fillRect(x + w * f(o.peak) - 2, ty - 6, 4, th + 12, C.dim);
    for (let i = 0; o.ticks && i <= o.ticks; i++) {
        const v = o.min + (o.max - o.min) * i / o.ticks, tx = x + w * i / o.ticks;
        const s = isNum(o.tickDec) && o.tickDec >= 0 ? v.toFixed(dp(o.tickDec)) : String(Math.round(v / (o.tickDiv || 1)));
        cv.fillRect(tx - 1, by + bh + 6, 2, 10, C.faint);
        cv.text(s, tx, by + bh + 44, T.cap, v >= lim ? C.crit : C.dim, { align: i === 0 ? 'left' : i === o.ticks ? 'right' : 'center', font: 'num' });
    }
}
function miniTile(cv, x, y, w, h, o) {
    hair(cv, x, y, w); caps(cv, o.label, x, y + 44, C.dim);
    const none = !isNum(o.value);
    cv.text(none ? '--' : o.value.toFixed(dp(o.dec)), x + w - cv.textWidth(' ' + o.unit, T.cap), y + 54, 52, none ? C.dim : C.text, { align: 'right', font: 'num' });
    cv.text(' ' + o.unit, x + w, y + 54, T.cap, C.dim, { align: 'right' });
    const by = y + h - 30;
    cv.fillRect(x, by, w, 10, C.track);
    cv.fillRect(x, by, w * (none ? 0 : fracOf(o)), 10, col(o.color, C.accent));
}
function field(cv, x, y, w, h, text, label, focus, hint) {
    cv.fillRect(x, y, w, h, C.panel);
    cv.fillRect(x, y + h - 4, w, 4, focus ? C.accent : C.edge);
    if (label) caps(cv, label, x + 20, y + 32, C.dim);
    const ty = label ? y + h - 24 : y + h / 2 + 12;
    const tw = cv.text(text || hint || '', x + 20, ty, T.body, text ? C.text : C.faint);
    if (focus) cv.fillRect(x + 24 + (text ? tw : 0), ty - 32, 3, 40, C.accent);
}
function videoBox(cv, x, y, w, h, label, quad) {
    cv.fillRect(x, y, w, h, '#0d1014');
    if (quad) { vhair(cv, x + w / 2 - 1, y, h, '#000000'); cv.fillRect(x, y + h / 2 - 1, w, 2, '#000000'); }
    const labs = quad ? [['FRONT', 0, 0], ['REAR', 1, 0], ['LEFT', 0, 1], ['RIGHT', 1, 1]] : [[label == null ? 'VIDEO' : label, 0, 0]];
    labs.forEach(([t, i, j]) => {
        const cw = quad ? w / 2 : w, ch = quad ? h / 2 : h, cx = x + i * cw, cy = y + j * ch;
        if (ch < 60) return;
        const lab = !!t && ch >= 120 && cv.textWidth(up(t), T.cap, CAPS) < cw - 20, is = Math.min(56, ch * 0.4);
        vicon(cv, 'video', cx + cw / 2 - is / 2, cy + ch / 2 - (lab ? is * 0.8 : is / 2), is, C.faint);
        if (lab) caps(cv, t, cx + cw / 2, cy + ch / 2 + 44, C.faint, { align: 'center' });
    });
}

function btn(cv, x, y, w, h, text, kind, icon, off) {             // kind: primary | outline | danger | dangerOutline | quiet
    let fg = C.text;
    if (off) { cv.roundRect(x, y, w, h, 4, C.track); fg = C.faint; }
    else if (kind === 'primary') { cv.roundRect(x, y, w, h, 4, C.accent); fg = C.onAccent; }
    else if (kind === 'danger') { cv.roundRect(x, y, w, h, 4, C.crit); fg = '#ffffff'; }
    else if (kind === 'quiet') cv.roundRect(x, y, w, h, 4, C.track);
    else { cv.strokeRoundRect(x, y, w, h, 4, 2, kind === 'dangerOutline' ? withAlpha(C.crit, 0.8) : C.edge); fg = kind === 'dangerOutline' ? C.crit : C.text; }
    const size = h >= 80 ? T.sub : T.cap, tw = text ? capsW(cv, text, size) : 0, is = icon ? Math.round(h * 0.42) : 0, gap = icon && text ? 16 : 0;
    const x0 = x + (w - tw - is - gap) / 2;
    if (icon) vicon(cv, icon, x0, y + (h - is) / 2, is, fg);
    if (text) caps(cv, text, x0 + is + gap, y + h / 2 + size * 0.36, fg, { size });
}
function seg(cv, x, y, w, h, its, sel, off) {
    const n = its.length, bw = w / Math.max(1, n);
    cv.strokeRoundRect(x, y, w, h, 4, 2, C.edge);
    its.forEach((it, i) => {
        const bx = x + i * bw, size = h >= 80 ? T.sub : T.cap;
        if (i === sel) cv.roundRect(bx, y, bw, h, 4, off ? C.track : C.accent);
        else if (i && i - 1 !== sel) vhair(cv, bx, y + 14, h - 28);
        caps(cv, it, bx + bw / 2, y + h / 2 + size * 0.36, off ? (i === sel ? C.dim : C.faint) : i === sel ? C.onAccent : C.dim, { size, align: 'center' });
    });
}
const segAt = (x, w, n, px) => Math.max(0, Math.min(n - 1, Math.floor((px - x) / (w / Math.max(1, n)))));
function toggle(cv, xr, y, on, off) {                             // 116 x 62, right edge xr
    const w = 116, h = 62, X = xr - w;
    cv.roundRect(X, y, w, h, 6, on && !off ? C.accent : C.track);
    if (!on || off) cv.strokeRoundRect(X, y, w, h, 6, 2, C.faint);
    cv.roundRect(on ? X + w - 55 : X + 7, y + 7, 48, 48, 3, on && !off ? '#000000' : C.dim);
}
function sliderDraw(cv, x, cy, w, f, label, off) {                // track centred on cy, the value right of it
    const fg = off ? C.faint : C.text;
    cv.fillRect(x, cy - 4, w, 8, C.track); cv.fillRect(x, cy - 4, w * f, 8, off ? C.faint : C.accent);
    cv.roundRect(x + w * f - 6, cy - 22, 12, 44, 2, fg);
    if (label != null) cv.text(String(label), x + w + 24, cy + 11, T.sub, fg, { font: 'num' });
}
const shownValue = (o) => (o.text ? o.text : isNum(o.value) ? `${o.value.toFixed(dp(o.decimals))}${o.unit ? ' ' + o.unit : ''}` : '--');
const sliderTrack = (b, o) => ({ x: b.x, w: Math.max(0, b.w - (o.showValue === false ? 0 : 160)) });
function sliderSet(b, o, p, track) {
    const tr = track || sliderTrack(b, o), k = Math.pow(10, dp(o.decimals));
    const f = tr.w > 0 ? Math.max(0, Math.min(1, (p.x - tr.x) / tr.w)) : 0;
    o.value = Math.round((o.min + (o.max - o.min) * f) * k) / k;
}

// a row's control boxes (drawing and touch use the same): { seg | slider | toggle }
function rowParts(b, o) {
    const right = b.x + b.w - 8, sw = o.sw || Math.min(600, b.w * 0.45), slw = o.sw || Math.min(380, b.w * 0.3);
    return { toggle: { x: right - 116, y: b.y + (b.h - 62) / 2, w: 116, h: 62 },
        seg: { x: right - sw, y: b.y + (b.h - 72) / 2, w: sw, h: 72 },
        slider: { x: right - slw - 120, w: slw } };
}
function rowDraw(cv, b, o) {
    const x = b.x, y = b.y, w = b.w, h = b.h, P = rowParts(b, o);
    hair(cv, x, y + h - 2, w);
    if (o.selected) cv.fillRect(x, y + 12, 5, h - 26, C.accent);
    let tx = x + (o.selected ? 22 : 0);
    if (o.badge != null && o.badge !== '') {
        const bc = col(o.badgeColor, C.dim), bt = up(o.badge), bs = bt.length > 2 ? T.cap : 30;
        const bw = o.badgeW || Math.max(70, cv.textWidth(bt, bs, CAPS) + 28);
        cv.roundRect(tx, y + (h - 58) / 2, bw, 58, 3, withAlpha(bc, 0.2));
        cv.text(bt, tx + bw / 2, y + h / 2 + bs * 0.36, bs, bc, Object.assign({ align: 'center' }, CAPS));
        tx += bw + 28;
    }
    const off = !!o.disabled, fg = off ? C.faint : C.text;          // greyed out: every text and control faint
    if (o.icon) { vicon(cv, o.icon, tx, y + (h - 44) / 2, 44, off ? C.faint : C.accent); tx += 70; }
    const room = (o.control === 'seg' ? P.seg.x : o.control === 'slider' ? P.slider.x : o.control === 'toggle' ? P.toggle.x : x + w) - tx - 24;
    cv.text(fit(cv, o.label || '', room, T.body - 2), tx, y + (o.sub ? h / 2 - 6 : h / 2 + 12), T.body - 2, fg);
    if (o.sub) cv.text(fit(cv, o.sub, room, T.cap), tx, y + h / 2 + 32, T.cap, off ? C.faint : col(o.subColor, C.dim));
    const right = x + w - 8, c = o.control;
    if (c === 'toggle') toggle(cv, right, P.toggle.y, !!o.on, off);
    else if (c === 'value' || c === 'chevron') {
        const cw = c === 'chevron' ? 44 : 0;
        if (cw) vicon(cv, 'chevron', right - 38, y + (h - 40) / 2, 40, off ? C.faint : C.dim);
        cv.text(o.text || '', right - cw, y + h / 2 + 11, T.sub, off ? C.faint : col(o.textColor, C.dim), { align: 'right' });
    } else if (c === 'slider') {
        sliderDraw(cv, P.slider.x, y + h / 2, P.slider.w, fracOf(o), null, off);
        cv.text(shownValue(o), right, y + h / 2 + 11, T.sub, fg, { align: 'right', font: 'num' });
    } else if (c === 'seg') seg(cv, P.seg.x, P.seg.y, P.seg.w, P.seg.h, items(o.items), o.sel | 0, off);
}
function tile(cv, x, y, w, h, icon, title, sub, selected) {
    cv.fillRect(x, y, w, h, selected ? withAlpha(C.accent, 0.1) : C.panel);
    cv.strokeRoundRect(x, y, w, h, 4, 2, selected ? C.accent : C.edge);
    if (h < 170) {                                                // low tile: icon left of the text
        if (icon) vicon(cv, icon, x + 22, y + (h - 48) / 2, 48, selected ? C.accent : C.text);
        cv.text(title, x + 90, y + h / 2 - (sub ? 4 : -10), T.body - 6, C.text);
        if (sub) cv.text(sub, x + 90, y + h / 2 + 30, T.cap, C.dim);
        return;
    }
    const s = Math.min(56, h * 0.36);
    if (icon) vicon(cv, icon, x + 24, y + 22, s, selected ? C.accent : C.text);
    cv.text(title, x + 24, y + h - (sub ? 52 : 26), T.body - 6, C.text);
    if (sub) cv.text(sub, x + 24, y + h - 20, T.cap, C.dim);
}
function appTile(cv, x, y, w, h, o) {
    cv.fillRect(x, y, w, h, o.selected ? withAlpha(C.accent, 0.1) : C.panel);
    cv.strokeRoundRect(x, y, w, h, 4, 2, o.selected ? C.accent : C.edge);
    const s = Math.min(64, h - 40), sx = x + 20, sy = y + (h - s) / 2;
    const img = o.pic ? W.picture(o.pic) : null;
    if (img) cv.image(img, sx, sy, s, s, 10);
    else { cv.roundRect(sx, sy, s, s, 10, col(o.color, '#5d6d7e')); cv.text(String(o.letter || '?'), sx + s / 2, y + h / 2 + 12, 34, '#ffffff', { align: 'center', font: 'bold' }); }
    cv.text(fit(cv, o.title || '', w - s - 60, T.sub), sx + s + 20, y + h / 2 + 11, T.sub, C.text);
}

const metrics = (o) => SHELL[o.hu === 'id7' ? 'id7' : 'id8'];
// the shell's tabs: [{ x, y, w, h, label, badge }] - drawing and touch share them
function shellBoxes(cv, b, o) {
    o = require('./localization').options(o);
    const M = metrics(o), top = b.y + M.top, x0 = b.x + M.pad;
    const aw = cv.textWidth(up(o.app || ''), T.body, { font: 'bold', spacing: 4 });
    let x = x0 + 68 + aw + 64;
    return items(o.tabs).map((t) => {
        const [label, badge] = Array.isArray(t) ? t : split(t, '|'), tw = capsW(cv, label, T.sub);
        const box = { x: x - 20, y: top, w: tw + 40 + (badge ? 60 : 0), h: M.hair, label, badge, tx: x, tw };
        x += tw + (badge ? 60 : 0) + 60;
        return box;
    });
}
function shellDraw(cv, b, o) {
    const M = metrics(o), top = b.y + M.top, x0 = b.x + M.pad, right = b.x + b.w - M.pad;
    if (o.icon) vicon(cv, o.icon, x0, top + 4, 48, C.accent);
    cv.text(up(o.app || ''), x0 + 68, top + 44, T.body, C.text, { font: 'bold', spacing: 4 });
    shellBoxes(cv, b, o).forEach((t, i) => {
        caps(cv, t.label, t.tx, top + 42, i === (o.sel | 0) ? C.text : C.dim, { size: T.sub });
        if (t.badge) { const bx = t.tx + t.tw + 12; cv.roundRect(bx, top + 14, 40, 34, 3, withAlpha(C.crit, 0.25)); cv.text(String(t.badge), bx + 20, top + 40, T.cap, C.crit, { align: 'center', font: 'bold' }); }
        if (i === (o.sel | 0)) cv.fillRect(t.tx, top + M.hair - 9, t.tw, 5, C.accent);
    });
    if (o.chips) chips(cv, right, top + 2, o.chips);
    hair(cv, x0, top + M.hair, right - x0);
    const sb = top + M.sub;
    let sx = x0 + (o.back ? 174 : 0);                              // the Back button (a teleButton) sits in that gap
    if (o.title) { caps(cv, o.title, sx, sb, C.text, { size: T.sub }); sx += capsW(cv, o.title, T.sub) + 24; }
    if (o.sub) cv.text(o.sub, sx, sb, T.cap, C.dim);
    if (o.credit !== '-') cv.text(o.credit || CREDIT, right, sb, T.credit, C.credit, { align: 'right' });
}
// keyboard: digits, three letter rows, the space row (Shift / Delete / Space / Go are named keys)
function keyBoxes(b) {
    const rows = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'], g = 10, kh = (b.h - g * 4) / 5, kw = (b.w - g * 9) / 10, out = [];
    rows.forEach((s, j) => {
        const ky = b.y + j * (kh + g);
        if (j < 2) [...s].forEach((ch, i) => out.push({ text: ch, x: b.x + i * (kw + g), y: ky, w: kw, h: kh }));
        else if (j === 2) [...s].forEach((ch, i) => out.push({ text: ch, x: b.x + kw / 2 + i * (kw + g), y: ky, w: kw, h: kh }));
        else {
            out.push({ text: 'Shift', kind: 'mod', x: b.x, y: ky, w: kw * 1.5 + g / 2, h: kh });
            [...s].forEach((ch, i) => out.push({ text: ch, x: b.x + kw * 1.5 + g * 1.5 + i * (kw + g), y: ky, w: kw, h: kh }));
            out.push({ text: 'Delete', kind: 'mod', x: b.x + kw * 8.5 + g * 8.5, y: ky, w: kw * 1.5 + g / 2, h: kh });
        }
    });
    const ky = b.y + 4 * (kh + g);
    out.push({ text: '-', x: b.x, y: ky, w: kw, h: kh }, { text: '.', x: b.x + kw + g, y: ky, w: kw, h: kh },
        { text: 'Space', kind: 'mod', x: b.x + (kw + g) * 2, y: ky, w: (kw + g) * 6 - g, h: kh },
        { text: 'Go', kind: 'go', x: b.x + (kw + g) * 8, y: ky, w: kw * 2 + g, h: kh });
    return out;
}
const keyText = (k, o) => (k.kind === 'go' ? o.go || 'Done' : o.shift && !k.kind && /^[a-z]$/.test(k.text) ? k.text.toUpperCase() : k.text);
function keyboard(cv, b, o) {
    keyBoxes(b).forEach((k, i) => {
        if (k.kind === 'go') cv.roundRect(k.x, k.y, k.w, k.h, 4, C.accent);
        else if (i === o.pressed) cv.roundRect(k.x, k.y, k.w, k.h, 4, C.track);
        else cv.strokeRoundRect(k.x, k.y, k.w, k.h, 4, 2, k.kind === 'mod' ? C.faint : C.edge);
        const c = k.kind === 'go' ? C.onAccent : k.kind === 'mod' ? (k.text === 'Shift' && o.shift ? C.accent : C.dim) : C.text, tx = keyText(k, o);
        if (k.kind) caps(cv, tx, k.x + k.w / 2, k.y + k.h / 2 + 9, c, { align: 'center' });
        else cv.text(tx, k.x + k.w / 2, k.y + k.h / 2 + 12, T.body - 2, c, { align: 'center' });
    });
}
// the dialog over the dimmed app area; its card and the two buttons' boxes (the generator places two teleButtons there).
// It takes every tap on its box and on the app area it dims (gpu-elements.js hitBox; iDrive 7: 84,76 1836 x 644)
function dialogLayout(area) {
    const w = Math.min(1300, area.w - 160), h = 380, x = area.x + (area.w - w) / 2, y = area.y + (area.h - h) / 2, bw = (w - 96 - 24) / 2;
    return { card: { x, y, w, h }, cancel: { x: x + 48, y: y + h - 48 - 96, w: bw, h: 96 }, ok: { x: x + 48 + bw + 24, y: y + h - 48 - 96, w: bw, h: 96 } };
}
function dialogDraw(cv, o) {
    const a = o.area || { x: 0, y: 76, w: 2880, h: 764 }, L = dialogLayout(a), k = L.card;
    cv.fillRect(a.x, a.y, a.w, a.h, withAlpha('#000000', 0.78));
    cv.fillRect(k.x, k.y, k.w, k.h, '#07080a'); cv.strokeRoundRect(k.x, k.y, k.w, k.h, 4, 2, C.edge); cv.fillRect(k.x, k.y, k.w, 5, o.danger ? C.crit : C.accent);
    caps(cv, o.title || '', k.x + 48, k.y + 80, C.text, { size: T.body });
    if (o.body) cv.text(o.body, k.x + 48, k.y + 140, T.sub, C.dim);
    if (o.body2) cv.text(o.body2, k.x + 48, k.y + 182, T.sub, C.dim);
}

const DRAW = {};
const TRY = {};

DRAW.teleValue = (cv, t, b, o) => { const right = o.align === 'right';
    value(cv, right ? b.x + b.w : b.x, b.y + o.size * 0.82, o.value, o.unit, o.size, col(o.color, C.text), right ? 'right' : 'left'); };
DRAW.teleChip = (cv, t, b, o) => chips(cv, b.x + b.w, b.y, o.items);
DRAW.teleProgress = (cv, t, b, o) => progress(cv, b.x, b.y + 24, b.w, Math.max(0, Math.min(1, +o.value || 0)), o.label, o.right, col(o.color, C.accent));
DRAW.teleEmpty = (cv, t, b, o) => empty(cv, b.x, b.y, b.w, b.h, o.icon, o.head, o.line, o.color ? col(o.color) : null);
DRAW.teleKv = (cv, t, b, o) => kv(cv, b.x, b.y, b.w, lines(o.rows), o.rowH || 60);
DRAW.teleTable = (cv, t, b, o) => table(cv, b.x, b.y, b.w, colList(o.columns), lines(o.rows), o.rowH || 72);

DRAW.teleTrend = (cv, t, b, o) => trend(cv, b.x, b.y, b.w, b.h, o);
DRAW.teleChart = (cv, t, b, o) => chart(cv, b.x + 60, b.y + 30, b.w - (isNum(o.y2Max) && o.y2Max > 0 ? 120 : 60), b.h - 70, pairs(o.points), o);
DRAW.teleBarTile = (cv, t, b, o) => barTile(cv, b.x, b.y, b.w, b.h, o);
DRAW.teleMiniTile = (cv, t, b, o) => miniTile(cv, b.x, b.y, b.w, b.h, o);
DRAW.teleField = (cv, t, b, o) => field(cv, b.x, b.y, b.w, b.h, o.text, o.label, o.focus, o.hint);
// the app's frames over the stand-in (renderer protocol 4, as the store's video element)
DRAW.teleVideo = (cv, t, b, o) => { videoBox(cv, b.x, b.y, b.w, b.h, o.text, o.quad); if (cv.video && o.show !== false && o.stream) cv.video(o.stream | 0, b.x, b.y, b.w, b.h, 0); };

DRAW.teleButton = (cv, t, b, o) => btn(cv, b.x, b.y, b.w, b.h, o.text, o.kind, o.icon, o.disabled);
DRAW.teleSeg = (cv, t, b, o) => seg(cv, b.x, b.y, b.w, b.h, items(o.items), o.sel | 0, o.disabled);
DRAW.teleToggle = (cv, t, b, o) => toggle(cv, b.x + b.w, b.y + (b.h - 62) / 2, !!o.on, o.disabled);
DRAW.teleSlider = (cv, t, b, o) => { const tr = sliderTrack(b, o); sliderDraw(cv, tr.x, b.y + b.h / 2, tr.w, fracOf(o), o.showValue === false ? null : shownValue(o), o.disabled); };

TRY.teleSeg = (cv, b, o, p) => { const n = items(o.items).length; if (!n || p.move) return false; o.sel = segAt(b.x, b.w, n, p.x); };
TRY.teleToggle = (cv, b, o, p) => { if (p.move) return false; o.on = !o.on; };
TRY.teleSlider = Object.assign((cv, b, o, p) => { sliderSet(b, o, p); }, { drag: true });

DRAW.teleRow = (cv, t, b, o) => rowDraw(cv, b, o);
DRAW.teleTile = (cv, t, b, o) => tile(cv, b.x, b.y, b.w, b.h, o.icon, o.title, o.sub, !!o.selected);
DRAW.teleAppTile = (cv, t, b, o) => appTile(cv, b.x, b.y, b.w, b.h, o);
// a list of videos (YouTube's results, Up next): the store's video list (store-widgets videoView: rows, columns, the
// first row shown; its TRY scrolls by whole rows and gives a tap as o.tap { id, part: 'video', n }) drawn as the
// Telemetry rows (redesign/phase2.js videoRow): the 16:9 picture ('key:<id>', the stand-in until it comes) with its
// duration, two lines of title, a small line, a hairline; the one playing (it.now) marked with the accent bar
DRAW.teleVideoList = (cv, t, b, o) => {
    const v = S.videoView(b, o);
    v.all.slice(v.top * v.cols, (v.top + v.n) * v.cols).forEach((it, k) => {
        const x = b.x + (k % v.cols) * (v.cw + v.gap), y = b.y + Math.floor(k / v.cols) * v.rh, th = v.rh - 20, tw = Math.round(th * 16 / 9);
        const img = it.thumb ? W.picture(it.thumb) : null;
        if (img) cv.image(img, x, y + 10, tw, th, 0); else videoBox(cv, x, y + 10, tw, th, '');
        if (it.dur) {
            const d = String(it.dur), dw = cv.textWidth(d, T.cap, { font: 'num' }) + 24;
            cv.roundRect(x + tw - 10 - dw, y + v.rh - 52, dw, 34, 3, '#000000');
            cv.text(d, x + tw - 10 - dw / 2, y + v.rh - 26, T.cap, C.text, { align: 'center', font: 'num' });
        }
        const tx = x + tw + 28, room = v.cw - tw - 28, n = W.wrap(cv, it.title, tx, y + 24, room, T.body - 4, C.text, 2);
        if (it.sub) cv.text(fit(cv, String(it.sub), room, T.cap), tx, y + 56 + Math.max(1, n) * 38, T.cap, C.dim);
        if (it.now) cv.fillRect(x - 16, y + 10, 5, th, C.accent);
        hair(cv, x, y + v.rh - 2, v.cw, '#101318');
    });
    if (v.rows > v.n) {                                           // more rows than shown: where the shown ones are
        const h = b.h * v.n / v.rows;
        cv.fillRect(b.x + b.w - 4, b.y + (b.h - h) * v.top / Math.max(1, v.rows - v.n), 4, h, C.faint);
    }
};
TRY.teleVideoList = S.TRY.videoList;

const inside = (r, p) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
// a tap flips the row's switch (anywhere on the row, as the builder's row); a seg follows the tap on it; a slider drags
// when the touch started on its slider part (o._drag, ended by the release); a tap on the label leaves it
TRY.teleRow = Object.assign((cv, b, o, p) => {
    const P = rowParts(b, o), n = items(o.items).length;
    if (o.control === 'slider') {
        const was = !!o._drag;
        if (!p.move) o._drag = p.x >= P.slider.x - 40;
        if (!o._drag) return was ? undefined : false;              // (a release that never came: drop its drag)
        sliderSet(b, o, p, P.slider); return;
    }
    if (p.move) return false;
    if (o.control === 'toggle') { o.on = !o.on; return; }
    if (o.control === 'seg' && n && inside(P.seg, p)) { o.sel = segAt(P.seg.x, P.seg.w, n, p.x); return; }
    return false;
}, { drag: true, up: (cv, b, o) => { o._drag = false; return null; } });   // null: unchanged (no extra 'change'), still a tap

DRAW.teleShell = (cv, t, b, o) => shellDraw(cv, b, o);
DRAW.teleKeyboard = (cv, t, b, o) => keyboard(cv, b, o);
DRAW.teleDialog = (cv, t, b, o) => dialogDraw(cv, o);

TRY.teleShell = (cv, b, o, p) => {
    if (p.move) return false;
    const i = shellBoxes(cv, b, o).findIndex((t) => inside(t, p));
    if (i < 0) return false;
    o.sel = i;
};
// as the store's keyboard: the key is typed at the touch (o.key = { text, n }), the release only un-presses
TRY.teleKeyboard = Object.assign((cv, b, o, p) => {
    if (p.move) return false;
    const ks = keyBoxes(b), i = ks.findIndex((k) => inside(k, p));
    if (i < 0) return false;
    const text = keyText(ks[i], o);
    if (text === 'Shift') o.shift = !o.shift;
    o.pressed = i; o.keyN = (o.keyN || 0) + 1; o.key = { text, n: o.keyN };
}, { up: (cv, b, o) => { if (o.pressed == null) return false; o.pressed = null; o.key = null; } });
TRY.teleDialog = () => false;

module.exports = { DRAW, TRY, C, T, CAPS, CREDIT, SHELL, shellBoxes, dialogLayout, keyBoxes, rowParts, items,
    caps, hair, fit, empty, videoBox };                            // the drawing helpers tele-clipgrid.js shares (controller.js: rowParts, items)
