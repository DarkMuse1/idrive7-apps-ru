#!/usr/bin/env python3
"""build_manifest.py - write a build manifest (TZ 13, item 11): the exact commit, the tools and
dependencies used, and SHA-256 of every shipped component and built package.

    python kit/tools/build_manifest.py                  # -> dist/BUILD_MANIFEST.json
    python kit/tools/build_manifest.py --out FILE --dist DIR

The manifest is deterministic for the same tree and inputs: the timestamp is SOURCE_DATE_EPOCH if set,
else the commit time. Tool versions are read from the tools found on PATH (or MGU_NODE, MGU_PYTHON);
a tool that is missing is recorded as null, never guessed. Nothing is uploaded anywhere.
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import platform
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
UPSTREAM_PIN = '682cc70d3914b59bf6329d68b047ce35ae20696f'

# shipped or build-relevant files whose exact bytes matter, with what we know about where they come from
COMPONENTS = [
    ('kit/renderd/prebuilt/mgu-renderd', 'prebuilt renderer; rebuilt bit-identical from kit/renderd at 682cc70 in Docker (docs/test-report.md T-M0-08)'),
    ('kit/renderd/prebuilt/mgu-inputgate.so', 'prebuilt controller gate; rebuilt bit-identical (T-M0-08); not installed by default'),
    ('kit/renderd/prebuilt/SOURCE_SHA256', 'fingerprint of the renderer sources the prebuilt binaries were made from'),
    ('apps/doom/doom.wasm', 'Doom engine (GPL-2.0), built from third_party/doomgeneric; Doom is not in the default kit'),
    ('apps/dtc_scanner/dtc_db.pack', 'BMW fault texts packed by upstream; distribution rights unconfirmed (docs/known-limitations.md)'),
]
GLOBS = [
    ('kit/runtime/fonts/*.json', 'baked glyph atlas'),
    ('kit/runtime/fonts/*.txt', 'font licence'),
    ('profiles/catalog/*.json', 'compatibility profile'),
    ('profiles/schema/*.json', 'profile schema'),
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def run(cmd):
    """first output line of a command, or None if it is not available"""
    try:
        p = subprocess.run(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    out = p.stdout.decode('utf-8', 'replace').strip().splitlines()
    return out[0].strip() if p.returncode == 0 and out else None


def entry(rel, note):
    p = os.path.join(ROOT, rel)
    if not os.path.isfile(p):
        return {'path': rel, 'present': False, 'note': note}
    return {'path': rel, 'present': True, 'size': os.path.getsize(p), 'sha256': sha256(p), 'note': note}


def manifest(dist):
    commit = run(['git', 'rev-parse', 'HEAD'])
    epoch = os.environ.get('SOURCE_DATE_EPOCH') or run(['git', 'log', '-1', '--format=%ct']) or '0'
    stamp = datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    dirty = run(['git', 'status', '--porcelain', '--untracked-files=no'])
    components = [entry(rel, note) for rel, note in COMPONENTS]
    for pattern, note in GLOBS:
        for p in sorted(glob.glob(os.path.join(ROOT, pattern))):
            components.append(entry(os.path.relpath(p, ROOT).replace(os.sep, '/'), note))
    packages = []
    for p in sorted(glob.glob(os.path.join(dist, '*.mgu')) + glob.glob(os.path.join(dist, '*.tgz')) + glob.glob(os.path.join(dist, '*.tar.gz'))):
        packages.append({'file': os.path.basename(p), 'size': os.path.getsize(p), 'sha256': sha256(p)})
    req = os.path.join(ROOT, 'requirements-dev.txt')
    dev = [l.strip() for l in open(req, encoding='utf-8') if l.strip() and not l.startswith('#')] if os.path.isfile(req) else []
    node = os.environ.get('MGU_NODE', 'node')
    return {
        'schema': 1,
        'generated_at': stamp,
        'source': {
            'commit': commit,
            'branch': run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
            'tracked_changes': bool(dirty),
            'upstream_pin': UPSTREAM_PIN,
        },
        'tools': {
            'python': platform.python_version(),
            'node': run([node, '--version']),
            'git': run(['git', '--version']),
            'renderer_build_image': {
                'dockerfile': 'kit/renderd/docker/Dockerfile',
                'verified_base': 'ubuntu:18.04@sha256:152dc042452c496007f07ca9127571cb9c29697f42acbfad72324b2bb2e43c98',
                'note': 'digest of the base image used for the bit-identical rebuild (T-M0-08); the Dockerfile itself names only the tag',
            },
        },
        'dependencies': {
            'build': 'Python and Node.js standard libraries only; no npm packages',
            'development': dev,
            'not_included': ['BMW oap-sdk (extracted by the owner from their own head unit, never committed or published)'],
        },
        'components': components,
        'packages': packages,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dist', default=os.path.join(ROOT, 'dist'))
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    out = args.out or os.path.join(args.dist, 'BUILD_MANIFEST.json')
    data = manifest(args.dist)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + '.part'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, out)
    print('manifest: %s (%d components, %d packages, commit %s)' % (out, len(data['components']), len(data['packages']), data['source']['commit']))


if __name__ == '__main__':
    main()
