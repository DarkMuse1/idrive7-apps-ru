'use strict';
/**
 * demomark.js - the DEMO mark the runtime draws over simulated data (docs/architecture.md 3,
 * docs/design.md 4; TZ 7.4): a band of diagonal warning stripes with "DEMO - NOT CAR DATA" on a dark
 * label in the middle. display.js puts it on every frame of the app's area and mgu.js on every
 * home-screen widget picture while kit/datastate.js says simulated data is shown, so no app can
 * leave it out.
 *
 *   demomark.band(cv, x, y, w, h)   the band in that rect; cv = a record.js Recorder or a canvas.js Canvas
 *   demomark.frame(cv, tabs, theme, nativeHeader)  mandatory mark in the reserved app header
 *   demomark.widget(cv, safe)       on a widget picture, inside its safe area (app.json startWidget.safe)
 *   demomark.TEXT                   the text (English in code; i18n.t() translates it)
 *
 * Colours and proportions come from tokens.js: the band on an app frame is T.space.xl high, other
 * sizes scale from that. Each size is drawn once as a cached layer (gauges.js layer()): the GPU
 * renderer keeps it as a texture, the software path blits it. Node 8 compatible (runs on the head unit).
 */
const T = require('./tokens');
const G = require('./gauges');
const { softLayer } = require('./record');
const { t } = require('./i18n');

const TEXT = 'DEMO - NOT CAR DATA';
const SHORT = 'DEMO';
const REF_H = T.space.xl;

/** The band into a w x h layer: stripes, edges and the label. */
function draw(r, w, h) {
    const C = T.color, k = h / REF_H;
    const edge = Math.max(1, Math.round(T.line.thin * k));
    const sw = Math.max(2, Math.round(T.space.xs * k)), step = Math.max(2 * sw, Math.round(T.space.l * k));
    // opaque underneath: nothing the app drew there can read as part of the mark, or show through it
    r.fillRect(0, 0, w, h, C.bg);
    r.fillRect(0, 0, w, h, C.demoStripe);
    for (let x = -h; x < w; x += step) r.quad([[x, h], [x + h, 0], [x + h + sw, 0], [x + sw, h]], C.demo);
    r.fillRect(0, 0, w, edge, C.demo);
    r.fillRect(0, h - edge, w, edge, C.demo);
    // the text on a dark label; the short form when the long one doesn't fit the width
    const opt = { align: 'center', font: T.type.title.font, spacing: 1.5 * k };
    const size = Math.max(10, Math.round(T.type.caption.size * k)), pad = Math.round(T.space.m * k);
    let label = t(TEXT), lw = r.textWidth(label, size, opt);
    if (lw + 2 * pad > w) { label = t(SHORT); lw = r.textWidth(label, size, opt); }
    const pw = Math.min(w, Math.ceil(lw + 2 * pad));
    r.roundRect(Math.round((w - pw) / 2), edge, pw, h - 2 * edge, Math.round(T.radius.s * k), C.bg);
    r.text(label, w / 2, h / 2 + size * 0.36, size, C.demo, opt);
}

/** The band in the rect x, y, w, h of cv (a Recorder or a Canvas). Returns cv. */
function band(cv, x, y, w, h) {
    w = Math.round(w); h = Math.round(h);
    if (!(w > 0 && h > 0)) return cv;
    // text in the layer at the size it is shown at (the full-screen GPU layout scales frames up)
    const L = G.layer('demomark|' + w + 'x' + h, w, h, (r) => draw(r, w, h), cv.textScale || 1);
    if (cv.recording) cv.blit(L, x, y); else cv.blit(softLayer(L), x, y);
    return cv;
}

/** Known app headers reserve room for the mark. Legacy frames without metadata keep the band. */
function frame(cv, tabs, theme, nativeHeader) {
    if (!tabs || !theme) return band(cv, 0, G.BAR_H, cv.w, REF_H);
    // Full-screen GPU moves page tabs into native chrome, leaving this row free.
    if (nativeHeader) return band(cv, 0, 0, cv.w, REF_H);
    const width = Math.ceil(cv.textWidth(TEXT, T.type.caption.size, { align: 'center', font: T.type.title.font, spacing: 1.5 }) + 2 * T.space.m + 2 * REF_H);
    const badges = [{ text: TEXT, color: T.color.demo, minWidth: width }].concat((tabs.badges || [])
        .filter((b) => b && b.text !== SHORT && b.text !== TEXT));
    const chrome = cv.chrome;
    cv.chrome = null;
    try { G.frame(cv, theme, tabs.tabs, tabs.sel, badges); } finally { cv.chrome = chrome; }
    return band(cv, cv.w - 16 - width, 2, width, REF_H);
}

/**
 * On a home-screen widget picture: at the top of the part the HMI doesn't crop (safe = [share of the
 * width, share of the height] kept clear on each side), across the whole width.
 */
function widget(cv, safe) {
    const sy = safe && typeof safe[1] === 'number' && safe[1] >= 0 && safe[1] < 0.4 ? safe[1] : 0;
    return band(cv, 0, Math.round(cv.h * sy), cv.w, Math.max(T.space.l, Math.round(cv.h * 0.14)));
}

module.exports = { band, frame, widget, TEXT, SHORT };
