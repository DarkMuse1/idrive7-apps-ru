'use strict';
/**
 * display.js - where an app's drawn screen goes.
 *
 * Apps draw each frame on ctx.canvas(W, H) (a record.js Recorder) and hand it to
 * ui.image(name, canvas). Then:
 *
 *   GPU path (mgu-renderd running): the recording goes to the renderer, which draws it on
 *   its own surface right over the app's area of the HMI screen, at display rate. ctx.loop
 *   is then paced by the renderer (one frame per screen refresh, up to 60 fps). The
 *   HMI's own image component only gets a plain background once.
 *
 *   Software path (no renderer): the recording is played into a canvas.js Canvas and handed
 *   to the HMI as a PNG, as before (a few frames per second).
 *
 * Layout (setting "layout"):
 *   full      (default) the renderer's surface covers the whole screen right of the HMI's back
 *             arrow. Up top, in the HMI's title strip, a compact header with the app's name and
 *             its page tabs (G.frame); right of it the strip is see-through, so the HMI's own
 *             status (radio station, phone signal, clock, mic, profile) shows. At the bottom a slim 48 px button bar drawn by the kit in
 *             place of the HMI's 120 px one: each label sits over the HMI button under it, so
 *             taps and controller presses land on the right one, and the HMI's focus events
 *             (Focusable=3 bar buttons) light up the button the iDrive controller is on. The
 *             page content is scaled up into everything in between.
 *   standard  the HMI's own title and bar; the renderer covers only the app's image area.
 *
 * Renderer 2.x (kit/renderd: mgu-render; also the Store's mgu-render): every app but Doom ("chrome":
 * false) asks for its own dialect, mgu-render/1 (renderd.js opts.native). An older renderer answers in
 * the first renderer's dialect and the app draws there as before (no touch, no sheets).
 *
 * Tabs: on a renderer that routes touch, the app's header and page are claimed and a tap on a tab calls
 * the app's ctx.onTab(i); the back column and the HMI's status icons still go to the HMI.
 *
 * mgu-render/1 with touch, full-screen layout: the kit runs the screen itself (own()). The header, page
 * and slim bar are claimed (a tap on a bar button presses it here, so the HMI never takes the screen
 * away), and the iDrive controller is held while the screen shows: turning moves along the page tabs, the
 * page's buttons and rows (G.button / cv.target), then the bar buttons; press opens the tab or presses the
 * button; pushed up / down / left / right goes to the nearest one that way (left with nothing there: back).
 * Settings is the header's last tab. Sheets (sheet.js: the settings, cards) are drawn over the page and
 * take the controller and touch while open (a finger drags their lists); push left goes back. A page that
 * scrolls (cv.scroll, ctx.onScroll) follows a finger and the knob. Should the renderer's foreground gate
 * not have the app in front while its screen shows, the app draws in the HMI's own image meanwhile (blocked).
 *
 * The kit runs the screen for an app written for it (_runnable): it turns its pages with ctx.onTab, or
 * takes touch on its page itself (ctx.onTap / ctx.onScroll), or has no bar button that only turns pages.
 * An older app that turns its pages with the bar's BTN_PAGE / BTN_PREV alone keeps the HMI's bar, touch
 * and controller, as with the first renderer; so does a game screen ("chrome": false: Doom's buttons are
 * the HMI's, under its picture). An app that holds the controller itself (ctx.controller.grab with
 * ctx.controller.onInput) keeps getting its events while the kit runs the screen; the kit's knob
 * navigation pauses meanwhile. Software path and standard layout: as before, none of this.
 *
 * Page touch for an app that draws its whole page itself (mgu.js ctx.onTap / ctx.onScroll):
 *   onTap(x, y)   a tap where no tab, page target (cv.target), bar button or sheet is: finger down and up
 *                 within 30 px, no drag; x, y in the app's canvas px (ctx.canvas(1600, 520): what it drew at
 *                 x, y is under the finger). As upstream, every such tap in the claimed area reaches it
 *                 (the app ignores coordinates outside its page); called on finger up.
 *   onScroll(dy)  a frame drawn with cv.scroll (true: the page; { y, bar }: a list from y down) scrolls: a
 *                 finger dragged more than 14 px up or down gives dy per move, canvas px, + = further down
 *                 (the content moves up); return true when it moved. No tap is called for a drag.
 *   While the kit runs the screen (renderer with touch routing, mgu-render/1, full-screen layout) and the
 *   screen is shown and in front, each frame claims the header, the page and the slim bar for the app
 *   (renderd.js claim, logical px); the claim is withdrawn as soon as the screen is hidden, covered (an
 *   HMI popup, the HMI's settings screen) or not in front, and by the renderer when the app goes. Other
 *   paths (software, standard layout, an older renderer): no touch reaches the app; its RHMI bar buttons
 *   and the controller work as before.
 *
 * Several canvas screens (the unified MGU Tools app): the renderer draws the one shown - the first until
 * another is, then the last one shown -, with its own bar buttons, tabs and placement; frames for the
 * others go to their HMI images (software), as before for every screen but the first.
 *
 * DEMO mark (docs/architecture.md 3): while kit/datastate.js says simulated data is shown, every frame
 * of the app's area gets the striped DEMO band (demomark.js) on top of what the app drew - in both
 * paths, on the renderer's repaints and keepalives, on sheets, and on the frame drawn in software when the
 * renderer goes away. It comes and goes with datastate at once, also for apps that draw only when
 * their data changes. The app's own recording is never changed: the mark goes on the copy that is shown.
 *
 * Times are kit/clock.js monotonic (docs/architecture.md 2 rule 7): the head unit sets its wall clock
 * after start-up, and a step back must not silence the keepalive or stretch a press flash.
 */
const { Recorder, play } = require('./record');
const { Canvas } = require('./canvas');
const { RenderClient } = require('./renderd');
const G = require('./gauges');
const { drawCredit } = require('./credits');
const datastate = require('./datastate');
const demomark = require('./demomark');
const clock = require('./clock');

// FrontCCU deflection: short / long push per direction (DREHGEBER enums as numbers)
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const PAGE = { w: 1600, h: 520 };
// bar buttons that only turn pages (Next page, Previous page)
const PAGER = ['BTN_PAGE', 'BTN_PREV'];
// px between the header (and the screen's bottom) and a page with no bar under it
const PAGE_GAP = 6;
// a frame that clears the renderer's surface to see-through (CLEAR 0)
const BLANK = new Uint32Array([1, 0]);

/* HMI geometry on the 1920 x 720 centre display (measured on the unit's HMI) */
const HMI = {
    screen: { w: 1920, h: 720 },
    img: { x: 124, y: 82, w: 1600, h: 520 },   // canvas screen's image component
    // bar buttons: from x 132, each as wide as its label + 180 px. The label's width in the HMI
    // font = our 'label' font at 40 px x 1.465 (measured: "Next page" 412, "Previous page" 507,
    // "Settings" 370 px wide)
    btn: { x: 132, pad: 180, size: 40, k: 1.465 },
    left: 84,                                   // the HMI's back arrow column (x 0..84): kept see-through
    barTop: 596,                                // top of the HMI's own button bar (its 2 px edge line; body from 600)
    colEnd: 530,                                // the back arrow column shows the HMI down to here (home, back arrow)
    headBg: '#000000',                          // the HMI's title / status strip
    status: { x: 1340, h: 76 },                 // status icons top right (notifications .. clock)
};
/* full-screen layout, in the surface's pixels (it covers the whole screen) */
const FULL = {
    headH: 80,                                  // header in the HMI's title strip
    barH: 48,                                   // slim button bar
    // part of the app's 1600 x 520 drawing shown: the tab bar (y < 38) moves to the header and
    // the side margins are trimmed a little, so the content can be scaled up further
    src: { x: 12, y: 38, w: 1576, h: 482 },
};
const LAYOUTS = ['full', 'standard'];

