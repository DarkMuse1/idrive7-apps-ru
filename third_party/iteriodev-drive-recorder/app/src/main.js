'use strict';
/*
 * oap-driverecorder-next 2.2.0: our own Drive Recorder (tile "Drive Recorder"). Research: analysis/drive-recorder.md,
 * design: docs/superpowers/specs/2026-10-31-drive-recorder-redesign-design.md, 2026-10-31-drive-recorder-export.md (2.1).
 * The parts:
 *   recorder.js  the HU's camera ring buffer (icam2proxy VideoBuffer) kept running, saves, camera DR mode (the 1.0.x
 *                logic and its history, + the DR mode at start, the views this car records)
 *   player.js    the player tool iteriodev-drplay (mgu-drplay 1.1.0, a required Store tool): clip list, playback into
 *                /dev/shm/mgu-video-drplay, thumbnails, lock / delete / Copy to USB (as recorded or one camera's MP4),
 *                oldest clips replaced over 4 GB
 *   meta.js      a clip's metadata: speed + time at the playback position
 *   ui.js        what the screens show and what a tap does (tested on its own)
 * This file wires them up (the shape of apps/oap-youtube): renderer/ (the HMI UI builder's export of
 * apps/hmi-ui-builder/projects/drive-recorder.json, mgu-render 1.2.0+ for the video) + one RHMI host state per screen
 * (BACK / HOME / popups, screenapp.js bindHosts); the HMI page "fallback" when the renderer doesn't answer; thumbnails =
 * the tool's 320x240 RGBA files (only the ones on screen kept); the frame file named to the renderer again after every reconnect
 * to the renderer or the tool; the vehicle speed (Vehicle2.statusCarSpeed2): video only while the car stands still.
 * 2.1.7: Save with a button (2.1.2, a learned FrontCCU console button) removed: on the car it never saved.
 * 2.2.0: the Telemetry design (scripts/oap-tools/make_driverec_project.js); the tabs replace each other over Record.
 * 2.3.0: iDrive 7 and iDrive 8 in one package: a source package on the shared OnlineApp host (oap-shared/online-host.js,
 * the Store's lifecycle; the unit's own oap-sdk, scripts/oap-tools/make_source_pkg.js) instead of the bundled iDrive 8
 * SDK; each screen has its own iDrive 7 layout (screenapp.js picks it by the renderer's screen).
 * 2.3.1: manifest/permissions carry what the SDK's OnlineApp start needs (Provisioning provisioningDataJSON +
 * setFilterForProvisioningData, HeartbeatMonitor registration): 2.3.0 never started on the car.
 * 2.3.6, iDrive 7 (car-tested on a G20): iDrive 7's app manager stopped the app within 2 s of every start (CPU 64-76 %
 * while it starts, cpuLimit was 10): oapAppSettings as the apps that run there (the Store, idrive7-apps: FOREGROUND,
 * CPU 60, 192 MB, 20 MB disk), ACTIVE at every start, the process's memory and CPU logged every 0.5 s for the first
 * 10 s and at shutdown; SOME/IP proxy timeouts as a number (iDrive 7's oap-sdk 24.x takes nothing else: an object
 * timed out at once); an uncaught exception's stack goes to the log and to CRASH_FILE before the SDK ends the process
 * (MainApp then wipes the data folder, the log with it); a failing screen refresh or 1 s tick is logged, not fatal;
 * iDrive 7's screens other than Record name it as their parent (ParentState in rhmiData's ID7 description, as the
 * Store's and idrive7-apps' do: without it iDrive 7's HMI answered openState with INVALID_COMPONENTID); needs the
 * player 1.1.2, which writes the provisioning lines into iDrive 7's das files.
 * 2.3.7: the camera check asks a view again while the camera ECU is still starting (iDrive 7: about 10 s after the
 * attach), instead of finding it missing: a G20 lost "All cameras" so; every car checks its cameras once more.
 * 2.3.8: the buffer's window is read again before it is started (a reset puts it back to the default: on the G20 every
 * save after a failed one failed at once), a save checks the window first and sets it up again when it is too short,
 * and a near-empty file from a failed store is not reported as a saved clip.
 * 2.3.9: the buffer's window holds the whole clip (before + after + 10 s: with before + 10 s a slow store ended in ERROR
 * 12 s in on the G20); the Drive Recorder seconds in it count from when the cameras last came back to the view asked for
 * (a parking view, also the automatic one at the start, ends them), and a save with fewer than "before" of them saves
 * what is there (from 5 s on) instead of failing.
 * 2.3.10: Copy to USB on a car that mounts sticks read-only: the stick is made writable while Copy to USB is open or a
 * copy runs (USB_FLAG, the player 1.1.3's usb-rw.sh), and the player is asked for it until it has one.
 * 2.3.11: the G20's failed saves (2.3.8's and 2.3.9's guesses: the window) came from the clip folder's quota, BMW's 1 GB
 * for the camera service and its group, full: the player 1.1.4 raises it to 4.5 GB (the 4 GB of clips it keeps + one
 * being written) and keeps its own files out of it. The buffer's window is the seconds before + 10 s again.
 * 2.3.12: a tap on "Save clip · N s before" saves (ui.js still waited for the full "before" seconds).
 * 2.3.13: Diagnostics on a car provisioned by BMW's servers (data state OTA) says the das lines are not read there (they
 * are only on DAS cars); the Drive Recorder seconds follow one camera state (XView3D's, else icam2proxy's) instead of
 * each in turn; a service not offered reads "not offered"; long Diagnostics values are cut, no longer drawn over their
 * names (iDrive 7).
 * 2.5.0 (car-apps issue #37, cars without a touchscreen): the iDrive controller, as Ambient Light and Seats: FrontCCU's
 * knob state (oap-shared/frontccu.js) into the screens (renderer/controller.js): turn = next control, press = tap, push
 * N / E / S = that way; a clip card each (the grid scrolls to it), the viewer's cameras each, the timeline seeks 1 s a
 * click after a press.
 * 2.5.1 (car-apps issues #23, #37, iDrive 7): DR mode at start no longer a single try - started with the car (player
 * 1.2.6), the camera side may not take it yet: asked again until it is, and the view read back until the ECU shows it
 * (recorder.js autoCam / camCheck); the controller's proxy timeout as a number (oap-shared/frontccu.js); the ring follows
 * the screen shown and skips what a dialog covers (renderer/screenapp.js, controller.js).
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const someipBuilders                   = require('oap-sdk/src/someip/someipBuilders');
const { createHost }                   = require('./online-host.js');
const { watchController }              = require('./frontccu.js');
const recorder                         = require('./recorder.js');
const { Player }                       = require('./player.js');
const meta                             = require('./meta.js');
const { Ui, exportOptions, crop }      = require('./ui.js');

const LOG = '[oap-driverec]';
const FRAMES = '/dev/shm/mgu-video-drplay';
const SCREENS = ['record', 'clips', 'viewer', 'export', 'settings', 'confirm', 'diag'];   // RHMI host states, the entry first
const THUMB_W = 320, THUMB_H = 240;

// the linked bundle is javascript/app.js: the package root is one up
const SOURCE = typeof __dirname === 'string' ? path.join(__dirname, '..') : `/var/opt/public/oap/oap_${process.getuid()}/source`;
const RENDERER = path.join(SOURCE, 'renderer');
const runtime = (f) => require(path.join(RENDERER, f));
const localization = runtime('localization.js');
let stopLanguage = null;
const DATA = `/var/opt/public/oap/oap_${process.getuid()}/data`;
const LOG_FILE = `${DATA}/driverec.log`;
const SETTINGS_FILE = `${DATA}/driverec.json`;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8')).version; } catch (e) { return ''; } })();

// ---- log + settings ---------------------------------------------------------------------------
function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) { /* no file yet */ }
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (e) { /* no data folder */ }
}
// length: index into recorder.LENGTHS; autoCam: "Start with the car" (the DR mode at start); view: the request value
// chosen (recorder.js VIEWS: 7 all, 5 front + rear; none / one the car lacks, e.g. 2.0.0's 9: the first one it has);
// views: the ones this car records (2.1.0, checked at the first start; missing = not checked yet)
let settings = { length: 1, buffer: true, autoCam: true };
try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (e) { /* defaults */ }
delete settings.saveButton; delete settings.buttonSave;      // 2.1.2-2.1.6's Save with a button
const saveSettings = () => { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (e) { log('settings not saved:', e); } };

