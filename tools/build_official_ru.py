"""Build official sources with automatic HU language or a fixed Russian locale."""
from pathlib import Path
import argparse,json,sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'kit/tools'))
import build as official
import localize

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app')
    parser.add_argument('--language',choices=['auto','ru'],default='auto')
    parser.add_argument('--preview-only',action='store_true')
    parser.add_argument('--sdk',default=str(ROOT/'oap-sdk'))
    parser.add_argument('--dist',default=str(ROOT/'dist'))
    args=parser.parse_args()
    # The source catalog requires x.y.z and the exact dist/<id>@<version>.tgz path.
    # Translation, application code, runtime and RHMI generation remain upstream's.
    localize.package_version=lambda version,language:version
    official.SDK=args.sdk
    official.DIST=args.dist
    official.build(args.app,'en' if args.language == 'auto' else 'ru',preview_only=args.preview_only)
    if args.language == 'auto':
        sys.path.insert(0,str(ROOT/'tools/auto-language'))
        import auto_language
        spec=json.loads((ROOT/'apps'/args.app/'app.json').read_text(encoding='utf-8'))
        auto_language.configure_author_stage(official,args.app,spec)

if __name__=='__main__':main()