class Display {
    constructor(ui, log, spec, settings, themeFn) {
        this.ui = ui; this.log = log; this.spec = spec; this.settings = settings; this.theme = themeFn;
        this.gpu = null;
        this.state = null;                 // canvas screen shown by the renderer (first canvas screen)
        this.recorders = new Map();
        // the last frame sent to the renderer and when (kit/clock.js monotonic ms, as every time below: the
        // head unit sets its wall clock after start-up, and a step back must not silence the keepalive)
        this.lastWords = null; this.lastSent = 0;
        this.tickT = null; this.shownT = null; this.softDone = false;   // last renderer tick, last show (_softIfNoTick)
        this.settingsOpen = false;                   // the HMI's settings screen is open over ours (_shown)
        this.pressed = null; this.pressedT = -1e9;   // last pressed bar button or page target (flash)
        this.focused = null;                         // bar button the iDrive controller is on
        this.labels = {};                            // bar labels the app changed (ui.text)
        this.barOff = 0;                             // how far the HMI has scrolled its bar left
        this.tickHandlers = [];
        this.layoutHandlers = [];                    // ctx.onLayout: where the frame goes changed
        this.layoutKey = null;
        this.bgShown = null;
        this.place = null;
        this.frames = 0; this.jsMs = 0; this.statT = clock.now();
        this.sheet = null;                           // sheet.js page drawn over the app's (openSheet)
        this.ccuLast = null;                         // last controller state (knob counter, press, push)
        this.ownHidden = new Set();                  // more bar buttons left out where the kit runs the screen (hideButton)
        this._onTab = null; this._onTap = null; this._onScroll = null;
        this.grabbing = false;                       // the app holds the controller itself (ctx.controller.grab)
        G.onConfirm(() => { this.lastWords = null; this.tickHandlers.forEach((fn) => fn()); });   // a reset asks / runs out
        // the app's canvas screens: the renderer draws the one shown (_setScreen); the first until another is
        this.screens = (spec.screens || []).filter((s) => s.kind === 'canvas');
        this.screen = this.screens[0] || null;
        if (!this.screen) return;
        this.ui.onVisible((name, v) => {
            // the HMI's own settings screen (mgu.js tracks it where the app has one): the drawn screen gives
            // way while it is open and is drawn again when it closes (upstream 2028c5e: it covered it within
            // a second once the focus came back on every stack change, mgu.js)
            if (name === 'SETTINGS') { this.settingsOpen = !!v; this._syncVisible(); if (!v) this._lost(); return; }
            const scr = this.screens.find((x) => x.name === name);
            if (!scr) return;
            if (v && scr !== this.screen) this._setScreen(scr);
            if (scr !== this.screen) return;
            if (v) this.barOff = 0;                   // the HMI builds the screen afresh
            if (!v) this.closeSheet();
            this._syncVisible();
        });
        if (this.ui.onFocus) this.ui.onFocus((name) => { if (name === this.screen.name) { this._syncVisible(); this._lost(); } });
        settings.onChange((k) => {
            if (k === 'layout' || k === 'renderer') this.closeSheet();
            if (k === 'layout') { this._place(); this.lastWords = null; }
            if (k === 'theme') this.bgShown = null;
            if (k === 'renderer') this._mode();
        });
        datastate.onChange(() => this._demoChanged());
        this._mode();
        // slim bar: light the button the controller is on (HMI focus events) and flash on press
        this.screens.forEach((scr) => (scr.buttons || []).forEach((b) => {
            const c = ui.rhmi && ui.rhmi.getByName(b[0]);
            if (!c || !c.on) return;
            // the bar is redrawn here at once: apps that draw only when their data changes
            // (Fault Scanner) would otherwise leave the highlight behind
            // the controller is on this screen's buttons, so no popup covers it: if the HMI never said
            // "focus back" after a popup (seen after an update + HMI restart: only the bar showed until
            // Settings and back), take this as the screen having focus again
            const inFront = () => { if (this.ui._setFocus) this.ui._setFocus(scr.name, true); };
            c.on('action', () => {
                if (scr !== this.screen) return;
                inFront();
                this._syncVisible();            // a tap on the bar went to the HMI: the renderer hid us
                this.pressed = b[0]; this.pressedT = clock.now(); this._repaint();
                setTimeout(() => this._repaint(), 320);              // end of the press flash
            });
            c.on('focus', (ev) => {
                if (scr !== this.screen) return;
                if (!ev || typeof ev.value !== 'boolean') return;          // (row-only events)
                if (ev.value) { inFront(); this.focused = b[0]; this.focusTab = null; this.focusKey = 'bar:' + b[0]; this._scroll(); } else if (this.focused === b[0]) this.focused = null;
                this._repaint();
            });
        }));
    }

    /**
     * Another of the app's canvas screens is shown: the renderer draws that one from now on, with its own bar
     * buttons, tabs and placement. Nothing of the screen left goes with it (its last frame, tabs, page
     * targets, the controller's place, a sheet); its own HMI bar buttons are shown again as the kit left them.
     */
    _setScreen(scr) {
        this.closeSheet();
        this.screen = scr;
        this._btns = null; this.barOff = 0; this.focused = null; this.focusKey = null; this.focusTab = null; this.ccuLast = null;
        this.tabInfo = null; this.pageTargets = []; this.pageScroll = false; this.tabs = [];
        this.app = null; this.headMax = 0; this.hmiBarHidden = null; this.reaches = false;
        this.lastWords = null; this.layoutKey = null;
        this.log.info('display: the renderer draws screen ' + scr.name);
        if (!(this.gpu && this.gpu.ready)) { this._hmiBar(); return; }
        // the renderer still has the last screen's frame: see-through until this screen's first one (the HMI's
        // own screen shows meanwhile, never the other screen's picture)
        if (this.place) this.gpu.frame({ words: () => BLANK });
        this._place();
    }
    /** The image component a canvas screen's frames go to (build.py: its "graphic", else NAME_GFX). */
    _graphic(scr) { return scr.graphic || scr.name + '_GFX'; }

    /** ctx.onTab(fn): fn(i[, closedSheet]) opens page tab i. Set or cleared: whether the kit may run the screen follows (_runnable). */
    get onTab() { return this._onTab; }
    set onTab(fn) { this._setHandler('_onTab', fn); }
    /** ctx.onTap(fn): fn(x, y) for a tap on the page (canvas px), where the kit runs the screen (the header comment). */
    get onTap() { return this._onTap; }
    set onTap(fn) { this._setHandler('_onTap', fn); }
    /** ctx.onScroll(fn): fn(dy) scrolls a page drawn with cv.scroll (finger or the kit's knob); true when it moved. */
    get onScroll() { return this._onScroll; }
    set onScroll(fn) { this._setHandler('_onScroll', fn); }
    _setHandler(k, fn) {
        const was = this._runnable();
        this[k] = typeof fn === 'function' ? fn : null;
        if (this._runnable() !== was) this._ownChanged();
    }

    /** Start / stop the GPU path for the 'renderer' setting; wait for the socket if it isn't there yet. */
    _mode() {
        const want = (process.env.MGU_RENDERER || this.settings.get('renderer') || 'auto') !== 'software';
        if (this.poll) { clearInterval(this.poll); this.poll = null; }
        if (!want) {
            if (this.gpu) { this.closeSheet(); this.gpu.show(false); this.gpu.close(); this.gpu = null; this.place = null; this.blocked = false; this._lost(); }
            this.log.info('display: software rendering (setting)');
            return;
        }
        if (this.gpu) return;
        const file = process.env.MGU_RENDERD_FILE;       // testing: write the stream for mgu-renderd --replay
        if (file || RenderClient.available()) { this._startGpu(file); return; }
        this.log.info('display: no mgu-renderd socket - software rendering until it appears');
        this.poll = setInterval(() => {
            if (RenderClient.available()) { clearInterval(this.poll); this.poll = null; this._startGpu(); }
        }, 5000);
    }

