'use strict';
/*
 * oap-turnview ("Turn View"): the control panel of the iteriodev-turnview tool, the front camera in the iDrive 8
 * cluster widget with the next turn drawn on the road (spec docs/superpowers/specs/2026-11-06-turn-view-design.md 3.2,
 * 3.4, 4.3). Everything shown is the tool's: this app talks to it over its control socket (JSON lines, CTL) and shows
 * what it pushes; it sets on / off and the camera calibration (sliders = live previews, Save stores them, leaving the
 * page without Save puts the saved values back: the tool does that on calib off or on a closed socket).
 *   -> { op: 'get' | 'reset' } | { op: 'set', settings: { enabled?, cal? } } | { op: 'preview', cal } | { op: 'calib', on }
 *      | { op: 'camreq', state }
 *   <- { state: { settings: { enabled, cal: { h, pitch, fov, yaw, x } }, status: { camera, rect, route, provider,
 *        maneuver: { kind, angle, side, exit, text } | null, cr, nav, state, camreq, widget } } }
 * 1.3.0 (user 2026-11-14): no pop-up any more (1.2.0's popupRow). Turn View is a widget in the cluster's widget menu:
 * its own "Turn View AR" (the tool's cluster-render drop-in) or cluster-render's "Cluster renderer" - status.widget,
 * the entry the texts tell the user to pick.
 * 1.4.0: iDrive 7 and iDrive 8 in one package (Drive Recorder 2.3.6's way: a source package, rhmiData for both HMIs,
 * the iDrive 8 design scaled into iDrive 7's app area by screenapp.js). On iDrive 7 (status.backend 'id7', tool 0.6.0)
 * the camera replaces the map in the cluster's centre: the texts say to set Instrument cluster > Central display area
 * to Map view (status.widget) instead of picking a widget. The camera shows with or without a route ('off' = Turn
 * View switched off). ACTIVE at every start, a background one too, and again when the screen goes (iDrive 7's manager
 * stops an app that is not; its host reports INACTIVE when the screen goes): the camera request runs in the background.
 * The app's own job: the camera request (camreq.js, Drive Recorder's functions): the front view asked of the camera
 * ECU while the widget shows it and no other app asks. It runs from the start, with or without a screen: the tool
 * starts this app in the background (hmictl start, no RHMI application: the host never calls onReady then); its
 * state goes to the tool on every change and on each connect; at shutdown the camera is given back.
 * 1.6.0 (user 2026-11-19, tool 0.9.0: a kerb-parking aid, at any speed): the Camera page (home's Camera button, Back
 * returns): "Picture on: Cluster | Head unit" (settings.picture) and, on the head unit, the camera's whole frame from
 * the tool (renderer protocol 4: FRAMES, written by mgu-camcluster while the page is open: { op: 'view', on }) with
 * the tool's { view } over it - the turn card (its pixels in CARD_FILE) and the turn sign's quads. No speed limit.
 * 1.7.0 (user 2026-11-20, tool 0.10.0, mock-ups approved): "Camera: Front | Night Vision" (settings.camera) on the
 * Camera page, only on a car whose head unit has the Night Vision chip (status.nv): BMW Night Vision's picture instead of
 * the front camera, in the cluster or here (the tool draws no turn sign over it; Calibrate hidden).
 *
 * Screens: drawn by the GPU renderer, designed in the HMI UI builder: apps/hmi-ui-builder/projects/turnview.json
 * (scripts/oap-tools/make_turnview_project.js), exported into this folder (rhmiData/ = one empty RHMI host state per
 * screen, renderer/ = screens.json + the builder's runtime). Start, tile and shutdown: the shared OnlineApp host
 * (oap-shared/online-host.js).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');
const someipBuilders                   = require('oap-sdk/src/someip/someipBuilders');
const { createHost }                   = require('./online-host.js');
const camreq                           = require('./camreq.js');

const LOG = '[iteriodev_turnview]';
const STATES = ['home', 'calib', 'camera'];   // screens = their RHMI host states, home the entry
const CTL = process.env.TURNVIEW_CTL || '/run/iteriodev-turnview/ctl.sock';
const RETRY_MS = 2000;
// the head unit's picture (1.6.0): the tool's camera frames and its card's pixels (360 x 150 RGBA, premultiplied)
const FRAMES = process.env.TURNVIEW_HU_FILE || '/dev/shm/mgu-video-turnview';
const CARD_FILE = process.env.TURNVIEW_CARD_FILE || '/run/iteriodev-turnview/card.rgba';

// the linked bundle is javascript/app.js: the package root (next to renderer/) is its parent folder, the app's data
// folder beside that (the Store's)
const SOURCE = typeof __dirname === 'string' ? path.join(__dirname, '..') : `/var/opt/public/oap/oap_${process.getuid()}/source`;
const DATA = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = `${DATA}/turnview.log`;

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) { /* no file yet */ }
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (e) { /* no data folder */ }
}

