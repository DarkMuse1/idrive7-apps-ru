'use strict';
// Local desktop preview, Node >=18. No third-party server dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.MGU_DEMO_PORT || 8765);
const HOST = '127.0.0.1';
const origin = 'http://' + HOST + ':' + PORT;
const apps = fs.readdirSync(path.join(ROOT, 'apps')).filter((id) => {
    const p = path.join(ROOT, 'apps', id, 'app.json');
    return fs.existsSync(p);
}).map((id) => {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', id, 'app.json'), 'utf8'));
    return { id, title: s.title };
});
const languages = ['en'].concat(fs.readdirSync(path.join(ROOT, 'kit/runtime/locales')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
const python = process.env.MGU_PYTHON || [path.join(ROOT, '.venv/Scripts/python.exe'), path.join(ROOT, '../idrive7-apps/.venv/Scripts/python.exe')].find(fs.existsSync) || (process.platform === 'win32' ? 'python' : 'python3');
let worker = null, generation = 0, pending = false, frame = null, frameId = 0;
let state = { status: 'idle', apps, languages, logs: [] };
const built = new Set();
function log(level, text) { state.logs.push({ level, text }); if (state.logs.length > 60) state.logs.shift(); }
function build(app, language) {
    const appDir = path.join(ROOT, 'apps', app);
    const spec = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
    for (const asset of spec.assets || []) {
        const file = path.join(appDir, asset.file);
        if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== asset.sha256) {
            return Promise.reject(new Error('Offline preview needs the verified local asset apps/' + app + '/' + asset.file + '; see docs/windows-demo.md. Nothing was downloaded.'));
        }
    }
    const dist = path.join(ROOT, 'dist-preview/desktop', language);
    const key = language + '/' + app;
    if (built.has(key)) return Promise.resolve(path.join(dist, app));
    return new Promise((resolve, reject) => {
        const p = cp.spawn(python, [path.join(__dirname, 'build.py'), '--preview-only', '--language', language, '--dist', dist, app], { cwd: ROOT, windowsHide: true });
        let output = '';
        p.stdout.on('data', (b) => { output = (output + b).slice(-8000); });
        p.stderr.on('data', (b) => { output = (output + b).slice(-8000); });
        const timer = setTimeout(() => p.kill(), 120000);
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error('Preview build failed: ' + output));
            built.add(key); resolve(path.join(dist, app));
        });
    });
}
async function start(app, language, mode) {
    if (pending) throw new Error('Preview is still starting');
    if (!apps.some((a) => a.id === app) || !languages.includes(language) || !['demo', 'missing', 'stale'].includes(mode)) throw new Error('Unknown preview selection');
    pending = true;
    const current = ++generation;
    if (worker) { worker.kill(); worker = null; }
    frame = null;
    state = { status: 'building', app, language, mode, apps, languages, logs: [] };
    try {
        const stage = await build(app, language);
        state.status = 'starting';
        const dataDir = fs.mkdtempSync(path.join(path.dirname(stage), '.demo-data-'));
        worker = cp.fork(path.join(__dirname, 'demo-worker.js'), [stage, mode, dataDir], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        worker.stderr.on('data', (b) => { if (current === generation) log('error', String(b)); });
        worker.on('message', (m) => {
            if (current !== generation) return;
            if (m.type === 'frame') { frame = Buffer.from(m.png, 'base64'); frameId++; state.data = m.data; }
            else if (m.type === 'ready') { state.status = 'ready'; state.spec = m.spec; state.values = m.values; state.data = m.data; state.screen = m.screen; }
            else if (m.type === 'screen') state.screen = m.name;
            else if (m.type === 'log') log(m.level, m.text);
            else if (m.type === 'label') { state.labels = state.labels || {}; state.labels[m.name] = m.text; }
        });
        worker.on('error', (e) => { if (current === generation) { state.status = 'error'; log('error', e.message); } });
        worker.on('exit', (code) => {
            fs.rmSync(dataDir, { recursive: true, force: true });
            if (current === generation) { state.status = 'error'; log('error', 'Preview process stopped (' + code + ')'); worker = null; }
        });
    } catch (e) { state.status = 'error'; log('error', e.message); throw e; }
    finally { pending = false; }
}
const html = fs.readFileSync(path.join(__dirname, 'demo.html'));
const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'none'");
    function reply(code, data, type) { res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' }); res.end(type ? data : JSON.stringify(data)); }
    if (req.headers.host !== HOST + ':' + PORT) return reply(403, { error: 'Local host only' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') return reply(200, html, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') return reply(200, Object.assign({}, state, { frameId }));
    if (req.method === 'GET' && url.pathname === '/frame.png') return frame ? reply(200, frame, 'image/png') : reply(503, { error: 'Waiting for first frame' });
    if (req.method !== 'POST' || url.pathname !== '/api/control') return reply(404, { error: 'Not found' });
    if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'Same-origin JSON required' });
    try {
        let body = '';
        for await (const b of req) { body += b; if (body.length > 8192) throw new Error('Request too large'); }
        const m = JSON.parse(body);
        if (m.type === 'shutdown') { reply(200, { ok: true }); setImmediate(stop); return; }
        if (m.type === 'start') await start(m.app, m.language, m.mode);
        else {
            if (!worker || state.status !== 'ready') throw new Error('Preview is not ready');
            if (!['click', 'setting', 'focus', 'screen'].includes(m.type)) throw new Error('Unknown command');
            worker.send(m);
        }
        reply(200, { ok: true });
    } catch (e) { reply(400, { error: e.message }); }
});
server.listen(PORT, HOST, () => {
    console.log('MGU Tools offline preview: ' + origin + '\nCtrl+C stops the preview. No connection to the car.');
    if (process.argv.includes('--open') && process.platform === 'win32') cp.spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin], { windowsHide: true, stdio: 'ignore' });
});
server.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
function stop() { if (worker) worker.kill(); server.close(() => process.exit()); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('exit', () => { if (worker) worker.kill(); });
