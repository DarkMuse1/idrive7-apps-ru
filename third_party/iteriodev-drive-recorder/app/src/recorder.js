'use strict';
/*
 * Drive Recorder: the recording side - the HU's camera ring buffer kept running, saves, the camera DR mode. Moved from
 * main.js 1.0.17 (2.0.0), behaviour unchanged unless a 2.0.0 note says otherwise. Research: analysis/drive-recorder.md
 *
 * The rolling window is the HU's own camera ring buffer in icam2proxy:
 *   de.bmw.infotainment.video.videobuffer.VideoBuffer (0xF78C): startRecording, setConfiguration
 *   ({maxDuration, maxBitrate}), storeVideo(baseFilename, secondsIntoPast, secondsIntoFuture),
 *   currentStatus (IDLE/ERROR/RECORDING/STORING), currentConfiguration.
 * The buffer autostarts with the car; this module keeps it running and saves a clip on demand: N s before + M s after
 * the tap, written by icam2proxy to /var/opt/public/ent/driverecorder/. icam2proxy only enables the buffer / export
 * when provisioning says /data/oap-driverecorder-next/@enabled (this app's id: the das line for it is that flag);
 * coding DRIVE_RECORDER (HU_MGU CAFD) is the other gate. The status lines (Diagnostics) show what the services report.
 * Firmware dump: /var/opt/public 0710 and /var/opt/public/ent 0770 group mgu_persist (903, in every app's start
 * groups), driverecorder 02775 ent_mono:mgu_driverec (mediaonoff), clips 0644 (icam2proxy).
 * 1.0.10/1.0.11: icam2proxy (CProvisioningProxy) waits for the provisioning service's provisioningDataState before it
 * asks getValue (not getValueJSON) for the key, once, at its start: both are shown, the data state first + logged.
 * 1.0.6: the buffer only gets frames while the camera ECU is in DR mode (all four cameras on AVB role .1), which the
 * stock DR app requests as icam2proxy's background (indirect) client: CameraProxy.clientAttach(CLIENT_INDIRECT) +
 * ICAM2Proxy.changeState(cookie, {DR_ACTIVE, MODE_MOSAIK, view}); release = clientDetach (icam2proxy ignores OFF from
 * an indirect client).
 * 1.0.14: a save needs the buffer recording and checks afterwards that a file was written.
 * 1.0.15: icam2proxy replies only in the state a call expects; ERROR came from a storeVideo with a name instead of the
 * folder, only reset leaves ERROR. keepBuffer drives the buffer from its state (every 2 s with a screen open, else
 * every 10 s); storeVideo gets the clip folder.
 * 1.0.16: icam2proxy drops frames it can't place ("Unknown perspective"): DR_ACTIVE asks a view - all cameras (9),
 * front + rear (5); 7 (left + right) gave all cameras on the car: dropped.
 * 1.0.17: real 1280x960 15 fps .ts clips (about 5 MB per second). The first DR request after attaching left the ECU at
 * perspective 0 (black filler frames): the view is read back and asked again.
 * 2.0.0: the DR mode is requested at start (settings.autoCam, default on) with the saved view (settings.view);
 * the window follows the clip length (maxDuration = before + 10 s, no own setting); the save cap is the player tool's
 * (iteriodev-drplay replaces the oldest unlocked clips over 4 GB; "full" = locked clips alone over 4 GB), 4 GB of our
 * own while it is not running. The clip list is the tool's: the folders are scanned only for "was a file written" and
 * that cap (the App Manager's recordings.json fallback is gone with the list).
 * 2.0.1: car (2026-10-31): asking view 9 never gives all cameras - the ECU answers view 0 (the black filler of 1.0.15/16,
 * "asked 3 times" in 2.0.0); asking 7 does (frames tagged 9/10, saved as all_cameras), 5 gives front + rear (5/6). So
 * the request values are 7 / 5; a saved 9 becomes 7. The 1.0.17 "first request ignored" was this, not a first request.
 * 2.1.0: other camera sets (rear camera only, front + rear without 360): the table VIEWS; the ones this car records
 * (settings.views) are checked at the first start and by Diagnostics > Check cameras: each asked for 6 s, kept when
 * CurrentState shows DR_ACTIVE with one of its `shown` views; then the chosen view again (else the first one the car
 * has). None found: checked again at the next start (a busy camera ECU must not end recording for good). 2.1.3: also
 * when the candidates changed since (settings.viewsChecked: 2.1.0-2.1.2 checked 7 + 5 only).
 *
 *   const rec = create({ someipBuilders, log, settings, saveSettings });   settings: { length, buffer, autoCam, view, views }
 *   rec.start(); rec.save(); rec.setView(req); rec.detect(); rec.probe([req ...]); rec.setLength(i); rec.release();
 *   rec.restart(); rec.status(); rec.active (a screen open: services read every 2 s); rec.tool = { up, full }; 'change'
 */
const fs = require('fs');
const net = require('net');
const util = require('util');
const EventEmitter = require('events');

