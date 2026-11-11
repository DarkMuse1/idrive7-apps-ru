"""Build the protected recorder with native pixmaps and canvas touch targets."""
from pathlib import Path
import argparse,json,os,shutil,sys,tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools/protected-apps/kit/tools'))
import build as kit


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app',nargs='?',default='drive_recorder_lab')
    parser.add_argument('--preview-only',action='store_true')
    parser.add_argument('--sdk',default=str(ROOT/'oap-sdk'))
    parser.add_argument('--dist')
    args=parser.parse_args()
    if args.app!='drive_recorder_lab':raise ValueError('Unexpected app id')
    mode='preview'
    if not args.preview_only:
        sdk=kit.check_sdk(args.sdk)
        mode='placeholder' if sdk.get('mguPlaceholder') is True else 'real'
    dist=Path(args.dist or (kit.PREVIEW_DIST if args.preview_only else kit.DIST)).resolve()
    dist.mkdir(parents=True,exist_ok=True)
    temporary=Path(tempfile.mkdtemp(prefix='.recorder-build-',dir=str(dist)))
    assert temporary.resolve().parent==dist
    try:
        mtime=kit.source_date_epoch()
        kit.build(args.app,'ru',dist=str(temporary),sdk=args.sdk,mode=mode,mtime=mtime)
        stage=temporary/args.app;source=stage/'source'
        # This app paints its own header. chrome:false must not opt it out of
        # native input/pixmaps; the old upstream dialect only painted controls.
        # Patch this package's staged runtime, never another app's shared kit.
        file=source/'javascript/kit/display.js'
        display=file.read_text('utf8')
        changes={
            "const native = this.screen.chrome !== false && process.env.MGU_RENDERD_PROTO !== 'upstream';":
            "const native = (this.screen.chrome !== false || this.spec.id === 'drive_recorder_lab') && process.env.MGU_RENDERD_PROTO !== 'upstream';",
            "if (!this.screen || this.screen.chrome === false) return false;":
            "if (!this.screen || (this.screen.chrome === false && this.spec.id !== 'drive_recorder_lab')) return false;",
        }
        for before,after in changes.items():
            if display.count(before)!=1:raise ValueError('Shared Display changed; review recorder native integration')
            display=display.replace(before,after)
        file.write_text(display,encoding='utf8')
        package=json.loads((source/'package.json').read_text('utf8'))
        package.update(private=True,mguLocalOnly=True,mguInternet=True)
        (source/'package.json').write_text(json.dumps(package,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        version=package['version'];suffix='.preview' if mode=='preview' else '-NOT-INSTALLABLE' if mode=='placeholder' else ''
        artifact=dist/(args.app+'@'+version+suffix+'.tgz')
        packed=temporary/'protected.tgz'
        kit.write_archive(str(packed),[(str(source),'package')],mtime)
        kit.replace_dir(str(stage),str(dist/args.app))
        os.replace(packed,artifact)
        print('Protected recorder '+version+': '+str(artifact)+(' (TEST ONLY, no real SDK)' if mode!='real' else ''))
    finally:
        assert temporary.resolve().parent==dist
        shutil.rmtree(temporary)


if __name__=='__main__':main()
