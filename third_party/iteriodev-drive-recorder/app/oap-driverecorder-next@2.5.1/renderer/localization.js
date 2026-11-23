'use strict';
// Display strings only. Model values, settings and vehicle commands stay in the author's format.
const ru = require('./ru.json');
const exact = Object.create(null);
const patterns = [];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
Object.keys(ru).forEach((key) => {
    if (key.indexOf('{') < 0) {
        exact[key.toLowerCase()] = ru[key];
        return;
    }
    const names = [];
    const source = key.split(/(\{\w+\})/).map((part) => {
        if (!/^\{\w+\}$/.test(part)) return escape(part);
        names.push(part.slice(1, -1));
        return '(.+?)';
    }).join('');
    patterns.push({ re: new RegExp('^' + source + '$', 'i'), names, text: ru[key] });
});

let language = 'en';
function fromHmi(value) {
    if (value && typeof value === 'object') {
        if (value.currentDisplayLanguage !== undefined) return fromHmi(value.currentDisplayLanguage);
        if (value.value !== undefined) return fromHmi(value.value);
        return 'en';
    }
    return /^(ru(?:[-_]|$)|russisch|russian)/i.test(String(value || '')) ? 'ru' : 'en';
}
function setLanguage(value) {
    const next = fromHmi(value);
    const changed = next !== language;
    language = next;
    return changed;
}

function translate(text, depth) {
    const direct = exact[text.toLowerCase()];
    if (direct !== undefined) return text === text.toUpperCase() ? direct.toUpperCase() : direct;
    if (depth < 4) {
        for (const rule of patterns) {
            const match = rule.re.exec(text);
            if (!match) continue;
            return rule.text.replace(/\{(\w+)\}/g, (_, key) => translate(match[rule.names.indexOf(key) + 1], depth + 1));
        }
        if (text.indexOf(' · ') >= 0) return text.split(' · ').map((part) => translate(part, depth + 1)).join(' · ');
    }
    const months = { Jan: 'янв', Feb: 'фев', Mar: 'мар', Apr: 'апр', May: 'мая', Jun: 'июн',
        Jul: 'июл', Aug: 'авг', Sep: 'сен', Oct: 'окт', Nov: 'ноя', Dec: 'дек' };
    return text.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (month) => months[month])
        .replace(/(\d) GB\b/g, '$1 ГБ').replace(/(\d) MB\b/g, '$1 МБ')
        .replace(/(\d) s\b/g, '$1 с').replace(/(\d) fps\b/g, '$1 кадр/с');
}
function t(text) {
    return language === 'ru' && typeof text === 'string' ? translate(text, 0) : text;
}

const textKeys = new Set(['app', 'title', 'sub', 'sub2', 'text', 'label', 'body', 'body2', 'empty', 'emptyLine', 'left', 'right', 'unit']);
const listKeys = new Set(['tabs', 'items', 'chips', 'rows', 'buttons', 'legend']);
function displayList(value) {
    if (typeof value === 'string') return value.split(',').map((part) => t(part.trim())).join(', ');
    if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? t(item) : displayList(item));
    return options(value);
}
function options(value) {
    if (language !== 'ru' || !value || typeof value !== 'object') return value;
    const copy = Object.assign({}, value);
    Object.keys(copy).forEach((key) => {
        if (textKeys.has(key)) copy[key] = t(copy[key]);
        else if (listKeys.has(key)) copy[key] = displayList(copy[key]);
    });
    return copy;
}

function watch(builders, changed, log) {
    let stopped = false;
    const timers = new Set();
    const proxies = new Set();
    function dispose(proxy) {
        proxies.delete(proxy);
        if (proxy && typeof proxy.shutdown === 'function') Promise.resolve().then(() => proxy.shutdown()).catch(() => {});
    }
    function connect(iface, instance) {
        if (stopped) return;
        let proxy;
        Promise.resolve().then(() => builders.buildAndInitTypedProxy(iface, instance, { timeoutMs: 10000 }))
            .then((p) => {
                proxy = p;
                if (stopped) return dispose(p);
                proxies.add(p);
                const field = p.currentDisplayLanguage;
                let revision = 0;
                const receive = (value) => {
                    revision++;
                    if (!stopped && setLanguage(value)) changed();
                };
                return Promise.resolve(field.subscribe(receive)).then(() => {
                    if (stopped || typeof field.getValue !== 'function') return;
                    const before = revision;
                    return Promise.resolve().then(() => field.getValue()).then((value) => {
                        if (!stopped && revision === before) receive(value);
                    }).catch(() => {});
                });
            }).catch((error) => {
                dispose(proxy);
                if (stopped) return;
                if (log) log('display language:', String(error && error.message || error));
                const timer = setTimeout(() => { timers.delete(timer); connect(iface, instance); }, 30000);
                timers.add(timer);
            });
    }
    connect('de.bmw.infotainment.hmi.hmicontext.HMIContext', 'HMI_CID');
    connect('de.bmw.infotainment.hmi.hmicontext2.HMIContext2', '1');
    return function stop() {
        stopped = true;
        timers.forEach(clearTimeout);
        timers.clear();
        proxies.forEach(dispose);
    };
}

module.exports = { t, options, fromHmi, setLanguage, watch };
