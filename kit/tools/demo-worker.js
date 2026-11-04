'use strict';
// Desktop-only adapter. Runs the built app and its real canvas/runtime in a child
// process. No SDK, sockets, SSH, or vehicle writes are available to the app.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const stage = path.resolve(process.argv[2]);
const mode = process.argv[3] || 'demo';
if (!process.send || !fs.existsSync(path.join(stage, 'PREVIEW_ONLY_NOT_INSTALLABLE'))) {
    throw new Error('Use demo-server.js with a preview-only build');
}
delete process.env.MGU_RENDERD_FILE;
const kit = path.join(stage, 'source/javascript/kit');
const spec = JSON.parse(fs.readFileSync(path.join(kit, 'app-spec.json'), 'utf8'));
const send = (m) => { if (process.connected) process.send(m); };
const log = {};
['info', 'warn', 'error', 'debug'].forEach((k) => { log[k] = (...args) => send({ type: 'log', level: k, text: args.map(String).join(' ').slice(0, 1500) }); });
const values = {}, listeners = [], clicks = {}, loops = {}, visible = [], watches = [];
const focusListeners = [], barFocus = {}, labels = {};
const { t } = require(path.join(kit, 'i18n'));
(spec.settings || []).forEach((s) => { values[s.key] = s.default; });
values.renderer = 'software';
values.demo = mode === 'demo' ? 'on' : 'off';
const settings = {
    get: (k) => values[k], item: (k) => spec.settings.find((s) => s.key === k),
    onChange: (fn) => listeners.push(fn),
    set(k, v) { values[k] = v; listeners.forEach((fn) => fn(k, v)); },
};
const cars = [];
const carFile = require.resolve(path.join(kit, 'car'));
const Car = require(carFile);
require.cache[carFile].exports = class extends Car {
    constructor() { super(...arguments); cars.push(this); }
};
let shown = spec.screens[0].name, display, busy = false, imagePending = false;
const ui = {
    rhmi: { getByName: name => ({ on: (event, fn) => {
        if (event === 'focus') (barFocus[name] || (barFocus[name] = [])).push(fn);
    } }) }, timing: { png: 0, push: 0 },
    image: (name, cv) => display.present(name, cv, async (n, img) => {
        if (imagePending) return;
        imagePending = true;
        process.send({ type: 'frame', data: cars.length ? cars[0].data() : null, png: (Buffer.isBuffer(img) ? img : img.png()).toString('base64') }, () => { imagePending = false; });
    }),
    text: async (name, text) => { text = t(text); labels[name] = text; if (display) display.label(name, text); send({ type: 'label', name, text }); },
    cells: async () => {}, rows: async () => {}, visible: async () => {}, enabled: async () => {}, checked: async () => {},
    comp: () => null, onClick: (name, fn) => { clicks[name] = fn; },
    onVisible: (fn) => visible.push(fn), onFocus: fn => focusListeners.push(fn), isVisible: (name) => name === shown,
    open: async (name) => {
        if (!spec.screens.some(s => s.name === name)) return;
        const previous = shown; shown = name;
        visible.forEach(fn => { if (previous !== name) fn(previous, false); fn(name, true); });
        focusListeners.forEach(fn => fn(name, true));
        send({ type: 'screen', name });
    },
    close: async () => ui.open(spec.screens[0].name),
};
const blocked = () => Promise.reject(new Error('Offline preview: vehicle transport unavailable'));
// Fixtures use raw signal encodings already exercised by replay tests.
const initial = fs.readFileSync(path.join(__dirname, '../../tests/fixtures/replay/vehicle/normal.jsonl'), 'utf8')
    .trim().split('\n').map((s) => JSON.parse(s)).filter((e) => e.t === 0 && e.type === 'field');
