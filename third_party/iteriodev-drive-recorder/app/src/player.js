'use strict';
/*
 * The player tool iteriodev-drplay (mgu-drplay) over its socket /run/iteriodev-drplay/drplay.sock: lines, fields split
 * by tabs, texts never hold tabs or newlines. The protocol is the header of apps/drplay/src/main.c. One client: this
 * app. Reconnects every 2 s; a lock / unlock / delete without its "done" in 10 s ends as done ... ok false "timeout", a
 * copy after 180 s without a line (the copy child fsyncs each file: a big one is silent for a while; every progress
 * line restarts its clock), and as "player not running" when the socket goes. A reply after that is ignored. Node 8.
 *   app -> tool: hello | list | play <clip> <start s> | pause | resume | seek <s> | cam <0-4> | stop | lock <clip> |
 *                unlock <clip> | delete <clip> | copy <clip> <all|front|rear|left|right> | usb
 *   tool -> app: hello <version> · clip <id> <seconds> <cams> <bytes> <locked 0|1> <thumb file> <pending 0|1> ...
 *                then clips <count> <total bytes> <full 0|1> · state <name> <clip> <pos> <dur> <cam> <cams> <text> ·
 *                usb <stick label> <free bytes> | usb - 0 · copy <clip> <percent> <encoding <cam> | stick label> ·
 *                done <command> <clip> <ok 0|1> <text>
 *   cams (2.1.0, tool 1.1.0): the layout - 0 all cameras (2x2), 1 front + rear (top / bottom), 2 left + right, 3 front,
 *   4 rear, 5 left, 6 right camera only. pending: still being saved (not playable). A seek opens a fresh decoder from
 *   the keyframe before it: the state follows a moment later. copy <what>: all = the clip as recorded, a camera = its
 *   MP4 with the stamp (made first: "encoding <cam>" progress, then the stick's label while it is written).
 *
 *   const p = new Player({ log, socket, retryMs, timeoutMs }); p.connect();
 *   p.up, p.version, p.clips [{ id, secs, cams (layout 0-6), bytes, locked, thumb, pending }] newest first, p.total,
 *   p.full, p.state { state, clip, pos, dur, cam, cams, text }, p.stick { label ('' = no stick), free } | null (not told)
 *   events: up, down, hello (version), clips, state (state), usb (stick), copy { clip, pct, text },
 *   done { cmd, clip, ok, text }
 */
const net = require('net');
const EventEmitter = require('events');

const SOCKET = '/run/iteriodev-drplay/drplay.sock';
const IDLE = { state: 'idle', clip: '', pos: 0, dur: 0, cam: 0, cams: 0, text: '' };
const ID = /^[0-9]{8}_[0-9]{6}$/;          // clip id = its metadata file's time (YYYYMMDD_HHMMSS)
const camsOf = (v) => (/^[0-6]$/.test(v) ? Number(v) : 0);
const WHAT = ['all', 'front', 'rear', 'left', 'right'];
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

class Player extends EventEmitter {
    constructor(o) {
        super();
        o = o || {};
        this.path = o.socket || SOCKET;
        this.retryMs = o.retryMs || 2000;
        this.timeoutMs = o.timeoutMs || 10000;
        this.copyTimeoutMs = o.copyTimeoutMs || 180000;
        this.log = o.log || (() => {});
        this.sock = null; this.inbuf = ''; this.closed = false;
        this.up = false; this.version = '';
        this.clips = []; this.next = []; this.total = 0; this.full = false;
        this.state = Object.assign({}, IDLE);
        this.stick = null;
        this.waiting = {};          // '<cmd> <clip>' -> its timeout
    }