// 2.3.6: the SDK's uncaughtException handler (registered after this one, in OnlineApp's constructor) exits the process,
// and MainApp's CorruptAppsHandler then wipes the data folder: the stack is written first, to the log and to CRASH_FILE
// (/dev/shm: kept until the head unit restarts)
const CRASH_FILE = '/dev/shm/oap-driverecorder-next-crash.log';
process.on('uncaughtException', (e) => {
    const text = String((e && e.stack) || e);
    try { fs.appendFileSync(CRASH_FILE, `${new Date().toISOString()} ${VERSION} uid ${process.getuid()} uncaught: ${text}\n`); } catch (x) { /* no /dev/shm */ }
    log('uncaught:', text);
});
// 2.3.6: memory and CPU since the last call (CPU: % of one core)
let usage = { at: Date.now(), cpu: process.cpuUsage() };
function usageText() {
    const now = Date.now(), cpu = process.cpuUsage(usage.cpu), ms = Math.max(1, now - usage.at), m = process.memoryUsage();
    usage = { at: now, cpu: process.cpuUsage() };
    return `rss ${Math.round(m.rss / 1048576)} MB, heap ${Math.round(m.heapUsed / 1048576)} MB, cpu ${Math.round((cpu.user + cpu.system) / (10 * ms))} %`;
}
{
    let n = 0;
    const timer = setInterval(() => { log('usage:', usageText()); if (++n >= 20) clearInterval(timer); }, 500);
}
// a failure that repeats (the 1 s tick, every refresh) is logged when it first shows or changes
const failed = (() => {
    const last = {};
    return (where, e) => {
        const text = String((e && e.stack) || e);
        if (last[where] !== text) { last[where] = text; log(`${where} failed:`, text); }
    };
})();

