'use strict';
/**
 * diagnostic-text.js - a fault (or Check Control) description in the package's language (upstream
 * 2.9.x, its diagnostic-text.js). Never the UI's word-by-word substitution (kit/runtime/i18n.js t()): a
 * description is translated whole or shown as it is, and drawn with { translate: false } afterwards.
 *
 *   diagnosticText('ABS: Voltage too low')   // 'ABS: Пониженное напряжение' in the Russian package
 *
 * Russian, first match wins:
 *   1. kit/runtime/locales/ru.json (our catalog, the one the UI uses): an exact entry for the whole text
 *   2. diagnostic_i18n.pack (ru.json in it): upstream's Russian descriptions for the texts of dtc_db.pack -
 *      BMW's own Russian texts (DiagDocDb 4.32.12) matched by label and ECU / code context, then upstream's
 *      UI catalog and its manual overrides (upstream kit/tools/build_diagnostic_ru.py catalog(), the pack
 *      upstream's build.py makes for the Russian Fault Scanner). Not individually reviewed by a person.
 *      Built from idrive7-apps origin/main 5389acc; the few characters the baked fonts lack (special hyphens
 *      and minus signs, zero-width and no-break spaces, German letters as texts.js ascii()) replaced
 *   3. the text as it is (English): nothing is made up
 * "<n> possible texts (depends on unit type)" gets its plural form (the catalog's plural row).
 * zh-CN: our zh-CN UI catalog, else the text (the pack has no Chinese part). English: the text.
 */
const path = require('path');
const { getLanguage, dict, plural } = require('./kit/i18n');

let db = null;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// what the baked fonts (kit/runtime/fonts) cannot draw: shown as the nearest character they have
const GERMAN = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' };
const drawable = (s) => String(s).replace(/[‐-‒−]/g, '-').replace(/​/g, '').replace(/ /g, ' ')
    .replace(/[äöüÄÖÜß]/g, (c) => GERMAN[c]);

function diagnosticText(value) {
    const source = String(value == null ? '' : value);
    const language = getLanguage();
    if (language === 'en') return source;
    const ambiguous = /^(\d+) possible texts \(depends on unit type\)$/.exec(source);
    if (ambiguous && language === 'zh-CN') return ambiguous[1] + ' 个候选说明（取决于单元型号）';
    if (ambiguous) {
        const n = Number(ambiguous[1]);
        return n + ' ' + plural(n, 'possible texts (depends on unit type)', 'possible texts (depends on unit type)');
    }
    if (has(dict, source)) return drawable(dict[source]);
    if (language !== 'ru') return source;
    if (!db) {
        try { db = require('./kit/pack').open(path.join(__dirname, 'diagnostic_i18n')); } catch (e) { db = { get: () => undefined }; }
    }
    let t;
    try { t = db.get('ru.json', source); } catch (e) { t = undefined; }
    return typeof t === 'string' && t ? drawable(t) : source;
}

module.exports = { diagnosticText, drawable };
