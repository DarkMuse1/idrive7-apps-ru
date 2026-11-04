'use strict';
// One owner of the kit's page-touch slots (ctx.onTab / onTap / onScroll / onLayout: one handler each for the
// whole app) for every canvas screen of the unified app: the shell's MAIN and the embedded modules' screens
// (LD_MAIN, EC_MAIN, TC_MAIN). The kit calls them only where it runs the screen (renderer 2.x with touch
// routing, mgu-render/1, full-screen layout), for the canvas screen it draws (ctx.display.screen), and only
// while that screen is shown and in front (its claims go otherwise). Here each event only goes to that
// screen's handlers - routing, no check of its own (as a standalone app gets the kit's events directly):
//   tap(x, y)          canvas px of ctx.canvas(1600, 520), on finger up (no drag)
//   scroll(dy)         a finger dragged on a page drawn with cv.scroll; returns whether the page moved,
//                      synchronously (the kit redraws on true)
//   tab(i, closed)     a page tab of the kit's header (the embedded modules' G.frame tabs)
//   layout()           where the frame goes changed: every registered screen hears it (it draws again when shown)
// Software path, the standard layout and an older renderer: the kit never calls these; the RHMI buttons and
// the controller work as before. Registering the slots is what lets the kit run the canvas screens (not a
// "chrome": false game screen: DOOM keeps the HMI's own buttons).
class TouchRouter {
    constructor(ctx, options) {
        this.ctx = ctx; this.log = (options && options.log) || ctx.log; this.screens = {}; this.closed = false;
        if (typeof ctx.onTab === 'function') ctx.onTab((i, closed) => this.tab(i, closed));
        if (typeof ctx.onTap === 'function') ctx.onTap((x, y) => this.tap(x, y));
        if (typeof ctx.onScroll === 'function') ctx.onScroll((dy) => this.scroll(dy));
        if (typeof ctx.onLayout === 'function') ctx.onLayout(() => this.layout());
    }
    /** handlers for canvas screen `name`: { tap, scroll, tab, layout } (each optional); later calls add to them. */
    screen(name, handlers) {
        const h = this.screens[name] || (this.screens[name] = {});
        Object.keys(handlers || {}).forEach((k) => { if (typeof handlers[k] === 'function') h[k] = handlers[k]; });
        return h;
    }
    shown(name) {
        const ui = this.ctx.ui || {};
        try { return !this.closed && !!(ui.isVisible && ui.isVisible(name)) && (!ui.hasFocus || ui.hasFocus(name)); } catch (e) { return false; }
    }
    /** The screen the event belongs to: the kit's current canvas screen (no display: a stand-in ctx: the one shown). */
    front() {
        if (this.closed) return null;
        const d = this.ctx.display, cur = d && d.screen && d.screen.name;
        if (cur) return this.screens[cur] ? cur : null;
        return Object.keys(this.screens).find((n) => this.shown(n)) || null;
    }
    run(kind, args) {
        const name = this.front(), h = name && this.screens[name][kind];
        if (!h) return undefined;
        try {
            const r = h.apply(null, args);
            if (r && typeof r.then === 'function') r.then(null, (e) => this.log.warn('touch ' + name + ' ' + kind + ': ' + (e && e.message || e)));
            return r;
        } catch (e) { this.log.warn('touch ' + name + ' ' + kind + ': ' + (e && e.message || e)); return undefined; }
    }
    tap(x, y) { return this.run('tap', [x, y]); }
    tab(i, closed) { return this.run('tab', [i, closed]); }
    scroll(dy) { const r = this.run('scroll', [dy]); return r === true; }
    layout() {
        Object.keys(this.screens).forEach((n) => {
            const h = this.screens[n].layout;
            if (h) try { h(); } catch (e) { this.log.warn('touch ' + n + ' layout: ' + (e && e.message || e)); }
        });
    }
    close() { this.closed = true; }
}
module.exports = TouchRouter;