// ---- the camera request (spec 4.3) ------------------------------------------------------------------------
const cam = camreq.create({ someipBuilders, log });
const sendCamreq = () => send({ op: 'camreq', state: cam.status().state });
cam.on('change', () => { sendCamreq(); render(); });

// ---- the tool ---------------------------------------------------------------------------------------------
let tool = null;                  // its last state, null = no connection
let sock = null;
let busy = false;                 // a connection being made
let calibrating = false;          // the Calibrate page is open: the tool draws the marks, sliders preview
let draft = null;                 // the sliders' values while calibrating (null: the saved ones, from the tool)
let saved = false;                // Save tapped, no slider moved since
let viewing = false;              // the Camera page is shown (the tool writes the head unit's frames then)
let view = null;                  // the tool's last { view } (head unit picture state, card, sign)

function connect() {
    if (sock || busy) return;
    busy = true;
    const s = net.connect(CTL);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => {
        busy = false; sock = s; log('tool connected');
        sendCamreq();
        // the tool restored the saved values when the old connection closed: the page's again
        if (calibrating) { send({ op: 'calib', on: true }); if (draft) send({ op: 'preview', cal: draft }); }
        if (viewing) send({ op: 'view', on: true });
    });
    s.on('data', (d) => {
        buf += d;
        for (let n; (n = buf.indexOf('\n')) >= 0; buf = buf.slice(n + 1)) {
            let m;
            try { m = JSON.parse(buf.slice(0, n)); } catch (e) { continue; }
            if (m.state) tool = m.state;
            if (m.view) {
                // frames again (camcluster started after the renderer was told the file): named afresh, as Drive Recorder
                if (m.view.hu === 'decoding' && (!view || view.hu !== 'decoding') && gpu) { gpu.video(1, null); gpu.video(1, FRAMES); }
                view = m.view; loadCard();
            }
            render();
        }
    });
    s.on('error', (e) => { if (!/ENOENT|ECONNREFUSED/.test(e.code)) log('tool:', e.message); });
    s.on('close', () => { busy = false; sock = null; tool = null; view = null; render(); setTimeout(connect, RETRY_MS); });
}
const send = (q) => { if (sock) sock.write(`${JSON.stringify(q)}\n`); };

// ---- screens (the renderer) ----------------------------------------------------------------------------
const RENDERER = path.join(SOURCE, 'renderer');
const runtime = (f) => require(path.join(RENDERER, f));
const localization = runtime('localization.js');
let stopLanguage = null;
let screens = null;

const NO_TOOL = [['Turn View tool not running', 'crit']];
const id7 = (st) => !!st && st.backend === 'id7';
// iDrive 7's own layout (its rows half as wide): the shorter lines - by the screen, also without a tool or cluster-render
const narrow = (st) => id7(st) || !!(screens && screens.gpu.screen && screens.gpu.screen.w && screens._hu() === 'id7');
// where the camera shows: iDrive 8 the widget menu entry to pick (the tool's, tool 0.4.0+, else cluster-render's own),
// iDrive 7 the Central display area setting (tool 0.6.0: 'Map view')
const widgetName = (st) => (st && typeof st.widget === 'string' && st.widget) || (id7(st) ? 'Map view' : 'Cluster renderer');
// (iDrive 7, tool 0.7.0: off at every start of the car, switched on here)
const pickText = (st) => (id7(st) ? `Off at every car start · Central display area: ${widgetName(st)}`
    : `Pick "${widgetName(st)}" in the cluster's widget menu`);