    _startGpu(file) {
        // mgu-render/1 for every app that draws no pixel images (Doom: "chrome": false keeps the first
        // renderer's dialect, its IMAGE uploads and GRAB); MGU_RENDERD_PROTO=upstream: that dialect for all
        const native = this.screen.chrome !== false && process.env.MGU_RENDERD_PROTO !== 'upstream';
        const gpu = this.gpu = new RenderClient(this.spec.id, this.log, Object.assign({ native }, file ? { file } : {}));
        gpu.on('ready', () => { if (this.gpu !== gpu) return; this._place(); this._syncVisible(); this._grab(); });
        gpu.on('tick', () => { if (this.gpu === gpu) { this.tickT = clock.now(); this.tickHandlers.forEach((fn) => fn()); } });
        gpu.on('close', () => {
            if (this.gpu !== gpu) return;
            clearTimeout(this.frontTimer); this.blocked = false;
            this.closeSheet();                      // (the app's page comes back: _lost draws it in the HMI)
            this._lost();
        });
        gpu.on('stats', (s) => { this.gpuStats = s; });
        // mgu-render/1: the renderer shows the app only while its foreground gate has it in front. A screen
        // that stays shown here while the gate says otherwise (seen: a leftover install claiming the same
        // RHMI uuid, which the gate then ignores) is drawn in the HMI's own image until the gate agrees.
        gpu.on('state', (st) => {
            if (this.gpu !== gpu) return;
            clearTimeout(this.frontTimer);
            if (st.front) {
                if (this.blocked) { this.blocked = false; this.log.info('display: renderer has the app in front again'); this.lastWords = null; this._syncVisible(); this._grab(); this._hmiBar(); }
                return;
            }
            this.frontTimer = setTimeout(() => {
                if (this.gpu !== gpu || gpu.onScreen || this.blocked || !this._shown()) return;
                this.blocked = true;
                this.log.warn('display: the renderer does not have this app in front while its screen shows - drawing in the HMI (journalctl -u mgu-renderd says why)');
                this.closeSheet();
                this._unclaim();
                this._grab();
                this._lost();                       // (shows the HMI's bar again)
            }, 1500);
        });
        // the controller events the HMI did not get: the app's (ctx.controller.onInput) where the kit does not run the
        // screen or while the app holds the controller itself (ctx.controller.grab), else the kit's knob navigation
        gpu.on('ccu', (v) => { if (this.gpu !== gpu) return; if (this.onCcu && (!this.own() || this.grabbing)) this.onCcu(v); else this._ccu(v); });
        gpu.on('touch', (phase, x, y) => { if (this.gpu === gpu) this._touch(phase, x, y); });
        // the HMI was touched outside the claims (the renderer hid us): shown again unless that left the screen
        gpu.on('closed', () => setTimeout(() => { if (this.gpu === gpu) this._syncVisible(); }, 700));
        G.onLayerDrop((id) => { if (this.gpu) this.gpu.dropLayer(id); });
        gpu.connect();
        if (this.grabbing) gpu.grab(true);
    }

    /** the iDrive controller to this app alone while on (GPU renderer + mgu-inputgate.so needed) */
    grab(on) {
        this.grabbing = !!on;
        this._grab();
    }
    /** held: the app asked (grab), or the kit runs the screen (own) and the HMI has the controller gate */
    _grab() {
        if (!this.gpu) return;
        const gate = !this.gpu.native || !this.gpu.info || this.gpu.info.controller;
        this.gpu.grab(this.grabbing || (this.own() && gate && !process.env.MGU_NO_GRAB));
    }

    /**
     * The app lets the kit run this screen: it turns its pages through ctx.onTab or takes touch on its page itself
     * (ctx.onTap / ctx.onScroll), or has no bar button that only turns pages (BTN_PAGE, BTN_PREV). Not a game
     * screen ("chrome": false: its buttons are the HMI's, under the picture). An app written before the kit ran
     * the screen (pages turned with the bar's Next page alone) keeps the HMI's bar, touch and controller, as with
     * the first renderer: where the kit runs the screen its Next page would be left out of the bar.
     */
    _runnable() {
        if (!this.screen || this.screen.chrome === false) return false;
        if (this._onTab || this._onTap || this._onScroll) return true;
        return !(this.screen.buttons || []).some((b) => PAGER.indexOf(b[0]) >= 0);
    }
    /** Whether the kit runs the screen changed (an app's onTab, onTap, onScroll): placed again where the renderer is there. */
    _ownChanged() {
        this._btns = null;
        if (this.gpu && this.gpu.ready && this.place) { this.closeSheet(); this._place(); } else this._hmiBar();
    }
    /** The kit runs the screen: mgu-render/1 with touch, full-screen layout, an app written for it. */
    own() { return !!(this.gpu && this.gpu.ready && !this.blocked && this.gpu.native && this.gpu.touch && this.place && this.place.full && this._runnable()); }
    /** own() but for the placement, which depends on it (the bar's height): the renderer, layout and app allow it. */
    ownable() {
        const g = this.gpu;
        return !!(g && g.ready && g.native && g.touch && this.layout() === 'full' && g.screen.w === HMI.screen.w && g.screen.h === HMI.screen.h && this._runnable());
    }
    /** Settings is the header's last tab where the kit runs the screen (the app has a Settings button). */
    hasSettings() { return !!(this.screen && (this.screen.buttons || []).some((b) => b[0] === 'BTN_SETTINGS')); }
    /** The header's tabs: the app's, then Settings. { tabs, sel, badges, settings: index or -1 } */
    _tabList() {
        const base = this.tabInfo || { tabs: [], sel: -1, badges: [] };
        const tabs = (base.tabs || []).slice();
        const settings = this.own() && this.hasSettings() ? tabs.push('Settings') - 1 : -1;
        const sel = this.sheet && this.sheet.settings ? settings : this.sheet ? -1 : base.sel;
        return { tabs, sel, badges: base.badges || [], settings };
    }
    /** Open header tab i: the app's page, or the settings (Settings tab). */
    _openTab(i) {
        const tl = this._tabList();
        if (i === tl.settings) { if (!(this.sheet && this.sheet.settings)) this._click('BTN_SETTINGS'); return; }
        const closed = !!this.sheet;
        this.closeSheet();
        if (this.onTab) try { Promise.resolve(this.onTab(i, closed)).catch((e) => this.log.error('tab', e)); } catch (e) { this.log.error('tab', e); }
    }
    /**
     * What the controller's knob goes through, in order: the header's tabs, the page's targets, the bar. A
     * scrolling page is one more place, before its targets; with cv.scroll = { y, bar } (a list on the page that
     * scrolls, from y down) after the targets that end over y (the page's buttons over the list).
     */
    _ring() {
        const tl = this._tabList();
        const tabs = tl.tabs.length > 1 || tl.settings >= 0 ? tl.tabs.map((x, i) => ({ k: 'tab:' + i, tab: i })) : [];
        const scroll = this.pageScroll && this.onScroll ? [{ k: 'scroll', scroll: true }] : [];
        const tgts = (this.pageTargets || []).map((q) => ({ k: 'tgt:' + q.key, tgt: q }));
        const top = this.pageScroll && this.pageScroll.y != null ? this.pageScroll.y : -Infinity;
        const over = tgts.filter((p) => p.tgt.y + p.tgt.h <= top);
        return tabs.concat(over, scroll, tgts.filter((p) => over.indexOf(p) < 0), this.buttons().map((b) => ({ k: 'bar:' + b.id, bar: b.id })));
    }
    /** HMI back (the controller pushed left): the app's screen closes as with the HMI's back arrow. */
    _back() {
        this.log.info('display: back (controller pushed left)');
        Promise.resolve(this.ui.close && this.ui.close(this.screen.name)).catch((e) => this.log.warn('back: ' + e));
    }
    /** A sheet can be shown now (else the app falls back to the HMI's own screens). */
    canSheet() { return this.own() && this.active(); }

