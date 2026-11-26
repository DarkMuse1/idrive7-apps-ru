'use strict';
/*
 * A renderer app's screens on mgu-renderd - car-portable (Node 8): the builder's emulator mode is one such app, an
 * app on the car the other (it ships this file with the builder's export, renderer/). Draws a design's screens
 * (gpu.js record) with the kit's RenderClient, claims their touch area and runs the touches like the builder's Try
 * mode (gpu.js touchElement: switches, sliders, tabs… -> 'change'; taps: open another screen, back, or an app
 * event -> 'event'). The app shows its own values with set(). It gets out of the HMI's way:
 *   - a "close the app" tap                                                  -> closed ('closed', 'app')
 *   - a touch on the HMI outside the claims: the renderer hid the app      -> closed ('closed', 'touch')
 *   - its RHMI host state hidden: HOME / BACK keys, voice, any HMI navigation -> closed ('closed', 'hmi')
 *   - the host state losing focus to an HMI popup (call, warning, options) -> hidden while it is up, then back
 * The last two need bindHosts() / bindHost(): only an RHMI app hears them (the renderer can't: the HMI draws its
 * popups and screens in its own surface, and the keys go to the HMI).
 *
 *   const app = new ScreenApp(gpu, design, { view: 'id8', log });     // design: renderer/screens.json
 *   // one RHMI host state per screen (the builder's export): the HMI's BACK goes back a screen
 *   app.bindHosts({ home: rhmiApp.getByName('home'), bests: rhmiApp.getByName('bests') },
 *       { open: (name) => rhmiApp.openState(name), close: (name) => rhmiApp.closeState(name) });
 *   app.on('event', (name) => ...);  app.on('change', (element, opts) => ...);
 *   app.on('show', (name) => ...);   // a screen is about to draw its first frame: set() its values here
 *   app.set('timeReadout', { value: 4.21 });                           // any element, by name
 *
 * A screen may carry its own iDrive 7 layout, screen.id7 = { components } in iDrive 7 screen px (1920 x 720, app
 * area E.TARGETS.id7.app), elements named as in the design: on an iDrive 7 that is drawn 1:1 instead of the design
 * scaled down to the screen's width. set() reaches both.
 *
 * The iDrive controller (cars without a touchscreen): app.controller(state) with each FrontCCU
 * statusRotaryEncoderState the car sends (oap-shared/frontccu.js) - a ring moves over the controls, a press acts as a
 * finger on the one ringed (controller.js).
 */
const EventEmitter = require('events');
const { record, touchElement, elementAt, claims } = require('./gpu');
const E = require('./public/gpu-elements');
const W = require('./widgets');
const K = require('./controller');

const truthy = (v) => v === true || v === 'true' || v === 1;
const copy = (o) => JSON.parse(JSON.stringify(o));

class ScreenApp extends EventEmitter {
    constructor(gpu, project, opts) {
        super();
        opts = opts || {};
        // a builder project { states } or the export's renderer/screens.json { design, screens }
        this.gpu = gpu; this.project = project && project.screens ? { states: project.screens } : project || { states: [] };
        this.view = opts.view || 'id8'; this.log = opts.log || console;
        this.st = null;            // the screen shown (its page copy: touches and set() change it), null = closed
        this.pages = {};           // name -> page copy, kept while the app is open (back to a screen: as it was)
        this.back = [];            // without hosts: the screens a tap opened this one from
        this.paused = false;       // hidden for an HMI popup
        this.hosts = null; this.nav = null; this.up = [];   // bindHosts: host state per screen, the ones shown
        this.press = -1; this.animate = false; this.keep = null; this.anim = null; this.lastEvent = null; this.closedBy = null;
        this.drawing = false;
        // the controller: its last state, the stop ringed (controller.js spots key), ring shown, a bar being adjusted,
        // the stop pressed (released with the knob)
        this.ccu = null; this.focus = null; this.ring = false; this.adjusting = false; this.held = null;
        this.ringAt = {};          // screen name -> the stop the ring was on there (back on that screen: there again)
        if (opts.maxFps && gpu.maxFps) gpu.maxFps(opts.maxFps);    // renderer frame cap (renderd 1.1.2+, older ignore it)
        gpu.on('touch', (phase, x, y) => this._touch(phase, x, y));
        gpu.on('closed', () => this._closed('touch'));
        gpu.on('ready', () => { if (this.st) { this._place(); this._draw(); this._claim(); } });   // (re)connected
    }

