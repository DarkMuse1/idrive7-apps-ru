'use strict';
// Thin shell for a password-locked app ("Подсветка"). The public store copy is ONLY this
// shell; it holds no app logic. On launch it:
//   1. asks the driver for the app's password on the native HMI keyboard (kit/speller),
//   2. sends {app, password} to the owner's server over the per-app internet grant,
//   3. the server (sourcing this app from the private close_mgu_app repo) returns the real
//      code only if the password is correct,
//   4. the shell writes that code next to the bundled kit in its data dir and runs its
//      start(ctx) inside this same mgu.run — so the real app takes over the screen.
// Without the correct password the shell downloads nothing useful and does nothing.
const mgu = require('./kit/mgu');
const speller = require('./kit/speller');
const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_KEY = 'ambient_light';          // the "key" the shell sends — its own name
const HOST = 'mgu.bmwexpertcode.com';
const UNLOCK_PATH = '/unlock';
// Pinned trust anchors (ISRG Root X1/X2) so TLS to the server validates regardless of the
// head unit's own (possibly old) CA bundle. See kit/runtime/server-ca.js (public roots).
const SERVER_CA = require('./kit/server-ca');

mgu.run({
    async start(ctx) {
        try {
            const pw = await speller.prompt(ctx.app, { title: 'Пароль «Подсветка»' });
            if (!pw) return showMessage(ctx, 'Доступ закрыт', 'Для запуска нужен пароль. Перезапустите приложение и введите пароль.');
            let bundle;
            try { bundle = await unlock(APP_KEY, pw); }
            catch (e) { ctx.log.warn('unlock: ' + msg(e)); return showMessage(ctx, 'Нет связи', 'Не удалось связаться с сервером: ' + msg(e)); }
            if (bundle === 'bad-password') return showMessage(ctx, 'Неверный пароль', 'Пароль не подошёл. Перезапустите приложение и попробуйте снова.');
            if (!bundle || !bundle.files) return showMessage(ctx, 'Ошибка', 'Сервер вернул пустой ответ.');
            let entry;
            try { entry = materialize(ctx, bundle); }
            catch (e) { ctx.log.warn('materialize: ' + msg(e)); return showMessage(ctx, 'Ошибка', 'Не удалось подготовить приложение: ' + msg(e)); }
            const real = require(entry);
            if (!real || typeof real.start !== 'function') return showMessage(ctx, 'Ошибка', 'Код приложения повреждён.');
            await real.start(ctx); // hands the screen to the real app, in this same ctx
        } catch (e) {
            ctx.log.warn('shell: ' + msg(e));
            try { showMessage(ctx, 'Ошибка', msg(e)); } catch (_) { /* nothing we can do */ }
        }
    },
});

function msg(e) { return String((e && e.message) || e); }

function showMessage(ctx, head, body) {
    ctx.loop('MAIN', 4, async () => {
        const t = ctx.theme(), cv = ctx.canvas(1600, 520).clear(t.bg);
        cv.text(head, 45, 110, 40, t.text, { font: 'bold' });
        wrap(body, 58).forEach((line, i) => cv.text(line, 45, 190 + i * 40, 26, t.dim));
        await ctx.ui.image('MAIN_GFX', cv);
    });
}

function wrap(s, n) {
    const words = String(s).split(' '), lines = []; let line = '';
    words.forEach((w) => {
        if ((line + ' ' + w).trim().length > n) { if (line) lines.push(line); line = w; }
        else line = (line ? line + ' ' : '') + w;
    });
    if (line) lines.push(line);
    return lines.slice(0, 6);
}

function unlock(app, password) {
    const body = JSON.stringify({ app: app, password: password });
    const options = {
        host: HOST, port: 443, path: UNLOCK_PATH, method: 'POST', servername: HOST, timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    if (SERVER_CA && SERVER_CA.length) options.ca = SERVER_CA; // pin the server's roots
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(new Error('ответ слишком большой')); });
            res.on('end', () => {
                if (res.statusCode === 401 || res.statusCode === 403) return resolve('bad-password');
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('некорректный ответ сервера')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('таймаут')));
        req.write(body); req.end();
    });
}

// Writes the delivered files next to a copy of the bundled kit in the app's data dir, so the
// real code's require('./kit/...') and require('./comfort-*') all resolve with plain Node.
function materialize(ctx, bundle) {
    const root = path.join(ctx.dataDir, '_payload');
    rmrf(root);
    mkdirp(root);
    Object.keys(bundle.files).forEach((name) => {
        if (String(name).indexOf('..') !== -1 || path.isAbsolute(name)) throw new Error('bad file name');
        const dest = path.join(root, name);
        mkdirp(path.dirname(dest));
        fs.writeFileSync(dest, String(bundle.files[name]));
    });
    copyDir(path.join(__dirname, 'kit'), path.join(root, 'kit'));
    const entry = path.join(root, bundle.entry || 'main.js');
    if (!fs.existsSync(entry)) throw new Error('нет точки входа');
    return entry;
}

function mkdirp(dir) {
    if (!dir || fs.existsSync(dir)) return;
    mkdirp(path.dirname(dir));
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
function rmrf(p) {
    let st; try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) { fs.readdirSync(p).forEach((f) => rmrf(path.join(p, f))); fs.rmdirSync(p); }
    else fs.unlinkSync(p);
}
function copyDir(src, dst) {
    mkdirp(dst);
    fs.readdirSync(src).forEach((f) => {
        const s = path.join(src, f), d = path.join(dst, f), st = fs.lstatSync(s);
        if (st.isDirectory()) copyDir(s, d);
        else fs.writeFileSync(d, fs.readFileSync(s));
    });
}
