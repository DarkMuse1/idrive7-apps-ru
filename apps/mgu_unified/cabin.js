(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./cabin-data'));
    else root.MguCabin = factory(root.MguCabinData);
}(this, function (asset) {
    'use strict';
    // Purely visual lighting: no relationship to BMW hue/brightness encodings.
    var base = typeof Buffer !== 'undefined' ? Buffer.from(asset.rgba, 'base64') : Uint8Array.from(atob(asset.rgba), function (c) { return c.charCodeAt(0); });
    var cached = null, lastKey = '';
    function render(rgb, brightness) {
        var key = rgb.join(',') + ':' + brightness;
        if (cached && key === lastKey) return cached;
        var out = new Uint8Array(base.length), gain = Math.pow(Math.max(0, Math.min(100, brightness)) / 100, 0.65);
        for (var i = 0; i < base.length; i += 4) {
            var r = base[i], g = base[i + 1], b = base[i + 2];
            // Magenta light is the generated asset's explicit light mask. Neutral
            // leather/metal and blue badge stay intact; recolour the spill too.
            var chroma = Math.min(r, b) - g;
            var mask = Math.max(0, Math.min(1, (chroma - 3) / 16));
            var energy = Math.max(r, b) - g;
            for (var c = 0; c < 3; c++) {
                var neutral = base[i + c] * (1 - mask) + g * mask;
                out[i + c] = Math.min(255, Math.round(neutral + rgb[c] / 255 * energy * mask * gain));
            }
            out[i + 3] = 255;
        }
        cached = { w: asset.w, h: asset.h, data: out, key: key }; lastKey = key;
        return cached;
    }
    return { render: render };
}));
