'use strict';
// Register only the translated app's font-resource identities before its first frame.
// The author's kit and its rendering code are unchanged.
const fonts = require('./kit/fonts');
const resources = require('./ru-fonts.json');
Object.keys(resources).forEach((family) => {
    const r = resources[family];
    r.sizes.forEach((size) => {
        const f = fonts.get(family, size);
        if (f) f.cacheKey = r.cacheKey;
    });
});
