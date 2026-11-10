'use strict';
// Public provisioning helper. No lighting protocol, password, download URL or
// general command execution. It can install ONE content-pinned private image.
// Node 8 / stock HU Node, launched by the existing root systemd component.
const fs = require('fs'), path = require('path'), net = require('net');
const crypto = require('crypto'), cp = require('child_process');
const IMAGE_SHA256 = '057bf1d9642c49a280814c55c77c288e4af5f9b03777067d21e9f0ba455d0a72';
const IMAGE_SIZE = 288928;
const AUTH_SHA256 = '025d48c1f719080b61cbc981b5d0fcc55251b749c507644bc30ca5e736c964dd';
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function directory(name, mode) {
    try { fs.mkdirSync(name, mode); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const s = fs.lstatSync(name);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022)) throw Error('Unsafe service directory');
    fs.chmodSync(name, mode);
}

async function run(options) {
    // Options are for the private offline harness only; IPC cannot set paths,
    // arguments, hashes, environment, URLs or executable names.
    const o = options || {}, base = o.base || '/var/opt/mgu-ambient-rgb';
    const runtime = o.runtime || '/run/mgu-ambient-rgb';
    directory(base, 0o755); directory(runtime, 0o755);
    const store = path.join(base, 'private'); directory(store, 0o700);
    const image = path.join(store, 'rgb-' + IMAGE_SHA256);
    const address = path.join(runtime, 'provision.sock');
    const control = path.join(runtime, 'control.sock');
    let child = null, stopping = false, retry = null, lastError = '', tail = '',authorization=null;
    const peers = new Set();
    function verified() {
        try {
            const s = fs.lstatSync(image);
            if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) || s.size !== IMAGE_SIZE) return false;
            return digest(fs.readFileSync(image)) === IMAGE_SHA256;
        } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    }
    function launch() {
        if (stopping || child) return;
        if (!verified()) throw Error('Private RGB module has not been activated');
        tail = ''; lastError = '';
        const binary = o.interpreter || image;
        const args = o.interpreter ? [image].concat(o.args || []) : [];
        const current = child = cp.spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        current.stderr.on('data', chunk => {
            tail = (tail + String(chunk)).slice(-2048);
            if (o.log) o.log(String(chunk)); else process.stderr.write(chunk);
        });
        current.on('error', error => { lastError = 'RGB process could not start: ' + error.message; });
        current.on('close', (code, signal) => {
            if (child !== current) return;
            child = null;
            lastError = lastError || ('RGB process stopped (' + (signal || code) + '): ' + tail.trim());
            if (!stopping) { retry = setTimeout(() => { retry = null; try { launch(); } catch (e) { lastError = e.message; } }, 5000); }
        });
    }
    function probe() {
        return new Promise(resolve => {
            const socket = net.createConnection(control); let done = false, input = '';
            const finish = result => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(result); };
            const timer = setTimeout(() => finish(false), 500);
            socket.on('error', () => finish(false));
            socket.on('connect', () => socket.write(JSON.stringify({id:1,op:'state',auth:authorization})+'\n'));
            socket.on('data', data => {
                input += data;
                if (input.length > 262144) return finish(false);
                if (input.indexOf('\n') < 0) return;
                try { const r = JSON.parse(input.split('\n')[0]); finish(r.ok === true && r.state && r.state.schema === 1); }
                catch (_) { finish(false); }
            });
        });
    }
    async function ready() {
        launch();
        const until = Date.now() + 10000;
        while (!stopping && Date.now() < until) {
            if (!child) throw Error(lastError || 'RGB process stopped');
            if (await probe()) return;
            await sleep(100);
        }
        throw Error(lastError || 'RGB process did not open its local control socket');
    }
    async function request(data) {
        if(data&&data.op==='install'&&typeof data.auth!=='string')throw Error('Обновите приложение «Подсветка» вместе с компонентом RGB в Магазине');
        if (!data || Object.keys(data).sort().join(',') !== 'auth,image,op' || data.op !== 'install' || typeof data.image !== 'string') throw Error('Only installation of the pinned RGB module is supported');
        if(typeof data.auth!=='string'||data.auth.length!==64||!crypto.timingSafeEqual(Buffer.from(digest(data.auth),'hex'),Buffer.from(AUTH_SHA256,'hex')))throw Error('RGB activation is not authorized');
        if (data.image.length !== 4 * Math.ceil(IMAGE_SIZE / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.image)) throw Error('Invalid private module encoding');
        const bytes = Buffer.from(data.image, 'base64');
        if (bytes.length !== IMAGE_SIZE || digest(bytes) !== IMAGE_SHA256) throw Error('Private module checksum does not match this release');
        authorization=data.auth;
        if (!verified()) {
            const temporary = path.join(store, '.rgb-' + crypto.randomBytes(8).toString('hex'));
            const fd = fs.openSync(temporary, 'wx', 0o700);
            try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o700); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            try { fs.renameSync(temporary, image); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
        await ready();
        return { ok: true, sha256: IMAGE_SHA256, running: true };
    }
    // Remove only this helper's own stale Unix socket; never a regular file or
    // a listening peer from another instance.
    if (fs.existsSync(address)) {
        const s = fs.lstatSync(address);
        if (!s.isSocket() || s.uid !== process.getuid()) throw Error('Provisioning socket path is occupied');
        const live = await new Promise(resolve => {
            const socket = net.createConnection(address);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('error', e => resolve(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'));
        });
        if (live) throw Error('Provisioning helper is already running');
        try { fs.unlinkSync(address); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const server = net.createServer(socket => {
        if (peers.size >= 8) return socket.destroy();
        peers.add(socket); let input = '', handled = false;
        socket.setEncoding('utf8'); socket.setTimeout(15000, () => socket.destroy());
        socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
        socket.on('data', chunk => {
            if (handled) return;
            input += chunk;
            if (input.length > 4*Math.ceil(IMAGE_SIZE/3)+4096) return socket.destroy();
            const end = input.indexOf('\n'); if (end < 0) return;
            handled = true;
            Promise.resolve().then(() => request(JSON.parse(input.slice(0, end))))
                .then(result => socket.end(JSON.stringify(result) + '\n'), error => socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'));
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(address, () => { fs.chmodSync(address, 0o666); server.removeListener('error', reject); resolve(); });
    });
    server.on('error', e => { lastError = e.message; if (o.log) o.log(e.message); });
    if (verified()) launch();
    const close = async () => {
        if (stopping) return;
        stopping = true; clearTimeout(retry);
        peers.forEach(socket => socket.destroy());
        await new Promise(resolve => server.close(resolve));
        const current = child;
        if (current) {
            await new Promise(resolve => {
                const kill = setTimeout(() => { current.kill('SIGKILL'); }, 25000);
                current.once('close', () => { clearTimeout(kill); resolve(); });
                current.kill('SIGTERM');
            });
        }
        // net.Server removes its own Unix socket on close.
    };
    return { close, image, address, control };
}

if (require.main === module) {
    if (process.argv.length !== 2) throw Error('No command line options are supported');
    run().then(service => {
        let closing = false;
        const stop = () => { if (closing) return; closing = true; service.close().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); }); };
        process.on('SIGTERM', stop); process.on('SIGINT', stop);
        console.log('MGU RGB loader ready; private module is installed only after app activation');
    }).catch(e => { console.error('MGU RGB loader: ' + e.message); process.exitCode = 1; });
}
module.exports = { run, IMAGE_SHA256, IMAGE_SIZE };
