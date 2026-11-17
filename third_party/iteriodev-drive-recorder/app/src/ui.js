'use strict';
/*
 * Drive Recorder 2.2: what the screens show and what a tap does - no HMI, no renderer, no socket, no services (main.js
 * wires those), so all of it runs in a test. Screens = apps/hmi-ui-builder/projects/drive-recorder.json, made by
 * scripts/oap-tools/make_driverec_project.js (record, clips, viewer, export, settings, confirm, diag; 2.2.0: the
 * Telemetry design, the tabs Record | Clips | Settings in each screen's frame 'nav'). Node 8.
 *   const ui = new Ui({ now });              now() -> ms (a test pins the clock)
 *   ui.setRecorder(status)                   recorder.js status()
 *   ui.setTool(up, version)                  the player tool's socket came / went (version from its hello)
 *   ui.setClips(list, total, full)           the tool's clip list (player.js clips, newest first)
 *   ui.setPlayer(state) / ui.setUsb(stick)   the tool's playback state / USB stick (player.js state, stick)
 *   ui.setSpeed(kmh, at) / ui.setMeta(at)    the car's speed / the clip's speed + time at the position (meta.js)
 *   ui.done(d) / ui.copying(c)               the tool's replies (lock, unlock, delete, copy) and copy progress
 *   ui.setShown(page | null) / ui.tick()     the screen on the display; once a second (the parked rule)
 *   ui.change(page, element, opts) / ui.event(page, name)   taps (ScreenApp 'change' / 'event')
 *   ui.values(page) -> { element: opts } for ScreenApp.set(); ui.take() -> [{ do, ... }] for main.js to run:
 *     go / close (page), tab (page), save, view (view), detect, setting (key len | auto, value), open /
 *     play (id, at), pause, resume, seek (s), cam (n), stop, lock (id, on), delete (id), copy (id, what), usb,
 *     exportPics (id)
 * Video only while the car stands still (fresh speed under 3 km/h, as YouTube): driving pauses it once. Pictures are
 * 'key:t:<clip id>': main.js keeps the tool's thumbnails of ui.thumbIds() loaded (ScreenApp.setImage), the grid rows
 * shown and the last clip (4 GB hold about 55 clips: not all of them); the Copy to USB page's 'key:x:<what>' are that
 * clip's thumbnail cut per camera (crop, exportOptions). A tap's opts.tap is cleared with the next values (a list
 * scrolled after a tap sends the old tap again otherwise).
 * 2.1.0: layouts 0-6 (player.js cams); Copy to USB is a page: as recorded or one camera's stamped MP4 (tool 1.1.0).
 */
// the Telemetry colours (renderer tele-widgets.js C) for text / rect elements; tele elements take their names (ok, warn, crit)
const CRIT = '#ff3b30', WARN = '#ffb020', OK = '#5bd68a', TEXT = '#f2f2f2', DIM = '#8b9099', FAINT = '#4a4f57';
const PARKED_KMH = 3, SPEED_FRESH_MS = 3000, NOTE_MS = 8000, SEEK_SHOWN_MS = 4000, GB4 = 4 * 1073741824;
const TABS = ['record', 'clips', 'settings'];                                                     // the frame's tabs
const TAB_OF = { record: 0, clips: 1, viewer: 1, export: 1, confirm: 1, settings: 2, diag: 2 };   // a sub-page: its parent's tab
const CAM_NAMES = ['', 'Front', 'Rear', 'Left', 'Right'];
const CAM_KEYS = ['all', 'front', 'rear', 'left', 'right'];       // the tool's copy <what>: cam n = its index
// per layout (player.js cams): name, cameras (cam n), the viewer video's parts (2x2, top / bottom, one picture)
const LAYOUT = ['all cameras', 'front + rear', 'left + right', 'front camera', 'rear camera', 'left camera', 'right camera'];
const CAMS = [[1, 2, 3, 4], [1, 2], [3, 4], [1], [2], [3], [4]];
const PARTS = [4, 2, 2, 0, 0, 0, 0];
const RES = ['All four cameras · each 640 × 480', 'Front + rear · each 1280 × 480', 'Left + right · each 1280 × 480'];
const MP4_RATE = [500000, 750000];        // bytes per second of a camera's MP4 (tool: ~4 Mbit/s 640x480, ~6 Mbit/s wider)
const TILES = 5;                          // the export page's t0..t4
const lay = (cams) => (CAMS[cams] ? cams : 0);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IDLE = { state: 'idle', clip: '', pos: 0, dur: 0, cam: 0, cams: 0, text: '' };
const ACTIVE = ['loading', 'playing', 'paused'];
// the Clips grid (drive-recorder.json: teleClipGrid 472 high, rows 236, 3 columns): pictures for the rows shown + one each side
const GRID_COLS = 3, GRID_ROWS = 2;