    connect() {
        if (this.closed) return;
        const s = net.createConnection(this.path);
        s.setEncoding('utf8');
        s.on('connect', () => {
            this.sock = s; this.inbuf = ''; this.up = true;
            this.log('player tool connected');
            this.send('hello');
            this.send('list');
            this.emit('up');
        });
        s.on('data', (d) => {
            this.inbuf += d;
            let nl;
            while ((nl = this.inbuf.indexOf('\n')) >= 0) {
                const l = this.inbuf.slice(0, nl).replace(/\r$/, '');
                this.inbuf = this.inbuf.slice(nl + 1);
                if (l) this.line(l.split('\t'));
            }
            if (this.inbuf.length > 65536) this.inbuf = '';
        });
        s.on('error', () => { /* close follows */ });
        s.on('close', () => {
            if (this.sock === s) {
                this.sock = null; this.up = false;
                this.clips = []; this.next = []; this.total = 0; this.full = false;
                this.state = Object.assign({}, IDLE);
                this.stick = null;
                Object.keys(this.waiting).forEach((k) => this.finish(k.split(' ')[0], k.split(' ')[1], false, 'player not running'));
                this.log('player tool gone');
                this.emit('down');
            }
            if (!this.closed) setTimeout(() => this.connect(), this.retryMs);
        });
    }
    /** No more reconnects (tests). */
    close() { this.closed = true; if (this.sock) this.sock.destroy(); }

    line(f) {
        const k = f[0];
        if (k === 'hello') { this.version = f[1] || ''; this.emit('hello', this.version); }
        else if (k === 'clip' && ID.test(f[1])) {
            this.next.push({ id: f[1], secs: num(f[2]), cams: camsOf(f[3]), bytes: num(f[4]), locked: f[5] === '1', thumb: f[6] || '', pending: f[7] === '1' });
        } else if (k === 'clips') {
            this.clips = this.next.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
            this.next = []; this.total = num(f[2]); this.full = f[3] === '1';
            this.emit('clips');
        } else if (k === 'state') {
            this.state = { state: f[1] || 'idle', clip: f[2] || '', pos: num(f[3]), dur: num(f[4]), cam: num(f[5]), cams: camsOf(f[6]), text: f[7] || '' };
            this.emit('state', this.state);
        } else if (k === 'usb') {
            this.stick = f[1] && f[1] !== '-' ? { label: f[1], free: num(f[2]) } : { label: '', free: 0 };
            this.emit('usb', this.stick);
        } else if (k === 'copy') {
            if (!this.waiting[`copy ${f[1]}`]) return;          // a copy already given up (timeout): not shown again
            this.wait('copy', f[1]);
            this.emit('copy', { clip: f[1], pct: num(f[2]), text: f[3] || '' });
        } else if (k === 'done' && this.waiting[`${f[1]} ${f[2]}`]) this.finish(f[1], f[2], f[3] === '1', f[4] || '');
    }

    send(line) {
        if (this.sock && !this.sock.destroyed && this.sock.writable) { this.sock.write(`${line}\n`); return true; }
        this.log('player tool not connected, dropped:', line.split('\t')[0]);
        return false;
    }
    // a request answered by "done" (arg: copy's what)
    ask(cmd, clip, arg) {
        if (!ID.test(clip)) return this.finish(cmd, String(clip), false, 'bad clip');
        if (this.send(`${cmd}\t${clip}${arg ? `\t${arg}` : ''}`)) this.wait(cmd, clip);
        else this.finish(cmd, clip, false, 'player not running');
    }
    wait(cmd, clip) {
        const k = `${cmd} ${clip}`;
        clearTimeout(this.waiting[k]);
        this.waiting[k] = setTimeout(() => this.finish(cmd, clip, false, 'timeout'), cmd === 'copy' ? this.copyTimeoutMs : this.timeoutMs);
    }
    finish(cmd, clip, ok, text) {
        const k = `${cmd} ${clip}`;
        clearTimeout(this.waiting[k]);
        delete this.waiting[k];
        this.emit('done', { cmd, clip, ok, text });
    }

    list() { this.send('list'); }
    play(id, at) { if (ID.test(id)) this.send(`play\t${id}\t${Math.max(0, Number(at) || 0)}`); }
    pause() { this.send('pause'); }
    resume() { this.send('resume'); }
    seek(s) { this.send(`seek\t${Math.max(0, Number(s) || 0).toFixed(1)}`); }
    cam(n) { n = Number(n); if (n >= 0 && n <= 4 && n === Math.floor(n)) this.send(`cam\t${n}`); }
    stop() { this.send('stop'); }
    lock(id, on) { this.ask(on === false ? 'unlock' : 'lock', id); }
    remove(id) { this.ask('delete', id); }
    copy(id, what) { this.ask('copy', id, WHAT.indexOf(what) >= 0 ? what : 'all'); }
    askUsb() { this.send('usb'); }
}

module.exports = { Player, SOCKET };
