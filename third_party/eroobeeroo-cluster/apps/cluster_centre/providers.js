'use strict';
/**
 * providers.js - readings other apps share in /dev/shm/cluster-info (the folder Cluster Info reads, its
 * providers.js has the format): eDrive Live's battery charge and power, and any app's ranges. A file older
 * than STALE_MS counts as gone. While the layout shows, want() asks for them as Cluster Info does.
 *
 *   power.kw                 the high-voltage battery's power (kW, - charging)
 *   power.outMax, .inMax     the power gauge's ends (kW): eDrive Live's, the battery's discharge and charge limits
 *   values.soc.pct           the battery's charge (%)
 *   values.erange.km         the electric range (km)
 *   values.frange.km         the fuel range (km)
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.CLUSTER_INFO_DIR || '/dev/shm/cluster-info';
const STALE_MS = 3000;

function startProviders(log, opts) {
    opts = opts || {};
    const dir = opts.dir || DIR;
    let entries = {};
    function scan() {
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { entries = {}; return; }
        const next = {};
        names.forEach((n) => {
            if (!/\.json$/.test(n) || /^wanted(-[\w.-]+)?\.json$/.test(n)) return;   // (what the apps want: not a provider)
            try {
                const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
                if (j && typeof j.t === 'number' && Date.now() - j.t < STALE_MS) next[n.replace(/\.json$/, '')] = j;
            } catch (e) { /* half written: the next scan */ }
        });
        const before = Object.keys(entries).sort().join(','), after = Object.keys(next).sort().join(',');
        if (before !== after) log.info('providers: ' + (after || 'none'));
        entries = next;
    }
    const first = (fn) => { for (const id of Object.keys(entries).sort()) { const v = fn(entries[id]); if (typeof v === 'number' && isFinite(v)) return v; } return undefined; };
    /*
     * wanted.json is Cluster Info's: it writes it while its panel is up, and eDrive Live shares only while it is
     * fresh. The folder is sticky (each app may replace or remove only its own files), so a wanted.json of ours
     * left behind is one Cluster Info can no longer refresh: eDrive Live then stops sharing with it. So this app
     * writes one only when none is there or it is ours, removes it as soon as it stops wanting, and removes a
     * leftover of its own at start.
     */
    const WANTED = path.join(dir, 'wanted.json');
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    /* This app's own wanted file, always: a wanted.json Cluster Info left behind (it doesn't remove it when its panel
     * goes) belongs to it, so this app can't replace it, and eDrive Live, seeing it stale, stopped sharing: no kW on
     * the cluster (Nov 9 2026). eDrive Live 1.9.6 reads every wanted*.json; wanted.json too while it's ours, for an
     * older one. */
    const OWN = path.join(dir, 'wanted-' + (opts.app || 'u' + uid) + '.json');
    const ours = () => { try { return fs.statSync(WANTED).uid === uid; } catch (e) { return null; } };   // null: none
    let wantedT = 0, holding = false;
    /** Ask the providers to read fast and share, at most once a second (see above). */
    function want(what) {
        if (Date.now() - wantedT < 1000) return;
        wantedT = Date.now();
        try {
            try { fs.mkdirSync(dir); fs.chmodSync(dir, 0o1777); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            const body = JSON.stringify(Object.assign({ t: Date.now() }, what));
            const put = (f) => { const tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, body, { mode: 0o644 }); fs.renameSync(tmp, f); };
            put(OWN);
            holding = true;
            if (ours() !== false) put(WANTED);   // (none there, or ours: for an eDrive Live before 1.9.6)
        } catch (e) { if (!want.warned) { want.warned = true; log.warn('providers: ' + e.message); } }
    }
    /** Stops asking: removes this app's wanted.json, so Cluster Info can write its own. */
    function release() {
        if (!holding && ours() !== true && !fs.existsSync(OWN)) return;
        holding = false;
        try { if (ours() === true) fs.unlinkSync(WANTED); } catch (e) { /* gone */ }
        try { fs.unlinkSync(OWN); } catch (e) { /* gone */ }
    }
    release();   // a leftover from before (an older version of this app, or one stopped mid-way)
    process.once('exit', release);
    /* A provider's new file seen at once (the folder watched: each write is a rename over the file), so eDrive
     * Live's power is on the cluster within a frame of its read; the scan every scanMs stays for a folder that
     * can't be watched. opts.onChange(): after each such rescan (the engine draws at once). */
    let watcher = null, pending = false;
    const soon = () => {
        if (pending) return;
        pending = true;
        setImmediate(() => { pending = false; scan(); if (opts.onChange) { try { opts.onChange(); } catch (e) { /* the listener's own */ } } });
    };
    function watchDir() {
        if (watcher || opts.watch === false) return;
        try {
            watcher = fs.watch(dir, (ev, name) => { if (!name || (/\.json$/.test(name) && !/^wanted/.test(name))) soon(); });
            watcher.on('error', () => { try { watcher.close(); } catch (e) { /* gone */ } watcher = null; });
        } catch (e) { watcher = null; }   // no folder yet: tried again with each scan
    }
    const timer = setInterval(() => { scan(); watchDir(); }, opts.scanMs || 250);
    scan(); watchDir();
    return {
        /** { kw, kwAt, kwOut, kwIn, soc, erange, frange, battery (°C) } (each undefined when no app shares it). */
        readings: () => ({
            // (its last reading too while a read or two missed, power.old: the gauge holds it, not dropping to 0)
            kw: first((e) => e.power && e.power.kw),
            kwAt: first((e) => e.power && typeof e.power.kw === 'number' && e.t),      // (when that reading was written)
            kwOut: first((e) => e.power && e.power.outMax),
            kwIn: first((e) => e.power && e.power.inMax),
            soc: first((e) => e.values && e.values.soc && e.values.soc.pct),
            erange: first((e) => e.values && e.values.erange && e.values.erange.km),
            frange: first((e) => e.values && e.values.frange && e.values.frange.km),
            battery: first((e) => e.values && e.values.battery && e.values.battery.c),
        }),
        want,
        release,
        list: () => Object.keys(entries).map((id) => entries[id].app || id),
        /** True while an app shares the battery's power at all (its file fresh), even when its last read missed
         * (power.old): that app holds the battery unit, and another asking it as well only makes both miss. */
        powerShared: () => Object.keys(entries).some((id) => !!entries[id].power),
        stop: () => { clearInterval(timer); if (watcher) { watcher.close(); watcher = null; } release(); },
    };
}
module.exports = { startProviders, DIR };
