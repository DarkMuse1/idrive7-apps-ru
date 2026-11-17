'use strict';
/**
 * Comfort also serves Seats. Its socket alone does not mean its ambient lighting is enabled.
 * Read the persisted settings without joining the control socket's client set: connecting there can probe
 * seats, and keeping an extra client alive affects when Comfort stops a manual seat move.
 * Comfort defaults to ambient off, including a fresh installation without data.json. Driving-mode colours
 * can enable it independently of the main switch. Unreadable settings retain the conflict guard.
 *
 *   const o = new Others({ log }); o.start();
 *   o.comfort -> light writes must wait        o.unknown -> settings could not be checked
 */
const EventEmitter = require('events');
const fs = require('fs');

const COMFORT_SOCK = process.env.MGU_AMBIENT_COMFORT || '/run/iteriodev-comfort/ctl.sock';
const COMFORT_DATA = process.env.MGU_AMBIENT_COMFORT_DATA || '/var/opt/iteriodev-comfort/data.json';
const EVERY_MS = 10000;
// Comfort supplies colours for modes 1-10 unless a saved entry explicitly disables one with null.
const MODE_COLOURS = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true, 9: true, 10: true };

class Others extends EventEmitter {
    constructor(o) {
        super();
        this.log = o && o.log; this.comfort = false; this.unknown = false; this._timer = null;
        this._hadData = false;
    }

    start() { this.check(); this._timer = setInterval(() => this.check(), EVERY_MS); return this; }

    stop() { clearInterval(this._timer); }

    check() {
        let running = false, on = false, unknown = false;
        try { running = fs.statSync(COMFORT_SOCK).isSocket(); } catch (e) {
            unknown = e.code !== 'ENOENT' && e.code !== 'ENOTDIR';
        }
        if (running) {
            try {
                const data = JSON.parse(fs.readFileSync(COMFORT_DATA, 'utf8'));
                if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid Comfort settings');
                const ambient = data.ambient || {};
                if (typeof ambient !== 'object' || Array.isArray(ambient)) throw new Error('invalid ambient settings');
                this._hadData = true;
                const modes = ambient.modes || {}, colours = Object.assign({}, MODE_COLOURS, modes.rgb);
                on = !!ambient.on || (modes.on === true && Object.keys(colours).some((mode) => !!colours[mode]));
            } catch (e) {
                // Before the first save, Comfort uses its disabled defaults. A previously read file disappearing
                // does not prove that the running service has discarded its in-memory settings.
                unknown = e.code !== 'ENOENT' || this._hadData;
                on = unknown;
            }
        } else if (!unknown) this._hadData = false;
        on = on || unknown;
        if (on === this.comfort && unknown === this.unknown) return;
        this.comfort = on; this.unknown = unknown;
        if (this.log) {
            if (unknown) this.log.warn('Comfort ambient settings could not be read; ambient writes are paused');
            else if (on) this.log.warn('Comfort ambient lighting is enabled; ambient writes are paused');
            else this.log.info('Comfort ambient lighting is disabled or its service is stopped');
        }
        this.emit('change');
    }
}

module.exports = { Others, COMFORT_SOCK, COMFORT_DATA };
