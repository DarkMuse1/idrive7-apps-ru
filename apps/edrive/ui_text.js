'use strict';
const { t, getLanguage } = require('./kit/i18n');
const { fitText } = require('./kit/text-layout');
// Formatting applies only at the display boundary; values, DIDs and saved data stay unchanged.
const rules = [
    [/^(.+) \(est\.\)$/, 'Estimate: {details}', ['details']],
    [/\bbaseline ([\d.]+) kW/g, 'Base consumption {n} kW', ['n']],
    [/^SCANNING\s+(\d+) %\s+\((\d+) \/ (\d+)\)\s+-\s+stay on this page, car in READY$/,
        'Scan {n} % ({done}/{total}); keep this page open, car in READY', ['n', 'done', 'total']],
    [/^Take a photo when it says DONE\..*\((scan_[0-9A-Fa-f]+\.json)\)\.$/,
        'Scan complete. Save a screenshot. Data file: {file}', ['file']],
    // (before the plain "at": the Energy page's Driving row while moving, eDrive 2.7)
    [/^live, at (\d+) (km\/h|mph)$/, 'live, at {n} {unit}', ['n', 'unit']],
    [/\bat (\d+) (km\/h|mph)\b/g, 'At {n} {unit}', ['n', 'unit']],
    [/\bread (\d+) s ago\b/gi, 'Read {n} seconds ago', ['n']],
    [/\bread (\d+) min ago\b/gi, 'Read {n} minutes ago', ['n']],
    [/\bread (\d+) h ago\b/gi, 'Read {n} hours ago', ['n']],
    [/\bread (\d+) days ago\b/gi, 'Read {n} days ago', ['n']],
    [/\b(\d+) s ago\b/gi, '{n} seconds ago', ['n']],
    [/\b(\d+) min ago\b/gi, '{n} minutes ago', ['n']],
    [/\b(\d+) h ago\b/gi, '{n} hours ago', ['n']],
    [/\b(\d+) days ago\b/gi, '{n} days ago', ['n']],
    [/^engine starts at ([\d.]+) %$/, 'Engine starts at {n} %', ['n']],
    [/^battery held at ([\d.-]+) %$/, 'Battery held at {n} %', ['n']],
    [/^Low battery: electric up to (\d+) (km\/h|mph), light throttle$/, 'Low charge: electric up to {n} {unit}, light throttle', ['n', 'unit']],
    [/^learned from (\d+) (km|mi)$/, 'Learned from {n} {unit}', ['n', 'unit']],
    [/\bcharging \+([\d.]+) % per 10 (km|mi)$/, 'charging +{n} % per 10 {unit}', ['n', 'unit']],
    [/\bbattery helps -([\d.]+) % per 10 (km|mi)$/, 'battery helps -{n} % per 10 {unit}', ['n', 'unit']],
    [/\bpower missed (\d+)\b/g, 'power missed {n}', ['n']],
    [/\bmissed ([A-Za-z]+ \d+(?: [A-Za-z]+ \d+)*)/g, 'missed: {list}', ['list']],
    [/\bcell (\d+)\b/g, 'Cell {n}', ['n']],
    [/\b(\d+) charges?\b/g, 'Charges: {n}', ['n']],
    [/^over (\d+) (km\/h|mph)$/, 'Over {n} {unit}', ['n', 'unit']],
    [/\b(\d+) identifiers known for this car\b/g, 'Known identifiers: {n}', ['n']],
    [/\b(\d+) answer\b/g, 'Replies: {n}', ['n']],
    [/\b(\d+) samples\b/g, 'Samples: {n}', ['n']],
    [/^Every charge of ([\d.]+) % or more shows up here,$/, 'Charges of {n} % or more appear here', ['n']],
    [/\b([\d.]+)x\/s, ([\d.]+) ms each\b/g, '{n} reads/s, {ms} ms each', ['n', 'ms']],
];
function message(value) {
    const original = String(value == null ? '' : value);
    if (getLanguage() !== 'ru' || !/[A-Za-z]/.test(original)) return original;
    let result = original;
    rules.forEach(rule => {
        result = result.replace(rule[0], function () {
            const captures = arguments;
            return t(rule[1]).replace(/\{(\w+)\}/g, (token, key) => {
                const i = rule[2].indexOf(key);
                return i < 0 ? token : captures[i + 1];
            });
        });
    });
    return t(result).replace(/\bkWh\b/gi, 'кВт·ч').replace(/\bkW\b/gi, 'кВт').replace(/\bkm\b/gi, 'км')
        .replace(/\bn\/a\b/g, 'нет данных').replace(/\bon\b/g, 'вкл.').replace(/\boff\b/g, 'выкл.');
}
function text(cv, value, x, y, size, color, options) {
    let label = options && options.translate === false ? value : message(value);
    if (options && options.maxWidth && getLanguage() === 'ru') {
        label = fitText(cv, label, size, options.maxWidth, Object.assign({}, options, { translate: false }));
    }
    return cv.text(label, x, y, size, color, options);
}
module.exports = { message, text, isRussian: () => getLanguage() === 'ru' };