    /** Draw sheet over the page until it closes (sheet.js). false: not possible now. */
    openSheet(sheet) {
        if (!sheet || !this.canSheet()) return false;
        if (!this.sheet) this.saved = this.app;          // the app's last frame, back when the sheet closes
        this.sheetHead = false;
        this.sheet = sheet; this.sheetDown = -1;
        if (!this.sheetTimer) this.sheetTimer = setInterval(() => this._paintSheet(), 33);   // scrolling glides
        this._paintSheet();
        return true;
    }
    closeSheet() {
        if (!this.sheet) return;
        const sh = this.sheet;
        this.sheet = null; this.sheetTargets = null; this.sheetHead = false;
        if (this.sheetTimer) { clearInterval(this.sheetTimer); this.sheetTimer = null; }
        if (this.saved) { this.app = this.saved; this.saved = null; }
        this.lastWords = null;
        this._repaint();
        this.tickHandlers.forEach((fn) => fn());         // the app draws its next frame
        if (sh.onClose) try { sh.onClose(); } catch (e) { this.log.error(e); }
    }
    /** Run fn (the sheet's press, back or a target's act; from the socket's data handler) and act on what it returns. */
    _sheetResult(fn) {
        let res;
        try { res = fn(); } catch (e) { res = Promise.reject(e); }
        Promise.resolve(res).then((v) => { if (v === 'close') this.closeSheet(); else this._paintSheet(); })
            .catch((e) => { this.log.error('sheet', e); this._paintSheet(); });
    }
    _paintSheet() {
        if (!this.sheet) return;
        if (!this.active() || !this.place.full) return;
        const L = this.saved || this.app, sc = this.place.scale;
        if (!L) return;
        const r = this.sheetRec && this.sheetRec.textScale === sc ? this.sheetRec : (this.sheetRec = new Recorder(PAGE.w, PAGE.h, { textScale: sc }));
        r.reset();
        r.extra = this.place.extra || 0;
        let targets = [];
        try { targets = this.sheet.draw(r, this.theme()) || []; } catch (e) { this.log.error('sheet draw', e); }
        this.sheetTargets = targets;
        // the header keeps the app's tabs (Settings lit for the settings): a tab leaves the sheet for that page
        this.app = {
            name: L.name, softImage: L.softImage, w: r.w, h: r.h, textScale: sc, words: new Uint32Array(r.words()),
            atlases: new Set(r.atlases), ramps: new Set(r.ramps), layersUsed: new Set(r.layersUsed || []), images: new Set(r.images || []),
            chrome: true, tabs: this.tabInfo || { tabs: [], sel: -1, badges: [] }, frameTabs: null, reaches: r.extraUsed, sheet: true,
        };
        this._keepalive();
        this._send(L.name, this._compose(), L.softImage, false);
        this._claimTabs(this.chromeRec.tabRects, null);
    }

    /** Press bar button id, as the HMI does for a tap or the controller's press. */
    _click(id) {
        const c = this.ui.rhmi && this.ui.rhmi.getByName(id);
        if (!c || !c.emit) return;
        if (this.sheet && !this.sheet.keepOnBar) this.closeSheet();
        c.emit('action', {});
    }

    /** The controller (held by the kit): knob, press and push, from the renderer. */
    _ccu(v) {
        const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
        const L = this.ccuLast;
        this.ccuLast = { k, pb, df };
        if (pb === 15 && df === 15) return;              // no controller behind it
        let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
        if (Math.abs(d) > 64) d = 0;                     // a counter reset
        const down = (x) => x === 1 || x === 2;
        const press = down(pb) && !(L && down(L.pb));
        const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
        const tl = this._tabList(), here = Math.max(0, tl.sel >= 0 ? tl.sel : tl.settings);
        if (this.sheet) {
            // pushed up: the header's tabs (the knob along them, press opens one); pushed down: back to the sheet
            if (tilt === 'N' && !this.sheetHead && tl.tabs.length && (!this.sheet.top || this.sheet.top())) { this.sheetHead = true; this._focus({ k: 'tab:' + here, tab: here }); this._paintSheet(); return; }
            if (!this.sheetHead && (tilt === 'N' || tilt === 'S')) { if (this.sheet.move) this.sheet.move(tilt === 'N' ? -1 : 1); this._paintSheet(); return; }
            if (this.sheetHead) {
                if (tilt === 'S') { this.sheetHead = false; this._focus(null); this._paintSheet(); return; }
                if (tilt === 'E' || tilt === 'W') d = tilt === 'E' ? 1 : -1;
                if (d) { const i = Math.max(0, Math.min(tl.tabs.length - 1, (this.focusTab != null ? this.focusTab : here) + d)); this._focus({ k: 'tab:' + i, tab: i }); this._paintSheet(); }
                if (press && this.focusTab != null) { this.sheetHead = false; this._openTab(this.focusTab); }
                return;
            }
            if (d && this.sheet.move) { this.sheet.move(d); this._paintSheet(); }
            if (press && this.sheet.press) this._sheetResult(() => this.sheet.press());
            if (tilt === 'W' && this.sheet.back) this._sheetResult(() => this.sheet.back());
            return;
        }
        // pushed up / down / left / right: the nearest place that way; left with nothing there goes back (leaves the app)
        if (tilt) {
            const to = this._toward(tilt, here);
            if (to) { this._focus(to); this._repaint(); } else if (tilt === 'W') this._back();
            return;
        }
        // one row of places for the knob: the header's tabs, the page's buttons and rows, the bar
        const ring = this._ring();
        let i = ring.findIndex((p) => p.k === this.focusKey);
        if (d && i >= 0 && ring[i].scroll && this._scrollBy(d * 70)) return;
        if (d && ring.length) {
            // the first turn lands on the page shown (or the first place there is)
            const sel = this._tabList().sel;
            i = i < 0 ? Math.max(0, ring.findIndex((p) => p.tab === sel)) : Math.max(0, Math.min(ring.length - 1, i + d));
            this._focus(ring[i]);
            this._repaint();
        }
        if (press && i >= 0) {
            const p = ring[i];
            if (p.tab != null) this._openTab(p.tab);
            else if (p.tgt) { try { Promise.resolve(p.tgt.run()).catch((e) => this.log.error('target', e)); } catch (e) { this.log.error('target', e); } this.pressed = p.k; this.pressedT = clock.now(); this._repaint(); }
            else if (p.bar) this._click(p.bar);
        }
    }
    /** A scrolling page (ctx.onScroll) moved by dy logical px; false when it was at its end already. */
    _scrollBy(dy) {
        let moved = false;
        try { moved = !!this.onScroll(dy); } catch (e) { this.log.error('scroll', e); }
        if (moved) this.tickHandlers.forEach((fn) => fn());
        return moved;
    }
    /** Where place p of the ring is on screen (the surface's px): { x, y, w, h }. */
    _rectOf(p) {
        const pl = this.place, k = pl.scale;
        if (p.tab != null) return ((this.chromeRec && this.chromeRec.tabRects) || []).find((q) => q.i === p.tab) || null;
        if (p.tgt) return { x: p.tgt.x * k + pl.ox, y: p.tgt.y * k + pl.oy, w: p.tgt.w * k, h: p.tgt.h * k };
        if (p.bar) { const b = this.buttons().find((q) => q.id === p.bar); return b ? { x: b.x - this.barOff - pl.x, y: pl.h - this.barH(), w: b.w, h: this.barH() } : null; }
        if (p.scroll) { const hx = HMI.left - pl.x; return { x: hx, y: this.headH(), w: pl.w - hx, h: pl.h - this.barH() - this.headH() }; }
        return null;
    }
    /**
     * The place nearest the controller's one in direction dir (N, S, E, W), by the places' centres: the
     * distance that way, the sideways one counting double. Nothing focused yet: the page's tab (left: none).
     */
    _toward(dir, here) {
        const ring = this._ring().filter((p) => !p.scroll || this.focusKey === 'scroll');
        const cur = ring.find((p) => p.k === this.focusKey), cr = cur && this._rectOf(cur);
        if (!cr) return dir === 'W' ? null : ring.find((p) => p.tab === here) || ring[0] || null;
        const cx = cr.x + cr.w / 2, cy = cr.y + cr.h / 2;
        let best = null, score = Infinity;
        ring.forEach((p) => {
            if (p === cur || p.scroll) return;
            const r = this._rectOf(p);
            if (!r) return;
            const dx = r.x + r.w / 2 - cx, dy = r.y + r.h / 2 - cy;
            const ahead = dir === 'E' ? dx : dir === 'W' ? -dx : dir === 'S' ? dy : -dy, side = dir === 'E' || dir === 'W' ? Math.abs(dy) : Math.abs(dx);
            if (ahead <= 4) return;
            const sc = ahead + 2 * side;
            if (sc < score) { score = sc; best = p; }
        });
        return best;
    }
    /** The controller is on place p of the ring (null: nowhere). */
    _focus(p) {
        this.focusKey = p ? p.k : null;
        this.focusTab = p && p.tab != null ? p.tab : null;
        this.focused = p && p.bar ? p.bar : null;
        if (this.focused) this._scroll();
    }

