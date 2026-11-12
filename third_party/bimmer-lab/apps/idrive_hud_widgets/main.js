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

mgu.run({
    start(ctx) {
        require('./ru-display')(ctx);
        let hud;
        try {
            hud = new HudApp(ctx);
        } catch (e) {
            // nothing drawn, but stay up: an exit here would count as a crash on the car
            ctx.log.error('HUD failed to start: ' + (e && e.stack || e));
            return;
        }
        hud.start();
        new Page(ctx, hud, {
            title: ctx.spec.title, what: 'HUD',
            look: { name: 'Layouts', style: 'cards', tags: { daily: 'gear · clock · oil', sport: 'rev bar · temps · boost', redline: 'shift lights · shift score', minimal: 'round BMW speed', shiftonly: 'lights · gear', boost: 'boost · peak', warmup: 'oil · coolant · intake', track: 'lights · G-meter', cruise: 'range · trip', retro: 'amber digital' } },
            tabs: ['look', 'readouts', 'position', 'colours', 'alerts', 'gmeter', 'settings'],
            settings: ['units', 'clock', 'timeZone', 'tankLitres', 'redline', 'shiftBefore', 'coldGuard', 'showClock', 'showOil', 'showCoolant', 'showBoost', 'demo'],
        }).start();
        process.on('exit', () => { try { hud.stop(); } catch (e) { /* exiting anyway */ } });
    },
});