const rec = recorder.create({ someipBuilders, log, settings, saveSettings });
// 2.0.3: a file DATA/probe-views ("1 2 3 4 6"), put there over SSH, makes the recorder ask each view once (rec.probe);
// looked for every second, deleted when read
const PROBE_FILE = `${DATA}/probe-views`;
function checkProbe() {
    if (!fs.existsSync(PROBE_FILE)) return;
    let views = [];
    try { views = String(fs.readFileSync(PROBE_FILE, 'utf8')).split(/\s+/).map(Number).filter((n) => n > 0 && n < 256); } catch (e) { log('probe file:', e); }
    try { fs.unlinkSync(PROBE_FILE); } catch (e) { log('probe file not deleted:', e); return; }
    if (views.length) rec.probe(views);
}
// 2.1.6: mgu-camcluster writes the camera the iDrive 8 cluster widget shows ("front" or "rear") here while it shows,
// every 5 s; gone or older than 15 s (it stopped): the recording view the user chose comes back
const CLUSTER_FILE = '/dev/shm/camcluster/showing';
function checkCluster() {
    let cam = null;
    try {
        if (Date.now() - fs.statSync(CLUSTER_FILE).mtime.getTime() < 15000) cam = String(fs.readFileSync(CLUSTER_FILE, 'utf8')).trim();
    } catch (e) { /* none: the widget isn't showing */ }
    rec.setCluster(cam === 'front' ? 1 : cam === 'rear' ? 2 : null);
}
const player = new Player({ log });
const ui = new Ui();

// ---- RHMI: the host states (the OnlineApp host hands them over) ----------------------------------------
let app = null, screens = null, gpu = null, kit = null;
const comp = (n) => app.getByName(n);
const showState = (name, open) => comp(name).updateResources().then(open || (() => app.openState(name)))
    .then(() => log(`opened ${name}`)).catch((e) => log(`open ${name} failed:`, e));
