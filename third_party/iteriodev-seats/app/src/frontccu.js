'use strict';
/*
 * The iDrive controller for an app's renderer screens (Node 8; 2026-11-12, cars without a touchscreen): FrontCCU
 * (0xB508, instance 1) statusRotaryEncoderState - the knob's counter, its press and push - each state the car sends ->
 * fn(state), the app's ScreenApp.controller (renderer/controller.js does the rest). The app's manifest.json lists the
 * proxy (de.bmw.infotainment.controlelements.FrontCCU, instances ["1"], statusRotaryEncoderState "rs"), as
 * robertnisipeanu's DOOM on iDrive 8 and idrive7-apps on iDrive 7. The HMI acts on the same states: on the app's
 * empty RHMI host state it has nothing to move; BACK and a push left still leave the page.
 * Not there (the VM, an older car): tried again every 30 s; the touchscreen works as before.
 * 2026-11-18 (car-apps issue #37, G20 iDrive 7): the proxy's timeout as a number. iDrive 7's oap-sdk 24.x hands the
 * argument to the native waitUntilAvailable unchanged, where { timeoutMs } times out at once (Drive Recorder 2.3.6,
 * PR #9): the knob then depended on FrontCCU being known at that instant (else tried again 30 s later).
 * iDrive 8's oap-sdk 50.x takes a number or { timeoutMs }.
 */
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const IF = 'de.bmw.infotainment.controlelements.FrontCCU';
const RETRY_MS = 30000;
const LOGGED = 20;                // the first states into the app's log (what the car sends: names or numbers)

const held = [];                 // the proxies, kept: one nobody holds is collected and its states stop (1.4.0 / 1.6.0 on the car)

function watchController(fn, log) {
    let n = 0;
    const each = (v) => {
        if (n < LOGGED) { n++; log(`controller ${JSON.stringify(v)}`); }
        try { fn(v); } catch (e) { log('controller state failed:', e); }
    };
    const go = () => someipBuilders.buildAndInitTypedProxy(IF, '1', 10000)
        .then((p) => { held.push(p); return p.statusRotaryEncoderState.subscribe(each); })
        .then(() => log('controller: subscribed'))
        .catch((e) => { log('controller:', String((e && e.message) || e)); setTimeout(go, RETRY_MS); });
    go();
}

module.exports = { watchController };
