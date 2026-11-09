'use strict';
// Node 8 compatible. No vehicle traffic or saved password; the real app owns its
// existing ctx only after the server has authorised this exact published release.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const LIMIT = 8 * 1024 * 1024;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const names = o => Object.keys(o).sort();
const plain = o => !!o && typeof o === 'object' && !Array.isArray(o);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fetchBundle(config, password, ca, transport) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ app: config.key, password: password });
        let req, timer, done = false;
        const finish = (error, value) => {
            if (done) return;
            done = true; clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        try {
            req = (transport || https).request({
                hostname: 'mgu.bmwexpertcode.com', port: 443, path: '/unlock', method: 'POST',
                servername: 'mgu.bmwexpertcode.com', ca: ca,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, res => {
                let bytes = 0, text = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    bytes += Buffer.byteLength(chunk);
                    if (bytes > LIMIT) { finish(Error('Ответ сервера слишком большой')); req.destroy(); }
                    else text += chunk;
                });
                res.on('error', () => finish(Error('Загрузка кода прервана')));
                res.on('aborted', () => finish(Error('Загрузка кода прервана')));
                res.on('end', () => {
                    if (res.statusCode === 401 || res.statusCode === 403) return finish(Error('Неверный пароль'));
                    if (res.statusCode === 429) return finish(Error('Слишком много попыток. Повторите через 5 минут'));
                    if (res.statusCode !== 200) return finish(Error('Сервер недоступен: HTTP ' + res.statusCode));
                    try { finish(null, JSON.parse(text)); } catch (_) { finish(Error('Некорректный ответ сервера')); }
                });
            });
            // A total deadline also bounds DNS/connection stalls, not only socket inactivity.
            timer = setTimeout(() => { finish(Error('Сервер не ответил за 15 секунд')); req.destroy(); }, 15000);
            req.on('error', () => finish(Error('Нет защищённого соединения с сервером')));
            req.end(body);
        } catch (_) { finish(Error('Не удалось отправить запрос на сервер')); }
    });
}

function validate(bundle, config) {
    if (!bundle || bundle.ok !== true || bundle.entry !== 'main.js' || !plain(bundle.files)) throw Error('Неполный ответ сервера');
    const text = bundle.files['release.json'];
    if (typeof text !== 'string' || hash(Buffer.from(text, 'utf8')) !== config.releaseSha256) throw Error('Версия кода не совпадает с установленным приложением');
    let release;
    try { release = JSON.parse(text); } catch (_) { throw Error('Повреждён список файлов приложения'); }
    if (release.schema !== 1 || release.app !== 'ambient_light' || release.version !== config.version || release.entry !== 'main.js' || !plain(release.files) || !plain(release.resources)) throw Error('Неподдерживаемая версия приложения');
    const list = names(release.files);
    if (!list.length || list.length > 199 || !own(release.files, 'main.js') || !equal(names(bundle.files), list.concat(['release.json']).sort())) throw Error('Состав файлов приложения не совпадает');
    let total = Buffer.byteLength(text);
    list.forEach(name => {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.js$/.test(name) || name.indexOf('..') >= 0 || typeof bundle.files[name] !== 'string') throw Error('Недопустимый файл приложения');
        const data = Buffer.from(bundle.files[name], 'utf8');
        total += data.length;
        if (total > LIMIT || hash(data) !== release.files[name]) throw Error('Код приложения загружен не полностью');
    });
    names(release.resources).forEach(name => {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(pack|wad|wasm)$/.test(name) || name.indexOf('..') >= 0 || !/^[a-f0-9]{64}$/.test(release.resources[name])) throw Error('Недопустимый ресурс приложения');
    });
    return release;
}

function mkdir(dir) { if (!fs.existsSync(dir)) { mkdir(path.dirname(dir)); fs.mkdirSync(dir); } }
function normalDirectory(dir) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Недопустимый каталог кода приложения');
}
function remove(dir) {
    const stat = fs.lstatSync(dir);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { fs.readdirSync(dir).forEach(n => remove(path.join(dir, n))); fs.rmdirSync(dir); }
    else fs.unlinkSync(dir);
}

// Proxies keep every kit singleton at its ORIGINAL installed path (not a copied
// runtime whose APP_ROOT would incorrectly point at data/_payload).
function kitProxies(source, target) {
    mkdir(target);
    fs.readdirSync(source).forEach(name => {
        const from = path.join(source, name), to = path.join(target, name), stat = fs.lstatSync(from);
        if (stat.isSymbolicLink()) throw Error('Неожиданный символический ресурс kit');
        if (stat.isDirectory()) kitProxies(from, to);
        else if (name.endsWith('.js')) fs.writeFileSync(to, "'use strict';\nmodule.exports=require(" + JSON.stringify(from) + ');\n');
        else fs.writeFileSync(to, fs.readFileSync(from));
    });
}

