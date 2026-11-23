'use strict';
/**
 * HUD Widgets: custom widgets on the iDrive 7 windshield HUD, drawn through cluster-render.
 *
 * The center screen is the app's own page (shared/page.js, a canvas screen): the layouts with their
 * pictures, which drive mode shows which, and the settings. Each choice is saved in the app's data/settings.json
 * by the kit; the shared engine (hud.js) listens and redraws at once. It keeps running after the page is
 * closed (OAP apps stay up in the background), so the page is only needed for changes. The kit's own
 * settings list stays one tap away (the bar's All settings).
 */
const mgu = require('./kit/mgu');
const HudApp = require('./hud');
const Page = require('./page');

/** The engine, started once: by background() when the car starts the app (app.json "autostart", issue #16), or by
 * start() when it was opened first. null when it failed (nothing drawn, but the app stays up: an exit here would
 * count as a crash on the car). */
function startHud(ctx) {
    try {
        const hud = new HudApp(ctx);
        hud.start();
        process.on('exit', () => { try { hud.stop(); } catch (e) { /* exiting anyway */ } });
        return hud;
    } catch (e) {
        ctx.log.error('HUD failed to start: ' + (e && e.stack || e));
        return null;
    }
}

mgu.run({
    background(bg) {
        // "Start with the car" off: nothing drawn until the app is opened (start() then starts the engine)
        if (bg.settings.get('autoStart') === false) { bg.log.info('Start with the car is off: waiting to be opened'); return null; }
        return startHud(bg);
    },
    start(ctx) {
        const hud = ctx.background || startHud(ctx);
        if (!hud) return;
        new Page(ctx, hud, {
            title: ctx.spec.title, what: 'HUD',
            look: { name: 'Layouts', style: 'cards', tags: { daily: 'gear · clock · oil', sport: 'rev bar · temps · boost', redline: 'shift lights · shift score', minimal: 'round BMW speed', shiftonly: 'lights · gear', boost: 'boost · peak', warmup: 'oil · coolant · intake', track: 'lights · G-meter', cruise: 'range · trip', retro: 'amber digital', mview: 'rev band · km/h', vector: 'lights · now playing' } },
            tabs: ['look', 'readouts', 'position', 'colours', 'alerts', 'gmeter', 'settings'],
            settings: ['units', 'clock', 'timeZone', 'tankLitres', 'redline', 'shiftBefore', 'coldGuard', 'showClock', 'showOil', 'showCoolant', 'showBoost', 'autoStart', 'holiday', 'demo'],
            // the drive mode check's candidates this app's app.json listens to (issue #8; shared/hud.js modeDiagLines)
            modeCheck: ['HMI', 'MDrive', 'Sport2'],
        }).start();
    },
});
