'use strict';
// Display-only Russian formatting for Live Data, as apps/edrive/ui_text.js and apps/dtc_scanner/ui_text.js:
// the numbers of a formatted line go into a Russian sentence and the units after them get their Russian symbols.
// The wording comes from kit/runtime/locales/ru.json (kit/i18n.js t()); values, keys and saved data stay as they are.
const { t, dict, getLanguage } = require('./kit/i18n');

const N = '(-?\\d+(?:[.:]\\d+)?)';                 // a number as the app writes it: 12, -0.5, 1.80, 0:42
const unit = (u) => [new RegExp(N + ' ' + u.replace(/\//g, '\\/') + '(?![\\w/])', 'g'), '{n} ' + u, ['n']];
// the tabs: "Units" alone is Redline's speed units in ru.json, so the tab has a key of its own
const TABS = [
    [/^Units$/, 'Units (control units)', []],
    [/^Unit( \d+\/\d+)?$/, 'Control unit{p}', ['p']],
];
const rules = [
    // notes
    [/^Read all done: (\d+) of (\d+) answer$/, 'Read all done: {n} of {m} answer', ['n', 'm']],
    [/^Asking control unit (\d+) of (\d+)\.\.\.$/, 'Asking control unit {n} of {m}...', ['n', 'm']],
    [/^(\d+) control units answered$/, 'Control units answered: {n}', ['n']],
    [/^(\d+) answered$/, 'Answered: {n}', ['n']],
    [/^\+ (\d+) more$/, '+ {n} more', ['n']],
    [/\bpage (\d+) of (\d+)/g, 'page {p} of {n}', ['p', 'n']],
    [/\b(\d+) of (\d+) values read\b/g, '{n} of {m} values read', ['n', 'm']],
    [/\b(\d+) of (\d+) with a value\b/g, '{n} of {m} with a value', ['n', 'm']],
    [/\b(\d+)-(\d+) of (\d+)/g, '{a}-{b} of {m}', ['a', 'b', 'm']],
    [/\b(\d+) of (\d+) read\b/g, '{n} of {m} read', ['n', 'm']],
    // units after a number (V, A, s, min, g, bar, Nm, rpm stay as the other apps show them)
    unit('l/100 km'), unit('l/100km'), unit('km/l'), unit('l/h'), unit('kg/h'), unit('km'), unit('l'), unit('h'), unit('mm'), unit('mg'),
    unit('kW'), unit('mA'), unit('ms'), unit('mph'),
];

function apply(text, list) {
    list.forEach((rule) => {
        text = text.replace(rule[0], function () {
            const captures = arguments;
            return t(rule[1]).replace(/\{(\w+)\}/g, (token, key) => {
                const i = rule[2].indexOf(key);
                return i < 0 ? token : captures[i + 1] === undefined ? '' : captures[i + 1];
            });
        });
    });
    return text;
}

function message(value) {
    const original = String(value == null ? '' : value);
    if (getLanguage() !== 'ru' || !/[A-Za-z]/.test(original)) return original;
    if (TABS.some((rule) => rule[0].test(original))) return apply(original, TABS);
    if (Object.prototype.hasOwnProperty.call(dict, original.trim())) return t(original);      // a text of its own ("under 1 km")
    // "2 Nov" -> "2 ноя"
    const text = apply(original, rules).replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (m, d, mon) => d + ' ' + t(mon));
    return t(text);
}

module.exports = { message };