const signals = {
    watch: async (iface, instance, handlers, logger, opts) => {
        const sub = { iface, available: mode === 'stale', shutdown() {} };
        watches.push({ iface, handlers, opts: opts || {}, sub });
        return sub;
    },
    proxy: blocked, call: blocked, set: blocked,
    hasNative: () => false,                      // (kit signals.js: no SOME/IP on the PC)
};
const theme = () => require(path.join(kit, 'themes')).theme(settings.get('theme'));
display = new (require(path.join(kit, 'display')).Display)(ui, log, spec, settings, theme);
ui.display = display;
const ctx = {
    ui, settings, spec, log, display, signals, theme, widget: null,
    dataDir: path.resolve(process.argv[4]),
    canvas: (w, h) => display.canvas(w, h),
    loop(name, fps, fn) { loops[name] = fn; return { stop() { delete loops[name]; }, kick() {} }; },
    // as kit/runtime/mgu.js: the controller and the renderer 2.x screen API (display.js). Software rendering
    // here: the kit does not run the screen, so no tab, tap or scroll comes and sheet() is false
    controller: { grab(on) { display.grab(on); }, onInput(fn) { display.onCcu = fn; } },
    onTab(fn) { display.onTab = fn; },
    onTap(fn) { display.onTap = fn; },
    sheet: (sh) => display.openSheet(sh),
    hideButton(id) { display.hideButton(id); },
    onScroll(fn) { display.onScroll = fn; },
    onLayout(fn) { display.onLayout(fn); },
};
let started;
const load = Module._load;
Module._load = function (request) {
    if (request === 'someip' || /oap-sdk/.test(request)) throw new Error('SDK is disabled in desktop preview');
    if (request === './kit/mgu' || /kit[\\/]mgu$/.test(request)) return {
        SPEC: spec, log, run(impl) { started = Promise.resolve().then(() => impl.start(ctx)); },
    };
    return load.apply(this, arguments);
};
require(path.join(stage, 'source/javascript/app.js'));
async function render() {
    if (busy) return;
    busy = true;
    try {
        if (loops[shown]) await loops[shown]();
        else {
            // A native HMI list has no canvas callback. Represent its existing items on the PC.
            const screen = spec.screens.find(s => s.name === shown);
            if (screen && screen.kind === 'menu') {
                const cv = ctx.canvas(1600, 520).clear('#0B1016');
                cv.text(screen.title || spec.title, 64, 95, 44, '#F3F6FA', { font: 'bold' });
                (screen.items || []).forEach((item, i) => cv.text(labels[item[1]] || item[2], 64, 170 + i * 70, 26, '#C4D0DE'));
                cv.text('OFFLINE · DEMO', 1536, 475, 22, '#FFB547', { align: 'right', font: 'bold' });
                await ui.image(shown + '_GFX', cv);
            }
        }
    } catch (e) { log.error(e.stack || e); } finally { busy = false; }
}
Promise.resolve(started).then(async () => {
    // Parked fixture for the game only: never disable the real parked-only setting.
    if (spec.id === 'doom' && mode === 'demo') {
        watches.filter(w => w.iface === 'de.bmw.infotainment.vehicle.Vehicle2').forEach(w => {
            w.sub.available = true;
            if (w.opts.onAvailable) w.opts.onAvailable(true);
            const feed = () => w.handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
            feed(); setInterval(feed, 2000);
        });
    }
    if (mode === 'stale') {
        watches.forEach((w) => {
            if (w.opts.onAvailable) w.opts.onAvailable(true);
            initial.filter((e) => e.iface === w.iface && w.handlers[e.field]).forEach((e) => w.handlers[e.field](e.value));
        });
        setTimeout(() => watches.forEach((w) => {
            w.sub.available = false;
            if (w.opts.onAvailable) w.opts.onAvailable(false);
        }), 2500);
    }
    await render();
    send({ type: 'ready', spec, values, mode, screen: shown, data: cars.length ? cars[0].data() : null });
    setInterval(render, 125); // 8 software PNG frames/s; HU GPU frame rate is tested separately
}).catch((e) => { log.error(e.stack || e); process.exitCode = 1; });
process.on('message', async (m) => {
    try {
        if (m.type === 'click' && clicks[m.name]) await clicks[m.name]({ row: 0 });
        else if (m.type === 'screen') await ui.open(m.name);
        else if (m.type === 'focus') {
            const screen = spec.screens.find(s => s.name === shown);
            const allowed = m.on ? [screen] : spec.screens; // late release after returning to the menu is harmless
            if (typeof m.on !== 'boolean' || !allowed.some(s => (s.buttons || []).some(b => b[0] === m.name))) throw new Error('Unknown preview control');
            (barFocus[m.name] || []).forEach(fn => fn({ value: m.on }));
        }
        else if (m.type === 'setting') {
            const s = settings.item(m.key);
            const allowed = s && (s.type === 'bool' ? [true, false] : s.type === 'choice' ? s.options.map((o) => o[0]) : s.steps);
            if (!allowed || allowed.indexOf(m.value) < 0 || ['renderer', 'demo'].indexOf(m.key) >= 0) throw new Error('Unsupported preview setting');
            settings.set(m.key, m.value);
        }
        await render();
    } catch (e) { log.error(e.stack || e); }
});
process.on('disconnect', () => process.exit());
process.on('exit', () => { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); });
