"""Build translated third-party apps with each author's unchanged, isolated kit."""
from pathlib import Path
import argparse, json, shutil, sys, tarfile, tempfile

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / 'tools/source-apps'
PROVIDERS = {
    'cluster_info': 'eroobeeroo-cluster',
    'cluster_layouts': 'eroobeeroo-cluster',
    'cluster_centre': 'eroobeeroo-cluster',
    'cluster_themes': 'bimmer-lab',
    'idrive_hud_widgets': 'bimmer-lab',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', choices=sorted(PROVIDERS))
    parser.add_argument('--language', choices=['auto', 'ru'], default='auto')
    parser.add_argument('--sdk', default=str(ROOT / 'oap-sdk'))
    parser.add_argument('--dist', default=str(ROOT / 'dist'))
    args = parser.parse_args()
    provider = PROVIDERS[args.app]
    language = 'en' if args.language == 'auto' else 'ru'
    source = ROOT / 'third_party' / provider
    sys.path.insert(0, str(source / 'kit/tools'))
    import build as author
    import localize
    localize.LOCALES = LOCAL / 'localization' / provider
    # Keep the source catalog's numeric version and exact output filename.
    localize.package_version = lambda version, language: version
    author.SDK = str(Path(args.sdk).resolve())
    author.DIST = str(Path(args.dist).resolve())
    if provider == 'bimmer-lab':
        # The author's RU build references a Cyrillic resource absent from its
        # tree. Add that resource to a temporary copy, leaving its kit intact.
        with tempfile.TemporaryDirectory(prefix='mgu-ru-kit-') as temp:
            kit = Path(temp) / 'kit'
            shutil.copytree(str(source / 'kit'), str(kit))
            destination = kit / 'localization/fonts/cyrillic-ru.json'
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(LOCAL / 'localization/assets/bimmer-kit/cyrillic-ru.json', destination)
            author.KIT = str(kit)
            author.build(args.app, language)
            if args.language == 'auto':
                # configure_author_stage runs below, after this temporary kit is
                # gone; preserve the original author's kit path for resources.
                author.KIT = str(source / 'kit')
    else:
        author.build(args.app, language)

    stage = Path(author.DIST) / args.app
    js = stage / 'source/javascript'
    assets = LOCAL / 'localization/assets'
    shutil.copyfile(LOCAL / 'ru-display.js', js / 'ru-display.js')
    shutil.copyfile(LOCAL / 'ru-text.js', js / 'ru-text.js')
    if provider == 'eroobeeroo-cluster':
        for p in (assets / 'cluster-kit').glob('*.json'):
            if p.name != 'index.json':
                shutil.copyfile(p, js / 'kit/fonts' / p.name)
        shutil.copyfile(assets / 'cluster-kit/index.json', js / 'ru-fonts.json')
        shutil.copyfile(LOCAL / 'ru-fonts.js', js / 'ru-fonts.js')
        entry = js / 'app.js'
        body = entry.read_bytes()
        assert body.startswith(b"'use strict';")
        entry.write_bytes(body.replace(b"'use strict';", b"'use strict';\nrequire('./ru-fonts');", 1))
        if args.app in ('cluster_layouts', 'cluster_centre'):
            for p in (assets / 'cluster-sdf').iterdir():
                shutil.copyfile(p, js / p.name)
    else:
        # Only the app's display font resources change; the author's pack format is retained.
        import pack_data
        with tempfile.TemporaryDirectory(prefix='mgu-ru-hud-') as temp:
            hud = Path(temp) / 'hud'
            shutil.copytree(source / 'apps' / args.app / 'hud', hud)
            overlay = assets / 'bimmer-hud' / args.app
            for p in overlay.rglob('*'):
                if p.is_file():
                    dest = hud / p.relative_to(overlay)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(p, dest)
            pack_data.pack(str(hud), str(js / 'hud.pack'))
    shutil.copyfile(LOCAL / 'localization/fonts/OFL-NotoSans.txt', js / 'OFL-NotoSans.txt')

    if args.language == 'auto':
        sys.path.insert(0, str(ROOT / 'tools/auto-language'))
        import auto_language
        spec = json.loads((source / 'apps' / args.app / 'app.json').read_text(encoding='utf-8'))
        fonts = {}
        if provider == 'bimmer-lab':
            fonts['cyrillic'] = assets / 'bimmer-kit/cyrillic-ru.json'
        auto_language.configure_author_stage(author, args.app, spec, LOCAL / 'localization' / provider, fonts)
        print('Automatic HU language resources applied; author vehicle logic unchanged.')
        return

    version = json.loads((stage / 'meta.json').read_text(encoding='utf8'))['version']
    with tarfile.open(str(Path(author.DIST) / (args.app + '@' + version + '.mgu')), 'w:gz') as archive:
        for name in ('meta.json', 'source', 'rhmiData', 'rhmiDataStartWidget', 'oapgen'):
            if (stage / name).exists():
                archive.add(str(stage / name), arcname=name)
    with tarfile.open(str(Path(author.DIST) / (args.app + '@' + version + '.tgz')), 'w:gz') as archive:
        archive.add(str(stage / 'source'), arcname='package')
    print('Russian display resources applied; author kit JavaScript unchanged.')


if __name__ == '__main__':
    main()
