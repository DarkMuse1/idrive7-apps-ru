'use strict';
/*
 * A clip's metadata, icam2proxy's <T>_Metadata.json (github.com/SkayoFox/BMW-driverecorder-processor):
 *   [{ VIN, entries: [{ id: frame, date, time, latitude, longitude, velocity | "velocity_KM/H" | "velocity_MP/H" }] }]
 * The VIN is never kept. Speed + time at a playback position (spec 3.4): entries carry a frame id, their rate is
 * derived per clip ((last id - first id) over the clip's seconds, else 30 per second), the first entry's date + time is
 * the start; the entry shown is the last one with a speed at or before the position. Node 8.
 *   load(file) -> { entries: [{ id, date, time, kmh }] } | null       (read only up to 4 MiB)
 *   at(meta, clipSecs, pos) -> { kmh, time 'hh:mm:ss', date '31 Oct 2026' } | null
 */
const fs = require('fs');

const MAX_BYTES = 4 << 20;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => (n < 10 ? '0' : '') + n;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const kmhOf = (x) => (num(x.velocity) !== null ? x.velocity : num(x['velocity_KM/H']) !== null ? x['velocity_KM/H']
    : x['velocity_MP/H'] != null && isFinite(parseFloat(x['velocity_MP/H'])) ? parseFloat(x['velocity_MP/H']) * 1.609344 : null);

function load(file) {
    try {
        if (fs.statSync(file).size > MAX_BYTES) return null;
        let m = JSON.parse(fs.readFileSync(file, 'utf8'));
        m = Array.isArray(m) ? m[0] : m;
        const entries = (m && Array.isArray(m.entries) ? m.entries : []).filter((x) => x && typeof x === 'object')
            .map((x, i) => ({ id: num(x.id) !== null ? x.id : i, date: x.date, time: x.time, kmh: kmhOf(x) }))
            .sort((a, b) => a.id - b.id);
        return entries.length ? { entries } : null;
    } catch (e) { return null; }
}

// the first entry's date ("31.10.2026" or "2026-10-31") + time ("13:42:11") -> { d: Date, date: known }
function startOf(x) {
    const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(x.time || ''));
    if (!t) return null;
    let y = 2000, mo = 1, da = 1;
    let d = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(x.date || ''));
    if (d) { da = +d[1]; mo = +d[2]; y = +d[3]; } else if ((d = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(x.date || '')))) { y = +d[1]; mo = +d[2]; da = +d[3]; }
    return { d: new Date(y, mo - 1, da, +t[1], +t[2], +(t[3] || 0)), date: !!d };
}

function at(meta, clipSecs, pos) {
    const e = meta && meta.entries;
    if (!e || !e.length) return null;
    pos = Math.max(0, Number(pos) || 0);
    const first = e[0].id, last = e[e.length - 1].id;
    const rate = clipSecs > 0 && last > first ? (last - first) / clipSecs : 30;
    const target = first + pos * rate;
    let best = null;
    for (const x of e) { if (x.id > target) break; if (x.kmh !== null) best = x; }
    if (!best) best = e.find((x) => x.kmh !== null) || null;
    const s = startOf(e[0]), d = s && new Date(s.d.getTime() + Math.floor(pos) * 1000);
    return {
        kmh: best ? Math.round(best.kmh) : null,
        time: d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '',
        date: d && s.date ? `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}` : String(e[0].date || '').slice(0, 20),
    };
}

module.exports = { load, at };