// 2.4.0 (route 3, analysis/drive-recorder-route3-own-receiver.md): the rolling buffer + save are no longer
// icam2proxy's VideoBuffer / DataExport (dead on OTA-provisioned cars - the enable flag is in BMW's signed
// ProvSigned.xml and the das override is not merged in). Our own receiver daemon (mgu-driverec-rx, the player tool)
// taps the camera ECU's AVB stream itself, keeps the RAM ring, and writes the clip files in icam2proxy's exact
// layout. No provisioning / coding / OTA gate. The camera DR mode is still driven here over ICAM2Proxy (ungated).
const RX_SOCK = '/var/opt/iteriodev-drplay/recd.sock';

const REC_DIRS = ['/var/opt/public/ent/driverecorder', '/mnt/share/ent/driverecorder'];   // icam2proxy: eMMC / HDD
const LENGTHS = [[10, 5], [20, 10], [30, 15], [60, 30]];   // seconds before / after the tap
// clips are about 5 MB per second (car: 59 MB for 11 s, 88 MB for 17 s); a failed store leaves an 80 KB "(0sec)" file
const MIN_BEFORE = 5;      // 2.3.9: a save needs at least this many seconds before the tap (else: shorter clips, not none)
const CAP = 4 * 1073741824, CLIP_RATE = 5.5 * 1048576;
const POLL_MS = 2000, RETRY_MS = 30e3;
// [interface, instance names to try] - names from the OAP catalogue's instanceIDs (VideoBuffer is not "1": 1.0.0 failed
// with "Instance not available in 'instances' section"; DataExport has 5, which one icam2proxy offers: tried in turn)
const IF = {
    svs: ['de.bmw.dass.svsrecorder.svsrecordercontrol.SvsRecorderControlCoordinator', ['1']],
    svsData: ['de.bmw.dass.svsrecorder.svsrecorderdata.SvsRecorderData', ['1']],
    prov: ['de.bmw.infotainment.telematic.provisioning.Provisioning', ['1']],
    cam: ['de.bmw.infotainment.video.cameraproxy.CameraProxy', ['1']],
    icam: ['de.bmw.infotainment.video.cameraproxy.ICAM2Proxy', ['1']],
    xv: ['de.bmw.dass.XView3D', ['1']],
};
// the key icam2proxy waits for before it offers VideoBuffer / DataExport (the App Manager's das line sets it)
const PROV_KEY = '/data/oap-driverecorder-next/@enabled';
// the views a car may record, in the Record page's order (the first one a car has = the default): req = changeState
// perspective, label = its tab, name = alone on the page, layout = the clips' cams (player.js), shown = what CurrentState
// may report once applied. Car probe (mgu-m4, 2026-10-31), request -> the frames' SEI tags: 7 -> 9/10 all cameras, 5 ->
// 5/6 front + rear, 1 / 2 -> front / rear only (1280x480, 30 fps); also 3 / 4 left / right only, 6 -> 7/8 left + right
// (not offered: user), 8-12 and 0 invalid (icam2proxy drops frames tagged 0: black filler).
const VIEWS = [
    { req: 7, label: 'All cameras', name: 'All cameras', layout: 0, shown: [7, 9, 10] },
    { req: 5, label: 'Front + rear', name: 'Front + rear', layout: 1, shown: [5, 6] },
    { req: 1, label: 'Front', name: 'Front camera', layout: 3, shown: [1] },
    { req: 2, label: 'Rear', name: 'Rear camera', layout: 4, shown: [2] },
];
// settings.viewsChecked: the list a car was checked with, and the check's version (2.3.7: a check made while the camera
// ECU was still starting could miss a view - every car checks once more)
const CANDIDATES = `${VIEWS.map((v) => v.req).join(' ')} c2`;
// the camera ECU is still starting (iDrive 7: CAMERA_INITIALIZING for about 10 s after the attach): it answers
// SIGNAL_UNFILLED / perspective 255 and drops what is asked
const notReady = (s) => !s || typeof s !== 'object' || /SIGNAL_UNFILLED/.test(String(s.application)) || Number(s.perspective) === 255;
const NOT_READY_TRIES = 4;     // views asked again at most this often in one check (the ECU starting)
const CAM_WIRE = { CLIENT_INDIRECT: 1, DR_STANDBY: 50, DR_ACTIVE: 51, MODE_MOSAIK: 50 };
// 2.5.1: a camera view of the car's own on the ECU (XView3D Xview3DApplication, G20 dump: TOPREARVIEW 1, SIDEVIEW 2,
// RFK 3, OFFROAD 20, REMOTE360 60) - parking / 360 view up: DR mode is not asked meanwhile, it comes back after it
const CAR_VIEW = /^(TOPREARVIEW|SIDEVIEW|RFK|OFFROAD|REMOTE360|1|2|3|20|60)$/;
const CAM_RETRY_MS = 15000;    // 2.5.1: DR mode at start / a view not shown yet: asked again this often