// the camera line: camcluster's video state as the tool reports it -> [text, colour]
function cameraLine(s) {
    switch (s.camera) {
        case 'decoding': return s.rect === 'half' ? ['Pair view (no chevrons)', 'warn'] : ['Front camera', 'ok'];
        case 'waiting': return ['Waiting for the camera', ''];
        // (iDrive 7: short, the row is half as wide; the toggle row's line says where to set it)
        case 'idle': return [id7(s) ? `Waiting for ${widgetName(s)}` : `Pick "${widgetName(s)}" in the cluster's widgets`, ''];
        case 'stalled': return ['Camera busy', 'warn'];
        // (tool 0.6.1: the cluster's 2 videos are other apps', e.g. Waze on cluster's map + HUD map; asked again)
        case 'refused': return ['Cluster video full', 'crit'];
        case 'off': return ['Off', ''];                // (tool 0.6.0: the camera shows without a route too)
        case 'restarting': return ['Camera tool restarting', 'warn'];
        case 'missing': return ['Camera tool missing', 'crit'];
        default: return [s.camera || '--', ''];
    }
}
const ROUTE = { none: ['No route', ''], active: ['Active', 'ok'], recalculating: ['Recalculating', 'warn'] };
const CR_STATE = { connected: 'Connected', connecting: 'Starting', 'not running': 'Not running', missing: 'Not installed', 'iDrive 8 only': 'iDrive 8 only', unsupported: 'Not supported here' };
const SLIDERS = { hRow: 'h', pitchRow: 'pitch', fovRow: 'fov', yawRow: 'yaw', xRow: 'x' };
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function render() {
    if (!screens) return;
    const t = tool, st = t && t.status, set = t && t.settings;
    // home
    screens.set('homeMenu', !t ? { chips: NO_TOOL, sub: 'Install it from the Store, then restart the head unit' }
        : { chips: [], sub: `Camera navigation view in the cluster ${id7(st) ? 'centre' : 'widget'}` });
    screens.set('enableRow', { on: !t || set.enabled, sub: pickText(st) });
    const onHu = !!set && set.picture === 'hu';             // (1.6.0: the picture on the head unit's Camera page)
    const nv = nvOn(st, set);                               // (1.7.0: Night Vision's picture)
    const camLine = !st ? ['--', ''] : onHu ? ['On the head unit', 'ok'] : nv && st.camera === 'decoding' ? ['Night Vision', 'ok'] : cameraLine(st);
    screens.set('cameraRow', { text: camLine[0], textColor: camLine[1],
        sub: onHu ? 'Camera button: the picture on this screen' : nv ? 'Night Vision in the cluster' : 'The front camera in the cluster' });
    const route = st ? (st.nav === 'no navigation data' ? ['No navigation data', 'warn'] : ROUTE[st.route] || [st.route, '']) : ['--', ''];
    screens.set('routeRow', { text: route[0], textColor: route[1],
        sub: st && st.nav === 'no navigation data' ? (narrow(st) ? 'No guidance: is navigation on?' : 'The car sends no guidance: is the navigation running?')
            : 'Guidance from the car' });
    screens.set('providerRow', { text: (st && st.provider) || '--' });
    const m = st && st.maneuver;
    screens.set('maneuverRow', { text: m ? `${m.text} · ${m.kind}${m.exit ? ` · exit ${m.exit}` : ''}` : st && st.route === 'active' ? 'None ahead' : '--' });
    screens.set('crRow', { text: st ? CR_STATE[st.cr] || st.cr : '--',
        textColor: !st || st.cr === 'connecting' ? '' : st.cr === 'connected' ? 'ok' : 'crit',
        sub: `${st && st.cr === 'missing' ? 'Install ' : ''}${narrow(st) ? '' : 'robertnisipeanu/'}idrive-apps${st && st.cr === 'missing' ? '' : ','} 0.5.10 or newer`,
        subColor: st && st.cr === 'missing' ? 'warn' : '' });
    const cs = cam.status();
    screens.set('camreqRow', { text: cap(cs.text), textColor: cs.state === 'on' ? 'ok' : cs.state === 'refused' || cs.state === 'rearonly' ? 'crit' : cs.state === 'asked' ? 'warn' : '' });
    // calib: the sliders show the draft (the saved values until one moves)
    if (calibrating && !draft && set) draft = Object.assign({}, set.cal);
    screens.set('calibMenu', { chips: !t ? NO_TOOL : saved ? [['Saved', 'ok']] : [] });
    if (draft) Object.keys(SLIDERS).forEach((row) => { if (typeof draft[SLIDERS[row]] === 'number') screens.set(row, { value: draft[SLIDERS[row]] }); });
    renderCamera(t, st, set);
}