    /** Show a screen (name, or a screen object: the builder) from its start; animate: demo values. */
    open(screen, animate) {
        const name = typeof screen === 'string' ? screen : screen && screen.name;
        if (typeof screen !== 'string' && screen) this.pages = {};
        const st = typeof screen === 'string' ? this._page(name) : screen && (this.pages[name] = copy(screen));
        if (!st) return false;
        this._letGo();
        this._stop();
        const from = this.st && this.st.name;
        Object.assign(this, { st, back: [], paused: false, press: -1, animate: !!animate, closedBy: null, adjusting: false });
        this.emit('show', name);       // the app sets this screen's values now: its first frame shows them, not the design's
        this._ringTo(from);
        this._place();
        this._draw(animate ? 0 : undefined);
        this._claim();
        this.gpu.show(true);
        this._run();
        return true;
    }

    /** Leave: hidden, nothing claimed, the pages' state forgotten. */
    close() {
        this._letGo();
        this._stop();
        this.gpu.show(false);
        this.st = null; this.pages = {}; this.ringAt = {}; this.back = []; this.up = []; this.paused = false;
        this._claim();
    }

    /** An HMI popup is over the app: hide it (the popup must be seen and touched), keep its state. */
    pause() {
        if (!this.st || this.paused) return;
        this._letGo();
        this.paused = true;
        this._stop();
        this.gpu.show(false);
        this._claim();
    }

    resume() {
        if (!this.st || !this.paused) return;
        this.paused = false;
        this._draw();
        this._claim();
        this.gpu.show(true);
        this._run();
    }

    /** The shown screen was edited (the builder): draw it again. Another screen: false. */
    update(st) {
        if (!this.st || !st || st.name !== this.st.name) return false;
        this.st = this.pages[st.name] = st;
        this._draw();
        this._claim();
        return true;
    }

    /**
     * The app's values: merge opts into element `name` (names are unique in a design) - in the design and in
     * every page copy, so a screen opened later shows them too. Drawn once per turn, only when something changed.
     */
    set(name, opts, screen) {         // screen: only that screen's element (names may repeat across screens)
        let changed = false;
        // arrays / objects (a chart's points) count as changed only when their content did
        const same = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
        // undefined = no value: null, which draws as '--' (page copies go through JSON, where an undefined
        // value would vanish and the element show its preview value)
        const val = (v) => (v === undefined ? null : v);
        const apply = (st) => (screen && st.name !== screen ? [] : (st.components || []).concat(st.id7 ? st.id7.components : [])).forEach((c) => {
            if (c.name !== name) return;
            c.opts = c.opts || {};
            Object.keys(opts).forEach((k) => { if (!same(c.opts[k], val(opts[k]))) { c.opts[k] = val(opts[k]); if (st === this.st) changed = true; } });
        });
        (this.project.states || []).forEach(apply);
        Object.keys(this.pages).forEach((k) => apply(this.pages[k]));
        if (changed) this._soon();
        return this;
    }

    /**
     * A picture for elements that name it 'key:<key>' (record.js makeImage; null = none): drawn again when the
     * screen shown uses it.
     */
    setImage(key, img) {
        W.setPicture(key, img);
        const ref = `key:${key}`;
        const uses = (v) => v === ref || (Array.isArray(v) && v.some((x) => x && (x.icon === ref || x.src === ref)));
        if (this.st && (this._layout().st.components || []).some((c) => c.opts && Object.keys(c.opts).some((k) => uses(c.opts[k])))) this._soon();
        return this;
    }

    /** Element `name`'s options on the shown screen (or the design). */
    get(name) {
        const find = (st) => st && (st.components || []).find((c) => c.name === name);
        const c = find(this.st && this._layout().st) || (this.project.states || []).map(find).find(Boolean);
        return c ? c.opts : undefined;
    }

