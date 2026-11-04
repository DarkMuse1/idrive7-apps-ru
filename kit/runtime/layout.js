'use strict';
/**
 * layout.js - screen layout from the real available area (TZ 7.3) instead of a fixed canvas.
 *
 *   const L = require('./kit/layout');
 *   const p = L.plan({ width, height, safe: { top, right, bottom, left } });
 *   p.mode       'wide' (columns side by side) or 'compact' (stacked)
 *   p.scale      factor applied to token sizes (1 = the reference area of that mode)
 *   p.content    the area inside the safe insets
 *   p.regions    wide: { left, main, right }; compact: { main, strip }
 *   p.px(n)      a token size scaled to this area; p.text(token) a type size, never below the minimum
 *   p.problems   why the area is too small or invalid ([] = fine); a plan is always returned, so a
 *                bad area can never throw inside a render loop
 *
 * The area comes from the platform profile (display.app_area, safe_areas). Until a profile is
 * verified, callers pass the upstream ID7 geometry that display.js uses; nothing here assumes an
 * ID8 size. Node 8 compatible.
 */
const T = require('./tokens');

// the areas the token sizes were designed on: the upstream canvas for wide, a 3:2 area for compact
const REFERENCE = { wide: { width: 1600, height: 520 }, compact: { width: 960, height: 640 } };
const WIDE_ASPECT = 2.2;       // wider than this: side-by-side columns
const MIN_SCALE = 0.6;         // below this the design no longer fits; reported, not hidden

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);
const rect = (x, y, width, height) => ({ x, y, width: Math.max(0, width), height: Math.max(0, height) });

function plan(area, opts) {
    opts = opts || {};
    const problems = [];
    const a = area || {};
    let W = num(a.width), H = num(a.height);
    if (!(W > 0) || !(H > 0)) { problems.push('invalid area ' + JSON.stringify(area)); W = 0; H = 0; }
    const s = a.safe || {};
    const inset = (k) => { const v = num(s[k]); if (s[k] !== undefined && !(v >= 0)) problems.push('invalid safe inset ' + k); return v >= 0 ? v : 0; };
    const top = inset('top'), right = inset('right'), bottom = inset('bottom'), left = inset('left');
    const content = rect(left, top, W - left - right, H - top - bottom);
    if (W > 0 && (content.width <= 0 || content.height <= 0)) problems.push('safe insets leave no content area');

    const aspect = content.height > 0 ? content.width / content.height : 0;
    const mode = opts.mode === 'wide' || opts.mode === 'compact' ? opts.mode : (aspect >= WIDE_ASPECT ? 'wide' : 'compact');
    const ref = REFERENCE[mode];
    const scale = content.width > 0 && content.height > 0 ? Math.min(content.width / ref.width, content.height / ref.height) : 0;
    if (W > 0 && scale < MIN_SCALE) problems.push('area ' + content.width + 'x' + content.height + ' is too small for the ' + mode + ' layout (scale ' + scale.toFixed(2) + ' < ' + MIN_SCALE + ')');

    const px = (n) => Math.round(n * scale);
    const gutter = Math.max(px(T.space.l), T.space.xs);
    const regions = {};
    if (mode === 'wide') {
        // side | main | side; the main column gets half of the width
        const inner = Math.max(0, content.width - 2 * gutter);
        const side = Math.floor(inner * 0.25), main = inner - 2 * side;
        regions.left = rect(content.x, content.y, side, content.height);
        regions.main = rect(content.x + side + gutter, content.y, main, content.height);
        regions.right = rect(content.x + side + gutter + main + gutter, content.y, side, content.height);
    } else {
        // main on top, a strip of secondary values below it
        const inner = Math.max(0, content.height - gutter);
        const strip = Math.floor(inner * 0.36);
        regions.main = rect(content.x, content.y, content.width, inner - strip);
        regions.strip = rect(content.x, content.y + inner - strip + gutter, content.width, strip);
    }
    return {
        mode, scale, content, regions, gutter, problems,
        px,
        /** type size for a token ('label', 'valueL', ... or a number), never below the minimum text size */
        text: (tok) => {
            const size = typeof tok === 'number' ? tok : (T.type[tok] || T.type.body).size;
            return Math.max(T.minimum.textPx, Math.round(size * scale));
        },
        target: Math.max(T.minimum.targetPx, px(T.minimum.targetPx)),
    };
}

/**
 * Uniform fit of a source rect (an app's drawing) into a destination rect (where it is shown),
 * centred. toScreen / toCanvas convert points both ways with the same transform the drawing uses,
 * so touch coordinates and drawn positions can never disagree.
 */
function fit(src, dst) {
    const s = Math.min(dst.width / src.width, dst.height / src.height);
    const ox = dst.x + (dst.width - src.width * s) / 2 - (src.x || 0) * s;
    const oy = dst.y + (dst.height - src.height * s) / 2 - (src.y || 0) * s;
    return {
        scale: s, offsetX: ox, offsetY: oy,
        toScreen: (p) => ({ x: ox + p.x * s, y: oy + p.y * s }),
        toCanvas: (p) => ({ x: (p.x - ox) / s, y: (p.y - oy) / s }),
        /** is a screen point over the shown part of the source? */
        contains: (p) => {
            const c = { x: (p.x - ox) / s, y: (p.y - oy) / s };
            const x0 = src.x || 0, y0 = src.y || 0;
            return c.x >= x0 && c.y >= y0 && c.x < x0 + src.width && c.y < y0 + src.height;
        },
    };
}

module.exports = { plan, fit, REFERENCE, WIDE_ASPECT, MIN_SCALE };