// ---- the Camera page (1.6.0) ------------------------------------------------------------------------------
const HU_LINE = { decoding: ['Front camera', 'ok'], waiting: ['Waiting for the camera', ''], stalled: ['Camera busy', 'warn'], off: ['Starting', ''] };
const NV_LINE = { decoding: ['Night Vision', 'ok'], waiting: ['Waiting for Night Vision', ''], stalled: ['No Night Vision picture', 'warn'], off: ['Starting', ''] };
// (1.7.0) the head unit has the Night Vision chip (tool 0.10.0's status.nv; 'busy': BMW's own screen took it first)
const NV_CAR = { holding: true, streaming: true, nosignal: true, busy: true };
const nvCar = (st) => !!st && !!NV_CAR[st.nv];
const nvOn = (st, set) => nvCar(st) && !!set && set.camera === 'nv';
let colors = {};                  // the design's ok / warn / dim / text colours (tele-widgets C), from the renderer
let cardImg = null, cardKey = '', cardLoading = '';
function renderCamera(t, st, set) {
    const hu = !!set && set.picture === 'hu', vs = (view && view.hu) || 'off', shown = hu && !!view && vs === 'decoding';
    const car = nvCar(st), nv = nvOn(st, set), busy = nv && st.nv === 'busy';
    screens.set('cameraMenu', { sub: nv ? 'Night Vision on this screen, at any speed' : 'The front camera on this screen, at any speed' });
    screens.set('pictureSeg', { sel: hu ? 1 : 0, disabled: !t });
    screens.set('pictureHint', { text: hu ? 'Any speed: kerbs, gaps, turns' : 'Head unit: the camera here, at any speed' });
    screens.set('camSeg', { hidden: !car, sel: nv ? 1 : 0, disabled: !t });
    const why = !t ? 'Turn View tool not running' : !hu ? 'The picture is in the cluster now'
        : busy ? 'BMW\'s Night Vision screen has it: restart the head unit'
        : nv ? (vs === 'stalled' ? 'No Night Vision picture' : 'Waiting for Night Vision')
        : st && st.noFront ? 'No front camera' : vs === 'stalled' ? 'Camera busy: a parking view has the cameras' : 'Waiting for the camera';
    const sign = shown && view.sign, card = shown && view.card && cardImg && cardKey === view.cardKey ? view.card : null;
    screens.set('camVideo', { show: shown, text: shown ? '' : why, quads: sign ? sign.quads : null, quadAlpha: sign ? 0.85 * sign.a : 0,
        over: card ? 'key:tvcard' : '', overRect: card ? [card.x, card.y, card.w, card.h] : null });
    const line = !t ? ['--', ''] : busy ? ['Taken by BMW Night Vision', 'warn'] : hu ? (nv ? NV_LINE : HU_LINE)[vs] || [vs, ''] : ['In the cluster', ''];
    if (narrow(st)) {               // iDrive 7: Camera instead of the hint, no state line or Calibrate on this page
        screens.set('camTitle', { hidden: !car });
        screens.set('pictureHint', { hidden: car });
    } else {                        // iDrive 8: the state under the Camera choice when it is there
        screens.set('camState', { hidden: car, text: line[0], color: colors[line[1]] || colors.text });
        screens.set('nvState', { hidden: !car, text: line[0], color: colors[line[1]] || colors.text });
        screens.set('camCalibrate', { hidden: nv });
    }
    const m = st && st.maneuver;
    screens.set('turnDist', { text: m ? m.text : st && st.route === 'active' ? 'None ahead' : 'No route', color: m ? colors.text : colors.dim });
    screens.set('turnText', { text: m ? [cap(m.kind || ''), m.exit ? `exit ${m.exit}` : '', st.provider || ''].filter(Boolean).join(' · ') : '' });
}
// the card's pixels: the tool writes CARD_FILE, then names it by its key; read once per key
function loadCard() {
    if (!kit || !view || !view.cardKey || view.cardKey === cardKey || view.cardKey === cardLoading) return;
    const key = cardLoading = view.cardKey, w = view.cardW, h = view.cardH;
    fs.readFile(CARD_FILE, (err, buf) => {
        if (cardLoading === key) cardLoading = '';
        if (err || !screens || buf.length !== w * h * 4) { if (err) log('card:', err.message); return; }
        const old = cardImg;
        cardImg = kit.makeImage(w, h, buf); cardKey = key;
        screens.setImage('tvcard', cardImg);
        if (old) { gpu.dropImage(old); kit.dropImage(old); }
        render();
    });
}
function setViewing(on) {
    if (on === viewing) return;
    viewing = on;
    if (!on) view = null;
    send({ op: 'view', on });
}