    /**
     * One RHMI host state per screen (oap-sdk components, the builder's export makes them): the screen shown is
     * the host state the HMI shows - so the HMI's BACK goes back a screen and HOME closes the app. nav: the app's
     * { open(name), close(name) } (rhmiApp.openState / closeState): taps open / leave screens through the HMI.
     */
    bindHosts(hosts, nav) {
        this.hosts = hosts; this.nav = nav;
        Object.keys(hosts).forEach((name) => {
            hosts[name].on('visible', (ev) => this._hostVisible(name, truthy((ev || {}).visible)));
            hosts[name].on('focus', (ev) => {
                if (truthy((ev || {}).focus)) { this.lost = null; if (!this.st || this.st.name === name) this.resume(); return; }
                // a host the HMI leaves (another screen, BACK) loses focus too: only a popup over the screen shown
                // pauses it - the host still shown, still this screen, focus not back a moment later
                const lost = this.lost = {};
                setTimeout(() => {
                    if (this.lost === lost && this.st && this.st.name === name && this.up.indexOf(name) >= 0) this.pause();
                }, 300);
            });
        });
    }

    /**
     * One RHMI host state for all screens (or a stand-in: the builder's emulator mode): hidden -> close, shown
     * again -> open `entry` (a screen name, or a function giving one) if closed; focus lost -> pause, back -> resume.
     */
    bindHost(state, entry) {
        state.on('visible', (ev) => {
            const name = typeof entry === 'function' ? entry() : entry;
            if (!truthy((ev || {}).visible)) { if (this.st) this._closed('hmi'); } else if (!this.st && name) this.open(name);
            else this.resume();
        });
        state.on('focus', (ev) => (truthy((ev || {}).focus) ? this.resume() : this.pause()));
    }

    status() {
        return { page: this.st && this.st.name, paused: this.paused, lastEvent: this.lastEvent, closedBy: this.closedBy,
            focus: this.ring ? this.focus : null, adjusting: this.adjusting };
    }

    /**
     * The iDrive controller: one state as the car sends it (FrontCCU statusRotaryEncoderState). The first use shows the
     * ring only (on the first control under the tabs); then turn = next / previous, push N / E / S = that way, press =
     * a finger on the control until the release, a bar or slider: press, turn, press (controller.js).
     */
    controller(v) {
        const ev = K.decode(v, this.ccu);
        if (!ev) return;
        this.ccu = ev.now;
        if (!this.st || this.paused) return this._letGo();
        if (ev.release) this._letGo();
        if (!ev.d && !ev.press && !ev.tilt) return;
        const st = this._layout().st, list = K.spots(st);
        let at = list.indexOf(this._focused(list));
        if (!this.ring || at < 0) {                    // nothing happens unseen: first the ring, where it is
            if (!list.length) return;
            if (at < 0) at = Math.max(0, list.findIndex((s) => !/^tab\d/.test(s.key)));
            Object.assign(this, { focus: list[at].key, ring: true, adjusting: false });
            return this._draw();
        }
        const s = list[at], c = st.components[s.i];
        if (this.adjusting) {
            if (ev.d) { if (K.adjust(c, ev.d)) { this._draw(); this.emit('change', c.name, c.opts); } return; }
            this.adjusting = false;                    // a press or a push ends it (a push also moves on)
            this._draw();
            if (ev.press) return;
        }
        if (ev.press) {
            if (s.kind === 'value') { this.adjusting = true; return this._draw(); }
            this.held = { i: s.i, p: s.p, page: this.st };
            return this._press(s.i, 'down', s.p);
        }
        const to = ev.d ? list[Math.max(0, Math.min(list.length - 1, at + ev.d))] : ev.tilt !== 'W' ? K.toward(list, s, ev.tilt) : null;
        if (!to || to.key === this.focus) return;
        this._letGo();                                 // turned away while pressed: let go
        this.focus = to.key;
        this._reveal(st, to);
        this._draw();
    }
    /** A grid card off the rows shown: the grid scrolls to it, as a drag would (the app hears the new top; not a tap). */
    _reveal(st, to) {
        const top = K.reveal(to);
        if (top == null) return;
        const g = st.components[to.i];
        g.opts = Object.assign({}, g.opts, { top });
        const o = Object.assign({}, g.opts);
        delete o.tap;
        this.emit('change', g.name, o);
    }
    /** The ring follows the screen shown (2026-11-18, car-apps issue #37: it kept the last screen's stop - the viewer's
     *  Delete under the confirm sheet, a same-named button elsewhere): on a tab it stays there (each page has the tab
     *  bar), back on a screen it is where it was there, else on the screen's first control under the tabs. */
    _ringTo(from) {
        if (from) this.ringAt[from] = this.focus;
        const st = this._layout().st, list = K.spots(st), has = (k) => list.find((x) => x.key === k);
        const s = (/^tab\d/.test(this.focus) && has(this.focus)) || has(this.ringAt[this.st.name])
            || list.find((x) => !/^tab\d/.test(x.key)) || list[0];
        this.focus = s ? s.key : null;
        this.focusOn = null;
        if (s) this._reveal(st, s);
    }
    /** The stop the ring is on, by its key; one gone from the screen still shown (a camera enlarged: one picture, the
     *  All cameras button hidden again) -> the same element's, else the nearest to where the ring was (2026-11-15). */
    _focused(list) {
        let s = list.find((x) => x.key === this.focus);
        const was = this.focusOn;
        if (!s && was && was.page === this.st && list.length) {
            const d = (x) => Math.pow(x.r.x + x.r.w / 2 - was.c.x, 2) + Math.pow(x.r.y + x.r.h / 2 - was.c.y, 2);
            s = list.find((x) => x.i === was.i) || list.reduce((a, x) => (d(x) < d(a) ? x : a));
            this.focus = s.key;
        }
        if (s) this.focusOn = { page: this.st, i: s.i, c: { x: s.r.x + s.r.w / 2, y: s.r.y + s.r.h / 2 } };
        return s;
    }