const errText = (e) => String(e && e.message || e).slice(0, 120);
const pad = (n) => (n < 10 ? '0' : '') + n;
const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const mb = (b) => `${((b || 0) / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
const show = (v) => (v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : String(v));
const byReq = (req) => VIEWS.find((v) => v.req === req);
const viewLabel = (req) => `${(byReq(req) || { label: 'view' }).label.toLowerCase()} (${req})`;
// a CurrentState (XView3D's, else icam2proxy's) that shows view req applied in DR mode
const applied = (req, s) => !!(s && byReq(req) && /^(DR_ACTIVE|51)$/.test(String(s.application)) && byReq(req).shown.indexOf(Number(s.perspective)) >= 0);
const camState = (s) => (s && typeof s === 'object' ? `${s.application}/${s.mode}/${s.perspective}` : show(s));
const camStream = (s) => (s && typeof s === 'object' ? `${s.imageWidth}x${s.imageHeight} ${s.framesPerSecond} fps` : show(s));

function create(o) {
    const log = o.log, settings = o.settings, saveSettings = o.saveSettings, someipBuilders = o.someipBuilders;
    const api = new EventEmitter();
    api.active = false;                     // a screen is open: services read every 2 s
    api.tool = { up: false, full: false };  // the player tool (main.js)
    const changed = () => api.emit('change');
    const len = () => LENGTHS[settings.length] || LENGTHS[1];
    // the views this car records (all of the table until checked); req, or the first of them; null = none
    const checked = () => Array.isArray(settings.views) && settings.views.length > 0 && settings.viewsChecked === CANDIDATES;
    const avail = () => VIEWS.filter((v) => !Array.isArray(settings.views) || settings.views.indexOf(v.req) >= 0);
    const pick = (req) => { const a = avail(), v = byReq(req); return a.indexOf(v) >= 0 ? req : a.length ? a[0].req : null; };

    const px = {}, link = {}, st = {};      // name -> typed proxy / 'connecting' | 'ok' | 'ERR ...'; values read
    let lastClip = '-', lastState = '';     // lastState: '' | saving | saved | failed
    const note = (state, text) => { lastState = state; lastClip = text; changed(); };

    // ---- the receiver daemon (mgu-driverec-rx): the rolling buffer + save, over a unix socket -------------------
    const rx = { up: false, state: null, version: null };     // state: { state RECORDING|WAITING, held s, bytes, fps, persp }
    let rxSock = null, rxBuf = '', rxStatusWait = null, rxSaveWait = null, rxConnTimer = null;
    function rxConnect() {
        if (rxSock) return;
        const s = net.connect(RX_SOCK);
        rxSock = s;
        s.setEncoding('utf8');
        s.on('connect', () => { rx.up = true; log('receiver: connected'); rxSend('hello'); changed(); });
        s.on('data', (d) => {
            rxBuf += d;
            for (let i; (i = rxBuf.indexOf('\n')) >= 0; ) { const line = rxBuf.slice(0, i); rxBuf = rxBuf.slice(i + 1); rxLine(line); }
        });
        const drop = (why) => {
            if (rxSock !== s) return;
            rxSock = null; rxBuf = ''; rx.up = false; rx.state = null;
            if (rxStatusWait) { const f = rxStatusWait; rxStatusWait = null; f(null); }
            if (rxSaveWait) { const f = rxSaveWait; rxSaveWait = null; f({ ok: false, text: `receiver not running (${why})` }); }
            changed();
            clearTimeout(rxConnTimer); rxConnTimer = setTimeout(rxConnect, 3000);
        };
        s.on('error', (e) => { log('receiver:', errText(e)); drop(errText(e)); });
        s.on('close', () => drop('closed'));
    }
    function rxSend(line) { try { if (rxSock && rx.up) rxSock.write(line + '\n'); } catch (e) { log('receiver write:', errText(e)); } }
    function rxLine(line) {
        const f = line.split('\t'), kind = f[0];
        if (kind === 'ready') { rx.version = f[1]; log(`receiver: ready ${f[1]}`); }
        else if (kind === 'status') {
            rx.state = { state: f[1], held: Number(f[2]) || 0, bytes: Number(f[3]) || 0, fps: Number(f[4]) || 0, persp: Number(f[5]) || 0 };
            if (rxStatusWait) { const g = rxStatusWait; rxStatusWait = null; g(rx.state); }
            changed();
        } else if (kind === 'saved' || kind === 'failed') {
            if (rxSaveWait) { const g = rxSaveWait; rxSaveWait = null; g(kind === 'saved' ? { ok: true, id: f[1], segs: Number(f[2]) || 0 } : { ok: false, id: f[1], text: f[2] || 'failed' }); }
        }   // 'saving' (the ack) is ignored
    }
    // one status round-trip (null if the daemon is down)
    function rxStatus() {
        if (!rx.up) return Promise.resolve(null);
        if (rxStatusWait) return Promise.resolve(rx.state);
        return new Promise((res) => { rxStatusWait = res; rxSend('status'); setTimeout(() => { if (rxStatusWait === res) { rxStatusWait = null; res(rx.state); } }, 3000); });
    }
    // save: resolves when the daemon has written the clip (after the 'after' seconds) -> { ok, id, segs } | { ok:false, text }
    function rxSave(before, after, dir) {
        if (!rx.up) return Promise.resolve({ ok: false, text: 'receiver not running' });
        if (rxSaveWait) return Promise.resolve({ ok: false, text: 'a save is already under way' });
        return new Promise((res) => {
            rxSaveWait = res;
            rxSend(`save\t${before}\t${after}${dir ? '\t' + dir : ''}`);
            setTimeout(() => { if (rxSaveWait === res) { rxSaveWait = null; res({ ok: false, text: 'the receiver did not answer' }); } }, (after + 20) * 1000);
        });
    }

    function connect(name) {
        link[name] = link[name] || 'connecting';
        const ifName = IF[name][0], instances = IF[name][1];
        let lastErr = null;
        const attempt = (i) => (i >= instances.length ? Promise.reject(lastErr)
            // the timeout as a number: iDrive 7's oap-sdk 24.x takes nothing else (an object timed out at once)
            : someipBuilders.buildAndInitTypedProxy(ifName, instances[i], instances.length > 1 ? 4000 : 10000)
                .then((p) => ({ p, inst: instances[i] }), (e) => { lastErr = e; return attempt(i + 1); }));
        return attempt(0)
            .then((r) => {
                px[name] = r.p; link[name] = `ok (${r.inst})`; log(`${name} connected, instance ${r.inst}`);
                if (name === 'icam') { log('icam methods:', Object.keys(r.p).join(' ')); autoCam(); }
            })
            // 2.3.13: a service that is not there in short (the Diagnostics row; CameraProxy never is, see camCall)
            .catch((e) => { link[name] = /waitUntilAvailable\(.*timed out/.test(errText(e)) ? 'not offered' : `ERR ${errText(e)}`; setTimeout(() => connect(name), RETRY_MS); })
            .then(changed);
    }

    // getters, not notifiers (Car Data: notifiers often never fire for an app)
    const get = (name, field, key) => (px[name] ? Promise.resolve().then(() => px[name][field].getValue())
        .then((v) => { if (util.inspect(st[key]) !== util.inspect(v)) { st[key] = v; changed(); } }, (e) => { st[key] = `ERR ${errText(e)}`; changed(); })
        : Promise.resolve());

    // 2.0.2 (user): Save only once the clip's "before" seconds are held. 2.4.0: the receiver daemon owns the ring and
    // reports how many seconds it holds (rx.state.held); the camera view confirmed (camSince) still bounds it, since
    // frames from before the Drive Recorder view (a parking view, the ECU starting) are the wrong layout for a clip.
    let camSince = null;
    const filled = () => {
        const held = rx.state && rx.state.state === 'RECORDING' ? rx.state.held : 0;
        if (camSince === null) return 0;
        return Math.min(held, Math.floor((Date.now() - camSince) / 1000));
    };
    // 2.3.9: the ECU's state as it changes (main.js's camera events, the polls): the Drive Recorder frames count from when
    // it last showed the view asked for. A parking view (TOPREARVIEW, also the automatic camera at the car's start), the
    // ECU off or starting, or another view end them: frames of those are no clip's (G20 2026-11-06: a save 31 s after
    // the automatic camera asked 60 s and got nothing)
    // 2.3.13: one state decides, XView3D's, else icam2proxy's (as camCheck, probe and the status): checked against each in
    // turn, two that differ in form reset the count at every poll. An event (src 'xv' | 'icam') updates its own first.
    function camSeen(v, src) {
        if (src) st[src === 'xv' ? 'xvState' : 'camState'] = v;
        const s = [st.xvState, st.camState].find((x) => x && typeof x === 'object');
        if (!s || camView === null || probing) return;
        if (applied(camView, s)) {
            if (camSince === null) { camSince = Date.now(); log(`camera: ${camState(s)}, the Drive Recorder frames count from now`); changed(); }
        } else if (camSince !== null) {
            camSince = null;
            log(`camera: ${camState(s)}, not the Drive Recorder view: the frames count again when ${viewLabel(camView)} is back`);
            changed();
        }
    }

    function readProv() {
        if (!px.prov) return Promise.resolve();
        // logged on change: the car showed only the status box's first lines (1.0.10)
        const keep = (key, v) => { if (util.inspect(st[key]) !== util.inspect(v)) { st[key] = v; changed(); log(`provisioning ${key}:`, v); } };
        return Promise.all([
            Promise.resolve().then(() => px.prov.provisioningDataState.getValue())
                .then((v) => keep('provState', v), (e) => keep('provState', `ERR ${errText(e)}`)),
            Promise.resolve().then(() => px.prov.getValueJSON({ expression: [PROV_KEY] }))
                .then((r) => keep('prov', r && Array.isArray(r.value) ? r.value[0] : r && r.value), (e) => keep('prov', `ERR ${errText(e)}`)),
            // icam2proxy's own call: getValue(key) -> value + errorInfo
            Promise.resolve().then(() => px.prov.getValue({ expression: PROV_KEY }))
                .then((r) => keep('provRaw', r), (e) => keep('provRaw', `ERR ${errText(e)}`)),
        ]);
    }

    function poll() {
        return pollAll().then(() => camSeen());
    }
    function pollAll() {
        return Promise.all([readProv(), rxStatus(),
            get('svs', 'svsRecorderStatus', 'svsStatus'), get('svsData', 'storedRecordings', 'stored'),
            get('icam', 'currentState', 'camState'), get('cam', 'cameraProxyState', 'camProxy'), get('cam', 'streamInfo', 'camStream'),
            get('xv', 'CurrentState', 'xvState'), get('xv', 'DegradationDriveRecorder', 'drDeg')]);
    }


    // 2.4.0: the rolling buffer is the receiver daemon's RAM ring (mgu-driverec-rx) - always on, fixed size, nothing to
    // start, configure or reset. The clip length only sets the save's "before" / "after" seconds (len()). "Start with
    // the car" (settings.buffer) just governs whether DR mode is requested at start (autoCam); the ring itself always
    // runs while the daemon is up. keepBuffer is gone; the receiver's state is read by rxStatus() in the poll loop.
    function restartBuffer() {
        settings.buffer = true;
        saveSettings();
        changed();
        return Promise.resolve();
    }

    // ---- the clip folders: only "was a file written" and the own cap (the list is the player tool's) ----------------
    let recs = null, recFrom = '-';         // recs null = the clip folder can't be read
    function scanRecordings() {
        const clips = [];
        let denied = null;      // a clip folder that is there but can't be listed (a missing one = no clips)
        const walk = (dir, depth) => {
            let names = [];
            try { names = fs.readdirSync(dir); } catch (e) { if (!depth && e.code !== 'ENOENT') denied = denied || e; return; }
            for (const n of names) {
                const f = `${dir}/${n}`;
                let s;
                try { s = fs.lstatSync(f); } catch (e) { continue; }
                if (s.isDirectory()) { if (depth < 2) walk(f, depth + 1); continue; }
                if (s.isFile() && /\.ts$/i.test(n)) clips.push({ f, size: s.size, mtime: s.mtime.getTime() });
            }
        };
        REC_DIRS.forEach((d) => walk(d, 0));
        changed();
        if (denied) { recs = null; recFrom = `clip folder not readable (${errText(denied)})`; return log('clip folder not readable:', errText(denied)); }
        recs = clips; recFrom = 'clip folder';
    }

    // 2.4.0: the receiver writes the clip itself (the same <folder>/<id>…ts + _Thumbnail .jpg + _Metadata.json layout
    // icam2proxy used) and reports when it is done. The app only decides whether to allow the save (frames arriving, the
    // "before" held, the 4 GB cap) and shows the result. One save at a time.
    let saving = false;
    function saveClip() {
        if (!rx.up) { note('failed', 'not possible: the receiver is not running'); return Promise.resolve(false); }
        if (saving) { log('save: one is under way, tap ignored'); return Promise.resolve(false); }
        saving = true;
        const done = (r) => { saving = false; return r; };
        return rxStatus().then((s) => {
            const refuse = (text) => { note('failed', text); log(`save: ${text}`); return false; };
            if (!s || s.state !== 'RECORDING') return refuse(`not saved: no camera frames are arriving (DR mode: ${camMsg})`);
            // the seconds of Drive Recorder frames held (since the cameras last showed the view), less 1: a shorter clip
            // rather than a failed one; under MIN_BEFORE s nothing worth saving
            const want = len()[0], after = len()[1], have = filled(), now = new Date(), label = hms(now);
            if (have < MIN_BEFORE) return refuse(`not saved: the cameras have recorded only ${have} s so far (a parking view or the start has them until then)`);
            const before = Math.min(want, have - 1);
            if (before < want) log(`save: ${before} s before the tap, not ${want}: the cameras have recorded only ${have} s`);
            scanRecordings();
            if (api.tool.up && api.tool.full) return refuse('not saved: locked clips fill the 4 GB, unlock some first');
            const used = (recs || []).reduce((a, r) => a + (r.size || 0), 0);
            if (!api.tool.up && used + (before + after) * CLIP_RATE > CAP) return refuse(`not saved: clips use ${mb(used)} of ${mb(CAP)} and the player that replaces old clips is not running`);
            note('saving', `clip of ${label} saving…${before < want ? ` (${before} s before the tap: only that long recorded)` : ''} (${after} s after)`);
            return rxSave(before, after, REC_DIRS[0]).then((r) => {
                if (r.ok) { note('saved', `clip of ${label} saved${r.segs > 1 ? ` (${r.segs} parts)` : ''}`); scanRecordings(); }
                else note('failed', `clip of ${label} failed: ${r.text || 'see log'}`);
                log(lastClip);
                return r.ok;
            });
        }).then(done, (e) => { done(); log('save:', e); return false; });
    }

    // ---- camera DR mode -------------------------------------------------------------------------------------------
    let camView = null, camCookie = null;       // camView: the view asked for (a VIEWS req), null = released
    let attaching = null;   // the attach under way: a second request (start + a tab tap) waits for it - one cookie
    let camMsg = 'not requested';
    // enum arguments by name (getters return names); if the proxy refuses, once more as wire numbers
    const named = (fn, byName, byNumber) => Promise.resolve().then(() => fn(byName))
        .catch((e) => { log('enum names refused, trying numbers:', errText(e)); return fn(byNumber); });

    // CameraProxy 0xF789 is never offered on its own on the car (1.0.12): ICAM2Proxy extends it, so clientAttach /
    // clientDetach live on ICAM2Proxy. The catalogue lists only ICAM2Proxy's own changeState, so without a typed method
    // the call goes through the SDK proxy's native callMethod.
    function camCall(method, args) {
        if (px.cam) return px.cam[method](args);
        if (typeof px.icam[method] === 'function') return px.icam[method](args);
        if (px.icam._someIpProxy) return px.icam._someIpProxy.callMethod(method, args, 10000);
        return Promise.reject(new Error(`ICAM2Proxy has no ${method}`));
    }

    const camRequest = (app, view) => {
        const state = (a, m) => ({ cookie: camCookie, desiredState: { application: a, mode: m, perspective: view } });
        return named((a) => px.icam.changeState(a), state(app, 'MODE_MOSAIK'), state(CAM_WIRE[app], CAM_WIRE.MODE_MOSAIK));
    };

    // attached as icam2proxy's indirect client (one cookie: a second request waits for the attach under way)
    const attach = () => (camCookie !== null ? Promise.resolve(camCookie) : attaching || (attaching =
        named((a) => camCall('clientAttach', a), { type: 'CLIENT_INDIRECT' }, { type: CAM_WIRE.CLIENT_INDIRECT })
            .then((r) => { attaching = null; camCookie = r && typeof r === 'object' ? r.cookie : r; log(`camera: attached, cookie ${camCookie}`); return camCookie; },
                (e) => { attaching = null; throw e; })));

    // DR_ACTIVE with a view (attached first); the view is kept for the next start. A view this car doesn't have (2.0.0's
    // saved 9, never applied by the ECU; one the check didn't find) -> the first one it has. Not while views are checked.
    function setView(want) {
        const view = pick(want);
        if (probing) { log(`camera: view ${want} not asked, the views are being checked`); return Promise.resolve(); }
        if (view === null) { camMsg = 'no drive-recorder cameras found (Diagnostics: Check cameras)'; changed(); return Promise.resolve(); }
        settings.view = view;
        saveSettings();
        return ask(clusterView !== null ? clusterView : view);
    }

    // 2.1.6: the cluster widget (mgu-camcluster, main.js) shows one camera: while it does, that camera's own view is
    // asked for; settings.view stays the user's and is asked again when the widget goes. Only while DR mode runs.
    let clusterView = null;
    function setCluster(req) {
        const view = req !== null && pick(req) === req ? req : null;    // a view this car has, else none
        if (view === clusterView) return Promise.resolve();
        clusterView = view;
        log(`camera: cluster widget ${view === null ? `gone, back to ${viewLabel(settings.view)}` : `shows ${viewLabel(view)}`}`);
        if (camView === null || probing) return Promise.resolve();
        return ask(view !== null ? view : settings.view);
    }

    function ask(view) {
        if (!px.icam) { camMsg = `not possible: ICAM2Proxy ${link.icam || '-'}`; changed(); return Promise.resolve(); }
        return attach()
            .then(() => camRequest('DR_ACTIVE', view))
            .then(() => { camView = view; camMsg = `cookie ${camCookie}, requested DR_ACTIVE / MODE_MOSAIK / ${viewLabel(view)}`; log(`camera: ${camMsg}`); camCheck(view, 0); },
                (e) => { camMsg = `DR_ACTIVE ${viewLabel(view)} failed: ${errText(e)}`; log('camera request failed:', e); })
            .then(() => { changed(); poll(); });
    }

    // 2.0.3: which view numbers this car's camera ECU takes: each view asked for ms (attached first), then CurrentState
    // logged ("probe: asked N -> ..."); scripts/camprobe run at the same time shows the frames' tags. -> the CurrentState
    // seen per view, or null (not attached / a probe under way). The re-request check is off meanwhile.
    let probing = false;
    function probe(views, ms) {
        if (probing || !px.icam) return Promise.resolve(null);
        probing = true;
        camSince = null;
        clearTimeout(camTimer);
        changed();
        log(`probe: views ${views.join(' ')}, ${ms / 1000} s each`);
        const seen = [], wait = () => new Promise((r) => setTimeout(r, ms));
        // 2.3.7: on iDrive 7 the ECU is still starting for about 10 s after the attach (SIGNAL_UNFILLED): the first
        // view, all cameras, was asked then and found missing. A view counts as there when it was applied, and as
        // missing only when an ECU that was ready when asked did not apply it; else it is asked again (at most
        // NOT_READY_TRIES times in all)
        let wasReady = false, retries = 0;
        const step = (i) => {
            if (i >= views.length) { probing = false; log('probe: done'); return seen; }
            const askedReady = wasReady;
            return camRequest('DR_ACTIVE', views[i]).then(wait)
                .then(() => get('xv', 'CurrentState', 'xvState')).then(() => get('icam', 'currentState', 'camState'))
                .then(() => {
                    const s = [st.xvState, st.camState].find((x) => x && typeof x === 'object') || null;
                    log(`probe: asked ${views[i]} -> ${camState(st.camState)} (icam2proxy) · ${camState(st.xvState)} (XView3D)`);
                    wasReady = !notReady(s);
                    if (!applied(views[i], s) && !(askedReady && wasReady) && retries < NOT_READY_TRIES) {
                        retries += 1;
                        log(`probe: the cameras were not ready, ${views[i]} asked again (${retries}/${NOT_READY_TRIES})`);
                        return i;
                    }
                    seen[i] = s;
                    return i + 1;
                }, (e) => { log(`probe: asked ${views[i]} failed: ${errText(e)}`); return i + 1; })
                .then(step);
        };
        // the ECU's state before the first request: ready (iDrive 8, a running car) or still starting
        const first = () => get('icam', 'currentState', 'camState').then(() => { wasReady = !notReady(st.camState); });
        return attach().then(first).then(() => step(0)).catch((e) => { probing = false; log('probe stopped:', errText(e)); changed(); return null; });
    }

    // 2.1.0: the views this car records (see the header): saved, then the chosen view again (restore) or the camera given
    // back; none found -> given back
    function detect(restore) {
        // no camera service to ask (ICAM2Proxy not there: the VM, a car without it): none found, said so - not a tap
        // that does nothing (the first connect checks again: autoCam)
        if (!px.icam && !probing) {
            settings.views = []; saveSettings();
            camMsg = `no camera service: ICAM2Proxy ${link.icam || '-'}`; log(`cameras: none, ${camMsg}`); changed();
            return Promise.resolve(null);
        }
        return probe(VIEWS.map((v) => v.req), 6000).then((seen) => {
            if (!seen) return null;
            // 2.5.1: a camera ECU never ready during the check (still starting: the app starts with the car now) tells
            // nothing - the views saved stay; at the start it is checked again (autoCam)
            if (VIEWS.every((v, i) => notReady(seen[i]))) {
                log('cameras: the camera ECU was not ready during the check, nothing saved');
                return restore && checked() ? setView(settings.view) : camRelease();
            }
            settings.views = VIEWS.filter((v, i) => applied(v.req, seen[i])).map((v) => v.req);
            settings.viewsChecked = CANDIDATES; settings.view = pick(settings.view); saveSettings();    // (one it lacks: the first)
            log(`cameras: ${settings.views.length ? avail().map((v) => viewLabel(v.req)).join(', ') : 'no drive-recorder view applied'}`);
            return settings.views.length && restore ? setView(settings.view) : camRelease();
        });
    }

    // 2.0.0: at start (when ICAM2Proxy is there), unless "Start with the car" is off; 2.1.0: the views checked first
    // when none are saved. 2.5.1 (car-apps issue #23): the player starts the app with the car (1.2.6), about a minute
    // after the head unit, when the camera side may not take a request yet. 2.5.0 asked once: a refused attach or
    // changeState, or a check that met no ready camera ECU, left DR mode off until a view was picked by hand. Now asked
    // again every CAM_RETRY_MS until DR mode is requested (camView); not on a car checked to have no DR cameras.
    let autoTimer = null, autoTries = 0;
    function autoCam() {
        clearTimeout(autoTimer);
        if (settings.autoCam === false || camView !== null || probing) return Promise.resolve();
        if (Array.isArray(settings.views) && !settings.views.length && settings.viewsChecked === CANDIDATES) return Promise.resolve();
        autoTries += 1;
        if (autoTries > 1) { if (autoTries === 2 || autoTries % 20 === 0) log(`camera: DR mode at start not requested yet (${camMsg}), asked again every ${CAM_RETRY_MS / 1000} s`); }
        else if (!checked()) log('camera: DR mode at start, the views this car records checked first');
        else log(`camera: DR mode at start, ${viewLabel(pick(settings.view))}`);
        return (checked() ? setView(settings.view) : detect(true))
            .then(() => { if (camView === null) autoTimer = setTimeout(autoCam, CAM_RETRY_MS); });
    }

    // 5 s after a request the ECU view is read back; when it isn't the one asked for, the view is asked again, the second
    // time after another view the car has (a safety net: 2.0.1 found the real cause, view 9, see the header).
    // 2.5.1 (car-apps issues #23, #37): no giving up after the third check (that left DR mode off for the drive): from
    // then on the view is read back every CAM_RETRY_MS and asked again until the ECU shows it (G20: only once the engine
    // runs). Not asked while the ECU is still starting (SIGNAL_UNFILLED: it drops requests) or shows a camera view of the
    // car's own (CAR_VIEW: DR mode comes back after it by itself, and BMW's camera player is up) - those are waited out.
    let camTimer = null, camWas = '';
    function camCheck(want, tries) {
        clearTimeout(camTimer);
        camTimer = setTimeout(() => {
            camTimer = null;
            if (camCookie === null || camView !== want || probing) return;
            get('xv', 'CurrentState', 'xvState').then(() => get('icam', 'currentState', 'camState')).then(() => {
                const s = [st.xvState, st.camState].find((x) => x && typeof x === 'object');
                const shown = s ? Number(s.perspective) : want, other = (avail().find((v) => v.req !== want) || {}).req;
                if (byReq(want).shown.indexOf(shown) >= 0) {
                    if (camSince === null) camSince = Date.now();
                    if (camWas) { camWas = ''; camMsg = `cookie ${camCookie}, requested DR_ACTIVE / MODE_MOSAIK / ${viewLabel(want)}`; }
                    return null;
                }
                const wait = notReady(s) || CAR_VIEW.test(String(s.application)), via = tries === 1 && other;
                if (tries < 3 || camState(s) !== camWas) {        // (the slow re-checks: logged when the ECU's state changes)
                    log(`camera: the ECU shows ${wait ? camState(s) : `view ${shown}`}, ${wait ? 'waiting' : `asking ${via ? `${other} then ` : ''}${want} again`}`);
                }
                camWas = camState(s);
                if (tries >= 2) camMsg = `${viewLabel(want)} requested, the ECU shows ${camWas}: checked every ${CAM_RETRY_MS / 1000} s`;
                if (wait) return camCheck(want, tries + 1);
                return (via ? camRequest('DR_ACTIVE', other) : Promise.resolve())
                    .then(() => camRequest('DR_ACTIVE', want))
                    .then(() => camCheck(want, tries + 1), (e) => { log('camera request failed:', e); camCheck(want, tries + 1); });
            }).then(() => { changed(); poll(); });
        }, tries > 2 ? CAM_RETRY_MS : 5000);
    }

    function camRelease() {
        clearTimeout(camTimer);
        camView = null; camSince = null;
        if (camCookie === null || !(px.cam || px.icam)) return Promise.resolve();
        const c = camCookie;
        return Promise.resolve().then(() => camCall('clientDetach', { cookie: c }))
            .then(() => { camCookie = null; camMsg = `released (cookie ${c})`; log(`camera: ${camMsg}`); },
                (e) => { camMsg = `release failed: ${errText(e)}`; log('camera release failed:', e); })
            .then(changed);
    }

    // ---- status (Diagnostics + the Record page) -------------------------------------------------------------------
    // 2.4.0: no provisioning / coding gate - the receiver daemon taps the camera stream itself. The verdict reports the
    // receiver and, for information only, the provisioning state the car reports (no longer the limiting factor).
    function gates() {
        let verdict;
        if (rx.up && rx.state && rx.state.state === 'RECORDING') verdict = 'Recording: the receiver is holding camera frames.';
        else if (rx.up) verdict = 'Receiver running, waiting for camera frames (turn DR mode on: pick a camera view).';
        else verdict = 'The receiver is not running (the player tool iteriodev-driverec-rx must be installed and started).';
        return [`Receiver: ${rx.up ? `up ${rx.version || ''}`.trim() : 'down'}${rx.state ? ` · ${rx.state.state}, holds ${rx.state.held} s (${mb(rx.state.bytes)}, ${rx.state.fps} fps, persp ${rx.state.persp})` : ''}`,
            verdict,
            `Provisioning (info only): data state ${show(st.provState)}`];
    }

    function statusText() {
        return gates().concat([
            `Last clip: ${lastClip}`,
            `Recordings: ${recs ? `${recs.length} (${recFrom})` : recFrom}`,
            `SVS recorder: ${show(st.svsStatus)} · stored: ${Array.isArray(st.stored) ? st.stored.filter((r) => r && r.recordingID).length : show(st.stored)}`,
            `Camera ECU: ${camState(st.camState)} (icam2proxy) · ${camState(st.xvState)} (XView3D) · DR degradation ${st.drDeg && typeof st.drDeg === 'object' ? st.drDeg.DegradationDriveRecorder : show(st.drDeg)}`,
            `Camera proxy: ${show(st.camProxy)} · stream ${camStream(st.camStream)} · DR mode: ${camMsg}`,
            `Camera views: ${probing ? 'being checked…' : !Array.isArray(settings.views) ? 'not checked yet' : settings.views.length ? avail()
                .map((v) => viewLabel(v.req)).join(', ') + (checked() ? '' : ' (checked again at the next start)') : 'none found (no drive-recorder cameras)'}`,
            `Services: ${Object.keys(IF).map((k) => `${k} ${link[k] || '-'}`).join(' · ')}`,
        ]);
    }

    api.status = () => {
        const s = [st.xvState, st.camState].find((x) => x && typeof x === 'object');
        return {
            // vb: the receiver's recording state (the Record page reads it like the old buffer state), null = down
            vb: rx.up ? (rx.state ? rx.state.state : '?') : null, verdict: gates()[1],
            camView, camOk: !!camView && applied(camView, s),
            camLayout: camView && byReq(camView) ? byReq(camView).layout : null,
            camMsg,
            view: pick(settings.view),                    // the view chosen (null: the car has none)
            views: avail().map((v) => ({ req: v.req, label: v.label, name: v.name, layout: v.layout })),
            checking: probing,
            autoCam: settings.autoCam !== false,
            length: settings.length, before: len()[0], after: len()[1],
            filled: filled(),       // seconds of usable frames held (Save from MIN_BEFORE on, shorter until "before")
            minBefore: MIN_BEFORE, window: rx.state ? rx.state.held : 0,
            lastClip, lastState,
            lines: statusText(),
        };
    };
    api.start = () => {
        scanRecordings();
        Object.keys(IF).forEach(connect);
        rxConnect();
        // no screen open: the receiver's state is still read every 10 s (RECORDING / held seconds for the Record page)
        let ticks = 0;
        setInterval(() => {
            ticks++;
            if (api.active) poll(); else if (ticks % 5 === 0) rxStatus();
        }, POLL_MS);
    };
    api.save = saveClip; api.setView = setView; api.setCluster = setCluster; api.camEvent = camSeen;
    api.detect = () => detect(camView !== null);        // Diagnostics: the camera as it was afterwards
    api.probe = (views) => probe(views, 8000).then((seen) => (seen ? setView(settings.view) : null));
    api.setLength = (i) => { settings.length = LENGTHS[i] ? i : 1; return restartBuffer(); };   // restartBuffer saves it
    api.restart = restartBuffer; api.release = camRelease;
    return api;
}

module.exports = { create, LENGTHS, REC_DIRS, VIEWS };
