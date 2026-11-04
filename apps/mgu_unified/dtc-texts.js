'use strict';
/**
 * texts.js - the text shown next to a fault (TZ 8: never made up from the code).
 *
 *   const T = require('./texts').create({ db, variant, own, known });
 *   T.describe(0x12, '102A5A') -> { text, source }
 *
 * The sources, asked in this order; the first one that knows the fault gives its text:
 *   'oem'     the fault text database (dtc_db/ or dtc_db.pack, BMW's texts; see main.js): a text for
 *             "<address>:<code>", the table for exactly this unit type, the table for this address, the
 *             unit type's own texts, a text for "*:<code>" (any unit), the code list (for any unit or
 *             only the units it names), the code-only table
 *   'export'  this car's coding tool export (dtc_texts.js, kit/tools/dtc_texts.py), for a fault the
 *             database has no text for
 *   'hand'    texts written for this project (known_texts.js, FAMILY below): only where none of the
 *             above has one, and always shown starting with "Hand-written:"
 *   'unknown' "text unknown" - when the database has several different texts for the code and the
 *             unit type is not known, it says how many; nothing is derived from the code itself
 */

// a summary where the database's texts for a unit family differ in wording but agree on the fault
// (hand-written, not an exact BMW text)
const FAMILY = {
    '23:D1C604': 'Assist sensors: Unexpected Ethernet communication/link',
    '61:03178A': 'Telematics: Mobile network connection limited',
};
const HAND = 'Hand-written: ';
const UNKNOWN = 'text unknown';

const hex2 = (a) => (a < 16 ? '0' : '') + a.toString(16).toUpperCase();
// Normalize legacy German names, but preserve Unicode from translated/OEM text.
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[\x00-\x1f\x7f]/g, '');
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);

/**
 * o = { db (kit/runtime/pack.js: get(file, key)), variant(addr) -> the unit type (SGBD) or null,
 *       own: { "<address>:<code>": text } (the car's export), known: { "<address>:<code>" or
 *       "*:<code>": text } (hand-written), family: (default FAMILY) }
 */
function create(o) {
    const db = o.db, own = o.own || {}, known = o.known || {}, family = o.family || FAMILY;
    const variant = o.variant || (() => null);
    const get = (file, key) => { try { return db.get(file, key); } catch (e) { return undefined; } };

    function oem(addr, code) {
        const a = hex2(addr), v = variant(addr);
        const c = get('code_texts.json', code);
        return str(get('dtc_texts.json', a + ':' + code))
            || (v && str(get('tables/variant/' + v.toLowerCase() + '.json', code)))
            || str(get('tables/addr/' + a + '.json', code))
            || (v && str(get('texts/' + v + '.json', code)))
            || str(get('dtc_texts.json', '*:' + code))
            || str(typeof c === 'string' ? c : c && typeof c === 'object' ? c[a] : null)
            || str(get('tables/codes.json', code));
    }

    function describe(addr, rawCode) {
        const code = String(rawCode).trim().toUpperCase().replace(/^0X/, '').padStart(6, '0');
        const key = hex2(addr) + ':' + code;
        const t = oem(addr, code);
        if (t) return { text: ascii(t), source: 'oem' };
        const e = str(own[key]);
        if (e) return { text: ascii(e), source: 'export' };
        const h = str(known[key]) || str(known['*:' + code]) || str(family[key]);
        if (h) return { text: HAND + ascii(h), source: 'hand' };
        const n = get('tables/ambiguous.json', code);
        return { text: n > 0 ? UNKNOWN + ' (' + n + ' possible texts, depends on unit type)' : UNKNOWN, source: 'unknown' };
    }

    return { describe };
}

module.exports = { create, FAMILY, HAND, UNKNOWN, ascii };
