#!/usr/bin/env python3
"""make_kit.py - build the apps and pack everything the head unit needs into one folder
(+ .tar.gz) for push-to-car.sh / push-to-car.ps1 or a USB stick. Runs on Linux, macOS and
Windows (Python 3.6+ and Node.js; no bash, no Docker needed).

    python3 kit/tools/make_kit.py                 # all apps in apps/
    python3 kit/tools/make_kit.py car_vitals ...  # only these
    (deploy/make-car-kit.sh and deploy\\make-car-kit.cmd call this)

Output: dist/mgu-custom-apps/ and dist/mgu-custom-apps.tar.gz

The GPU renderer (kit/renderd) is compiled in Docker when Docker is there. Without Docker the
kit takes kit/renderd/prebuilt/mgu-renderd, which is committed to the repository together
with a fingerprint of the source it was built from. A Docker build of changed source updates
the prebuilt copy (commit it). If no renderer matching the source can be had, it asks.
"""
import hashlib, io, json, os, re, shutil, subprocess, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEPLOY = os.path.join(ROOT, 'deploy')
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(DIST, 'mgu-custom-apps')
RENDERD = os.path.join(ROOT, 'kit', 'renderd')
BUILT = os.path.join(RENDERD, 'build', 'mgu-renderd')
PRE_DIR = os.path.join(RENDERD, 'prebuilt')
PRE = os.path.join(PRE_DIR, 'mgu-renderd')
PRE_SUM = os.path.join(PRE_DIR, 'SOURCE_SHA256')
# files copied next to the apps; text, so always shipped with Unix line endings
CAR_FILES = [('car/deploy-car.sh', 'deploy-car.sh'), ('mgu-app-install.sh', 'mgu-app-install.sh'),
             ('mainapp-patch.js', 'mainapp-patch.js'), ('car/README.txt', 'README.txt')]
CAR_FILES += [('upstream-renderd/foreground_gate.js', 'foreground_gate.js'), ('upstream-renderd/hmi_template.js', 'hmi_template.js'), ('upstream-renderd/mgu-render-hmi.sh', 'mgu-render-hmi.sh'), ('upstream-renderd/mgu-render-hmi-guard.sh', 'mgu-render-hmi-guard.sh'), ('upstream-renderd/LICENSE', 'LICENSE'), ('upstream-renderd/LICENSE.mgu-renderd', 'LICENSE.mgu-renderd')]


def copy_install_helpers(out):
    """Installer-owned helpers, independent of every .mgu's contents."""
    for src, dst in CAR_FILES:
        with open(os.path.join(DEPLOY, src), 'rb') as stream:
            data = re.sub(rb'\r+\n', b'\n', stream.read())
        if dst.endswith('.sh') and (b'\r' in data or data.startswith(b'\xef\xbb\xbf')):
            raise ValueError('Invalid Linux shell encoding: ' + dst)
        target = os.path.join(out, dst)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as stream:
            stream.write(data)
    return [dst for src, dst in CAR_FILES]


def source_hash():
    """Fingerprint of everything the renderer binary is built from (line endings ignored)."""
    files = []
    for sub, exts in (('src', None), ('inputgate', ('.cpp',)), ('protocol', ('.xml',)), ('docker', None), ('', ('Makefile',))):
        d = os.path.join(RENDERD, sub)
        for n in sorted(os.listdir(d)):
            p = os.path.join(d, n)
            if not os.path.isfile(p): continue
            if exts and not any(n.endswith(e) for e in exts): continue
            files.append(((sub + '/' + n).lstrip('/'), p))
    h = hashlib.sha256()
    for rel, p in files:
        h.update(rel.encode() + b'\0' + open(p, 'rb').read().replace(b'\r\n', b'\n') + b'\0')
    return h.hexdigest()


def prebuilt_hash():
    try: return open(PRE_SUM, encoding='utf-8').read().split()[0]
    except (OSError, IndexError): return None


