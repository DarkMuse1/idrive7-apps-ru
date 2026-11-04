(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MguColor = factory();
}(this, function () {
    'use strict';
    // Screen-space HSV only. This is deliberately not an encoding for BMW hue fields.
    function clamp(v, low, high) { return Math.max(low, Math.min(high, v)); }
    function hue(h) { return ((h % 360) + 360) % 360; }
    function rgb(h, s, v) {
        h = hue(h); s = clamp(s, 0, 1); v = clamp(v, 0, 1);
        var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
        var sectors = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
        return sectors[Math.floor(h / 60)].map(function (n) { return Math.round((n + m) * 255); });
    }
    function hex(h, s, v) { return '#' + rgb(h, s, v).map(function (n) { return ('0' + n.toString(16)).slice(-2); }).join('').toUpperCase(); }
    var wheel = { x: 236, y: 266, radius: 143 };
    function fromPoint(x, y) {
        if (!isFinite(x) || !isFinite(y)) return null;
        var dx = x - wheel.x, dy = y - wheel.y, radius = Math.sqrt(dx * dx + dy * dy);
        if (radius > wheel.radius + 1) return null;
        return { hue: hue(330 - Math.atan2(dy, dx) * 180 / Math.PI), saturation: clamp(radius / wheel.radius, 0, 1) };
    }
    function point(h, s) { var angle = (330 - hue(h)) * Math.PI / 180; return { x: wheel.x + Math.cos(angle) * wheel.radius * s, y: wheel.y + Math.sin(angle) * wheel.radius * s }; }
    var presets = [
        { name: 'Янтарный', hue: 34, saturation: 0.8 }, { name: 'Красный', hue: 0, saturation: 1 },
        { name: 'Зелёный', hue: 137, saturation: 0.85 }, { name: 'Синий', hue: 216, saturation: 0.9 },
        { name: 'Фиолетовый', hue: 280, saturation: 0.75 }, { name: 'Белый', hue: 0, saturation: 0 }
    ];
    return { rgb: rgb, hex: hex, hue: hue, clamp: clamp, wheel: wheel, fromPoint: fromPoint, point: point, presets: presets };
}));
