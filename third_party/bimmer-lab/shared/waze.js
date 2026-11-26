'use strict';
/**
 * waze.js - "Show Waze map inside the theme" (Cluster Themes, page.js Map tab).
 *
 * robertnisipeanu's waze-on-cluster draws the phone's map on cluster-render's "map" target by default: the KOMBI
 * slot UNDER BMW's gauges, so BMW's own map-view readouts (speed, consumption, badge) always sit over it and a
 * see-through hole in a theme shows them too. Nothing can hide that overlay, so the map has to come up into the
 * panel our theme draws on, ABOVE BMW's gauges: our frame over it with a rounded window, our readouts over that.
 *
 * Two ways, picked by the cluster-render service's hello (hud.js tells us with hosting()):
 *  - HOSTING (cluster-render 0.8.2 and newer, hello host_layers 1; robertnisipeanu/idrive-apps#250, Nov 23 2026):
 *    hud.js sends cluster-render a "host" of the "map" target into "panel" at the theme's window, on the connection
 *    whose frame is drawn over it (PROTOCOL.md "Hosting from layers"). waze-on-cluster 0.14.5 and newer follows it:
 *    its map layer goes into the window, just under our frame, and its status file says "hosted": 1. We send
 *    waze-on-cluster nothing at all. The window opens once the map is there (hosted and showing) and stays open
 *    through a rebuild's short gap (DOWN_GRACE_MS: our layers are dropped and made again, so the map goes home for
 *    a moment). The host ends with unhost, when our layers there hide, or when our app exits: the map goes home.
 *  - START PANEL (an older service, no host_layers): waze-on-cluster up to 0.10.9 took {"cmd":"start","target":
 *    "panel"} on its control socket (/dev/shm/waze-on-cluster/ctl.sock, group tm_oap_app): its map on "panel" at a
 *    fixed place under our frame. Sent while wanted and the map isn't on "panel", the socket closed again within a
 *    second (it has one owner: the Waze app holds it while its page is open and a second connection is told "busy",
 *    so we never hold it and retry every 5 s); when no longer wanted, and only if WE moved it, "start map" once.
 *    "start" isn't saved (a restart of its service puts it back on "map"); we just send it again. 0.10.10 (Nov 18
 *    2026) dropped "start" and keeps its status file the same, so we tell by what happens: IGNORED_SENDS sends
 *    taken without the map moving and we stop asking and say an update is needed, trying again every
 *    IGNORED_RETRY_MS.
 * Either way the status file (/run/waze-on-cluster/status.json, 0644, rewritten about once a second:
 * { state: idle|starting|showing|frozen|error|off|unsupported, target, hosted (1 only while hosted), ... }) is read
 * every second.
 * Never sent: "cluster" (would turn the map off), "guide" (saved by the tool). Never touched: patch.sock (root).
 * Facts from the waze-on-cluster 0.9.3 source (main.cpp, control.cpp, map_feed.cpp, the .socket unit), read
 * Nov 7 2026, and 0.14.12 with cluster-render 0.8.11 (PROTOCOL.md, map_feed.cpp, main.cpp), read Nov 24 2026.
 * Plain Node 8 (the car's 8.16.2).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const STATUS_PATH = '/run/waze-on-cluster/status.json';
const CONTROL_PATH = '/dev/shm/waze-on-cluster/ctl.sock';
const POLL_MS = 1000;
const STALE_MS = 10000;          // a status file older than this: the service isn't running
const RETRY_MS = 5000;           // between two sends (busy, error, or waiting for the status to show the switch)
const LINGER_MS = 800;           // how long we stay connected after the command (its answer, then close)
const IGNORED_SENDS = 4;         // "start panel" taken this many times running and the map never moved: not supported
const IGNORED_RETRY_MS = 600000; // then asked again only this often (Waze on Cluster may have been updated)
const DOWN_GRACE_MS = 8000;      // hosting: the window stays open this long after the map left it (a rebuild's gap)
const OLD_WAZE_MS = 20000;       // hosting: our host live and the map showing this long without "hosted": too old

class Waze {
    /**
     * opts: { status, control, dataDir }; env WAZE_STATUS / WAZE_CTL override the paths (the Mac bench's fake).
     * onChange(): called when "up" (the map is showing inside the theme) or the page's status text changes.
     */
    constructor(opts, log, onChange) {
        opts = opts || {};
        this.statusPath = process.env.WAZE_STATUS || opts.status || STATUS_PATH;
        this.controlPath = process.env.WAZE_CTL || opts.control || CONTROL_PATH;
        this.memo = opts.dataDir ? path.join(opts.dataDir, 'waze.json') : null;
        this.log = log;
        this.onChange = onChange || (() => {});
        this.wanted = false;
        this.st = null;              // the last status read: { state, target } or null (no file / unreadable / stale)
        this.up = false;             // the map is showing on the panel
        this.sending = false;
        this.nextTry = 0;
        this.problem = null;         // 'busy' | an error text, from the last send
        this.moved = false;          // we put it on the panel (so we put it back)
        this.ignored = 0;            // "start panel" sends taken in a row while the map stayed where it was
        this.hostMode = null;        // the service hosts from layers (true), it doesn't (false), not known yet (null)
        this.host = null;            // our host's state from cluster-render: { state: 'live'|'waiting', reason } or null
        this.downSince = 0;          // hosting: when the map left the window while it was open (DOWN_GRACE_MS)
        this.unhostedSince = 0;      // hosting: since when our host is live and the map shows, but not hosted
        try { this.moved = JSON.parse(fs.readFileSync(this.memo, 'utf8')).moved === true; } catch (e) { /* first run */ }
        this.lastText = null;
        this.changePending = false;
    }

    start() {
        this.timer = setInterval(() => this._poll(), POLL_MS);
        this._poll();
    }

    /** Stop polling; if we moved the map, ask once for it back on "map" (best effort: the process may be exiting). */
    stop() {
        clearInterval(this.timer);
        if (this.moved && this.st && this.st.target === 'panel') this._send('map');
    }

    /** Whether the theme wants the map on the panel now (the setting, and a layout with a map window). */
    want(on) {
        on = on === true;
        if (on === this.wanted) return;
        this.wanted = on;
        this.nextTry = 0;
        this._refresh();
    }

    /** hud.js, after the service's hello: whether it hosts from layers (host_layers 1). */
    hosting(on) {
        on = on === true;
        if (on === this.hostMode) return;
        this.hostMode = on;
        this.log.info('waze: ' + (on ? 'cluster-render hosts the map in the theme (host from layers)' : 'cluster-render can\'t host the map; asking Waze on Cluster for "start panel" (0.10.9 and older)'));
        this.nextTry = 0;
        this._refresh();
    }

    /** hud.js: our host of "map" as cluster-render says ('hosting' event), or null (none sent, or the connection went). */
    hostState(state, reason) {
        const h = state ? { state: String(state), reason: reason ? String(reason) : '' } : null;
        if (JSON.stringify(h) === JSON.stringify(this.host)) return;
        this.host = h;
        if (h) this.log.info('waze: our host of the map is ' + h.state + (h.reason ? ' (' + h.reason + ')' : ''));
        this._refresh();
    }

    /** For the page: { text, up, ok } (ok: false when something is wrong). */
    info() {
        const s = this.st;
        if (!s) return { text: 'Waze on Cluster isn\'t running', up: false, ok: false };
        if (s.state === 'unsupported') return { text: 'Waze on Cluster: this car isn\'t supported', up: false, ok: false };
        if (s.state === 'off') return { text: 'Waze map is turned off in the Waze app', up: false, ok: false };
        if (!this.wanted) return { text: 'Off. Waze shows the map in BMW\'s own map view', up: false, ok: true };
        if (this.hostMode) return this._hostInfo(s);
        if (this.hostMode === null) return { text: 'Waiting for the cluster', up: false, ok: true };
        if (s.target !== 'panel') {
            if (this.ignored >= IGNORED_SENDS) return { text: 'Update Waze on Cluster and cluster-render to show the map in the theme', up: false, ok: false };
            if (this.problem === 'busy') return { text: 'Waze app is open, retrying', up: false, ok: false };
            if (this.problem) return { text: 'Can\'t reach Waze on Cluster (' + this.problem + ')', up: false, ok: false };
            return { text: 'Moving the map into the theme', up: false, ok: true };
        }
        return this._stateInfo(s);
    }

    /** Hosting: what the page says while wanted. */
    _hostInfo(s) {
        if (this.up) return { text: 'Map showing in the theme', up: true, ok: true };
        if (s.state === 'showing' || s.state === 'starting') {
            if (!this.host) return { text: 'Moving the map into the theme', up: false, ok: true };
            if (this.host.state !== 'live') return Waze._waiting(this.host.reason);
            if (this.unhostedSince && Date.now() - this.unhostedSince >= OLD_WAZE_MS) return { text: 'Update Waze on Cluster to show its map in the theme', up: false, ok: false };
            return { text: 'Moving the map into the theme', up: false, ok: true };
        }
        return this._stateInfo(s);
    }

    /** Our host not live: cluster-render's reason (PROTOCOL.md "hosting" event) said plainly; the log has it word for word. */
    static _waiting(reason) {
        const r = reason || '';
        if (/is hosted by a scene|another client/.test(r)) return { text: 'Another app is showing the Waze map', up: false, ok: false };
        if (/is not on screen|wait for a scene file/.test(r)) return { text: 'Waiting for the theme to show on the cluster', up: false, ok: true };
        if (/no layer of the client is drawn/.test(r)) return { text: 'Waiting for the theme to draw', up: false, ok: true };
        return { text: 'Waiting to show the map' + (r ? ' (' + r + ')' : ''), up: false, ok: true };
    }

    /** The map's own state, once it is where it should be. */
    _stateInfo(s) {
        if (s.state === 'showing') return { text: 'Map showing in the theme', up: true, ok: true };
        if (s.state === 'frozen') return { text: 'Map frozen, waiting for the phone', up: false, ok: false };
        if (s.state === 'error') return { text: 'Waze on Cluster reports an error', up: false, ok: false };
        return { text: 'Waiting for the map', up: false, ok: true };
    }

    _poll() {
        fs.stat(this.statusPath, (err, st) => {
            if (err || Date.now() - st.mtime.getTime() > STALE_MS) return this._update(null);
            fs.readFile(this.statusPath, 'utf8', (e, txt) => {
                let s = null;
                try { if (!e) { const j = JSON.parse(txt); s = { state: String(j.state || ''), target: j.target == null ? null : String(j.target), hosted: j.hosted === 1 }; } } catch (x) { s = null; }
                this._update(s);
            });
        });
    }

    _update(s) {
        this.st = s;
        if (s && s.target === 'map' && !this.wanted && this.moved) this._setMoved(false);   // it's back
        if (s && s.target === 'panel' && this.problem) this.problem = null;
        if (s && s.target === 'panel') this.ignored = 0;
        this._refresh();
    }

    /** Works out "up" and the page's text again; onChange() when either changed. */
    _refresh() {
        const s = this.st, now = Date.now();
        let up;
        if (this.hostMode) {
            const live = !!(this.host && this.host.state === 'live');
            const there = !!(this.wanted && s && live && s.hosted && s.state === 'showing');
            const showing = !!(this.wanted && s && live && s.state === 'showing');
            this.unhostedSince = showing && !s.hosted ? (this.unhostedSince || now) : 0;
            if (there) { up = true; this.downSince = 0; }
            else if (this.up && this.wanted && s && s.state === 'showing') {
                // still showing, only not in our window: a rebuild drops our layers, so the map goes home and comes
                // back; open a moment longer. The map itself gone (idle, frozen) closes it at once, as before.
                if (!this.downSince) this.downSince = now;
                up = now - this.downSince < DOWN_GRACE_MS;
            } else up = false;
            if (!up) this.downSince = 0;
        } else up = !!(this.hostMode === false && this.wanted && s && s.target === 'panel' && s.state === 'showing');
        const was = this.up;
        if (up !== was && this.hostMode) this.log.info('waze: the map ' + (up ? 'is in the theme' : 'left the theme') + (s ? ' (' + s.state + (s.hosted ? ', hosted' : '') + ')' : ''));
        this.up = up;
        const text = this.info().text;
        const changed = up !== was || text !== this.lastText;
        this.lastText = text;
        this._sync();
        if (changed) this._changed();
    }

    /** onChange() once, after the code that called us is done (want() is called from inside hud.js's rebuild). */
    _changed() {
        if (this.changePending) return;
        this.changePending = true;
        setImmediate(() => { this.changePending = false; this.onChange(); });
    }

    _sync() {
        const s = this.st;
        if (this.sending || Date.now() < this.nextTry || !s) return;
        if (s.state === 'unsupported' || s.state === 'off') return;
        if (this.wanted && s.target !== 'panel' && this.hostMode === false) this._send('panel');
        else if (!this.wanted && this.moved && s.target === 'panel') this._send('map');
    }

    _send(target) {
        this.sending = true;
        this.nextTry = Date.now() + RETRY_MS;
        let answer = '', done = false;
        const sock = net.connect(this.controlPath);
        const finish = (problem) => {
            if (done) return;
            done = true;
            clearTimeout(t);
            try { sock.destroy(); } catch (e) { /* closed */ }
            this.sending = false;
            if (/"reason"\s*:\s*"busy"/.test(answer)) problem = 'busy';
            this.problem = problem || null;
            if (!this.problem) {
                if (target === 'panel' && this.st && this.st.target !== 'panel') {
                    this.ignored++;
                    if (this.ignored >= IGNORED_SENDS) {
                        this.nextTry = Date.now() + IGNORED_RETRY_MS;
                        if (this.ignored === IGNORED_SENDS) this.log.warn('waze: "start panel" taken ' + IGNORED_SENDS + ' times and the map never moved: this Waze on Cluster no longer takes it (0.10.10 and newer) and this cluster-render cannot host the map (0.8.2 and newer can); asking again every ' + IGNORED_RETRY_MS / 60000 + ' min');
                        this._changed();
                        return;
                    }
                }
                this.log.info('waze: asked for the map on "' + target + '"');
                if (target === 'panel') this._setMoved(true);
            } else this.log.info('waze: "start ' + target + '" not sent (' + this.problem + '), retrying in ' + RETRY_MS / 1000 + ' s');
        };
        const t = setTimeout(() => finish(null), LINGER_MS + 1000);
        sock.setEncoding('utf8');
        sock.on('data', (d) => { if (answer.length < 4096) answer += d; });
        sock.on('error', (e) => finish(e.code || e.message));
        sock.on('close', () => finish(null));
        sock.on('connect', () => {
            sock.write(JSON.stringify({ cmd: 'start', target }) + '\n');
            setTimeout(() => { try { sock.end(); } catch (e) { /* closed */ } }, LINGER_MS);
        });
    }

    _setMoved(on) {
        this.moved = on;
        if (!this.memo) return;
        try { fs.writeFileSync(this.memo, JSON.stringify({ moved: on })); } catch (e) { this.log.warn('waze: cannot save ' + this.memo + ' (' + e.message + ')'); }
    }
}

module.exports = Waze;
