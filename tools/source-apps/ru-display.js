'use strict';
// These apps mark their own UI copy as literal. Localize that drawing boundary
// without changing values in settings, signals, diagnostics or renderer messages.
const localText = require('./ru-text');
module.exports = function localizeDisplay(ctx) {
    const make = ctx.canvas;
    ctx.canvas = function (w, h) {
        const cv = make.call(ctx, w, h), text = cv.text, width = cv.textWidth;
        // The author's Display reuses its Recorder for successive frames.
        // Wrap it once, rather than nesting another translator every frame.
        if (cv._mguTranslatedDisplay) return cv;
        cv._mguTranslatedDisplay = true;
        cv.text = function (s, x, y, size, colour, options) {
            return text.call(this, options && options.literal ? localText(s) : s, x, y, size, colour, options);
        };
        if (width) cv.textWidth = function (s, size, options) {
            return width.call(this, options && options.literal ? localText(s) : s, size, options);
        };
        return cv;
    };
};