// a state that is not open answers INVALID_COMPONENTID (tabTo closes them all): not logged (car 2026-11-05, 2.2.1)
const closeState = (name) => app.closeState(name).catch((e) => {
    if (!/INVALID_COMPONENTID/.test(String((e && e.message) || e))) log(`close ${name} failed:`, e);
});
// the tabs (Record | Clips | Settings) replace each other over Record, the entry state: every other state closes (a
// tab, the viewer, Copy to USB, Diagnostics - all of them: the HMI hides a covered state, so ScreenApp's up holds only
// the shown one), then the tab opens - the HMI's BACK on a tab goes to Record
function tabTo(page) {
    SCREENS.slice(1).reverse().forEach((n) => { if (n !== page) closeState(n); });
    if (page !== 'record') showState(page);
}

// ---- what ui.js asks for ------------------------------------------------------------------------------
let seekTimer = null;
let clipMeta = null;            // { id, m (meta.load) } of the clip in the viewer
function openMeta(id) {
    clipMeta = { id, m: null };
    if (/^[0-9]{8}_[0-9]{6}$/.test(id)) {
        recorder.REC_DIRS.forEach((d) => ['', '/locked'].forEach((sub) => {
            const f = `${d}${sub}/${id}_Metadata.json`;
            if (!clipMeta.m && fs.existsSync(f)) clipMeta.m = meta.load(f);
        }));
    }
    ui.setMeta(meta.at(clipMeta.m, 0, 0));
}
function exec(a) {
    if (a.do === 'go') showState(a.page);
    else if (a.do === 'tab') tabTo(a.page);
    else if (a.do === 'close') closeState(a.page);
    else if (a.do === 'save') rec.save();
    else if (a.do === 'view') rec.setView(a.view);
    else if (a.do === 'detect') rec.detect();
    else if (a.do === 'setting' && a.key === 'len') rec.setLength((settings.length + 1) % recorder.LENGTHS.length);
    else if (a.do === 'setting' && a.key === 'auto') { settings.autoCam = !!a.value; saveSettings(); if (a.value) rec.setView(settings.view); }
    else if (a.do === 'open') openMeta(a.id);
    else if (a.do === 'play') player.play(a.id, a.at);
    else if (a.do === 'seek') { clearTimeout(seekTimer); seekTimer = setTimeout(() => player.seek(a.s), 250); }   // a drag: the last one
    else if (a.do === 'cam') player.cam(a.n);
    else if (a.do === 'lock') player.lock(a.id, a.on);
    else if (a.do === 'delete') player.remove(a.id);
    else if (a.do === 'copy') player.copy(a.id, a.what);
    else if (a.do === 'usb') player.askUsb();
    else if (a.do === 'exportPics') exportPics(a.id);
    else if (a.do === 'pause' || a.do === 'resume' || a.do === 'stop') player[a.do]();
}
// run ui.js's requests, then the shown screen gets the values ui.js has for it (2.3.6: a throw is logged, not fatal -
// refresh runs from timers and the player's, the renderer's and the recorder's events)
function refresh() {
    try { refreshNow(); } catch (e) { failed('refresh', e); }
}
function refreshNow() {
    ui.take().forEach(exec);
    const s = rec.status();
    ui.setRecorder(s);
    const page = screens && screens.status().page;
    if (!page) return;
    const v = ui.values(page);
    Object.keys(v).forEach((el) => screens.set(el, v[el], page));
    loadThumbs();
}