function prepare(bundle, config, dataDir, installedDir) {
    const release = validate(bundle, config); // no writes before the whole reply passes
    installedDir = path.resolve(installedDir);
    names(release.resources).forEach(name => {
        if (hash(fs.readFileSync(path.join(installedDir, name))) !== release.resources[name]) throw Error('Повреждён ресурс ' + name + '. Обновите приложение в магазине');
    });
    const parent = path.resolve(dataDir, '_payload');
    mkdir(parent); normalDirectory(parent);
    const base = path.join(parent, 'ambient_light');
    mkdir(base); normalDirectory(base);
    // A new generation avoids stale require.cache and never writes into an
    // existing generation that may already have been required.
    const id = config.releaseSha256 + '-' + crypto.randomBytes(6).toString('hex');
    const stage = path.join(base, '.' + id), dest = path.join(base, id);
    fs.mkdirSync(stage, 0o700);
    try {
        names(release.files).forEach(name => fs.writeFileSync(path.join(stage, name), bundle.files[name], 'utf8'));
        names(release.resources).forEach(name => {
            const from = path.join(installedDir, name), to = path.join(stage, name);
            try { fs.linkSync(from, to); } catch (_) { fs.writeFileSync(to, fs.readFileSync(from)); }
        });
        kitProxies(path.join(installedDir, 'kit'), path.join(stage, 'kit'));
        fs.renameSync(stage, dest); // publish only a complete generation
    } catch (error) { if (fs.existsSync(stage)) remove(stage); throw error; }
    // Only generations created by this loader; settings, logs, legacy import and
    // every other app data directory stay untouched.
    fs.readdirSync(base).filter(n => n !== id && /^\.?[a-f0-9]{64}-[a-f0-9]{12}$/.test(n)).forEach(n => {
        const old = path.join(base, n);
        Object.keys(require.cache).filter(k => k.indexOf(old + path.sep) === 0).forEach(k => delete require.cache[k]);
        remove(old);
    });
    return path.join(dest, 'main.js');
}

function start(ctx, config, dependencies) {
    const d = dependencies || {};
    const speller = d.speller || require('./kit/speller');
    const ca = d.ca || require('./kit/server-ca');
    const installedDir = d.installedDir || __dirname;
    let phase = 'idle', headline = 'Подсветка · доступ по паролю';
    let message = 'Откройте приложение и введите пароль от подсветки.';
    const foreground = () => ctx.ui.isVisible('MAIN') && (!ctx.ui.hasFocus || ctx.ui.hasFocus('MAIN'));
    const paint = async () => {
        const t = ctx.theme(), cv = ctx.canvas(1600, 520).clear(t.bg);
        cv.text(headline, 45, 110, 38, t.text, {font:'bold'});
        const words = message.split(' '), lines = []; let line = '';
        words.forEach(word => { if ((line + ' ' + word).length > 70) { lines.push(line); line = word; } else line += (line ? ' ' : '') + word; });
        if (line) lines.push(line);
        lines.slice(0, 5).forEach((s, i) => cv.text(s, 45, 190 + i * 42, 26, t.dim));
        if (phase === 'error' || phase === 'cancelled') cv.text('«Выбрать» или касание экрана — повторить', 45, 450, 24, t.text);
        await ctx.ui.image('MAIN_GFX', cv);
    };
    const gate = ctx.loop('MAIN', 2, paint);
    const widgetNotice = () => {
        if (phase === 'ready' || !ctx.widget || !ctx.widget.instances) return;
        ctx.widget.instances().forEach(inst => {
            ctx.widget.set(inst.spawnId, 'Title', 'Подсветка', 'Text');
            ctx.widget.set(inst.spawnId, 'TextRecordings', 'Откройте приложение', 'Text');
            ctx.widget.set(inst.spawnId, 'TextCam', 'Введите пароль для запуска', 'Text');
        });
    };
    if (ctx.widget && ctx.widget.onChange) ctx.widget.onChange(widgetNotice);
    widgetNotice(); // no second widget loop and no popup on a background start
    async function attempt() {
        if (!foreground() || ['idle','error','cancelled'].indexOf(phase) < 0) return;
        phase = 'prompting'; headline = 'Введите пароль'; message = 'Подтвердите пароль на экранной клавиатуре автомобиля.';
        try {
            let password = await speller.prompt(ctx.app, {title:'Пароль подсветки'});
            if (!password) { phase = 'cancelled'; headline = 'Доступ закрыт'; message = 'Пароль не введён. Для запуска нажмите «Выбрать».'; return; }
            phase = 'downloading'; headline = 'Загрузка подсветки'; message = 'Проверяем доступ и загружаем код приложения с сервера…';
            ctx.log.info('Подсветка: запрос доступа к версии ' + config.version + '; пароль не сохраняется');
            let bundle;
            try { bundle = await (d.fetchBundle || fetchBundle)(config, password, ca); }
            finally { password = null; }
            const entry = prepare(bundle, config, ctx.dataDir, installedDir);
            const app = require(entry);
            if (!app || typeof app.start !== 'function') throw Error('Отсутствует точка входа приложения');
            phase = 'starting';
            // Stop only the gate's screen loop; the app registers its own loops
            // and widget on the SAME ctx and retains all existing settings/data.
            if (gate && gate.stop) gate.stop();
            await app.start(ctx);
            phase = 'ready';
            ctx.log.info('Подсветка ' + config.version + ': доступ подтверждён, приложение запущено');
        } catch (error) {
            // Do not restart a partly started business app and duplicate its
            // subscriptions/commands after an exception in its own start().
            if (phase === 'starting') {
                phase = 'failed-start'; headline = 'Не удалось запустить Подсветка';
                message = 'Перезапустите приложение. Подробности ошибки сохранены в журнале.';
                ctx.loop('MAIN', 1, paint);
                ctx.log.error('Подсветка: ошибка запуска: ' + String(error && error.message || error));
                return;
            }
            phase = 'error'; headline = 'Не удалось открыть подсветку';
            message = String(error && error.message || error);
            ctx.log.warn('Подсветка: ' + message);
        }
    }
    function request() { attempt().catch(() => {}); }
    ctx.ui.onVisible((name, on) => { if (name === 'MAIN' && on && phase === 'idle') request(); });
    if (ctx.ui.onFocus) ctx.ui.onFocus((name, on) => { if (name === 'MAIN' && on && phase === 'idle') request(); });
    ctx.ui.onClick('BTN_SELECT', request);
    if (ctx.onTap) ctx.onTap(request);
    if (foreground()) request();
    return {attempt:attempt, phase:() => phase};
}

module.exports = {start, fetchBundle, validate, prepare};
