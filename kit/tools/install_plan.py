#!/usr/bin/env python3
"""Read-only Windows installer preflight (TZ 9.1/9.2).

Inspects local discovery facts and an explicit SHA-256 bundle manifest, without
extracting or executing package contents. Does not connect to a head unit.
This is the planning component, not the completed installer or a root adapter.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile

import jsonschema

ROOT = Path(__file__).resolve().parents[2]
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_UNPACKED = 512 * 1024 * 1024
MAX_MEMBERS = 20000
WARNING = ('Установка может повредить головное устройство и привести к потере кодировок. '
           'Файловая резервная копия приложений не восстанавливает прошивку и состояние до root. '
           'Перед изменениями требуется явное подтверждение этого плана пользователем.')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def file_identity(s):
    # On Windows path stat and descriptor stat can expose different ctime values.
    # Content identity comes from SHA-256 of the private snapshot, not timestamps.
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns


@contextmanager
def verified_snapshot(path, expected_sha256, expected_size):
    """Freeze exactly the bytes that are hashed, before any archive parsing."""
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('package must be a regular local file')
    if type(expected_size) is not int or before.st_size != expected_size or not 0 <= expected_size <= MAX_ARCHIVE:
        raise ValueError('package size mismatch or limit exceeded')
    with path.open('rb') as source, tempfile.TemporaryFile() as snapshot:
        if file_identity(os.fstat(source.fileno())) != file_identity(before):
            raise ValueError('package changed before inspection')
        digest, copied = hashlib.sha256(), 0
        while True:
            # One extra byte detects growth without copying an unbounded source.
            chunk = source.read(min(1024 * 1024, expected_size - copied + 1))
            if not chunk:
                break
            copied += len(chunk)
            if copied > expected_size:
                raise ValueError('package size changed during inspection')
            digest.update(chunk)
            snapshot.write(chunk)
        if copied != expected_size or file_identity(os.fstat(source.fileno())) != file_identity(before):
            raise ValueError('package changed during inspection')
        if digest.hexdigest() != expected_sha256:
            raise ValueError('package SHA-256 mismatch')
        snapshot.seek(0)
        yield snapshot
        current = path.lstat()
        if (not stat.S_ISREG(current.st_mode) or file_identity(current) != file_identity(before)
                or file_identity(os.fstat(source.fileno())) != file_identity(before)):
            raise ValueError('package changed during inspection')


def inspect_package(path, expected_sha256, expected_size):
    """Reject unsafe archives before extraction; never import package JS or Python."""
    path = Path(path)
    if not re.fullmatch('[0-9a-f]{64}', str(expected_sha256)):
        raise ValueError('missing or invalid SHA-256')
    with verified_snapshot(path, expected_sha256, expected_size) as stream:
        with tarfile.open(fileobj=stream, mode='r:gz') as archive:
            names, total, meta, sdk = set(), 0, None, None
            for n, member in enumerate(archive):
                if n >= MAX_MEMBERS:
                    raise ValueError('too many archive members')
                name = member.name
                parts = PurePosixPath(name).parts
                if (not name or name.startswith('/') or '\\' in name or ':' in name
                        or any(x in ('..', '.') for x in name.split('/') if x)
                        or any(ord(c) < 32 for c in name) or name != '/'.join(parts)):
                    raise ValueError('unsafe archive path: ' + repr(name))
                if name in names:
                    raise ValueError('duplicate archive member: ' + name)
                names.add(name)
                if not (member.isfile() or member.isdir()) or member.mode & 0o7000:
                    raise ValueError('links, devices, special modes and sparse entries are not accepted')
                if member.issparse():
                    raise ValueError('sparse entries are not accepted')
                total += member.size
                if total > MAX_UNPACKED:
                    raise ValueError('unpacked size limit exceeded')
                if 'NOT_INSTALLABLE' in name or 'NOT-INSTALLABLE' in name:
                    raise ValueError('preview/placeholder package is not installable')
                if name in ('meta.json', 'source/node_modules/oap-sdk/package.json'):
                    if not member.isfile() or member.size > 65536:
                        raise ValueError('invalid package metadata')
                    obj = json.load(archive.extractfile(member))
                    if not isinstance(obj, dict):
                        raise ValueError('metadata must be an object')
                    if name == 'meta.json':
                        meta = obj
                    else:
                        sdk = obj
            if not meta or not re.fullmatch('[a-z][a-z0-9_-]*', str(meta.get('id', ''))):
                raise ValueError('missing or invalid app id')
            if not isinstance(meta.get('version'), str) or not meta['version']:
                raise ValueError('missing version')
            if meta.get('previewOnly') or meta.get('placeholderSdk'):
                raise ValueError('preview/placeholder metadata is not installable')
            if not sdk or sdk.get('mguPlaceholder') or str(sdk.get('version', '')).startswith('0.0.0-'):
                raise ValueError('missing SDK or placeholder SDK')
            if not {'source/manifest.json', 'source/javascript/app.js'} <= names:
                raise ValueError('incomplete app package')
    return dict(id=meta['id'], version=meta['version'], file=path.name, sha256=expected_sha256,
                bytes=expected_size, unpacked_bytes=total, entries=len(names))


def make_plan(discovery, bundle_path, catalog=None):
    bundle_path = Path(bundle_path).resolve()
    blockers, packages, candidates = [], [], []
    if not isinstance(discovery, dict):
        raise ValueError('discovery report must be an object')
    if discovery.get('synthetic') is True:
        blockers.append('Synthetic discovery is not evidence for a real installation')
    facts = discovery.get('facts', {})
    if discovery.get('schema_version') != 1 or not isinstance(facts, dict):
        blockers.append('Invalid discovery report; schema_version=1 and flat facts are required')
        facts = {}
    catalog = Path(catalog or ROOT / 'profiles/catalog')
    validator = jsonschema.Draft7Validator(read_json(ROOT / 'profiles/schema/profile.schema.json'))
    for file in sorted(catalog.glob('*.json')):
        profile = read_json(file)
        if list(validator.iter_errors(profile)):
            blockers.append('Invalid catalog profile: ' + file.name)
            continue
        rules = profile['match']['rules']
        # bool and int compare equal in Python; discovery matching must preserve types.
        matches = rules and all(r['key'] in facts and type(facts[r['key']]) is type(r['equals'])
                                and facts[r['key']] == r['equals'] for r in rules)
        if matches and profile['status'] == 'verified':
            candidates.append(profile)
    if len(candidates) != 1:
        blockers.append('Exactly one verified compatibility profile must match; matched ' + str(len(candidates)))
    if facts.get('power.stable') is not True:
        blockers.append('Stable external power has not been verified')
    manifest = read_json(bundle_path)
    if not isinstance(manifest, dict):
        raise ValueError('bundle manifest must be an object')
    if manifest.get('schema_version') != 1 or not isinstance(manifest.get('packages'), list) or not manifest['packages']:
        blockers.append('Bundle manifest must list packages explicitly')
    else:
        ids = set()
        for item in manifest['packages']:
            try:
                if not isinstance(item, dict):
                    raise ValueError('package entry must be an object')
                name = item.get('file')
                if not isinstance(name, str) or not re.fullmatch('[A-Za-z0-9_.@+-]+[.]mgu', name):
                    raise ValueError('package file must be a plain .mgu filename')
                p = bundle_path.parent / name
                if p.resolve().parent != bundle_path.parent:
                    raise ValueError('package resolves outside bundle directory')
                package = inspect_package(p, item.get('sha256'), item.get('bytes'))
                if package['id'] in ids:
                    raise ValueError('duplicate app id: ' + package['id'])
                ids.add(package['id']); packages.append(package)
            except (ValueError, OSError, tarfile.TarError, json.JSONDecodeError) as e:
                blockers.append('Package refused: ' + str(e))
    profile = candidates[0] if len(candidates) == 1 else None
    access = discovery.get('access', {})
    if not isinstance(access, dict):
        raise ValueError('discovery access must be an object')
    existing = access.get('ssh_verified') is True
    # This gate remains even for an existing SSH session: credentials alone do not
    # verify the transport, backup/restore, or the app transaction adapter.
    blockers.append('No device-tested installation adapter is shipped in this build')
    if not existing:
        blockers.append('Initial root/SSH adapter and pre-root backup/recovery need device verification')
    steps = [
        dict(id='preflight', effect='read', description='Compatibility, package hashes, power and free-space checks'),
        dict(id='consent', effect='user_confirmation', description=WARNING),
        dict(id='pre_root_backup', effect='skip' if existing else 'backup', automatic=True,
             verification_required=not existing, on_failure='pause_for_manual_backup_confirmation',
             description='Initial access is not scheduled; a pre-root state cannot be recovered retroactively' if existing else
                         'Automatically capture and verify the required coding/recovery data before initial access'),
        dict(id='pre_root_manual_backup', effect='skip' if existing else 'conditional_user_confirmation',
             only_if='automatic_backup_failed_or_unavailable', checkbox_default=False,
             separate_risk_acceptance=True, record_as='user_attested_not_verified',
             description='Offer manual backup after automatic failure; require two explicit confirmations bound to the current device and plan, then log the exception'),
        dict(id='initial_access', effect='skip' if existing else 'device_write', description='Verify existing access' if existing else 'Obtain root/SSH automatically through the verified profile adapter; no blind retry'),
        dict(id='ssh_identity', effect='read', description='Verify the device-bound host key and privileges; never accept an arbitrary key'),
        dict(id='rediscovery', effect='read', description='Full discovery and repeat application compatibility check'),
        dict(id='app_baseline', effect='backup', automatic=True, verification_required=True,
             on_failure='pause_for_manual_backup_confirmation',
             description='Automatically preserve and verify first-install baseline and update snapshot, absent files, owners, modes, links and mounts'),
        dict(id='app_manual_backup', effect='conditional_user_confirmation',
             only_if='automatic_backup_failed_or_unavailable', checkbox_default=False,
             separate_risk_acceptance=True, record_as='user_attested_not_verified',
             description='Manual app backup exception is separate from pre-root backup and never bypasses other checks'),
        dict(id='stage', effect='device_write', description='Stage and verify the selected packages only'),
        dict(id='apply', effect='device_write', description='Apply with durable per-step journal and safe cancellation points'),
        dict(id='health', effect='read', description='Check platform and application health'),
        dict(id='commit_or_restore', effect='device_write', description='Commit or use the verified app restore strategy; no firmware rollback claim'),
    ]
    return dict(schema_version=1, mode='dry-run', can_execute=False, status='blocked',
                profile=profile['profile_id'] if profile else None, warning=WARNING,
                packages=packages, blockers=blockers, steps=steps,
                backup_policy=dict(automatic=True, verify_before_write=True, preserve_first_baseline=True,
                                   overwrite_previous=False, stop_on_backup_error=True,
                                   manual_fallback=dict(enabled=True, after='automatic_backup_failed_or_unavailable',
                                                        backup_checkbox_required=True, separate_risk_acceptance_required=True,
                                                        verified_by_application=False, invalidated_on_context_change=True,
                                                        warning_version='manual-backup-v1-20261029'),
                                   pre_access_backup_status='not_created', app_backup_status='not_created'),
                touched_paths=profile['install_strategy']['touched_paths'] if profile else [],
                services=profile['install_strategy']['services'] if profile else [],
                package_unpacked_bytes=sum(p['unpacked_bytes'] for p in packages),
                required_space_bytes=None, confirmation_required=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--discovery', required=True)
    ap.add_argument('--bundle', required=True)
    args = ap.parse_args()
    try:
        plan = make_plan(read_json(args.discovery), args.bundle)
    except (OSError, ValueError) as e:
        ap.exit(2, 'Cannot make plan: ' + str(e) + '\n')
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    return 2 if plan['blockers'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