    // ---- inside ----
    _find(name) { return (this.project.states || []).find((s) => s.kind === 'gpu' && s.name === name); }
    _page(name) {
        if (!this.pages[name]) { const st = this._find(name); if (!st) return null; this.pages[name] = copy(st); }
        return this.pages[name];
    }

    // The head unit is told by its screen: iDrive 8's 2880 x 960 (3:1), iDrive 7's 1920 x 720 (8:3).
    _hu() { return this.gpu.screen.w / this.gpu.screen.h > 2.8 ? 'id8' : 'id7'; }
    // what the shown screen draws: its iDrive 7 layout there (in that head unit's px; components shared with the page
    // copy, so touches and set() keep it), else the design
    _layout() {
        const hu = this._hu(), own = this.st && this.st[hu];
        return own ? { st: Object.assign({}, this.st, own), design: E.TARGETS[hu], area: E.TARGETS[hu].app }
            : { st: this.st, design: undefined, area: undefined };
    }

    // an own layout: 1:1 (the screen's size over the head unit's). The design: its app area fitted into the head
    // unit's, top left - iDrive 8 1:1, iDrive 7 right of the back arrow, under the title strip
    _place() {
        const g = this.gpu, hu = E.TARGETS[this._hu()];
        const k = Math.min(g.screen.w / hu.w, g.screen.h / hu.h), from = E.appArea(this.view), to = hu.app;
        if (this._layout().design) { this.scale = k; g.place({ x: 0, y: 0, w: g.screen.w, h: g.screen.h, scale: k, ox: 0, oy: 0 }); return; }
        this.scale = k * Math.min(to.w / from.w, to.h / from.h);
        g.place({ x: 0, y: 0, w: g.screen.w, h: g.screen.h, scale: this.scale,
            ox: k * to.x - from.x * this.scale, oy: k * to.y - from.y * this.scale });
    }

    _draw(time) {
        if (!this.st || this.paused || !this.gpu.ready) return;
        const l = this._layout(), rec = record(l.st, { textScale: this.scale, time, view: this.view, design: l.design, area: l.area });
        const s = this.ring && this._focused(K.spots(l.st));
        if (s) K.ring(rec, s, this.adjusting);
        this.gpu.frame(rec);
    }
    _soon() {            // set() many values in one turn: one frame
        if (this.drawing) return;
        this.drawing = true;
        setImmediate(() => { this.drawing = false; if (!this.animate) this._draw(); });
    }