// ---- the player tool ------------------------------------------------------------------------------------
// the renderer opens the frame file when it is named: again after the renderer or the tool came back
function nameVideo() { if (gpu) { gpu.video(1, null); gpu.video(1, FRAMES); } }
player.on('up', () => { ui.setTool(true); rec.tool = { up: true, full: player.full }; nameVideo(); refresh(); });
player.on('hello', (v) => { ui.setTool(true, v); refresh(); });
player.on('down', () => { ui.setTool(false); rec.tool = { up: false, full: false }; loadThumbs(); refresh(); });
player.on('clips', () => {
    ui.setClips(player.clips, player.total, player.full);
    rec.tool = { up: true, full: player.full };
    pics.forEach((p, id) => { if (p.bad) pics.delete(id); });      // a new list: unreadable thumbnails tried again
    loadThumbs();
    refresh();
});
player.on('state', (s) => {
    ui.setPlayer(s);
    if (clipMeta && clipMeta.id === s.clip) {
        const c = player.clips.find((x) => x.id === s.clip);
        ui.setMeta(meta.at(clipMeta.m, (c && c.secs) || s.dur, s.pos));
    }
    refresh();
});
player.on('usb', (u) => { ui.setUsb(u); refresh(); });
player.on('copy', (c) => { ui.copying(c); refresh(); });
player.on('done', (d) => { log(`player: ${d.cmd} ${d.clip} ${d.ok ? 'ok' : 'failed'} ${d.text}`); ui.done(d); refresh(); });
rec.on('change', refresh);

// thumbnails: the tool's RGBA files -> kit pictures 't:<clip id>', only for ui.thumbIds() (the grid rows shown + one row
// each side, the last clip's card: at most 13); a picture scrolled out is dropped
const pics = new Map();         // clip id -> { img } | { loading: true } | { bad: true } (tried again with the next list)
function dropPic(id) {
    const p = pics.get(id);
    pics.delete(id);
    if (p && p.img) { screens.setImage(`t:${id}`, null); gpu.dropImage(p.img); kit.dropImage(p.img); }
}
function loadThumbs() {
    if (!screens) return;
    const want = ui.thumbIds();
    [...pics.keys()].forEach((id) => { if (want.indexOf(id) < 0) dropPic(id); });
    want.forEach((id) => {
        const c = player.clips.find((x) => x.id === id);
        if (!c || pics.has(id) || !/^\/.*\.rgba$/.test(c.thumb)) return;      // ("" = none yet: the next list has it)
        pics.set(c.id, { loading: true });
        fs.readFile(c.thumb, (err, buf) => {
            const p = pics.get(c.id);
            if (!p || !p.loading) return;                     // dropped meanwhile
            if (err || buf.length !== THUMB_W * THUMB_H * 4) { pics.set(c.id, { bad: true }); return; }
            const img = kit.makeImage(THUMB_W, THUMB_H, buf);
            pics.set(c.id, { img });
            screens.setImage(`t:${c.id}`, img);
        });
    });
}
// the Copy to USB page's tile pictures 'x:<what>' (2.1.0): the clip's thumbnail cut per camera (ui.js crop); the last
// clip's dropped when another one opens (a read that ends after a newer open: not used)
let xpics = [], xseq = 0;
function exportPics(id) {
    const seq = ++xseq, c = player.clips.find((x) => x.id === id);
    xpics.forEach((p) => { screens.setImage(`x:${p.what}`, null); gpu.dropImage(p.img); kit.dropImage(p.img); });
    xpics = [];
    if (!screens || !c || !/^\/.*\.rgba$/.test(c.thumb)) return;
    fs.readFile(c.thumb, (err, buf) => {
        if (err || seq !== xseq || buf.length !== THUMB_W * THUMB_H * 4) return;
        exportOptions(c.cams).forEach((o) => {
            const p = crop(buf, c.cams, o.what), img = kit.makeImage(p.w, p.h, p.data);
            xpics.push({ what: o.what, img });
            screens.setImage(`x:${o.what}`, img);
        });
    });
}

// ---- the renderer, or the HMI page when it doesn't answer -------------------------------------------
let fallbackUp = false, fallbackTimer = null, fallbackText = '';
function fallback(text) {
    clearTimeout(fallbackTimer);
    fallbackText = text;
    comp('fbText').setValue(0, 'Text', localization.t(text), 'Text');
    if (!fallbackUp) { fallbackUp = true; showState('fallback'); }
}
// a tile tap (the host opens the entry state): the HMI page instead when the renderer doesn't answer within 10 s
function armFallback() {
    clearTimeout(fallbackTimer);
    if (gpu && !gpu.ready) fallbackTimer = setTimeout(() => { if (!gpu.ready) fallback('Starting the renderer… Reinstall it from the Store if this stays.'); }, 10000);
}