// ---- what the user does ---------------------------------------------------------------------------------
function startCalib() {
    if (calibrating) return;
    calibrating = true; draft = null; saved = false;
    send({ op: 'calib', on: true });
    render();
}
// leaving the page (Back, the HMI's BACK, another screen, the app closed): the tool puts the saved values back
function leaveCalib() {
    if (!calibrating) return;
    calibrating = false; draft = null; saved = false;
    send({ op: 'calib', on: false });
}
const EVENTS = {
    camera: () => showScreen('camera'),
    calibrate: () => { startCalib(); showScreen('calib'); },
    save: () => { const cal = draft || (tool && tool.settings.cal); if (cal) { send({ op: 'set', settings: { cal } }); saved = true; render(); } },
    reset: () => { send({ op: 'reset' }); draft = null; saved = false; },    // the tool pushes the defaults: the sliders follow
};
function onEvent(name) { if (EVENTS[name]) EVENTS[name](); }
function onChange(name, o) {
    if (name === 'enableRow') return send({ op: 'set', settings: { enabled: !!o.on } });
    if (SLIDERS[name] && typeof o.value === 'number') {
        draft = Object.assign({}, draft || (tool && tool.settings.cal));
        draft[SLIDERS[name]] = o.value;
        saved = false;
        send({ op: 'preview', cal: draft });
        return render();
    }
    if (name === 'pictureSeg' && (o.sel === 0 || o.sel === 1)) return send({ op: 'set', settings: { picture: o.sel === 1 ? 'hu' : 'cluster' } });
    if (name === 'camSeg' && (o.sel === 0 || o.sel === 1)) return send({ op: 'set', settings: { camera: o.sel === 1 ? 'nv' : 'front' } });
    // the one tab (Status): from the Calibrate or Camera page it goes back home
    if (name === 'calibMenu') { screens.set(name, { sel: 0 }); closeScreen('calib'); }
    if (name === 'cameraMenu') { screens.set(name, { sel: 0 }); closeScreen('camera'); }
    return null;
}

// ---- RHMI: the host states (the shared OnlineApp host hands over the RHMI application) -------------------
let app = null, gpu = null, kit = null;
const comp = (n) => app.getByName(n);
function showScreen(name) {
    return comp(name).updateResources().then(() => app.openState(name))
        .then(() => log(`opened ${name}`))
        .catch((e) => log(`open ${name} failed:`, e));
}
const closeScreen = (name) => app.closeState(name).catch((e) => log(`close ${name} failed:`, e));

function startScreens(rhmiApp) {
    app = rhmiApp;
    const design = JSON.parse(fs.readFileSync(path.join(RENDERER, 'screens.json'), 'utf8'));
    const { RenderClient } = runtime('kit/renderd.js');
    const { ScreenApp } = runtime('screenapp.js');
    const rlog = { info: (m) => log(m), warn: (m) => log(m), error: (m) => log(m) };
    kit = runtime('kit/record.js');
    const C = runtime('tele-widgets.js').C;
    colors = { ok: C.ok, warn: C.warn, dim: C.dim, text: C.text };
    gpu = new RenderClient('iteriodev_turnview', rlog);
    gpu.video(1, FRAMES);                        // the tool's camera frames (renderer protocol 4), the Camera page's
    screens = new ScreenApp(gpu, design, { view: 'id8', log: rlog });
    const hosts = {};
    STATES.forEach((s) => { hosts[s] = comp(s); });
    screens.bindHosts(hosts, { open: (name) => showScreen(name), close: closeScreen });
    screens.on('event', (n) => { try { onEvent(n); } catch (e) { log(`${n} failed:`, e); } });
    screens.on('change', (n, o) => { try { onChange(n, o); } catch (e) { log(`${n} failed:`, e); } });
    screens.on('show', (name) => { if (name === 'calib') startCalib(); else leaveCalib(); setViewing(name === 'camera'); render(); });
    // the user left for the HMI (touched it): leave the host states too, or the HMI would show its empty page
    screens.on('closed', (why) => { leaveCalib(); setViewing(false); if (why !== 'hmi') STATES.slice().reverse().forEach(closeScreen); });
    gpu.connect();
    render();
    stopLanguage = localization.watch(someipBuilders, () => screens._draw(), log);
}

// ---- lifecycle: the camera request and the tool from the start; the screens when the host hands them over --
log('start', process.getuid());
cam.start();
connect();
const active = () => Promise.resolve(host.registerActive()).catch((e) => log('registerActive failed:', e));
const host = createHost({
    states: STATES,
    log,
    alwaysActive: true,         // 1.4.0 (Drive Recorder 2.3.6): iDrive 7's manager stops an app that is not ACTIVE
    onReady: (rhmiApp) => { startScreens(rhmiApp); log('screens ready'); },
    onHidden: active,           // iDrive 7's host reports INACTIVE when the screen goes: the camera request runs on
    // give the camera back first (an attached indirect client stays in icam2proxy otherwise), at most 2 s
    onShutdown: () => {
        if (stopLanguage) stopLanguage();
        return Promise.race([cam.release(), new Promise((r) => setTimeout(r, 2000))]);
    },
});
