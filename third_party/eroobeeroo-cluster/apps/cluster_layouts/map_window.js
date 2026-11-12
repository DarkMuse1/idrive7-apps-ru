'use strict';
/**
 * map_window.js - tells Waze on cluster (waze-on-cluster 0.9.107 or later) where the layout's map window is, so it
 * draws the map in the layout's own target (panel), on top of the layout and filling the window. In the map slot
 * under the layout the KOMBI draws its own map screen over the map (its speed readout, its edge shading, its
 * vignette), which showed through the window.
 *
 * The file is /dev/shm/cluster-info/map_window.txt (the folder every app shares, providers.js), one line:
 *   panel <x> <y> <w> <h>
 * rewritten every second while the layout shows with the Waze centre; removed as soon as it doesn't. Waze on cluster
 * takes it while it is fresh (written in the last 3 s) and goes back to its own place when it is gone or stale, so a
 * stopped app leaves nothing behind for long.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.CLUSTER_INFO_DIR || '/dev/shm/cluster-info';
const FILE = 'map_window.txt';

function startMapWindow(log, opts) {
    opts = opts || {};
    const dir = opts.dir || DIR, f = path.join(dir, FILE);
    let holding = false, warned = false, lastLine = '';
    function release() {
        if (!holding) return;
        holding = false; lastLine = '';
        try { fs.unlinkSync(f); } catch (e) { /* gone */ }
        log.info('map window: given back (Waze on cluster to its own place)');
    }
    /** r: { x, y, w, h } to hold, or null to let go. */
    function set(r) {
        if (!r) return release();
        const line = 'panel ' + [r.x, r.y, r.w, r.h].map((v) => Math.round(v)).join(' ') + '\n';
        try {
            try { fs.mkdirSync(dir); fs.chmodSync(dir, 0o1777); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            const tmp = f + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, line, { mode: 0o644 });
            fs.renameSync(tmp, f);
            if (line !== lastLine) log.info('map window: ' + line.trim() + ' (Waze on cluster draws there, over the layout)');
            holding = true; lastLine = line; warned = false;
        } catch (e) { if (!warned) { warned = true; log.warn('map window: ' + e.message); } }
    }
    process.once('exit', release);
    return { set, release, holding: () => holding };
}

module.exports = { startMapWindow, FILE };
