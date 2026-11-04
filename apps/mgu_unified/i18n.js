(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./i18n-en'));
    else root.MguI18n = factory(root.MguI18nEn);
}(this, function (EN) {
    'use strict';
    // RU is the source language; EN comes from a dictionary kept apart from the logic (TZ 7.4).
    // Translation happens at the drawing boundary: exact phrase first, then whole-word fragments
    // (longest first) so concatenated texts with numbers translate too. Vehicle-provided texts
    // (CBS names, DTC descriptions) stay in the car's language unless the dictionary knows them.
    var lang = 'ru', re = null, phrases = EN.phrases;
    var LETTER = 'А-Яа-яЁё';
    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function compile() {
        var keys = Object.keys(phrases).filter(function (k) { return /[А-Яа-яЁё¼⅛]/.test(k); }).sort(function (a, b) { return b.length - a.length; });
        // (^|non-letter)(key)(?=non-letter|$): no lookbehind, so Node 8 works as well.
        re = new RegExp('(^|[^' + LETTER + '])(' + keys.map(esc).join('|') + ')(?=[^' + LETTER + ']|$)', 'g');
    }
    function tr(s) {
        if (lang === 'ru' || s === null || s === undefined) return s;
        s = String(s);
        if (!/[А-Яа-яЁё¼⅛]/.test(s)) return s;
        if (Object.prototype.hasOwnProperty.call(phrases, s)) return phrases[s];
        var t = s.trim();
        if (t !== s && Object.prototype.hasOwnProperty.call(phrases, t)) return s.replace(t, phrases[t]);
        if (!re) compile();
        // Replacing may expose a new boundary; two passes cover adjacent fragments.
        var out = s.replace(re, function (m, pre, key) { return pre + phrases[key]; });
        return out.replace(re, function (m, pre, key) { return pre + phrases[key]; });
    }
    // The kit's baked atlases lack some glyphs (HU shows '?'): label has no ¼ ⅛ → “ ”, the numeric
    // font has no em/en dash. Substitute covered characters at the drawing boundary (tests/test_fonts.js).
    function glyphSafe(s, numeric) {
        s = String(s).replace(/→/g, '»').replace(/¼/g, '1/4').replace(/⅛/g, '1/8').replace(/[“”]/g, '"');
        return numeric ? s.replace(/—/g, '--').replace(/–/g, '-') : s;
    }
    function setLanguage(l) { lang = l === 'en' ? 'en' : 'ru'; }
    function language() { return lang; }
    function locale() { return lang === 'en' ? 'en-GB' : 'ru-RU'; }
    function decimal(text) { return lang === 'en' ? text : String(text).replace('.', ','); }
    return { tr: tr, glyphSafe: glyphSafe, setLanguage: setLanguage, language: language, locale: locale, decimal: decimal, phrases: phrases };
}));