function startScreens(rhmiApp, hosts) {
    app = rhmiApp;
    const design = JSON.parse(fs.readFileSync(path.join(RENDERER, 'screens.json'), 'utf8'));
    const { RenderClient } = runtime('kit/renderd.js');
    const { ScreenApp } = runtime('screenapp.js');
    kit = runtime('kit/record.js');
    const rlog = { info: (m) => log(m), warn: (m) => log(m), error: (m) => log(m) };
    gpu = new RenderClient('oap-driverec', rlog);
    nameVideo();                                     // the player tool's frames (renderer protocol 4)
    screens = new ScreenApp(gpu, design, { view: 'id8', log: rlog });   // (an iDrive 7 screen: its own layouts)
    screens.bindHosts(hosts, { open: (name) => showState(name), close: closeState });
    screens.on('show', (name) => { ui.setShown(name); refresh(); });
    screens.on('change', (el, opts) => { ui.change(screens.status().page, el, opts); refresh(); });
    screens.on('event', (name) => { ui.event(screens.status().page, name); refresh(); });
    screens.on('closed', (why) => { ui.setShown(null); refresh(); if (why !== 'hmi') SCREENS.slice().reverse().forEach(closeState); });
    watchController((v) => screens.controller(v), log);      // 2.5.0: the iDrive controller
    gpu.on('ready', () => {
        nameVideo();
        if (fallbackUp) { fallbackUp = false; closeState('fallback'); }
        if (!gpu.videos) log(`the renderer is older than 1.2.0 (protocol ${gpu.version}): no video picture - update it from the Store`);
    });
    // (the kit reconnects every 3 s by itself)
    comp('fbRetry').on('action', () => fallback('Waiting for the renderer… Reinstall it from the Store if this stays.'));
    gpu.connect();
    loadThumbs();
    log('screens ready');
}