def docker_build():
    """Compile kit/renderd in Docker (x86-64 like the head unit). Returns (ok, output)."""
    plat = ['--platform', 'linux/amd64']
    user = ['-u', '%d:%d' % (os.getuid(), os.getgid())] if hasattr(os, 'getuid') else []
    log = []
    def run(cmd):
        p = subprocess.run(cmd, cwd=RENDERD, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log.append(p.stdout.decode('utf-8', 'replace'))
        return p.returncode == 0
    ok = (run(['docker', 'image', 'inspect', 'mgu-renderd-build'])
          or run(['docker', 'build'] + plat + ['-t', 'mgu-renderd-build', 'docker']))
    ok = ok and run(['docker', 'run', '--rm'] + plat + user + ['-v', RENDERD + ':/src', 'mgu-renderd-build', 'make'])
    return ok and os.path.isfile(BUILT), ''.join(log)


def ask(why, fallback, allow_stale=False):
    print('\n!! ' + why)
    if fallback: print('!! The kit would ship kit/renderd/prebuilt/mgu-renderd, which is OLDER than the source.')
    else: print('!! The kit would ship no renderer: the apps then draw in software (PNG, a few fps).')
    if fallback and allow_stale:
        print('!! Older renderer explicitly selected with --allow-stale-renderer.')
        return fallback
    if sys.stdin is not None and sys.stdin.isatty():
        if input('Continue anyway? [y/N] ').strip().lower() not in ('y', 'yes'):
            print('stopped - nothing was built or packed'); sys.exit(1)
    else:
        sys.exit('stopped before building or packing: renderer fallback needs an explicit choice; '
                 'use --software-renderer, or --allow-stale-renderer when a prebuilt binary exists')
    return fallback


def pick_renderer(allow_stale=False):
    """The renderer binary to ship (path or None). Decided before anything is built."""
    want, have = source_hash(), prebuilt_hash()
    pre_ok = os.path.isfile(PRE) and have == want
    older = PRE if os.path.isfile(PRE) else None
    if shutil.which('docker'):
        ok, log = docker_build()
        if ok:
            if not pre_ok:
                os.makedirs(PRE_DIR, exist_ok=True)
                shutil.copyfile(BUILT, PRE)
                shutil.copyfile(gate_of(BUILT), gate_of(PRE))
                with open(PRE_SUM, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(want + '\n# sha256 of kit/renderd src/, inputgate/*.cpp, protocol/*.xml, docker/, Makefile '
                            '(make_kit.py source_hash) this binary was built from\n')
                print('renderer: source changed - updated kit/renderd/prebuilt/ (commit it)')
            return BUILT
        print('\n'.join(log.strip().splitlines()[-15:]))
        if pre_ok:
            print('renderer: Docker build failed - using the prebuilt one (built from this same source)')
            return PRE
        return ask('The mgu-renderd build failed (output above).', older, allow_stale)
    if pre_ok:
        print('renderer: prebuilt (kit/renderd/prebuilt, matches the source)')
        return PRE
    if older:
        return ask('The source in kit/renderd changed since the prebuilt renderer was made, and there is '
                   'no Docker to rebuild it (see kit/renderd/README.md).', older, allow_stale)
    return ask('No prebuilt renderer and no Docker to build one (see kit/renderd/README.md).', None)


def gate_of(rd):
    """the controller gate (mgu-inputgate.so, loaded into the HMI) built next to the renderer"""
    return os.path.join(os.path.dirname(rd), 'mgu-inputgate.so')


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def write_kit_sums(out, names):
    """Shared by CLI and portable worker; Linux md5sum must never see CRLF."""
    rows = []
    for name in names:
        if any(c in name for c in '\r\n\\'):
            raise ValueError('Invalid checksum path: ' + repr(name))
        target = os.path.join(out, name)
        if name.endswith('.sh'):
            with open(target, 'rb') as stream:
                data = stream.read()
            if b'\r' in data or data.startswith(b'\xef\xbb\xbf'):
                raise ValueError('Invalid Linux shell encoding: ' + name)
        rows.append('%s  %s\n' % (md5(target), name))
    # Bytes avoid platform-dependent newline translation on Windows.
    with open(os.path.join(out, 'KIT_SUMS'), 'wb') as stream:
        stream.write(''.join(rows).encode('utf-8'))


def main():
    import argparse
    from localize import languages, package_version
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', choices=languages(), default='en')
    renderer = parser.add_mutually_exclusive_group()
    renderer.add_argument('--software-renderer', action='store_true',
                          help='explicitly omit GPU renderer and controller gate (software drawing only)')
    renderer.add_argument('--allow-stale-renderer', action='store_true',
                          help='explicitly permit an older prebuilt renderer if a matching build is unavailable')
    parser.add_argument('apps', nargs='*')
    args = parser.parse_args()
    # English (the default) keeps the usual dist/mgu-custom-apps(.tar.gz); other languages get a suffix
    name = 'mgu-custom-apps' + ('' if args.language == 'en' else '-' + args.language)
    OUT = os.path.join(DIST, name)
    archive = os.path.join(DIST, name + '.tar.gz')
    apps = args.apps or sorted(d for d in os.listdir(os.path.join(ROOT, 'apps'))
                                  if os.path.isfile(os.path.join(ROOT, 'apps', d, 'app.json')))
    rd = None if args.software_renderer else pick_renderer(args.allow_stale_renderer)

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(os.path.join(OUT, 'apps'))
    for app in apps:
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'kit', 'tools', 'build.py'), '--language', args.language, app], cwd=ROOT)
        if r.returncode: sys.exit('build of %s failed' % app)
        ver = json.load(open(os.path.join(ROOT, 'apps', app, 'app.json'), encoding='utf-8'))['version']
        ver = package_version(ver, args.language)
        shutil.copyfile(os.path.join(DIST, '%s@%s.mgu' % (app, ver)), os.path.join(OUT, 'apps', '%s@%s.mgu' % (app, ver)))
    helper_names = copy_install_helpers(OUT)
    gate = rd and os.path.isfile(gate_of(rd))
    if rd: shutil.copyfile(rd, os.path.join(OUT, 'mgu-renderd'))
    if gate: shutil.copyfile(gate_of(rd), os.path.join(OUT, 'mgu-inputgate.so'))
    if not rd: print('note: no mgu-renderd in the kit - the apps install with software rendering only')

    names = helper_names + \
            ['apps/' + n for n in sorted(os.listdir(os.path.join(OUT, 'apps')))] + (['mgu-renderd'] if rd else []) + (['mgu-inputgate.so'] if gate else [])
    write_kit_sums(OUT, names)

    # the archive carries Unix modes (scripts and the renderer executable), also when made on Windows
    def mode(ti):
        ti.uid = ti.gid = 0; ti.uname = ti.gname = 'root'
        ti.mode = 0o755 if ti.isdir() or ti.name.endswith(('.sh', '/mgu-renderd', '.so')) else 0o644
        return ti
    with tarfile.open(archive, 'w:gz') as tf:
        tf.add(OUT, arcname='mgu-custom-apps', filter=mode)
    if hasattr(os, 'chmod'):
        for n in ('deploy-car.sh', 'mgu-app-install.sh') + (('mgu-renderd',) if rd else ()):
            os.chmod(os.path.join(OUT, n), 0o755)
    shutil.copyfile(os.path.join(DEPLOY, 'push-to-car.ps1'), os.path.join(DIST, 'push-to-car.ps1'))  # Windows: next to the .tar.gz
    print('kit: %s  (%s)' % (OUT, ' '.join(sorted(os.listdir(os.path.join(OUT, 'apps'))))))
    print('     %s' % archive)


if __name__ == '__main__':
    main()
