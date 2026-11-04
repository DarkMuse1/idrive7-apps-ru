'use strict';
/**
 * tokens.js - MGU Tools design tokens: the one place for colours, spacing, radii, type sizes,
 * line widths and motion (TZ 7.1). Screens and gauges take values from here instead of keeping
 * their own constants.
 *
 * The seven palette colours are the project's proposal from the TZ, not a BMW standard. Every
 * other colour is mixed from them, so changing the palette changes the whole design.
 * Sizes are in pixels of the reference surface (scale 1); layout.js scales them to the real one.
 * Node 8 compatible (runs on the head unit).
 */

const PALETTE = {
    bg: '#0B1016',          // background
    surface: '#151E29',     // cards and panels
    text: '#F3F6FA',        // primary text and values
    textDim: '#9CAEC0',     // labels, units, secondary text
    accent: '#37A8FF',      // selection, focus, the live value bar
    warn: '#FFB547',        // warning: cold engine, approaching a limit, stale data
    crit: '#FF5252',        // critical: limit reached, shift now, invalid data
};

function hex(c) {
    const n = parseInt(c.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(rgb) {
    return '#' + rgb.map((v) => ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2)).join('').toUpperCase();
}
/** a + (b - a) * t per channel */
function mix(a, b, t) {
    const x = hex(a), y = hex(b);
    return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t));
}
/** '#RRGGBB' + alpha 0..1 -> '#RRGGBBAA' (the colour format canvas.js and record.js accept) */
function alpha(c, a) {
    return c.slice(0, 7) + ('0' + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16)).slice(-2).toUpperCase();
}

const color = {
    bg: PALETTE.bg,
    surface: PALETTE.surface,
    // selected row, pressed button; kept dark enough that crit text on it stays >= 4.5:1
    surfaceRaised: mix(PALETTE.surface, PALETTE.text, 0.05),
    line: mix(PALETTE.surface, PALETTE.text, 0.14),            // dividers, card edges
    track: mix(PALETTE.surface, PALETTE.text, 0.05),           // empty part of bars and arcs (a groove on bg)
    tick: mix(PALETTE.surface, PALETTE.textDim, 0.55),         // scale ticks
    text: PALETTE.text,
    textDim: PALETTE.textDim,
    // stale values: only at value sizes (type.valueS and up; contrast ~3.9:1 is enough for large
    // text only), always next to a STALE label drawn in warn
    textMuted: mix(PALETTE.textDim, PALETTE.surface, 0.35),
    accent: PALETTE.accent,
    accentSoft: mix(PALETTE.surface, PALETTE.accent, 0.25),    // focus fill behind the focused control
    warn: PALETTE.warn,
    crit: PALETTE.crit,
    // demo: the warning colour on purpose - simulated data must never look like a normal state
    demo: PALETTE.warn,
    demoStripe: alpha(PALETTE.warn, 0.16),
};

// spacing scale: everything is a multiple of 4
const space = { xxs: 4, xs: 8, s: 12, m: 16, l: 24, xl: 32, xxl: 48 };
const radius = { s: 4, m: 8, l: 12 };
const line = { hairline: 1, thin: 2, regular: 3, bold: 6, focus: 4 };

/**
 * Type scale. size = the font size asked for (fonts.js picks the nearest baked atlas at or above
 * it); font = the atlas family. The smallest text anywhere is caption.
 */
const type = {
    caption: { size: 20, font: 'label' },
    label: { size: 24, font: 'label' },
    body: { size: 28, font: 'label' },
    title: { size: 32, font: 'bold' },
    valueS: { size: 44, font: 'num' },
    valueM: { size: 64, font: 'num' },
    valueL: { size: 96, font: 'num' },
    valueXL: { size: 150, font: 'num' },
    gear: { size: 200, font: 'gear' },
};

const minimum = {
    textPx: 20,         // no text smaller than this on the reference surface (scaled with the surface)
    targetPx: 72,       // smallest touch / focus target edge on the reference surface
};

/**
 * Motion. Smoothing is for display only (TZ 7.4): calculations always use the raw, time-stamped
 * samples. Nothing blinks faster than 2 Hz, and data loss is never animated as if it were live.
 */
const motion = {
    valueTauMs: 80,         // time constant of the needle / bar smoothing
    fadeMs: 200,            // live -> stale dimming
    maxBlinkHz: 2,
};

module.exports = { PALETTE, color, space, radius, line, type, minimum, motion, mix, alpha, hex };
