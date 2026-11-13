'use strict';
// Display-only language state. Vehicle signals, commands and settings are not touched.
const config = require('./auto-language.json');
const i18n = require('./kit/i18n');
const locale = require('./kit/locale.json');
const contexts = [];
const subscriptions = [];
const nativeText = [];
let running = false, stopped = false, installed = false;
let language = config.defaultLanguage || 'en';
const HMI = [
    ['de.bmw.infotainment.hmi.hmicontext.HMIContext', 'HMI_CID'],
    ['de.bmw.infotainment.hmi.hmicontext2.HMIContext2', '1'],
];
function fromHmi(value) {
    if (value && typeof value === 'object') {
        if (value.currentDisplayLanguage !== undefined) return fromHmi(value.currentDisplayLanguage);
        if (value.value !== undefined) return fromHmi(value.value);
        return 'en';
    }
    const key = String(value || '').toLowerCase().replace(/_/g, '-');
    if (/^(ru(?:-|$)|russisch|russian)/.test(key)) return 'ru';
    if (/^(ko(?:-|$)|koreanisch|korean)/.test(key)) return 'ko';
    if (['zh-cn', 'zh-yue-hans-cn', 'chinesisch-simple', 'kantonesisch-simple'].indexOf(key) >= 0) return 'zh-CN';
    if (['zh-tw', 'zh-hk', 'zh-yue-hant-cn', 'chinesisch-traditionell', 'kantonesisch-traditionell'].indexOf(key) >= 0) return 'zh-TW';
    return 'en';
}
function invalidate(ctx) {
    if (stopped) return;
    if (ctx.ui && ctx.ui._invalidate) ctx.ui._invalidate();
    const display = ctx.display;
    if (!display) return;
    display.lastWords = null;
    display.bgShown = null;
    const screen = display.screen && display.screen.name;
    if (screen && ctx.ui && ((ctx.ui.isVisible && !ctx.ui.isVisible(screen) && !ctx.ui.isVisible('SETTINGS')) ||
        (ctx.ui.hasFocus && !ctx.ui.hasFocus(screen)))) {
        ctx.autoLanguageNeedsRedraw = true;
        return;
    }
    ctx.autoLanguageNeedsRedraw = false;
    // These author callbacks redraw pages which otherwise draw only on data
    // changes; they do not recreate the app or synthesize any control action.
    if (display._layoutChanged) display._layoutChanged();
    else (display.layoutHandlers || []).forEach((fn) => fn());
    (display.tickHandlers || []).forEach((fn) => fn());
}
function setLanguage(value) {
    if (stopped) return false;
    const requested = fromHmi(value);
    const next = Object.prototype.hasOwnProperty.call(config.languages, requested) ? requested : 'en';
    if (next === language) return false;
    language = next;
    i18n.setLanguage(next, config.languages[next] || {});
    locale.credit = (config.credits || {})[next] || '';
    nativeText.forEach((item) => {
        item.values.forEach((args) => {
            if (!stopped) Promise.resolve().then(() => {
                if (!stopped && (!item.writer.autoLanguageCanWrite || item.writer.autoLanguageCanWrite(args[2])))
                    return item.original.apply(item.writer, args);
            }).catch(() => {});
        });
    });
    contexts.forEach(invalidate);
    return true;
}
function stop() {
    if (stopped) return;
    stopped = true;
    subscriptions.splice(0).forEach((sub) => { try { sub.shutdown(); } catch (e) {} });
    contexts.length = 0;
    nativeText.length = 0;
}
function registerDisplayStrings(maps) {
    Object.keys(maps || {}).forEach((name) => {
        const words = maps[name];
        if (!words || typeof words !== 'object') throw new Error('Invalid display dictionary');
        Object.keys(words).forEach((key) => {
            if (typeof words[key] !== 'string') throw new Error('Invalid display translation');
        });
        config.languages[name] = Object.assign({}, config.languages[name] || {}, words);
    });
    i18n.setLanguage(language, config.languages[language] || {});
    if (running && !stopped) contexts.forEach(invalidate);
}
function attach(ctx) {
    if (stopped || !ctx || contexts.indexOf(ctx) >= 0) return;
    contexts.push(ctx);
    if (ctx.app && ctx.app.once) ctx.app.once('shutdown', stop);
    const repaint = (name, shown) => { if (!stopped && shown && ctx.autoLanguageNeedsRedraw) invalidate(ctx); };
    if (ctx.ui && ctx.ui.onVisible) ctx.ui.onVisible(repaint);
    if (ctx.ui && ctx.ui.onFocus) ctx.ui.onFocus(repaint);
    if (running) return;
    running = true;
    const signals = ctx.signals || require('./kit/signals');
    // Native initialization is serialized inside the author's signals.watch.
    HMI.forEach((pair) => {
        Promise.resolve().then(() => {
            if (stopped) return null;
            return signals.watch(pair[0], pair[1], { currentDisplayLanguage: setLanguage }, ctx.log);
        }).then((sub) => {
            if (!sub) return;
            if (stopped) { if (sub.shutdown) sub.shutdown(); }
            else if (sub.shutdown) subscriptions.push(sub);
        }).catch(() => {});
    });
}
function install() {
    if (installed) return;
    installed = true;
    i18n.setLanguage(language, config.languages[language] || {});
    // Private payloads already share this installed i18n singleton through
    // their existing kit proxies; no duplicated module/config or path escape.
    i18n.registerDisplayStrings = registerDisplayStrings;
    const mgu = require('./kit/mgu');
    try {
        const speller = require('./kit/speller');
        const prompt = speller.prompt;
        if (typeof prompt === 'function') speller.prompt = function (app, options) {
            const translated = Object.assign({}, options || {});
            if (translated.title !== undefined) translated.title = i18n.t(translated.title);
            return prompt.call(this, app, translated);
        };
    } catch (error) {
        if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
    }
    // Keep original dynamic RHMI writes so static states and settings which do
    // not redraw continuously can be relabelled without replaying a button.
    const HmiText = require('./kit/hmi-text').HmiText;
    const nativeSet = HmiText.prototype.set;
    HmiText.prototype.set = function () {
        if (stopped) return nativeSet.apply(this, arguments);
        let item = nativeText.find((entry) => entry.writer === this);
        if (!item) {
            item = { writer: this, original: nativeSet, values: new Map() };
            nativeText.push(item);
        }
        const args = Array.prototype.slice.call(arguments);
        const key = JSON.stringify(args.slice(1, 4));
        item.values.set(key, args);
        return nativeSet.apply(this, args);
    };
    const run = mgu.run;
    mgu.run = function (impl) {
        const next = Object.assign({}, impl);
        if (impl.start) next.start = function (ctx) { attach(ctx); return impl.start(ctx); };
        if (impl.background) next.background = function (ctx) { attach(ctx); return impl.background(ctx); };
        return run.call(this, next);
    };
    process.once('exit', stop);
}
module.exports = { install, attach, stop, registerDisplayStrings, setLanguage, fromHmi, getLanguage: () => language };
