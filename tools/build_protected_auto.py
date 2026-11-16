"""Build protected apps with their isolated original kit and automatic RU/EN display."""
from pathlib import Path
import argparse
import copy
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/auto-language'))
from auto_language import apply
sys.path.insert(0, str(ROOT / 'tools/protected-apps/kit/tools'))
import build as author

APPS = {'mgu_unified'}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def assign(spec, path, text):
    node = spec
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = text


def strings(spec, language):
    _, ui, result, _ = author.build_ui(spec, language)
    author.unicode_resources(ui, result, language)
    for table in spec.get('strings', {}).values():
        result.update(table)
    return result


def finish(app, stage):
    spec = read(ROOT / 'apps' / app / 'app.json')
    russian = copy.deepcopy(spec)
    native = ROOT / 'apps' / app / 'native-labels.ru.json'
    if native.exists():
        for item in read(native):
            assign(russian, item['path'], item['text'])
    english_words = ROOT / 'apps' / app / 'public-ui.en.json'
    languages = {'en': read(english_words) if english_words.exists() else {},
                 'ru': dict(author.load_locale('ru'))}
    extra_russian = ROOT / 'apps' / app / 'ui-texts.ru.json'
    if extra_russian.exists():
        languages['ru'].update(read(extra_russian))
    if spec.get('texts', {}).get('ru', {}).get('title'):
        languages['ru'][spec['title']] = spec['texts']['ru']['title']
    tables = {'en': strings(spec, 'en'),
              'ru': {key: languages['ru'].get(value, value) for key, value in strings(russian, 'ru').items()}}
    if spec.get('texts', {}).get('ru', {}).get('title'):
        tables['ru']['SID_' + app.upper() + '_TITLE'] = spec['texts']['ru']['title']
    if set(tables['en']) != set(tables['ru']):
        raise ValueError('Native StringIds must be identical across languages')
    meta_path = Path(stage) / 'meta.json'
    meta = read(meta_path)
    meta['texts'] = spec.get('texts', {})
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return apply(stage, spec=spec, strings_by_language=languages, rhmi_strings=tables)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', choices=sorted(APPS))
    parser.add_argument('--language', choices=['auto'], default='auto')
    parser.add_argument('--preview-only', action='store_true')
    parser.add_argument('--sdk', default=str(ROOT / 'oap-sdk'))
    parser.add_argument('--dist')
    args = parser.parse_args()
    dist = Path(args.dist or (author.PREVIEW_DIST if args.preview_only else author.DIST)).resolve()
    dist.mkdir(parents=True, exist_ok=True)
    mode = 'preview'
    if not args.preview_only:
        sdk = author.check_sdk(args.sdk)
        mode = 'placeholder' if sdk.get('mguPlaceholder') is True else 'real'
    mtime = author.source_date_epoch()
    author.build(args.app, 'en', dist=str(dist), sdk=args.sdk, mode=mode, mtime=mtime)
    stage = dist / args.app
    finish(args.app, stage)
    if mode != 'preview':
        version = read(stage / 'meta.json')['version']
        suffix = '-NOT-INSTALLABLE' if mode == 'placeholder' else ''
        for extension in ('tgz', 'mgu'):
            artifact = dist / (args.app + '@' + version + suffix + '.' + extension)
            if extension == 'tgz':
                members = [(str(stage / 'source'), 'package')]
            else:
                members = [(str(stage / name), name) for name in
                           ('meta.json', author.MARKER, 'source', 'rhmiData', 'rhmiDataStartWidget', 'oapgen')
                           if (stage / name).exists()]
            temporary = Path(str(artifact) + '.part')
            author.write_archive(str(temporary), members, mtime)
            temporary.replace(artifact)


if __name__ == '__main__':
    main()
