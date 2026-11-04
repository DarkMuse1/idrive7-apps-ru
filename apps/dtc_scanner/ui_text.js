'use strict';
/**
 * ui_text.js - display-only formatting of the Fault Scanner's dynamic messages (counts, unit names,
 * outcomes of a scan or a clear) for the Russian package. A whole message goes through a template of
 * the catalog (kit/runtime/locales/ru.json; {name} slots filled in), then the catalog's phrase
 * substitution (kit/runtime/i18n.js t) translates what is left in it (unit names, reasons). The
 * messages themselves - the app's log, the saved scan - stay English; other languages show them as
 * they are.
 *
 *   message('Cleared 2 of 3 control unit(s)')   // 'Очищено блоков: 2 из 3' (ru)
 *   message('Last scan 03.11. 21:40')           // 'Последнее чтение: 03.11. 21:40' (ru)
 *   tf('Message {id}', { id: 186 })              // 'Сообщение 186' (ru), 'Message 186' (en)
 */
const { t, getLanguage } = require('./kit/i18n');

/** t(template) with its {name} slots filled from vars (English: the English template, filled). */
function tf(template, vars) {
    return t(template).replace(/\{(\w+)\}/g, (token, key) => (vars && vars[key] !== undefined ? String(vars[key]) : token));
}

// [English message (a part of one, with g), the catalog's template, the template's slots in capture order (name*:
//  the captured text translated too, e.g. a unit's name)]
const rules = [
    [/^Clears (\d+) control unit\(s\) - press again within 5 s$/, 'Clears {count} control units - press again within 5 s', ['count']],
    [/^Cleared (\d+) of (\d+) control unit\(s\) - scanning again$/, 'Cleared {done} of {count} control units - scanning again', ['done', 'count']],
    [/^Cleared (\d+) of (\d+) control unit\(s\)$/, 'Cleared {done} of {count} control units', ['done', 'count']],
    [/^Clearing all control units\.\.\.$/, 'Clearing all control units...', []],
    [/^Clearing (.+)\.\.\.$/, 'Clearing {unit}...', ['unit*']],
    [/^Not cleared - /, 'Not cleared - {units}', [], true],
    [/^Cleared; back at once \(still present\): /, 'Cleared; back at once (still present): {units}', [], true],
    [/\+ (\d+) more on the next page/g, '+ {count} more on the next page', ['count']],
    [/\+ (\d+) more\b/g, '+ {count} more', ['count']],
    [/\breply ((?:[0-9A-F]{2})+)$/, 'reply {bytes}', ['bytes']],
    [/^Last scan (\d\d\.\d\d\. \d\d:\d\d)$/, 'Last scan {when}', ['when']],
];

function message(value) {
    const original = String(value == null ? '' : value);
    if (getLanguage() !== 'ru') return original;
    let text = original;
    for (const rule of rules) {
        const [re, template, names, prefix] = rule;
        if (prefix) {
            // a fixed start, the rest a list of unit names and reasons (translated by t below)
            const m = re.exec(text);
            if (m) text = tf(template, { units: text.slice(m[0].length) });
            continue;
        }
        text = text.replace(re, function () {
            const captures = arguments;
            const vars = {};
            names.forEach((name, i) => {
                const own = name.charAt(name.length - 1) === '*';
                vars[own ? name.slice(0, -1) : name] = own ? t(captures[i + 1]) : captures[i + 1];
            });
            return tf(template, vars);
        });
    }
    return t(text);
}

module.exports = { message, tf };