const pad = (n) => (n < 10 ? '0' : '') + n;
const clock = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const size = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round((b || 0) / 1048576)} MB`);
// clip id (YYYYMMDD_HHMMSS) -> "Today 13:42" | "Yesterday 18:05" | "28 Oct 09:15"
function when(id, now) {
    const m = /^(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)/.exec(id || '');
    if (!m) return id || '';
    const d = new Date(+m[1], +m[2] - 1, +m[3]), today = new Date(now), t = `${m[4]}:${m[5]}`;
    const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - d) / 864e5);
    return days === 0 ? `Today ${t}` : days === 1 ? `Yesterday ${t}` : `${+m[3]} ${MON[+m[2] - 1]} ${t}`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const up = (s) => String(s || '').toUpperCase();          // the design's caps labels
const short = (s, n) => { s = cap(String(s || '')); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The Copy to USB page's options for a clip of layout cams: as recorded (named by the layout), then each camera's MP4. */
function exportOptions(cams) {
    const l = lay(cams);
    return [{ what: 'all', label: cap(LAYOUT[l]), sub: 'Whole clip as recorded' }]
        .concat(CAMS[l].map((n) => ({ what: CAM_KEYS[n], label: CAM_NAMES[n], sub: `MP4 · ${CAM_KEYS[n]} camera` })));
}
/**
 * A tile picture: the tool's 320x240 RGBA thumbnail of a clip of layout cams cut for `what` -> { w, h, data } (4:3):
 * a quadrant (all cameras: TL front, TR rear, BL left, BR right), a half (top / bottom) letterboxed into 320x240 (the
 * camera is 8:3), or all of it ('all', a single-camera clip).
 */
function crop(buf, cams, what) {
    const W = 320, H = 240, l = lay(cams), i = CAMS[l].indexOf(CAM_KEYS.indexOf(what));
    if (i < 0 || !PARTS[l]) return { w: W, h: H, data: buf };
    const four = PARTS[l] === 4, w = four ? W / 2 : W, h = H / 2, x0 = four ? (i % 2) * w : 0, y0 = (four ? i >> 1 : i) * h;
    const top = four ? 0 : H / 4, out = Buffer.alloc(w * (four ? h : H) * 4);
    if (!four) for (let k = 3; k < out.length; k += 4) out[k] = 255;      // the bars: black
    for (let y = 0; y < h; y++) buf.copy(out, (top + y) * w * 4, ((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + w) * 4);
    return { w, h: four ? h : H, data: out };
}

class Ui {
    constructor(o) {
        o = o || {};
        this.now = o.now || Date.now;
        this.queue = [];
        this.rec = { vb: null, verdict: '', camView: null, camOk: false, camLayout: null, camMsg: '', view: null, views: [], checking: false,
            autoCam: true, before: 20, after: 10, filled: 0, lastClip: '', lastState: '', lines: [] };
        this.up = false; this.version = '';
        this.clips = []; this.total = 0; this.full = false;
        this.st = Object.assign({}, IDLE);
        this.speed = null; this.drivePaused = false;
        this.shown = null;
        this.filter = 0;                     // clips: 0 all, 1 locked
        this.gridTop = 0;                    // clips: the first grid row shown (scrolled)
        this.clipId = null; this.from = 'clips';
        this.metaAt = null;
        this.copy = null;                    // { clip, what, pct, text: encoding <cam> | the USB stick } while copying
        this.usb = null;                     // the tool's stick { label ('' none), free } | null (not told yet)
        this.xsel = 0;                       // export page: the option selected (exportOptions index)
        this.msg = null;                     // { text, until }: a reply shown for a while
        this.seekTo = null; this.seekAt = 0; // a seek while playing (shown at once)
        this.startAt = null;                 // the seek bar moved while nothing plays: play starts there
        this.reopen = null;                  // { id, pos, cam, paused }: playing again after a lock / unlock
        this.savingAt = null;                // when a save was first seen under way (Record: the bar in Save's place)
        this.lastCopy = null;                // { clip, bytes, until }: a copy just done (Copy to USB: Copied, Done)
    }

    /* ---- in ---- */
    setRecorder(s) {
        // a save under way (the tap until the clip is found): counted from the first status that says so
        const saving = s.lastState === 'saving';
        if (!saving) this.savingAt = null; else if (this.savingAt === null) this.savingAt = this.now();
        this.rec = s;
    }
    setTool(up, version) {
        this.up = !!up;
        if (version !== undefined) this.version = version;
        if (!up) { this.clips = []; this.total = 0; this.full = false; this.st = Object.assign({}, IDLE); this.copy = null; this.usb = null; }
    }
    setClips(list, total, full) { this.clips = list || []; this.total = total || 0; this.full = !!full; }
    setPlayer(st) {
        this.st = st || Object.assign({}, IDLE);
        // the player got where play / a seek went (within 1 s): its own position from now on
        if (this.seekTo !== null && this.st.clip === this.clipId && Math.abs(this.st.pos - this.seekTo) <= 1) this.seekTo = null;
    }
    setUsb(stick) { this.usb = stick || null; }
    setSpeed(kmh, at) { this.speed = { kmh, at }; }
    setMeta(at) { this.metaAt = at; }
    copying(c) { this.copy = Object.assign({}, this.copy && this.copy.clip === c.clip ? this.copy : {}, c); }      // (keeps what)
    done(d) {
        const what = { lock: ['Locked: never replaced', 'Lock'], unlock: ['Unlocked', 'Unlock'], delete: ['Deleted', 'Delete'], copy: ['Copied to the USB stick', 'Copy to USB'] }[d.cmd];
        if (d.cmd === 'copy') {              // done: Copied (its size) and Done on the page while the note shows
            this.lastCopy = d.ok ? { clip: d.clip, bytes: (this.copy && this.copy.bytes) || 0, until: this.now() + NOTE_MS } : null;
            this.copy = null;
        }
        // lock / unlock move the clip's files, so the tool stops its playback first: the clip watched plays again
        // where it was (paused if it was, or while driving), so the picture comes back
        const r = this.reopen;
        if ((d.cmd === 'lock' || d.cmd === 'unlock') && r && r.id === d.clip) {
            this.reopen = null;
            if (d.ok && this.clipId === r.id) {
                this.push({ do: 'play', id: r.id, at: r.pos }, { do: 'cam', n: r.cam });
                if (r.paused || !this.parked()) this.push({ do: 'pause' });
            }
        }
        if (what) this.note(d.ok ? (d.cmd === 'copy' && d.text ? `${what[0]}: ${d.text}` : what[0]) : `${what[1]} failed: ${d.text || 'no reason given'}`, d.cmd);
    }
    setShown(page) {
        const was = this.shown, viewing = (p) => p === 'viewer' || p === 'confirm' || p === 'export';
        this.shown = page;
        if (viewing(was) && !viewing(page) && ACTIVE.indexOf(this.st.state) >= 0) this.push({ do: 'stop' });
        if (!page) this.gridTop = 0;                      // closed: the screens start from the top again
    }
    tick() {
        if (this.parked()) { this.drivePaused = false; return; }
        if (!this.drivePaused && (this.st.state === 'playing' || this.st.state === 'loading')) { this.drivePaused = true; this.push({ do: 'pause' }); }
    }

    /* ---- helpers ---- */
    push() { this.queue.push.apply(this.queue, arguments); }
    take() { const q = this.queue; this.queue = []; return q; }
    go(page) { this.push({ do: 'go', page }); }
    note(text, cmd) { this.msg = { text, cmd, until: this.now() + NOTE_MS }; }
    noteText() { return this.msg && this.now() < this.msg.until ? this.msg.text : ''; }
    parked() { const now = this.now(); return !!(this.speed && now - this.speed.at < SPEED_FRESH_MS && this.speed.kmh < PARKED_KMH); }
    clip() { return this.clips.find((c) => c.id === this.clipId) || null; }
    mine() { return this.clipId && this.st.clip === this.clipId ? this.st : IDLE; }       // the viewer clip's playback
    clipSub(c) { return `${c.secs} s · ${LAYOUT[lay(c.cams)]} · ${c.pending ? 'saving…' : size(c.bytes)}`; }
    shownList() { return this.filter ? this.clips.filter((c) => c.locked) : this.clips; }
    copyingThis(c) { return !!(this.copy && c && this.copy.clip === c.id); }
    // the copy's progress: making a camera's MP4 first ("encoding <cam>"), then writing it / the clip to the stick
    encoding() { const m = /^encoding (\w+)$/.exec(this.copy ? this.copy.text : ''); return m ? m[1] : ''; }
    /** A copy of the clip shown just done: { clip, bytes, until } while its note is up, else null. */
    copied() { const k = this.lastCopy; return k && k.clip === this.clipId && this.now() < k.until ? k : null; }
    /** About how many bytes a copy of clip c as option o writes (as recorded: the clip; a camera: its MP4). */
    estimate(c, o) { return o.what === 'all' ? c.bytes : c.secs * MP4_RATE[lay(c.cams) ? 1 : 0]; }
    /** The frame's chips on Record and Clips, the rightmost first: how the cameras started, whether they are ready. */
    chips() {
        const r = this.rec, out = r.camView ? [[r.autoCam ? 'Started with the car' : 'Started by hand', 'dim']] : [];
        out.push(r.camView && r.camOk ? ['Cameras ready', 'ok'] : r.camView ? ['Cameras starting…', 'warn']
            : (r.views || []).length && r.vb === 'RECORDING' ? ['Cameras off', 'dim'] : ['Cameras not ready', 'crit']);
        if (!this.up) out.push(['Player not running', 'crit']);
        return out;
    }
    /** The clips whose thumbnails main.js keeps loaded: the grid rows shown (+ one row each side) and the last clip's card. */
    thumbIds() {
        const ids = this.shownList().slice(Math.max(0, this.gridTop - 1) * GRID_COLS, (this.gridTop + GRID_ROWS + 1) * GRID_COLS).map((c) => c.id);
        if (this.clips[0] && ids.indexOf(this.clips[0].id) < 0) ids.unshift(this.clips[0].id);
        return ids;
    }
    open(id, from) {
        const c = this.clips.find((x) => x.id === id);
        if (!c || c.pending) return;                        // still being saved: listed, not playable yet
        this.clipId = id; this.from = from; this.seekTo = null; this.startAt = null; this.metaAt = null;
        this.push({ do: 'open', id });
        if (this.parked()) this.play(c);
        this.go('viewer');
    }
    play(c) {                                               // from the start, or where the seek bar was put meanwhile
        const at = this.startAt !== null ? this.startAt : 0;
        this.startAt = null; this.seekTo = at; this.seekAt = this.now();
        this.push({ do: 'play', id: c.id, at }, { do: 'cam', n: 0 });
    }

    /* ---- out ---- */
    values(page) {
        const fn = { record: this.recordValues, clips: this.clipsValues, viewer: this.viewerValues, export: this.exportValues,
            settings: this.settingsValues, confirm: this.confirmValues, diag: this.diagValues }[page];
        const v = fn ? fn.call(this) : {};
        if (TAB_OF[page] !== undefined) v.nav = Object.assign({ sel: TAB_OF[page] }, v.nav);      // the frame: its tab selected
        return v;
    }

    recordValues() {
        const r = this.rec, vb = r.vb, last = this.clips[0], views = r.views || [], now = this.now();
        let word, sub, dot, bad = vb !== 'RECORDING';         // bad: the receiver is not recording
        // 2.4.0: vb is the receiver's state - null (down), WAITING (no frames yet), RECORDING. A save no longer changes
        // it (the daemon keeps recording); the "Saving…" bar comes from lastState (savingAt) below.
        if (!vb) { word = 'Not available'; sub = r.verdict || 'The receiver is not running'; dot = FAINT; bad = true; }
        else if (r.checking) { word = 'Checking the cameras…'; sub = 'Each camera view is asked for a few seconds'; dot = WARN; }
        else if (r.cameraBusy) { word = 'Starting the cameras…'; sub = 'Waiting for the camera service'; dot = WARN; }
        else if (r.retrying) { word = 'Cameras not ready'; sub = 'Camera start failed. Trying again shortly.'; dot = WARN; bad = true; }
        else if (!views.length) { word = 'No cameras'; sub = 'Settings > Diagnostics > Check cameras looks again'; dot = FAINT; bad = true; }
        else if (!r.camView) { word = 'Cameras off'; sub = 'Pick a camera view to start them'; dot = FAINT; }
        else if (!r.camOk) { word = 'Starting the cameras…'; sub = short(r.camMsg, 60); dot = WARN; }
        else if (vb !== 'RECORDING') { word = 'Not recording'; sub = 'Cameras are on, waiting for video frames'; dot = WARN; bad = true; }
        else { word = 'Recording'; sub = RES[r.camLayout] || `${cap(LAYOUT[r.camLayout] || 'one camera')} · 1280 × 480 · 30 fps`; dot = CRIT; }   // (single: car 2.1.3)
        // saving: a bar in Save's place from the tap until the clip is found ("after" s on + 5 s); a refused save: why
        const saving = this.savingAt !== null, f = saving ? Math.max(0, Math.min(0.95, (now - this.savingAt) / ((r.after + 5) * 1000))) : 0;
        const failed = r.lastState === 'failed';
        const ok = saving || (last && last.pending) ? ['Saving…', WARN] : failed ? ['Not saved', CRIT] : r.lastState === 'saved' ? ['Saved', OK]
            : last && last.locked ? ['Locked', WARN] : ['', OK];
        return {
            // 2.3.9: the seconds a clip can have before the tap (Drive Recorder frames since the cameras last came back)
            nav: { title: 'Record', sub: bad ? 'Not recording' : r.filled < r.before ? `${Math.max(0, r.filled - 1)} of the ${r.before} s before the tap recorded`
                : `The last ${r.before} s are kept for a clip`, chips: this.chips() },
            recDot: { color: dot },
            recWord: { text: up(word), color: bad ? DIM : TEXT },
            recSub: { text: sub, color: bad ? WARN : DIM },
            // the views this car records (2.1.0): segments; one: its name; none: said so
            view: { items: views.map((x) => x.label).join(','), sel: Math.max(0, views.map((x) => x.req).indexOf(r.view)),
                hidden: !views.length || (views.length === 1 && r.camView && r.camOk), disabled: !!r.checking || !!r.cameraBusy },
            viewName: { hidden: views.length > 1 || (views.length === 1 && !(r.camView && r.camOk)),
                text: views.length ? views[0].name || views[0].label : 'No drive-recorder cameras found', color: views.length ? TEXT : WARN },
            saveHint: failed ? { text: short(r.lastClip, 110), color: CRIT } : { text: saving ? `Recording the next ${r.after} s, then writing the clip.`
                : r.filled < r.before && r.filled >= (r.minBefore || 5) ? `Save clip writes the last ${r.filled - 1} s (all the cameras have recorded so far) and the next ${r.after} s.`
                    : `Save clip writes the last ${r.before} s and the next ${r.after} s to the head unit.`, color: DIM },
            // the buffer must hold the clip's "before" seconds first (user, 2.0.2): a countdown on the button until then
            // 2.3.9: from minBefore s on a save is possible, with as many seconds before the tap as there are until "before"
            save: { hidden: saving, text: vb === 'RECORDING' && r.camOk && r.filled < r.before
                ? (r.filled < (r.minBefore || 5) ? `Save clip in ${(r.minBefore || 5) - r.filled} s` : `Save clip · ${r.filled - 1} s before`) : 'Save clip',
                disabled: vb !== 'RECORDING' || !r.camOk || r.checking || r.cameraBusy || r.filled < (r.minBefore || 5) || (this.up && this.full) || !views.length },
            saving: { hidden: !saving, value: f, right: `${Math.round(f * 100)} %` },
            lastThumb: { src: last ? `key:t:${last.id}` : '', hidden: !last },
            lastDurBg: { hidden: !last },
            lastDur: { text: last ? clock(last.secs) : '', hidden: !last },
            lastTitle: { text: last ? when(last.id, now) : this.up ? 'No clips yet' : 'Player not running' },
            lastSub: { text: last ? this.clipSub(last) : this.up ? 'Save clip writes the first one' : 'Install "Drive Recorder player" from the Store' },
            lastOk: { text: up(ok[0]), color: ok[1], hidden: !last },
            lastPlay: { disabled: !last || !this.up || !!last.pending },
            storage: { right: this.up ? `${size(this.total)} of 4 GB` : '-', value: this.up ? Math.min(1, this.total / GB4) : 0 },
            storageSub: { text: !this.up ? 'Drive Recorder player not running' : this.full ? 'Locked clips fill the 4 GB: unlock some to save new ones'
                : 'Over 4 GB the oldest unlocked clips are replaced' },
        };
    }

    clipsValues() {
        const now = this.now(), n = this.clips.length, r = this.rec;
        return {
            nav: { title: 'Clips', chips: this.chips(), sub: this.noteText() || (!this.up ? 'Drive Recorder player not running'
                : n ? `${n} clip${n === 1 ? '' : 's'} · ${size(this.total)} of 4 GB · newest first` : `No clips · ${size(this.total)} of 4 GB`) },
            filter: { sel: this.filter, disabled: !this.up || (!n && !this.filter) },
            grid: {
                tap: null, top: this.gridTop, sel: this.clipId || '',
                items: this.shownList().map((c) => ({ id: c.id, thumb: `key:t:${c.id}`, title: when(c.id, now), sub: `${c.secs} s · ${LAYOUT[lay(c.cams)]}`,
                    sub2: c.pending ? 'saving…' : size(c.bytes), dur: clock(c.secs), locked: !!c.locked })),
                // none: the grid's empty state (approved p4 clips-empty)
                empty: !this.up ? 'Drive Recorder player not running' : this.filter ? 'No locked clips' : 'No clips yet',
                emptyLine: !this.up ? 'Install "Drive Recorder player" from the Store' : this.filter ? 'Lock a clip in its viewer: it is never replaced'
                    : `Save clip on the Record tab keeps the last ${r.before} s and the next ${r.after} s.`,
            },
        };
    }

    viewerValues() {
        const c = this.clip(), s = this.mine(), now = this.now(), cam = s.cam || 0, cams = lay(s.clip ? s.cams : c ? c.cams : 0);
        const parked = this.parked(), state = s.state;
        let text = '';
        if (!this.up) text = 'Drive Recorder player not running';
        else if (!c) text = 'This clip is gone';
        else if (!parked) text = 'Video plays while the car stands still';
        else if (state === 'loading') text = s.text || 'Loading…';
        else if (state === 'error') text = s.text || 'This clip can\'t be played';
        else if (state === 'idle') text = 'Tap play to watch the clip';
        const dur = s.dur || (c && c.secs) || 0;
        const pos = this.startAt !== null && ACTIVE.indexOf(state) < 0 ? this.startAt
            : this.seekTo !== null && now - this.seekAt < SEEK_SHOWN_MS ? this.seekTo : s.pos;
        const at = this.metaAt || {};
        // a clip still being saved or being copied: no lock, no delete (and one copy at a time)
        const copying = this.copyingThis(c), usable = !!(c && !c.pending && this.up);
        return {
            // the page line: the clip (only speed and time beside the video: user decision)
            nav: { title: c ? when(c.id, now) : '', sub: c ? [`${c.secs} s`, cam ? `${(CAM_NAMES[cam] || '').toLowerCase()} camera` : LAYOUT[cams], size(c.bytes)].join(' · ') : 'This clip is gone' },
            video: { show: !!(this.up && c && parked && ['playing', 'paused', 'ended'].indexOf(state) >= 0), text, parts: cam ? 0 : PARTS[cams] },
            gridBack: { hidden: !cam },
            camName: { hidden: !cam, text: up(CAM_NAMES[cam]) },
            pause: { icon: state === 'playing' || state === 'loading' ? 'pause' : 'play' },
            timeline: { min: 0, max: Math.max(1, dur), value: Math.min(Math.max(1, dur), pos) },
            time: { text: `${clock(pos)} / ${clock(dur)}` },
            spd: { value: at.kmh != null ? String(at.kmh) : '--' },
            clock: { value: at.time || '--:--:--' },
            clockSub: { text: at.date || '' },
            lock: Object.assign(c && c.locked ? { text: 'Unlock', icon: 'unlock' } : { text: 'Lock', icon: 'lock' }, { disabled: !usable || copying }),
            // (opens the Copy to USB page; while this clip is copied: its progress there)
            export: { text: copying ? `Copying ${this.copy.pct} %` : 'Copy to USB', disabled: !usable },
            delete: { disabled: !usable || copying },
            // the copy's progress line: the camera's MP4 being made, then the USB stick written
            hint: { text: this.noteText() || (copying ? (this.encoding() ? `Preparing the ${this.encoding()} camera… ${this.copy.pct} %`
                : `Copying to ${this.copy.text || 'the USB stick'}… ${this.copy.pct} %`)
                : cam ? 'Tap the picture or All cameras for the grid' : PARTS[cams] ? 'Tap a camera to enlarge it · plays only while the car stands still'
                    : 'Plays only while the car stands still') },
        };
    }

    // Copy to USB (2.1.0): one tile per option (as recorded, each camera), the one selected highlighted + a check; the
    // stick (the tool's usb line, asked when the page opens); Export, the progress beside it while this clip copies,
    // Copied + Done when it is done
    exportValues() {
        const c = this.clip(), opts = c ? exportOptions(c.cams) : [], sel = Math.min(this.xsel, opts.length - 1), o = opts[sel];
        const mine = this.copyingThis(c), usb = this.usb, now = this.now(), done = this.copied(), v = {
            nav: { title: 'Copy to USB', sub: c ? [when(c.id, now), `${c.secs} s`, c.pending ? 'saving…' : size(c.bytes)].join(' · ') : 'This clip is gone' },
        };
        for (let i = 0; i < TILES; i++) {
            const t = opts[i], on = i === sel;
            v[`t${i}`] = { hidden: !t, selected: on, title: t ? t.label : '', sub: t ? t.sub : '' };
            v[`t${i}Pic`] = { hidden: !t, src: t ? `key:x:${t.what}` : '' };
            v[`t${i}Check`] = { hidden: !t, kind: on ? 'primary' : 'quiet', icon: on ? 'check' : '' };
        }
        const est = c ? this.estimate(c, o) : 0;
        const x = mine ? this.copy.what || 'all' : '', note = this.msg && this.msg.cmd === 'copy' ? this.noteText() : '';
        let label = usb && usb.label ? usb.label : 'USB stick', sub, subColor = '';
        if (!this.up) sub = 'Drive Recorder player not running';
        else if (!c) sub = 'This clip is gone';
        else if (note) sub = note;
        else if (mine) sub = `Writing ${x === 'all' ? 'the clip' : `${x} camera`} to DriveRecorder/${c.id}/`;
        else if (this.copy) sub = 'Another clip is being copied: wait for it';
        else if (!usb) sub = 'Looking for a USB stick…';
        else if (!usb.label) { label = 'No USB stick'; sub = 'Plug a USB stick into the car to copy clips'; subColor = 'warn'; }
        else sub = `USB stick · ${size(usb.free)} free · ${o.what === 'all' ? `about ${size(est)} will be copied` : `${o.what} camera, about ${size(est)}`}`;
        const enc = this.encoding(), pct = mine ? this.copy.pct || 0 : 0;
        return Object.assign(v, {
            usb: { label, sub, subColor },
            export: done ? { text: 'Done', icon: 'check', kind: 'outline', disabled: false }
                : { text: 'Export', icon: 'arrowDown', kind: 'primary', disabled: !c || c.pending || !this.up || !!this.copy || !usb || !usb.label },
            bar: done ? { hidden: false, label: 'Copied', right: size(done.bytes), value: 1, color: 'ok' }
                : { hidden: !mine, label: enc ? `Preparing ${enc} camera…` : 'Copying…', right: `${pct} %`, value: pct / 100, color: '' },
        });
    }

    settingsValues() {
        const r = this.rec;
        return {
            nav: { title: 'Settings', sub: 'Saved on the head unit' },
            lenRow: { sub: `${r.before} s before the tap · ${r.after} s after`, text: `${r.before} / ${r.after} s` },
            autoRow: { on: !!r.autoCam },
        };
    }

    // the delete dialog over the viewer (the confirm screen holds the viewer's elements under the same names)
    confirmValues() {
        const c = this.clip();
        return Object.assign(this.viewerValues(), { dialog: { body: c ? [when(c.id, this.now()), `${c.secs} s`, size(c.bytes)].join(' · ') : 'This clip is gone' } });
    }

    // Diagnostics: recorder.js's status lines as key | value (split at the first ': '), then the player tool
    diagValues() {
        const rows = (this.rec.lines || []).map((l) => { const i = l.indexOf(': '); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 2)]; });
        rows.push(this.up ? ['Player', `running ${this.version} · ${this.clips.length} clips · ${size(this.total)}${this.full ? ' · full: locked clips over 4 GB' : ''}`, 'ok']
            : ['Player', 'not running (iteriodev-drplay)', 'crit']);
        return { nav: { title: 'Diagnostics', sub: 'For support' }, diagText: { rows },
            check: { text: this.rec.checking ? 'Checking cameras…' : 'Check cameras', disabled: !!this.rec.checking } };
    }

    /* ---- taps ---- */
    change(page, el, o) {
        o = o || {};
        const tap = o.tap;
        // a tab (the frame's sel): the tabs replace each other over Record (main.js); a sub-page's own tab is its list
        if (el === 'nav' && typeof o.sel === 'number') { const p = TABS[o.sel]; if (p && p !== page) this.push({ do: 'tab', page: p }); }
        else if (el === 'view' && typeof o.sel === 'number') {
            const v = (this.rec.views || [])[o.sel];
            if (v && !this.rec.checking && !this.rec.cameraBusy && (v.req !== this.rec.view || !this.rec.camView || !this.rec.camOk)) this.push({ do: 'view', view: v.req });
        } else if (el === 'filter' && typeof o.sel === 'number') { this.filter = o.sel ? 1 : 0; this.gridTop = 0; }
        else if (el === 'grid') {                            // scrolled (top: the first row shown) or a card tapped
            if (typeof o.top === 'number') this.gridTop = Math.max(0, o.top);
            if (tap) this.open(tap.id, 'clips');
        } else if (el === 'timeline' && typeof o.value === 'number') {
            if (ACTIVE.indexOf(this.mine().state) < 0) { this.startAt = o.value; return; }   // nothing playing: play starts there
            this.seekTo = o.value; this.seekAt = this.now(); this.push({ do: 'seek', s: o.value });
        } else if (el === 'autoRow' && typeof o.on === 'boolean') this.push({ do: 'setting', key: 'auto', value: o.on });   // Start with the car
    }

    event(page, name) {
        const c = this.clip(), s = this.mine();
        if (page === 'export') return this.exportEvent(c, name);
        // 2.3.12: from minBefore s on, as the button (2.3.9 enabled it then and this tap still waited for "before")
        if (name === 'save') { if (this.rec.filled >= (this.rec.minBefore || 5) && (this.rec.views || []).length) this.push({ do: 'save' }); }
        else if (name === 'check') { if (!this.rec.checking) this.push({ do: 'detect' }); }
        else if (name === 'len') this.push({ do: 'setting', key: 'len' });        // Settings: Clip length, Diagnostics
        else if (name === 'diag') this.go('diag');
        else if (name === 'lastPlay') { if (this.clips[0]) this.open(this.clips[0].id, 'record'); }
        else if (name === 'pause') {
            if (s.state === 'playing' || s.state === 'loading') this.push({ do: 'pause' });
            else if (!c || !this.parked()) return;              // (the picture's box says why)
            else if (s.state === 'paused') this.push({ do: 'resume' });
            else if (!c.pending) this.play(c);                  // idle, ended, error: again
        } else if (name === 'gridBack') this.push({ do: 'cam', n: 0 });
        else if (/^video:[0-4]$/.test(name)) {                // grid: that camera; one camera: any tap -> the grid
            const l = lay(s.clip ? s.cams : c ? c.cams : 0), n = PARTS[l] ? CAMS[l][Number(name.slice(6)) - 1] || 0 : 0;
            if (s.cam || n) this.push({ do: 'cam', n: s.cam ? 0 : n });     // (2x2: part n = cam n; halves: the layout's two)
        } else if (name === 'yes') {
            if (c && !c.pending && !this.copyingThis(c)) this.push({ do: 'delete', id: c.id });
            this.push({ do: 'close', page: 'confirm' }, { do: 'close', page: 'viewer' });
            if (this.from !== 'clips') this.go('clips');
        } else if (name === 'no') this.push({ do: 'close', page: 'confirm' });
        else if (!c || c.pending) return;                   // a clip still being saved: no lock, copy or delete
        else if ((name === 'lock' || name === 'delete') && this.copyingThis(c)) return;   // (being copied)
        else if (name === 'lock') {
            this.reopen = ACTIVE.indexOf(s.state) >= 0 ? { id: c.id, pos: s.pos, cam: s.cam || 0, paused: s.state === 'paused' } : null;
            this.push({ do: 'lock', id: c.id, on: !c.locked });
        }
        else if (name === 'export') {                         // the Copy to USB page: the playback paused meanwhile
            const w = this.copyingThis(c) ? this.copy.what : 'all';
            this.xsel = Math.max(0, exportOptions(c.cams).map((o) => o.what).indexOf(w));
            if (s.state === 'playing' || s.state === 'loading') this.push({ do: 'pause' });
            this.push({ do: 'exportPics', id: c.id }, { do: 'usb' });
            this.go('export');
        } else if (name === 'delete') this.go('confirm');
    }
    // the Copy to USB page: a tile selects (not while this clip copies), Export starts it - one copy at a time, a stick
    // there; Lock / Delete of the clip wait for it from now on (copyingThis); once copied the button is Done: back
    exportEvent(c, name) {
        const opts = c ? exportOptions(c.cams) : [], t = /^t([0-9])$/.exec(name);
        if (t) { if (+t[1] < opts.length && !this.copyingThis(c)) this.xsel = +t[1]; return; }
        if (name !== 'export') return;
        if (this.copied()) { this.lastCopy = null; this.push({ do: 'close', page: 'export' }); return; }
        const o = opts[Math.min(this.xsel, opts.length - 1)];
        if (!o || c.pending || !this.up || this.copy || !this.usb || !this.usb.label) return;
        this.copy = { clip: c.id, what: o.what, pct: 0, text: o.what === 'all' ? '' : `encoding ${o.what}`, bytes: this.estimate(c, o) };
        this.push({ do: 'copy', id: c.id, what: o.what });
    }
}

module.exports = { Ui, clock, size, when, exportOptions, crop };
