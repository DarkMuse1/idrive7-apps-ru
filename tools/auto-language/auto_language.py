"""Build-time, display-only multilingual overlay; never modifies an author's kit tree."""
from pathlib import Path
import copy
import gzip
import hashlib
import json
import os
import shutil
import tarfile

HERE = Path(__file__).resolve().parent
HMI_CONTEXTS = (
    ('de.bmw.infotainment.hmi.hmicontext.HMIContext', 'HMI_CID'),
    ('de.bmw.infotainment.hmi.hmicontext2.HMIContext2', '1'),
)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    write_text(path, json.dumps(value, ensure_ascii=False, indent=1) + '\n')


def write_text(path, value):
    with open(str(path), 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(value)


def patch_i18n(text):
    """Retain the author's translation algorithm, adding only mutable locale state."""
    def replace(old, new):
        nonlocal text
        if text.count(old) != 1:
            raise ValueError('Unsupported author i18n source: ' + old[:60])
        text = text.replace(old, new, 1)
    replace('const dict = locale.strings || {};', 'const dict = Object.assign({}, locale.strings || {});')
    replace("const language = locale.language || 'en';", "let language = locale.language || 'en';")
    has_localized_values = 'const localizedValues = new Set(Object.values(dict));' in text
    if has_localized_values:
        replace('const localizedValues = new Set(Object.values(dict));', 'let localizedValues = new Set(Object.values(dict));')
    replace('const phrases = Object.keys(dict)', 'let phrases = Object.keys(dict)')
    replace('const pattern = ', 'let pattern = ')
    # Explicit source-language aliases also support original Russian private apps.
    # They are supplied by the caller; no reverse lookup of a global dictionary.
    replace("    if (language === 'en') return s;", "    const direct = s.trim();\n    if ((language === 'en' || !/[A-Za-z]/.test(s)) && Object.prototype.hasOwnProperty.call(dict, direct))\n        return s.slice(0, s.indexOf(direct)) + dict[direct] + s.slice(s.indexOf(direct) + direct.length);\n    if (language === 'en') return phrases.length ? s.replace(pattern, (_, before, word) => before + (dict[word] || folded[word.toLowerCase()])) : s;")
    # A Russian source label must not match in the middle of another word.
    text = text.replace('[^A-Za-z0-9_./]', r'[^A-Za-z0-9_./\u0400-\u04ff]')
    start = text.index('let phrases = ')
    finish = text.index('\nfunction t(value)', start)
    index_source = text[start:finish].replace('let phrases =', 'phrases =', 1).replace('let pattern =', 'pattern =', 1)
    extension = '''
function setLanguage(next, words) {
    language = next || 'en';
    Object.keys(dict).forEach((key) => { delete dict[key]; });
    Object.assign(dict, words || {});
    LOCALIZED_VALUES
    Object.keys(folded).forEach((key) => { delete folded[key]; });
    Object.keys(dict).forEach((key) => { folded[key.toLowerCase()] = dict[key]; });
    INDEX_SOURCE
    cache.clear();
    locale.language = language;
    locale.strings = dict;
}
'''.replace('INDEX_SOURCE', index_source).replace('LOCALIZED_VALUES', 'localizedValues = new Set(Object.values(dict));' if has_localized_values else '')
    marker = 'module.exports = {'
    replace(marker, extension + '\nmodule.exports = { setLanguage,')
    return text


def patch_widget_text(text):
    """Only a widget's text transport changes; its lifecycle/queues stay author-owned."""
    marker = "    return String(s).replace(/°/g, '').replace(/[^\\x20-\\x7e]/g, '');"
    if marker not in text:
        return text
    text = text.replace(marker, '    return String(s); // auto locale uses the widget StringBundle for Unicode', 1)
    helper = '''
function autoLanguageWidgetPut(widget, spawnId, cell, value, type) {
    type = type || 'Text';
    if (type !== 'Text') return widget.comp.setValue(Number(spawnId), cell, value, type);
    if (!widget._autoLanguageText) {
        widget._autoLanguageText = new HmiText();
        widget._autoLanguageText.autoLanguageCanWrite = (id) => !!widget.comp &&
            (!widget._isGone || !widget._isGone(id)) &&
            (!widget.comp.spawnedInstances || Object.prototype.hasOwnProperty.call(widget.comp.spawnedInstances, id));
    }
    if (!widget._autoLanguageText.autoLanguageCanWrite(spawnId)) return Promise.resolve();
    return widget._autoLanguageText.set(widget.comp, 'WIDGET', Number(spawnId), cell, value);
}
'''
    if text.count('class Widget {') != 1:
        raise ValueError('Unsupported widget class')
    text = text.replace('class Widget {', helper + '\nclass Widget {', 1)
    for call in ("this.comp.setValue(Number(spawnId), cell, value, type || 'Text')", 'this.comp.setValue(Number(spawnId), cell, value, type)'):
        if call in text:
            text = text.replace(call, 'autoLanguageWidgetPut(this, spawnId, cell, value, type)', 1)
            return text
    raise ValueError('Unsupported widget text write')


def patch_display_caches(js, kit=None):
    """Give known display-only caches a locale identity, preserving calculations."""
    js = Path(js)
    kit = Path(kit or js / 'kit')
    changed = []
    for path in js.rglob('*.js'):
        if kit in path.parents:
            continue
        if path.name not in ('hud.js', 'hud-draw.js', 'engine.js', 'overlay.js'):
            continue
        source = path.read_text(encoding='utf-8')
        result = source
        relative = os.path.relpath(str(kit / 'i18n'), str(path.parent)).replace('\\', '/')
        if not relative.startswith('.'):
            relative = './' + relative
        language = "require('%s').getLanguage()" % relative
        if path.name == 'hud-draw.js':
            result = result.replace('const key = bgKey(f);', "const key = bgKey(f) + '|' + " + language + ';')
        if path.name == 'hud.js':
            result = result.replace('const key = frameKey(f);', "const key = frameKey(f) + '|' + " + language + ';')
            needle = '    _update(x, now, force) {\n        const w = x.w;'
            if needle in result and "textRaster.drawText" in result:
                result = result.replace(needle, "    _update(x, now, force) {\n        const locale = " + language + ";\n        if (x.autoLanguage !== locale) { x.autoLanguage = locale; force = true; }\n        const w = x.w;", 1)
        if path.name == 'engine.js' and "font.line(txt," in result:
            needle = "const txt = typeof s.text === 'function' ? String(s.text(d, t)) : String(s.text);"
            replacement = "const txt = require('./ru-text')(typeof s.text === 'function' ? String(s.text(d, t)) : String(s.text));"
            result = result.replace(needle, replacement)
        if path.name == 'overlay.js' and 'drawBadge' in result:
            result = result.replace('cv.text(e.label,', "cv.text(require('./ru-text')(e.label),")
        if result != source:
            write_text(path, result)
            changed.append(path.relative_to(js).as_posix())
    return changed


def apply(stage, spec=None, strings_by_language=None, rhmi_strings=None,
          font_sources=None, entry='app.js', default_language='en',
          credits=None):
    """Add auto locale support to an already-built stage.

    stage: directory containing source/javascript/kit and optionally rhmiData.
    strings_by_language: explicit source UI label -> translated UI label maps.
    rhmi_strings: locale tag -> full static StringId table (same ids per language).
    font_sources: optional {font family: path to author's/translated atlas}.
    entry: payload entry filename, relative to source/javascript.
    No source kit, settings, identifiers, provisioning or vehicle logic is edited.
    """
    stage = Path(stage)
    js = stage / 'source/javascript'
    kit = js / 'kit'
    languages = dict(strings_by_language or {'en': {}})
    languages.setdefault('en', {})
    for language, words in languages.items():
        if not isinstance(words, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in words.items()):
            raise ValueError('Invalid locale dictionary: ' + language)
    locale_path = kit / 'locale.json'
    write_json(locale_path, {'language': default_language, 'strings': languages.get(default_language, {})})
    write_json(js / 'auto-language.json', {'defaultLanguage': default_language,
               'languages': languages, 'credits': credits or {}})
    source = kit / 'i18n.js'
    original = source.read_text(encoding='utf-8')
    write_text(source, patch_i18n(original))
    mgu_path = kit / 'mgu.js'
    if mgu_path.exists():
        write_text(mgu_path, patch_widget_text(mgu_path.read_text(encoding='utf-8')))
    credit_path = kit / 'credits.js'
    if credit_path.exists():
        body = credit_path.read_text(encoding='utf-8')
        body = body.replace("const CREDIT = typeof locale.credit === 'string' ? locale.credit : '';", "const CREDIT = ''; // auto packages choose the current language's credit at draw time")
        body = body.replace('    if (!CREDIT) return;', "    const text = typeof locale.credit === 'string' ? locale.credit : '';\n    if (!text) return;")
        body = body.replace('canvas.text(CREDIT,', 'canvas.text(text,')
        write_text(credit_path, body)
    shutil.copyfile(HERE / 'auto-language.js', js / 'auto-language.js')
    display_cache_files = patch_display_caches(js, kit)
    entry_path = js / entry
    body = entry_path.read_text(encoding='utf-8')
    directive = "require('./auto-language').install();\n"
    if directive not in body:
        # Preload before any kit module destructures i18n.t or caches a title.
        if body.startswith("'use strict';"):
            body = body.replace("'use strict';", "'use strict';\n" + directive, 1)
        else:
            body = directive + body
        write_text(entry_path, body)
    for family, path in (font_sources or {}).items():
        shutil.copyfile(path, kit / 'fonts' / (family + '.json'))
    manifest_path = stage / 'source/manifest.json'
    if manifest_path.exists():
        manifest = read_json(manifest_path)
        for interface, instance in HMI_CONTEXTS:
            manifest.setdefault('proxies', {})[interface] = {
                'instances': instance, 'attributes': {'currentDisplayLanguage': 'rs'}}
        write_json(manifest_path, manifest)
    if rhmi_strings:
        # The HMI selects the current language's StringBundle itself, including
        # entry-point/tile names. Both package and installed resource forms stay
        # multilingual; no application reinstall or language-specific ID exists.
        for directory in [stage / 'source/rhmiData/variantGroups/Common/texts',
                          stage / 'rhmiData/strings',
                          stage / 'source/rhmiDataStartWidget/variantGroups/Common/texts',
                          stage / 'rhmiDataStartWidget/strings']:
            if not directory.exists():
                continue
            for path in directory.glob('*.json'):
                language = resource_language(path.stem, languages)
                if language in rhmi_strings:
                    table = rhmi_strings[language]
                    if 'StartWidget' in str(directory):
                        existing = read_json(path)
                        words = languages[language]
                        table = {key: words.get(value, value) for key, value in existing.items()}
                        for n in range(256):
                            table['SID_CN_DYNAMIC_%04d' % n] = ''
                        if len(table) > 1024:
                            raise ValueError('Widget string bundle exceeds 1024-resource budget')
                    write_json(path, table)
    audit = {'schema': 1, 'mode': 'auto', 'defaultLanguage': default_language,
             'languages': sorted(languages), 'authorI18nSha256': hashlib.sha256(original.encode()).hexdigest(),
             'displayCacheFiles': display_cache_files,
             'scope': 'display translation and HMI language subscription only'}
    write_json(js / 'auto-language-build.json', audit)
    return audit


def resource_language(tag, languages):
    normalized = tag.lower().replace('_', '-')
    if normalized in ('zh-cn', 'zh-yue-hans-cn'):
        language = 'zh-CN'
    elif normalized in ('zh-tw', 'zh-hk', 'zh-yue-hant-cn'):
        language = 'zh-TW'
    else:
        language = {'ru': 'ru', 'ko': 'ko'}.get(normalized.split('-')[0], 'en')
    return language if language in languages else 'en'


def language_tables(author, spec, languages):
    """Use one English UI structure so StringIds/state ids cannot drift by locale."""
    english = copy.deepcopy(spec)
    english['title'] = spec.get('title', english['title'])
    _, ui, strings, states = author.build_ui(english, 'en')
    author.unicode_resources(ui, strings, 'en')
    try:
        _, ui8, strings8, states8 = author.build_ui(english, 'en', 'ID8')
    except TypeError:  # older independent provider kit has ID7 only
        ui8 = strings8 = None
    if strings8 is not None:
        author.unicode_resources(ui8, strings8, 'en', 'SID_CN_STATIC8_')
        assert states8 == states
        strings.update(strings8)
    for table in spec.get('strings', {}).values():
        strings.update(table)
    result = {}
    for language, words in languages.items():
        result[language] = {key: str(words.get(value, value)).replace(' (default)', ' ' + words.get('(default)', '(default)'))
                            for key, value in strings.items()}
    return result


def repack(stage, dist=None, executable_files=()):
    stage = Path(stage)
    if not (stage / 'meta.json').exists():
        return
    meta = read_json(stage / 'meta.json')
    dist = Path(dist or stage.parent)
    for suffix in ('mgu', 'tgz'):
        path = dist / (meta['id'] + '@' + meta['version'] + '.' + suffix)
        modes = {}
        if path.exists():
            with tarfile.open(path, 'r:gz') as prior:
                modes = {member.name: member.mode for member in prior.getmembers()}
        def normalize(member):
            member.mtime = member.uid = member.gid = 0
            member.uname = member.gname = ''
            previous_mode = modes.get(member.name, 0o755 if member.isdir() else 0o644)
            member.mode = 0o755 if member.isdir() or previous_mode & 0o111 else 0o644
            if member.name in executable_files:
                member.mode = 0o755
            return member
        with gzip.GzipFile(str(path), 'wb', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as archive:
            if suffix == 'tgz':
                archive.add(stage / 'source', arcname='package', filter=normalize)
            else:
                for name in ('meta.json', 'source', 'rhmiData', 'rhmiDataStartWidget', 'oapgen'):
                    if (stage / name).exists():
                        archive.add(stage / name, arcname=name, filter=normalize)


def collect_languages(kit, overlay=None):
    result = {'en': {}}
    for directory in [Path(kit) / 'runtime/locales', Path(overlay) if overlay else None]:
        if not directory or not directory.exists():
            continue
        for language in ('ru', 'zh-CN', 'ko'):
            path = directory / (language + '.json')
            if path.exists():
                result[language] = read_json(path)
    return result


def configure_author_stage(author, app, spec, locale_overlay=None, font_sources=None):
    """Finish an English author build as one multilingual install package."""
    stage = Path(author.DIST) / app
    languages = collect_languages(author.KIT, locale_overlay)
    for language, text in spec.get('texts', {}).items():
        if language in languages and isinstance(text, dict):
            if isinstance(text.get('title'), str):
                languages[language] = dict(languages[language])
                languages[language][spec['title']] = text['title']
    tables = language_tables(author, spec, languages)
    sources = dict(font_sources or {})
    kit = Path(author.KIT)
    for family, filename in [('cyrillic', 'cyrillic-ru.json'), ('korean', 'korean.json')]:
        path = kit / 'localization/fonts' / filename
        if path.exists() and family not in sources:
            sources[family] = path
    credits = {}
    for language in languages:
        path = kit / 'localization' / ('credit.' + language + '.json')
        if path.exists():
            credits[language] = read_json(path).get('corner', '')
    audit = apply(stage, spec, languages, tables, sources, credits=credits)
    # Keep app data packs which the author's text reader selects by getLanguage.
    if app == 'dtc_scanner':
        import tempfile
        import pack_data
        with tempfile.TemporaryDirectory(prefix='mgu-auto-diagnostics-') as temporary:
            for language, module in [('ru', 'build_diagnostic_ru'), ('zh-CN', 'build_diagnostic_zh')]:
                if language not in languages:
                    continue
                catalog = __import__(module).catalog()
                write_json(Path(temporary) / (language + '.json'), catalog)
            pack_data.pack(temporary, str(stage / 'source/javascript/diagnostic_i18n.pack'))
    meta_path = stage / 'meta.json'
    if meta_path.exists():
        meta = read_json(meta_path)
        meta['title'] = spec['title']
        if spec.get('texts'):
            meta['texts'] = spec['texts']
        write_json(meta_path, meta)
    repack(stage, author.DIST)
    return audit