    /**
     * Touch (logical px): a tap (down and up on the same thing) on a tab opens its page; with the kit
     * running the screen also on a bar button (pressed), a sheet's targets, or the page (ctx.onTap).
     */
    _touch(phase, x, y) {
        if(phase===1)this.rangeTouch=null;
        if(this.rangeTouch&&!this.own()){this.rangeTouch=null;return;}
        const inside = (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
        if (this.own()) {
            if(this.rangeTouch){
                const captured=(this.pageTargets||[]).find(t=>t.key===this.rangeTouch);
                if(phase===3||phase!==2)this.rangeTouch=null;
                if(captured&&typeof captured.drag==='function'&&(phase===2||phase===3)){
                    try{Promise.resolve(captured.drag(x,y,phase)).catch(e=>this.log.error('range',e));}catch(e){this.log.error('range',e);}
                }
                return;
            }
            const pl = this.place, sx = x * pl.scale + pl.ox, sy = y * pl.scale + pl.oy;
            const bar = sy >= pl.h - this.barH() ? this.buttons().find((b) => sx >= b.x - this.barOff - pl.x && sx < b.x - this.barOff - pl.x + b.w) : null;
            // the header's tabs (Settings among them) work over a sheet too
            const tab = !bar && (this.tabs || []).find(inside);
            const tgt = !bar && !tab && !this.sheet ? (this.pageTargets || []).find(inside) : null;
            const key = bar ? 'bar:' + bar.id : tab ? 'tab:' + tab.i : tgt ? 'tgt:' + tgt.key : this.sheet ? 'sheet:' + (this.sheetTargets || []).findIndex(inside) : null;
            if(phase===1&&tgt&&typeof tgt.drag==='function'){
                this.rangeTouch=tgt.key;this.ownDown=null;this.downAt=null;this.dragging=false;
                this._focus({k:key,tgt});
                try{Promise.resolve(tgt.drag(x,y,phase)).catch(e=>this.log.error('range',e));}catch(e){this.log.error('range',e);}
                return;
            }
            if (phase === 3 && this.dragging && !this.sheet) { this.dragging = false; this.ownDown = null; return; }
            if (phase === 3 && !this.dragging && key && key === this.ownDown && (tab || tgt)) {
                this.ownDown = null;
                if (tab) this._openTab(tab.i);
                else {
                    this.pressed = key; this.pressedT = clock.now(); this._repaint();
                    setTimeout(() => this._repaint(), 320);
                    try { Promise.resolve(tgt.run()).catch((e) => this.log.error('target', e)); } catch (e) { this.log.error('target', e); }
                }
                return;
            }
            // a finger moved on a sheet: its list follows (no tap then)
            if (phase === 1) { this.ownDown = key; this.downAt = { x, y }; this.lastY = y; this.dragging = false; } else if (phase === 2) {
                if (!this.sheet && this.pageScroll && this.onScroll && !bar && !tab && this.downAt) {
                    if (!this.dragging && Math.abs(y - this.downAt.y) > 14) this.dragging = true;
                    if (this.dragging) this._scrollBy(this.lastY - y);
                }
                if (this.sheet && this.sheet.scroll && !bar && this.downAt) {
                    if (!this.dragging && Math.abs(y - this.downAt.y) > 14) this.dragging = true;
                    if (this.dragging) { this.sheet.scroll(this.lastY - y); this._paintSheet(); }
                }
                this.lastY = y;
            } else if (phase === 3) {
                const was = this.ownDown;
                this.ownDown = null;
                if (this.dragging) { this.dragging = false; if (this.sheet && this.sheet.release) this.sheet.release(); return; }
                if (bar && was === key) { this._click(bar.id); return; }
                if (this.sheet) {
                    const i = (this.sheetTargets || []).findIndex(inside);
                    if (i >= 0 && was === key) this._sheetResult(() => this.sheetTargets[i].act());
                    return;
                }
                if (was && was.indexOf('bar:') === 0) return;
            }
            if (bar || this.sheet || tab || tgt) return;
        }
        const at = (this.tabs || []).find(inside);
        // a tap not on a tab (bar / target / sheet taps returned above): the app's ctx.onTap, in canvas px,
        // exactly as upstream - no page-area restriction of our own (the app ignores coordinates it doesn't use)
        if (!at && this.onTap && this.own() && phase === 3 && this.downAt && Math.abs(x - this.downAt.x) < 30 && Math.abs(y - this.downAt.y) < 30) {
            Promise.resolve().then(() => this.onTap(x, y)).catch((e) => this.log.error('tap', e));
        }
        if (phase === 1) this.tabDown = at ? at.i : -1;
        else if (phase === 3) {
            const i = this.tabDown;
            this.tabDown = -1;
            if (at && at.i === i && this.onTab) Promise.resolve().then(() => this.onTab(i)).catch((e) => this.log.error('tab', e));
        }
    }

    /** The tabs of the frame just sent (rects in logical px, or in the surface's for the header). */
    _claimTabs(rects, r) {
        const pl = this.place;
        if (!pl || !this.gpu) return;
        const logical = (q) => (r ? q : { i: q.i, x: (q.x - pl.ox) / pl.scale, y: (q.y - pl.oy) / pl.scale, w: q.w / pl.scale, h: q.h / pl.scale });
        this.tabs = (rects || []).map(logical);
        const W = pl.w, hx = HMI.left - pl.x, by = pl.h - this.barH();
        if (this.own()) {
            // header (tabs), page and the slim bar: the back column and the status corner stay the HMI's
            // (headEnd: where the header drawn last ends; none drawn yet: no header part)
            const he = this.headEnd != null ? this.headEnd : hx;
            this.gpu.claim([{ x: hx, y: 0, w: he - hx, h: this.headH() }, { x: hx, y: this.headH(), w: W - hx, h: pl.h - this.headH() }].map(logical));
            return;
        }
        // tabs by touch where the kit does not run the screen (an app that opens its tabs itself)
        if (!this.onTab || this.tabs.length < 2) { this.gpu.claim([]); return; }
        this.gpu.claim(r ? [{ x: 0, y: 0, w: r.w, h: r.h }]
            : [{ x: hx, y: 0, w: this.headEnd - hx, h: this.headH() }, { x: hx, y: this.headH(), w: W - hx, h: by - this.headH() }].map(logical));
    }

    /** GPU path gone (or off): the HMI's own image shows again - push a frame now. */
    _lost() {
        this.lastWords = null; this.bgShown = null;
        this.ui._invalidate && this.ui._invalidate();
        // the HMI's image still shows the plain background: draw the last frame there at once
        // (apps that draw only on changes would otherwise leave it blank), with the page tabs the
        // header had and the DEMO mark (RD-01: the header part is left out by software playback).
        // Where the kit runs the screen and only an HMI popup (Option, a call) covers it, the HMI's image
        // stays plain: the renderer's picture comes back when the popup goes.
        const A = this.app;
        if (A && !this.active() && this.ui.isVisible(this.screen.name)) {
            const plain = this.ownable() && !this.blocked;
            try {
                const cv = plain ? new Canvas(A.w, A.h).clear(this.theme().bg) : this._softFrame(A);
                Promise.resolve(A.softImage(A.name, cv)).catch(() => {});
            } catch (e) { this.log.warn('display: last frame ' + e); }
        }
        this._hmiBar();
        this.tickHandlers.forEach((fn) => fn());
        // apps that draw only when their data changes draw again (ctx.onLayout; none registered: nothing happens)
        this.layoutKey = null;
        this._layoutChanged();
    }

    /** The HMI's own bar buttons: hidden where the kit runs the screen (its bar, tabs and page buttons
     *  take their place), so none shows around an HMI popup; shown for every other path. */
    _hmiBar() {
        if (!this.screen) return;
        const hide = this.screen.hmiBar === false || (this.ownable() && !this.blocked);
        if (this.hmiBarHidden === hide) return;
        this.hmiBarHidden = hide;
        (this.screen.buttons || []).forEach((b) => { if (this.ui.visible) Promise.resolve(this.ui.visible(b[0], !hide)).catch(() => {}); });
    }

    /**
     * Simulated data started or ended: show the last frame again with or without the DEMO mark and ask
     * the app for a new one. Deferred a tick: datastate changes inside car.js's source switch, and the
     * app's drawing must not run in the middle of it.
     */
    _demoChanged() {
        if (this.demoPending) return;
        this.demoPending = true;
        setImmediate(() => {
            this.demoPending = false;
            this.lastWords = null;
            const A = this.app;
            try {
                if (A && this.active()) this._send(A.name, this._compose(), A.softImage, true);
                else if (A && this.ui.isVisible(this.screen.name)) Promise.resolve(A.softImage(A.name, this._softFrame(A))).catch(() => {});
            } catch (e) { this.log.warn('display: DEMO mark ' + e); }
            this.tickHandlers.forEach((fn) => fn());
        });
    }

    /**
     * An app frame in software: its recording, then the page tabs if they had gone up to the
     * full-screen header (G.frame hands them over; software playback leaves the header out), then
     * the DEMO mark while simulated data is shown.
     */
    _softFrame(A) {
        const cv = new Canvas(A.w, A.h);
        play(A.words, cv);
        if (A.tabs) G.frame(cv, this.theme(), A.tabs.tabs, A.tabs.sel, A.tabs.badges);
        if (datastate.isDemo()) demomark.frame(cv, A.frameTabs || A.tabs, this.theme());
        return cv;
    }

    /** A finished Canvas (or PNG) from old code: marked on a copy, the app's canvas stays as it was. */
    _markCopy(img) {
        if (!datastate.isDemo()) return img;
        if (img && img.d instanceof Uint8Array && img.w > 0 && img.h > 0 && img.d.length === img.w * img.h * 4) {
            const cv = new Canvas(img.w, img.h);
            cv.d.set(img.d);
            return demomark.frame(cv, img.frameTabs, this.theme());
        }
        if (!this.pngWarned) { this.pngWarned = true; this.log.warn('display: a PNG frame cannot carry the DEMO mark - draw on ctx.canvas()'); }
        return img;
    }

    layout() {
        const v = this.settings.get('layout') || 'full';
        return LAYOUTS.indexOf(v) >= 0 ? v : 'full';
    }

    /** Renderer placement for the current layout. */
    _place() {
        if (!this.gpu || !this.gpu.ready) return;
        const scr = this.gpu.screen, v = this.layout();
        let pl;
        if (v === 'standard' || scr.w !== HMI.screen.w || scr.h !== HMI.screen.h) {
            pl = { x: HMI.img.x, y: HMI.img.y, w: HMI.img.w, h: HMI.img.h, scale: 1, ox: 0, oy: 0, full: false };
        } else {
            // the surface covers the whole screen, so the HMI's own bar can't show under the back
            // arrow column; the page content goes right of that column
            const w = scr.w - HMI.left, h = scr.h, src = FULL.src;
            const ah = h - this.headH() - this.barH();
            const s = Math.floor(Math.min(w / src.w, ah / src.h) * 1000) / 1000;
            pl = {
                x: 0, y: 0, w: scr.w, h, full: true,
                scale: s,
                ox: HMI.left + Math.round((w - src.w * s) / 2 - src.x * s),
                oy: Math.round(this.headH() + (ah - src.h * s) / 2 - src.y * s),
            };
            // no bar under the page (the kit's, emptied): a page that reaches down (its panels, a sheet: it reads
            // extra, logical px below the app's 520, G.panel) starts where it does over the slim bar, and its
            // panels go on down to the screen's bottom; any other stays centred (_reach picks one for each frame)
            const spare = ah - 2 * PAGE_GAP - src.h * s;
            if (!this.barH() && spare > 0) {
                const top = Math.round(this.headH() + PAGE_GAP - src.y * s);
                if (this.screen && this.screen.chrome === false) {
                    // a screen the app draws whole (a game, in screen pixels): its page right at the top
                    pl.oy = top;
                    pl.extra = Math.floor(spare / s);
                } else {
                    pl.oyMid = pl.oy;
                    pl.oyTop = Math.max(top, Math.round(this.headH() + (ah - FULL.barH - src.h * s) / 2 - src.y * s));
                    pl.extra = Math.floor((h - PAGE_GAP - pl.oyTop) / s - PAGE.h);
                    if (this.reaches) pl.oy = pl.oyTop;     // as the last frame was (it may draw in screen pixels, r.place)
                }
            }
        }
        this.place = pl;
        this.gpu.place(pl);
        this._grab();
        this._hmiBar();
        this.recorders.clear();             // text sizes depend on the scale
        // the last frame stays: the keepalive shows it until the app draws one for this placement
        this.outRec = null;
        this.lastWords = null;              // a new placement (or its dropped resources) needs a frame, the same or not
        const own = this.own();
        this.log.info('display: renderer placement ' + JSON.stringify(pl) + ' (layout ' + v + (own ? ', the kit runs the screen' : '') + ')');
        // ctx.onLayout: only a real change of the placement, of the kit running the screen or of its bar
        // (hideButton places again for every button it hides; none registered: nothing happens)
        const key = JSON.stringify([pl, own, this.screen ? this.buttons().map((b) => b.id) : []]);
        if (key !== this.layoutKey) { this.layoutKey = key; this._layoutChanged(); }
    }
    /** Apps that draw only on changes draw again: the last frame has the old layout (bar, header, place). */
    _layoutChanged() { this.layoutHandlers.forEach((fn) => { try { fn(); } catch (e) { this.log.error('layout', e); } }); }

    /** No bar under the page: one that reaches down (it read the recorder's extra) starts as over the slim bar, any other is centred. */
    _reach(reaches) {
        const pl = this.place;
        if (!pl || pl.oyTop == null) return;
        const oy = reaches ? pl.oyTop : pl.oyMid;
        if (pl.oy === oy) return;
        pl.oy = oy;
        this.gpu.place(pl);                 // (the same scale: the renderer keeps our resources)
        this.lastWords = null;              // the renderer draws the page at the new oy with the next frame
    }

    /**
     * the screen is up and not covered by an HMI popup, nor by the HMI's settings screen (it shows then,
     * not our picture; settingsOpen follows its visibility events, so a stand-in ui without them is as before)
     */
    _shown() { return this.ui.isVisible(this.screen.name) && !this.settingsOpen && (!this.ui.hasFocus || this.ui.hasFocus(this.screen.name)); }

    _syncVisible() {
        if (!this.gpu) return;
        const on = this._shown();
        if (on && !this.gpu.visible) { this.shownT = clock.now(); this.softDone = false; }
        this.gpu.show(on);
        if (on) this.lastWords = null;
        else this._unclaim();               // (the next frame shown claims again)
    }
    /** No touch for this app now (hidden, covered, not in front): its claims go (renderd.js sends nothing if it had none). */
    _unclaim() { if (this.gpu && this.gpu.claimed && this.gpu.claimed !== '[]') this.gpu.claim([]); }

    /** GPU path usable for this screen right now? */
    active(stateName) {
        return !!(this.gpu && this.gpu.ready && this.place && !this.blocked && (!stateName || stateName === this.screen.name) && this._shown());
    }

    /** The surface to draw a frame on (reused). */
    canvas(w, h) {
        const scale = this.active() ? this.place.scale : 1;
        const key = w + 'x' + h + '@' + scale;
        let r = this.recorders.get(key);
        if (!r) { r = new Recorder(w, h, { textScale: scale }); this.recorders.set(key, r); }
        r.reset();
        r.tabRects = null;
        // full-screen layout: G.frame hands its tabs to the header instead of drawing them
        r.chrome = this.active() && this.place.full && this.screen.chrome !== false ? { tabs: null } : null;
        // where the frame lands on screen (apps that draw some parts in screen pixels, r.xf)
        r.place = this.active() ? this.place : null;
        // the kit runs the screen: buttons drawn on the page (G.button) take the place of the bar's
        r.own = this.own() && this.active();
        r.extra = r.own && this.place.extra ? this.place.extra : 0;
        return r;
    }

    /**
     * Show a frame. r: Recorder (or a canvas.js Canvas / PNG buffer from old code).
     * Returns a promise like ui.image.
     */
    present(name, r, softImage) {
        if (!(r instanceof Recorder)) return softImage(name, this._markCopy(r));
        // another canvas screen's image (the app has several, this one is not shown): in software, nothing else changes
        if (this.screens.length > 1 && name !== this._graphic(this.screen) && this.screens.some((x) => this._graphic(x) === name)) {
            if (!r._cnStamped) { r.xf().noclip(); drawCredit(r, r.w - 96, 25); r._cnStamped = true; }
            return softImage(name, this._softFrame({ w: r.w, h: r.h, words: new Uint32Array(r.words()), tabs: r.chrome ? r.chrome.tabs : null, frameTabs: r.frameTabs || null }));
        }
        if (r.chrome && r.chrome.tabs) this.tabInfo = r.chrome.tabs;
        else if (r.tabInfo) this.tabInfo = r.tabInfo;
        if (!this.sheet) { this.pageTargets = r.targets || []; this.pageScroll = r.scroll && typeof r.scroll === 'object' ? r.scroll : !!r.scroll; }
        // the app's own drawing: what is shown is built from it - the renderer's frames with the header
        // and bar and the DEMO mark (also its repaints and keepalives), and the software frames (also
        // when the renderer goes, RD-01, and when the mark comes or goes). chrome: drawn for the
        // full-screen layout, where G.frame hands the page tabs (tabs) to the header.
        const frameOf = () => ({
            name, softImage, w: r.w, h: r.h, textScale: r.textScale, words: new Uint32Array(r.words()),
            atlases: new Set(r.atlases), ramps: new Set(r.ramps), layersUsed: new Set(r.layersUsed || []), images: new Set(r.images || []),
            chrome: !!r.chrome, tabs: r.chrome ? r.chrome.tabs : null, frameTabs: r.frameTabs || null, reaches: !!r.extraUsed,
        });
        // a sheet is over the page: the app's frames wait (the last one comes back when it closes)
        if (this.sheet && this.active() && this.place.full) {
            if (r.chrome) this.saved = frameOf();
            return Promise.resolve();
        }
        // Standard/software layout: keep the rightmost 96 px free for the DEMO badge.
        // Full-screen GPU layout draws it below the native status strip in _drawChrome.
        if (!(r.chrome && this.active() && this.place.full) && !r._cnStamped) {
            r.xf().noclip();
            drawCredit(r, r.w - 96, 25);
            r._cnStamped = true;
        }
        // the app's page reaches down or not (never a sheet's frame): _place starts from it
        this.reaches = !!r.extraUsed;
        const A = this.app = frameOf();
        this._keepalive();
        if (this.active()) {
            const full = this.place.full && A.chrome;
            if (!full) this._reach(A.reaches);
            this._send(name, full || datastate.isDemo() ? this._compose() : r, softImage, false);
            if (full) this._claimTabs(this.chromeRec.tabRects, null);
            else if (this.own()) this._claimTabs(null, null);
            else this._claimTabs(r.tabRects, r);
            // the HMI's own image under the renderer's surface: a plain background, once
            const t = this.theme();
            if (this.bgShown !== t.bg) {
                this.bgShown = t.bg;
                return softImage(name, new Canvas(r.w, r.h).clear(t.bg));
            }
            return Promise.resolve();
        }
        // an HMI popup covers the screen the kit runs: the HMI's image stays plain (_lost) meanwhile
        if (this.ownable() && !this.blocked && this.gpu.visible === false && this.ui.isVisible(this.screen.name)) return Promise.resolve();
        return softImage(name, this._softFrame(A));
    }

    /** Send a frame to the renderer (skipped when identical to the last one, within a second). */
    _send(name, out, softImage, force) {
        const w = out.words();
        // unchanged frame (parked car, steady values): nothing to send - but at least one a
        // second, the renderer hides an app that goes quiet for 3 s (hung app over the HMI).
        // lastWords is in bytes: compared with w.length (words) it never matched, and every app sent
        // 60 frames a second also on a static page (upstream e70df86)
        const now = clock.now();
        if (!force && this.lastWords && now - this.lastSent < 1000 && this.lastWords.length === w.byteLength && Buffer.from(w.buffer, w.byteOffset, w.byteLength).equals(this.lastWords)) return;
        this.lastSent = now;
        this.gpu.frame(out);
        this.lastWords = Buffer.from(Buffer.from(w.buffer, w.byteOffset, w.byteLength));
        this._stats();
    }

    /**
     * The app's last frame for the renderer, as it should look now: with the DEMO mark while demo, and
     * the current header and bar when it was drawn for the full-screen layout and that is the layout.
     */
    _compose() {
        const a = this.app;
        const o = this.outRec && this.outRec.w === a.w && this.outRec.h === a.h && this.outRec.textScale === a.textScale
            ? this.outRec : (this.outRec = new Recorder(a.w, a.h, { textScale: a.textScale }));
        o.reset();
        o._grow(a.words.length); o.u.set(a.words, 0); o.n = a.words.length;
        a.atlases.forEach((x) => o.atlases.add(x)); a.ramps.forEach((x) => o.ramps.add(x));
        if (a.images) a.images.forEach((x) => o.images.add(x));
        if (a.layersUsed.size) { o.layersUsed = o.layersUsed || new Set(); a.layersUsed.forEach((x) => o.layersUsed.add(x)); }
        const chrome = a.chrome && this.place && this.place.full;
        // Reserve the app header for the runtime mark; never cover the data below it.
        if (datastate.isDemo()) demomark.frame(o, a.frameTabs || a.tabs, this.theme(), !!chrome);
        o.chrome = chrome ? { tabs: a.tabs } : null;
        if (chrome) {
            this._reach(a.reaches);         // (before _drawChrome: its focus marks follow the page)
            this._drawChrome(o);
        }
        return o;
    }

    /** Header / bar changed (focus, press): show it now, without waiting for the app's next frame. */
    _repaint() {
        this.lastWords = null;
        if (!this.app || !this.app.chrome || !this.active() || !this.place.full) return;
        const oy = this.place.oy;
        try { this._send(this.app.name, this._compose(), this.app.softImage, true); } catch (e) { this.log.warn('display: repaint ' + e); }
        // the page moved (a sheet closed over a centred page): its claims and tabs follow it
        if (this.place.oy !== oy && this.chromeRec) this._claimTabs(this.chromeRec.tabRects, null);
    }

    /**
     * Apps that draw only on changes still send the renderer a frame every second (it hides an app that
     * goes quiet for 3 s): the last one, built as it should look now - never a stored copy, which could
     * be one drawn for software playback or from before the DEMO mark came or went.
     */
    _keepalive() {
        if (this.keepTimer) return;
        this.keepTimer = setInterval(() => {
            if (this.app && this.active() && clock.now() - this.lastSent >= 1000) {
                this.lastSent = clock.now();
                try { this.gpu.frame(this._compose()); } catch (e) { this.log.warn('display: keepalive ' + e); }
            }
            this._softIfNoTick();
        }, 500);
        if (this.keepTimer.unref) this.keepTimer.unref();
    }

    /**
     * Shown for 2 s and the renderer has taken no frame since (no tick): its surface may not be on screen
     * yet - the first app opened after the head unit started showed only the HMI's empty page (upstream
     * b8f3fed). The last frame goes into the HMI's own image too, once per show, built as _lost() builds it
     * (page tabs, DEMO mark: RD-01); the renderer's surface covers it when it comes.
     */
    _softIfNoTick() {
        const A = this.app;
        // A monotonic clock may start at zero; a tick in the same millisecond as show already confirms it.
        if (!A || this.softDone || !this.active() || this.shownT === null || clock.now() - this.shownT < 2000 ||
            (this.tickT !== null && this.tickT >= this.shownT)) return;
        this.softDone = true;
        this.log.info('display: no frame taken by the renderer 2 s after showing - the last frame drawn in the HMI too');
        try { Promise.resolve(A.softImage(A.name, this._softFrame(A))).catch(() => {}); } catch (e) { this.log.warn('display: last frame ' + e); }
    }

    _stats() {
        this.frames++;
        const now = clock.now();
        if (now - this.statT >= 10000) {
            const g = this.gpuStats;
            this.log.info('display: ' + Math.round(this.frames * 1000 / (now - this.statT)) + ' fps sent' +
                (g ? ', renderer ' + g.fps + ' fps, ' + (g.avgUs / 1000).toFixed(2) + ' ms per frame (max ' + (g.maxUs / 1000).toFixed(1) + ')' : ''));
            this.frames = 0; this.statT = now;
        }
    }

    /**
     * Full-screen layout: header, slim bar and the see-through status corner, appended to the
     * frame in the surface's own pixels (xf). Software playback skips this part.
     */
    _drawChrome(r) {
        const pl = this.place, t = this.theme(), W = pl.w, H = pl.h;
        const c = this.chromeRec || (this.chromeRec = new Recorder(W, H));
        c.reset();
        const tb = this.own() ? this._tabList() : r.chrome.tabs || { tabs: [], sel: -1, badges: [] };
        // compact header in the HMI strip's own black, only as wide as its name, tabs and badges:
        // right of it the HMI's strip shows through (radio station, phone signal, status icons)
        const hx = HMI.left - pl.x;
        const end = G.header(c, Object.assign({}, t, { bg: HMI.headBg }), hx, 0, HMI.status.x - pl.x - hx, FULL.headH,
            this.screen.title || this.spec.title, tb.tabs, tb.sel, tb.badges, true, true);
        // the HMI's own title is in the strip under the header: a narrower header (a sheet: no tabs) stays
        // as wide as the app's widest, so none of that title shows beside it
        if (!this.sheet) this.headMax = Math.max(this.headMax || 0, end);
        const sx = this.headEnd = Math.min(HMI.status.x - pl.x, Math.ceil(Math.max(end, this.headMax || 0)));
        if (sx > end) { c.fillRect(end, 0, sx - end, FULL.headH - 2, HMI.headBg); c.fillRect(end, FULL.headH - 2, sx - end, 2, G.withAlpha('#ffffff', 0.22)); }
        // the tab the controller is on (the kit holds it: Display._ccu)
        const ft = this.focusTab != null && (!this.sheet || this.sheetHead) && (c.tabRects || []).find((q) => q.i === this.focusTab);
        if (ft) c.strokeRoundRect(ft.x + 4, ft.y + 10, ft.w - 8, ft.h - 20, 10, 2, t.sel || t.accent);
        // the page button (or row) the controller is on, and one just pressed
        const k = pl.scale, onPage = (key) => !this.sheet && key && (this.pageTargets || []).find((q) => 'tgt:' + q.key === key);
        const flashing = clock.now() - this.pressedT < 300;
        const pt = onPage(this.focusKey), pp = flashing && onPage(this.pressed);
        if (pp) c.roundRect(pp.x * k + pl.ox, pp.y * k + pl.oy, pp.w * k, pp.h * k, (pp.r != null ? pp.r : pp.h / 2) * k, G.withAlpha(t.sel || t.accent, 0.35));
        // the controller on a page that scrolls: a frame round the page; on a list (cv.scroll = { y, bar }) its
        // scroll bar in the colour of the selection (bar: where the page drew it, so it moves with the list)
        const sb = this.focusKey === 'scroll' && !this.sheet && this.pageScroll;
        if (sb === true) c.strokeRoundRect(hx + 6, FULL.headH + 6, W - hx - 12, H - this.barH() - FULL.headH - 12, 14, 3, G.withAlpha(t.sel || t.accent, 0.8));
        else if (sb && sb.bar) c.roundRect((sb.bar.x - 2) * k + pl.ox, sb.bar.y * k + pl.oy, (sb.bar.w + 4) * k, sb.bar.h * k, (sb.bar.w / 2 + 2) * k, t.sel || t.accent);
        if (pt) c.strokeRoundRect(pt.x * k + pl.ox - 5, pt.y * k + pl.oy - 5, pt.w * k + 10, pt.h * k + 10, (pt.r != null ? pt.r : pt.h / 2) * k + 5, 3, t.sel || t.accent);
        // the strip's bottom edge continues under the see-through part
        c.fillRect(sx, 0, W - sx, FULL.headH, HMI.headBg);
        c.fillRect(sx, FULL.headH - 2, W - sx, 2, G.withAlpha('#ffffff', 0.22));
        // slim bar: each label over its HMI button
        const by = H - this.barH();
        const btns = this.buttons().map((b) => ({ id: b.id, label: b.label, x: b.x - this.barOff - pl.x, w: b.w }));
        const flash = this.pressed && flashing ? btns.findIndex((b) => b.id === this.pressed) : -1;
        const focus = btns.findIndex((b) => b.id === this.focused);
        if (btns.length && this.barH()) G.menuBar(c, t, 0, by, W, FULL.barH, btns, focus, 'slim', flash);
        // the HMI's status icons and its back arrow column (home button, back arrow) show through;
        // the column under them is covered, so the HMI's own bar doesn't show at the bottom left, nor the
        // mark the HMI draws above it when its bar is wider than the screen (eDrive's "Reset drive totals")
        c.clip(sx, 0, W - sx, HMI.status.h).clear(0).noclip();
        if (hx > 0) c.clip(0, 0, hx, HMI.colEnd - pl.y).clear(0).noclip();
        // DEMO (docs/architecture.md 3): the page's own band (demomark.frame, its top rows) is under this header,
        // so the band goes into the header row too: right of the name and tabs, clear of the HMI's status icons
        if (datastate.isDemo()) this._demoHeader(c, sx, HMI.status.x - pl.x);
        drawCredit(c, W - 18, FULL.headH + 17);
        r.xf(1, 0, 0).append(c).xf();
    }
    /** The DEMO band in the full-screen header's row from x0 to x1 (screen px); no room there: right under the header. */
    _demoHeader(c, x0, x1) {
        const room = x1 - x0 - 32, hx = HMI.left - this.place.x;
        if (room >= 140) demomark.band(c, x0 + 16, 16, Math.min(520, room), FULL.headH - 36);
        else demomark.band(c, hx, FULL.headH, this.place.w - hx, 20);
    }

    /** A bar button's text changed (ui.text): its width, and so the bar's layout, follow. */
    label(id, text) {
        if (!(this.screen && (this.screen.buttons || []).some((b) => b[0] === id))) return;
        if (this.labels[id] === String(text)) return;
        this.labels[id] = String(text);
        this._btns = null;
        this._scroll();
        this._repaint();
    }

    /**
     * Wider than the screen, the HMI scrolls its bar as little as needed to show the focused
     * button whole between x 132 and the screen's right edge (measured), and keeps that offset
     * until focus leaves the visible part again. The slim bar copies it, so each label stays over
     * the HMI button a tap lands on.
     */
    _scroll() {
        const f = this.buttons().find((b) => b.id === this.focused);
        if (!f) return;
        const right = HMI.screen.w;
        if (f.x + f.w - this.barOff > right) this.barOff = f.x + f.w - right;
        if (f.x - this.barOff < HMI.btn.x) this.barOff = f.x - HMI.btn.x;
        if (this.barOff < 0) this.barOff = 0;
    }

    /**
     * Height of the kit's slim bar: 0 for a screen with "bar": false in app.json (a game: its
     * bar buttons still exist in the HMI under the surface, for focus and taps, but aren't drawn).
     */
    barH() {
        if (this.screen && (this.screen.hmiBar === false || this.screen.bar === false || this.screen.chrome === false)) return 0;
        // the kit's bar with nothing left on it (its buttons on the page, Settings a tab): no bar
        return this.ownable() && !this.buttons().length ? 0 : FULL.barH;
    }
    /** Leave bar button id out where the kit runs the screen (the app draws it on the page there). */
    hideButton(id) {
        this.ownHidden.add(String(id)); this._btns = null;
        if (this.place) this._place();
    }
    /** Header height: 0 for "chrome": false (the app draws the whole screen itself, e.g. a game). */
    headH() { return this.screen && this.screen.chrome === false ? 0 : FULL.headH; }

    /**
     * The HMI's bar buttons in screen pixels, unscrolled: [{ id, label, x, w }]. Where the kit runs
     * the screen, the bar is its own: the page buttons are left out (the tabs, touched or pushed to
     * with the controller, turn the pages); they stay in the HMI's bar for the other paths.
     */
    buttons() {
        if (this.screen && this.screen.hmiBar === false) return [];
        const own = this.ownable();
        if (this._btns && this._btnsOwn === own) return this._btns;
        this._btnsOwn = own;
        const m = new Recorder(1, 1);
        let x = HMI.btn.x;
        this._btns = (this.screen.buttons || []).filter((b) => !own || (PAGER.indexOf(b[0]) < 0 && b[0] !== 'BTN_SETTINGS' && !this.ownHidden.has(b[0]))).map((b) => {
            const label = this.labels[b[0]] != null ? this.labels[b[0]] : String(b[1] || b[0]);
            const w = Math.round(m.textWidth(label, HMI.btn.size, { font: 'label' }) * HMI.btn.k) + HMI.btn.pad;
            const r = { id: b[0], label, x, w };
            x += w;
            return r;
        });
        return this._btns;
    }

    onTick(fn) { this.tickHandlers.push(fn); }
    /** ctx.onLayout(fn): fn() when where the frame goes changed (the renderer came or went, the kit running the screen, the layout setting). */
    onLayout(fn) { if (typeof fn === 'function') this.layoutHandlers.push(fn); }
}

module.exports = { Display, HMI, FULL };
