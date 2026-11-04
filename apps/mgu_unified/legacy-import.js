(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MguLegacyImport = factory();
}(this, function () {
    'use strict';
    // Import of the separate apps' settings (oap_<uid>/data/settings.json) and G-Force records,
    // delivered by the PC installer as legacy-import.json. Only keys that exist in the unified
    // schema AND hold one of the original allowed values are offered; nothing is applied without
    // an explicit choice, and the caller backs up the current files first.
    var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };
    var settingsOf = function (legacy, id) { var app = legacy.apps[id], src = app && app.settings; return src && typeof src === 'object' && !Array.isArray(src) ? src : null; };
    // The apps with the engine profile (M Vitals 2.14.0, Redline 1.9.0, Virtual Dyno 1.3.0, Warm-Up 1.5.0) save
    // "engine" with every value. Without it the file is from an older version: its old rpm default carried no
    // choice (the updated app moves it to Auto once), so it is read as Авто (0); the PC copy has no _reset_ marks.
    var ENGINE_APPS = ['car_vitals', 'redline', 'dyno', 'warmup'];
    /**
     * opts (optional): shell = the current shell settings ({ engine }), engineSettings = the allowed «Тип двигателя»
     * values, fromOldDefault(id, key, value) = Telemetry.fromOldDefault. A change of a shell setting has shell: true.
     */
    function plan(legacy, modules, schema, validRecords, currentRecords, opts) {
        opts = opts || {};
        var out = { changes: [], skipped: [], records: null, error: '', createdAt: legacy && legacy.createdAt || null };
        if (!legacy || legacy.schema !== 1 || !legacy.apps || typeof legacy.apps !== 'object' || Array.isArray(legacy.apps)) { out.error = 'Файл импорта не распознан'; return out; }
        Object.keys(schema).forEach(function (id) {
            var src = settingsOf(legacy, id);
            if (!src) return;
            var old = opts.fromOldDefault && ENGINE_APPS.indexOf(id) >= 0 && !has(src, 'engine');
            schema[id].forEach(function (f) {
                if (!has(src, f[0])) return;
                var v = old ? opts.fromOldDefault(id, f[0], src[f[0]]) : src[f[0]];
                if (f[3].indexOf(v) < 0) { out.skipped.push({ module: id, key: f[0], value: v }); return; }
                if (modules[id][f[0]] !== v) out.changes.push({ module: id, key: f[0], label: f[1], from: modules[id][f[0]], to: v });
            });
        });
        // M Vitals drew its own G circle; here the only one is G-Force's: brake on top if either app had it on
        var cv = settingsOf(legacy, 'car_vitals'), flip = out.changes.filter(function (c) { return c.module === 'gforce' && c.key === 'flipLong'; })[0];
        if (cv && cv.flipLong === true && modules.gforce && has(modules.gforce, 'flipLong')) {
            if (flip) { flip.to = true; flip.source = 'car_vitals'; if (flip.from === true) out.changes.splice(out.changes.indexOf(flip), 1); }
            else if (modules.gforce.flipLong !== true) out.changes.push({ module: 'gforce', key: 'flipLong', label: 'Торможение сверху', from: modules.gforce.flipLong, to: true, source: 'car_vitals' });
        }
        // «Тип двигателя»: one shell setting from the apps' own "engine"; Auto there is no choice, a conflict is skipped
        if (opts.shell && opts.engineSettings) {
            var chosen = [];
            ENGINE_APPS.forEach(function (id) {
                var src = settingsOf(legacy, id);
                if (!src || !has(src, 'engine')) return;
                if (opts.engineSettings.indexOf(src.engine) < 0) { out.skipped.push({ module: id, key: 'engine', value: src.engine }); return; }
                if (src.engine !== 'auto' && chosen.indexOf(src.engine) < 0) chosen.push(src.engine);
            });
            if (chosen.length > 1) out.skipped.push({ module: 'shell', key: 'engine', value: chosen.join(' / ') });
            else if (chosen.length && chosen[0] !== opts.shell.engine) out.changes.push({ shell: true, module: null, key: 'engine', label: 'Тип двигателя', from: opts.shell.engine, to: chosen[0] });
        }
        var g = legacy.apps.gforce && legacy.apps.gforce.records;
        if (g !== undefined) {
            if (!validRecords(g)) out.skipped.push({ module: 'gforce', key: 'records', value: 'invalid' });
            else {
                var merged = JSON.parse(JSON.stringify(currentRecords || {})), changed = false;
                Object.keys(g).forEach(function (k) { if (!merged[k] || g[k].v > merged[k].v) { merged[k] = { v: g[k].v, at: g[k].at }; changed = true; } });
                if (changed) out.records = merged;
            }
        }
        return out;
    }
    return { plan: plan };
}));