    /** The touch area (gpu.js claims, design px = logical px of the placement); nothing while closed or paused. */
    _claim() { const l = this._layout(); this.gpu.claim(this.st && !this.paused ? claims(l.st, this.view, l.area) : []); }

    // animated: a frame per tick; static: one a second (the renderer hides an app silent for 3 s - and drops its claims)
    _run() {
        if (this.animate) { const t0 = Date.now(); this.anim = () => this._draw((Date.now() - t0) / 1000); this.gpu.on('tick', this.anim); }
        else this.keep = setInterval(() => this._draw(), 1000);
    }
    _stop() {
        if (this.anim) this.gpu.removeListener('tick', this.anim);
        clearInterval(this.keep);
        this.anim = this.keep = null;
    }

    _closed(why) {
        this._letGo();
        this.log.info(`screens closed (${{ touch: 'the HMI was touched', hmi: 'the HMI took over', app: 'a "close the app" tap' }[why]})`);
        if (why !== 'touch') this.gpu.show(false);  // 'touch': the renderer already hid it
        this._stop();
        this.st = null; this.pages = {}; this.ringAt = {}; this.back = []; this.up = []; this.paused = false; this.closedBy = why;
        this._claim();
        this.emit('closed', why);
    }

    // hosts: the screen shown follows the host states the HMI shows; none left (HOME, BACK out of the app) -> closed.
    // The HMI hides the old state and shows the new one in either order: wait a moment before closing.
    _hostVisible(name, on) {
        this.up = this.up.filter((n) => n !== name);
        if (on) {
            this.up.push(name);
            if (!this.st) this.open(name);
            else if (this.st.name !== name) this._show(name);
            return;
        }
        setTimeout(() => {
            if (!this.up.length) { if (this.st) this._closed('hmi'); } else if (this.st && this.st.name !== this.up[this.up.length - 1]) this._show(this.up[this.up.length - 1]);
        }, 300);
    }

    _show(name) {
        const st = this._page(name);
        if (!st) return;
        this._letGo();
        const from = this.st && this.st.name;
        this.st = st; this.press = -1; this.adjusting = false;
        this.emit('show', name);
        this._ringTo(from);
        this._place();                // (a screen with an own layout and one without place differently)
        this._draw();
        this._claim();
    }

    _touch(phase, x, y) {
        if (!this.st || this.paused) return;
        if (phase === 'down' && (this.ring || this.held)) {    // a finger: the controller's ring goes
            this._letGo();
            this.ring = this.adjusting = false;
            this._draw();
        }
        const p = { x, y }, l = this._layout(), st = l.st;
        if (phase === 'down') this.press = elementAt(st, p, l.area || E.appArea(this.view));   // (as _claim: a dialog dims that area)
        if (this.press < 0) return;
        const i = this.press;
        if (phase === 'up') this.press = -1;
        this._press(i, phase, p);
    }
    /** element i of the screen shown, touched at p (a finger, or the controller's press): its change, its tap */
    _press(i, phase, p) {
        const st = this._layout().st, c = st.components[i];
        if (!c) return;
        const r = touchElement(st, i, phase, p);
        if (r.opts) { this._draw(); this.emit('change', c.name, c.opts); }
        if (r.action) this._tap(r.action);
    }
    /** the controller's press let go (released, turned away, the screen leaving): the release on the same element */
    _letGo() {
        const h = this.held;
        this.held = null;
        if (h && this.st === h.page && !this.paused) this._press(h.i, 'up', h.p);
    }

    /** A tap's onTap: another screen of the design, back, close the app, or an app event. */
    _tap(a) {
        if (a.event) { this.lastEvent = a.event; this.emit('event', a.event); return; }
        if (a.close) return this._closed('app');     // the car app closes its RHMI host state on 'closed' too
        if (this.nav) {                               // through the HMI: its host state becomes visible -> shown
            if (a.open && this._find(a.open)) this.nav.open(a.open);
            else if (a.back && this.st) this.nav.close(this.st.name);
            return;
        }
        const name = a.back ? this.back.pop() : a.open;
        if (!name || !this._find(name)) return;
        if (a.open) this.back.push(this.st.name);
        this._show(name);
    }
}

module.exports = { ScreenApp };
