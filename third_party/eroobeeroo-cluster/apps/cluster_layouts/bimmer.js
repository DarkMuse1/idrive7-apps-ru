'use strict';
/**
 * bimmer.js - what the M and Sport layouts (layout_m.js, layout_sport.js) share to stand where bimmer-lab's Cluster
 * Themes (github.com/bimmer-lab/apps, MIT: NOTICE) put them: its texts' fonts (their sizes and baselines, from its
 * hud/fonts/*.json) and a text piece placed from one of its text widgets' boxes, so a glyph comes out the size and on
 * the line theirs does. Their texts are pre-drawn bitmaps; ours are the distance-field atlas (font.js), the same faces
 * baked by tools/bake_font.py ('wide': Michroma, 'orb': Orbitron Black, both with Barlow Medium for the small print).
 */
const C = require('./layout_common');
const BAKED = require('./font_baked');
const { smallPrint } = require('./font');

/* bimmer-lab's fonts: the font size, the baseline (px from the box's top) and the face (main: the family's own,
 * lower: its Barlow) */
const FONTS = {
    // Sport (Michroma, Barlow)
    s_scale: [27, 24, 'main'], s_speed: [74, 62, 'main'], s_gear: [70, 58, 'main'], s_val: [26, 23, 'main'], s_gl: [21, 19, 'main'],
    s_unit: [24, 22, 'lower'], s_label: [30, 24, 'lower'],
    // M (Orbitron Black, Barlow)
    m_num: [36, 28, 'main'], m_gear: [125, 96, 'main'], m_speed: [78, 61, 'main'], m_gl: [25, 21, 'main'], m_mid: [34, 27, 'main'],
    m_tyre: [25, 21, 'main'], m_label: [20, 17, 'main'], m_tiny: [26, 25, 'lower'], m_unit: [30, 28, 'lower'], m_badge: [26, 21, 'lower'],
    // (the M8's side gauges' scale numbers: Barlow)
    m_scale: [25, 20, 'lower'],
};
const BASE = 0.79;   // our glyphs' baseline, of the text layer's height (tools/bake_font.py)

/**
 * A text piece where one of bimmer-lab's text widgets is: box [x, y, w, h] (their px; y passed through Y, the
 * layout's heights to ours), their font name, align 'left' | 'center' | 'right'. The layer is as high as our font's
 * size needs, its baseline on theirs.
 */
function text(fam, key, box, font, txt, colors, align, Y) {
    const f = FONTS[font], m = BAKED[fam] || {};
    const em = f[2] === 'lower' ? (m.emLower || 0.92) : (m.em || 0.92);
    const h = Math.round(f[0] / em), y = (Y ? Y(box[1]) : box[1]) + f[1] - BASE * h;
    // (their small print is Barlow throughout: its figures and capitals too, from the family's second face)
    const sp = f[2] === 'lower' ? (typeof txt === 'function' ? (d, t) => smallPrint(txt(d, t)) : smallPrint(txt)) : txt;
    return C.text(key, box[0], Math.round(y), box[2], h, sp, colors, { align: align === 'right' ? 1 : align === 'center' ? 0.5 : 0 });
}

/** A colour role as a text's colours. */
const role = (k) => (t) => ({ color: [t[k], 1], glow: [t[k], 0] });

/* their SPEED_SCALE: the speed scale's numerals, evenly spaced */
const SPEED_SCALE = { us: [0, 20, 40, 60, 80, 100, 120, 160, 200], metric: [0, 30, 60, 90, 120, 150, 180, 250, 320] };
/** A speed (display unit) as 0..1 along a scale of evenly spaced numerals (theirs: scaleFrac). */
function scaleFrac(v, marks) {
    if (!(v > 0)) return 0;
    for (let i = 1; i < marks.length; i++) if (v <= marks[i]) return (i - 1 + (v - marks[i - 1]) / (marks[i] - marks[i - 1])) / (marks.length - 1);
    return 1;
}
/** Their red marks for a rev scale to max rpm: the red line's place and the orange dashes' start, 0..1. */
function redMarks(o, max) {
    const redFrom = Math.min(o.redline || 7000, max - 500) / max;
    return [redFrom, redFrom - 700 / max];
}
/** At the shift point now (theirs: the red line less 300 rpm). */
const shiftNow = (o, d) => C.isNum(d.rpm) && d.rpm >= (o.redline || 7000) - 300;

/* bimmer-lab's line icons (LICON_FS) by name */
const ICON = { gauge: 0, shock: 1, wheel: 2, cog: 3, stack: 4, therm: 5, fuel: 6, tyre: 7, oilcan: 8, battery: 9, bolt: 10, turbo: 11, batteryTemp: 12, torque: 13 };
/** One of their line icons in their widget's box. */
const icon = (key, x, y, w, h, name, colour) => ({ key, kind: 'licon', x, y, w, h, params: { u_icon: [ICON[name]] },
    colors: (t) => ({ color: [t[colour], 1] }) });

/** A family's small-print glyphs for a shader's own numbers: [the figure 0's code, '-', '.', a figure's advance],
 * ['-' advance, '.' advance] (glyph heights), and the glyph height px for one of bimmer-lab's fonts. */
function smallGlyphs(fam, font) {
    const m = BAKED[fam] || {}, chars = m.chars || '', adv = m.adv || [];
    const at = (ch) => chars.indexOf(smallPrint(ch));
    const f = FONTS[font] || [25];
    return { glyph: [at('0'), at('-'), at('.'), adv[at('0')] || 0.5], glyph2: [adv[at('-')] || 0.3, adv[at('.')] || 0.2], h: Math.round(f[0] / (m.emLower || 0.92)) };
}

module.exports = { FONTS, text, smallGlyphs, role, SPEED_SCALE, scaleFrac, redMarks, shiftNow, icon };