// 2.1.4: the camera ECU's side, logged as events ("cam-ev: ..."): XView3D's activation source (FeedbackSA2:
// BUTTON_ACTIVATION ...), its state and PerspectiveChangeTriggered event, ICAM2Proxy's camera state (a parking view
// taking the cameras over shows here)
const evText = (v) => (v && typeof v === 'object' ? JSON.stringify(v).replace(/"/g, '').slice(0, 160) : String(v));
function connectCameraEvents() {
    const watch = (iface, fields) => someipBuilders.buildAndInitTypedProxy(iface, '1', 10000)
        .then((p) => Promise.all(fields.map((f) => Promise.resolve()
            .then(() => (p[f] && typeof p[f].subscribe === 'function' ? p[f].subscribe((v) => {
                log(`cam-ev: ${f}=${evText(v)}`);
                // 2.3.9: what the buffer holds (2.3.13: and whose state it is - XView3D's CurrentState, icam2proxy's currentState)
                if (f === 'CurrentState' || f === 'currentState') rec.camEvent(v, f === 'CurrentState' ? 'xv' : 'icam');
            }) : log(`cam-ev: no ${f}`)))
            .catch((e) => log(`cam-ev: ${f} not subscribed:`, String(e && e.message || e))))))
        .then(() => log(`cam-ev: ${iface.split('.').pop()} watched`))
        .catch((e) => { log(`cam-ev: ${iface}:`, String(e && e.message || e)); setTimeout(() => watch(iface, fields), 30000); });
    watch('de.bmw.dass.XView3D', ['FeedbackSA2', 'CurrentState', 'PerspectiveChangeTriggered', 'ActivationMode', 'Handshake']);
    watch('de.bmw.infotainment.video.cameraproxy.ICAM2Proxy', ['currentState', 'cameraProxyState']);
}

// ---- the vehicle speed: video only while the car stands still -----------------------------------------
let speedProxy = null;
function connectSpeed() {
    someipBuilders.buildAndInitTypedProxy('de.bmw.infotainment.vehicle.Vehicle2', '1', 10000)
        .then((p) => { speedProxy = p; log('speed connected'); })
        .catch((e) => { log('speed:', e); setTimeout(connectSpeed, 15000); });
}
function pollSpeed() {
    if (!speedProxy) return;
    Promise.resolve().then(() => speedProxy.statusCarSpeed2.getValue()).then((x) => {
        if (x && typeof x.speedVehicleCentreOfGravity === 'number' && x.speedVehicleCentreOfGravity !== 65535) ui.setSpeed(x.speedVehicleCentreOfGravity / 64, Date.now());
    }, () => null);
}

// ---- Copy to USB: the stick made writable while it is wanted -------------------------------------------------------
// 2.3.10: the car mounts a USB stick read-only (for its media player) and the player copies only to a writable one
// ("No USB stick" on the G20): while Copy to USB is open or a copy runs, USB_FLAG is written every 3 s - the player's
// usb-rw.sh (root, player 1.1.3) makes the stick writable meanwhile and read-only again 20 s after - and the player is
// asked for the stick again every 3 s until it has one
const USB_FLAG = '/dev/shm/oap-driverecorder-usb';
let usbFlagAt = 0, usbAskAt = 0;
function usbWanted() {
    const page = screens ? screens.status().page : null;
    if (page !== 'export' && !ui.copy) return;
    const now = Date.now();
    if (now - usbFlagAt >= 3000) {
        usbFlagAt = now;
        try { fs.writeFileSync(USB_FLAG, `${now}\n`); } catch (e) { /* no /dev/shm, or another uid's file there */ }
    }
    if (page === 'export' && !(ui.usb && ui.usb.label) && now - usbAskAt >= 3000) { usbAskAt = now; player.askUsb(); }
}

// ---- lifecycle: the shared OnlineApp host (start, tile, shutdown; iDrive 7 + 8) ----------------------------------
// The recorder, the player tool and the services start with the app (the car's start: no screen needed); the screens
// when the host hands over the RHMI application. ACTIVE the whole time, as 2.x (OnlineAppBackground): a recorder.
function startServices() {
    stopLanguage = localization.watch(someipBuilders, () => {
        if (screens) screens._draw();
        if (fallbackUp) comp('fbText').setValue(0, 'Text', localization.t(fallbackText), 'Text');
    }, log);
    rec.start();
    player.connect();
    connectSpeed();
    connectCameraEvents();
    setInterval(() => {
        try {
            checkProbe();
            checkCluster();
            pollSpeed();
            const page = screens ? screens.status().page : null;
            rec.active = !!page;            // services read every 2 s while a screen is open
            ui.tick();
            usbWanted();
        } catch (e) { failed('tick', e); }
        refresh();                          // the parked rule, times, chips
    }, 1000);
}
const active = () => Promise.resolve(host.registerActive()).catch((e) => log('registerActive failed:', e));
log('start', process.getuid(), VERSION, util.inspect(settings));
const host = createHost({
    states: SCREENS,
    log,
    // ACTIVE at every start, a start for no screen too (2.3.6: iDrive 7's manager stops an app that is not)
    alwaysActive: true,
    onReady: (rhmiApp, hosts) => { startScreens(rhmiApp, hosts); return active(); },
    // iDrive 7's host reports INACTIVE when the screen goes: this app records in the background, ACTIVE again
    onHidden: active,
    // stop playback, give the camera back first (an attached indirect client stays in icam2proxy otherwise), at most 2 s
    onShutdown: () => {
        if (stopLanguage) stopLanguage();
        log('usage at shutdown:', usageText());
        if (player.up) player.stop();
        return Promise.race([rec.release(), new Promise((r) => setTimeout(r, 2000))]);
    },
});
host.once('initialized', startServices);
host.on('entryPointExecute', armFallback);
