#!/usr/bin/env python3
"""MGU App Kit build: apps/<id>/app.json + main.js  ->  installable app.

    python3 kit/tools/build.py            # build every app in apps/
    python3 kit/tools/build.py car_vitals # just one

Produces in dist/:
    <id>@<ver>.mgu   install bundle for deploy/mgu-app-install.sh (VM and car)
    <id>@<ver>.tgz   npm-format package (the platform's preinstalled_apps format)
    <id>/            the staged tree (handy for inspection)

    --sdk DIR    BMW's oap-sdk (default oap-sdk/, see README 3.1); checked before anything is built
    --dist DIR   output folder (default dist/, dist-preview/ with --preview-only)
    --preview-only
                 offline, without BMW's SDK: only the staged tree, in dist-preview/<id>/, for
                 kit/tools/preview.js and replay.js. node_modules/oap-sdk is a stub that throws,
                 meta.json says "previewOnly": true and a PREVIEW_ONLY_NOT_INSTALLABLE file sits in
                 the stage and in source/. No .mgu / .tgz: it can never be installed. Nothing is
                 downloaded: an app.json asset that isn't there yet (Doom's game data) is left out.

An SDK whose package.json has "mguPlaceholder": true (a stand-in for offline pipeline checks) is
marked the same way, and its archives are named <id>@<ver>-NOT-INSTALLABLE.mgu / .tgz.

The archives are reproducible: two builds of the same commit with the same Python give the same
bytes. Folder contents are packed in sorted order, every timestamp is SOURCE_DATE_EPOCH (else the
HEAD commit's time, else 0), owner 0:0 without names, folders 0755 and files 0644
(deploy/mgu-app-install.sh sets the modes on the unit itself), and the gzip header has neither a
time nor a file name. A failed build leaves no partial stage or archive (see build()).

The RHMI layout (application.xml + uiDescription.json) is GENERATED from the
"screens" + "settings" in app.json, using only widget templates that BMW's own
apps use on this firmware (see reference/rhmi-widget-cells.md).
"""
import gzip, hashlib, json, os, re, shutil, subprocess, sys, tarfile, uuid
from xml.sax.saxutils import escape
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pack_data  # noqa: E402
from localize import unicode_resources, localize_spec, load_locale, languages

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
KIT = os.path.join(ROOT, 'kit')
APPS = os.path.join(ROOT, 'apps')
DIST = os.path.join(ROOT, 'dist')
PREVIEW_DIST = os.path.join(ROOT, 'dist-preview')
SDK = os.path.join(ROOT, 'oap-sdk')
NS = uuid.UUID('6b1d3a52-8f0e-4c4b-9a77-0d0c4d4e5f10')

# builds that must never reach a car: no SDK (--preview-only) or a placeholder SDK
MARKER = 'PREVIEW_ONLY_NOT_INSTALLABLE'
MARKER_TEXT = {
    'preview': 'NOT INSTALLABLE: preview-only build (kit/tools/build.py --preview-only).\n'
               "BMW's oap-sdk is not included; source/node_modules/oap-sdk is a stub that throws when loaded.\n"
               'For the PC tools only (kit/tools/preview.js, kit/tools/replay.js).\n',
    'placeholder': 'NOT INSTALLABLE: built with a placeholder oap-sdk (its package.json has "mguPlaceholder": true).\n'
                   'For offline checks of the build pipeline only.\n',
}
PREVIEW_SDK_INDEX = ("'use strict';\n"
                     "// kit/tools/build.py --preview-only: BMW's oap-sdk is not included, so this stage can\n"
                     '// never be installed. Loading the SDK fails on purpose.\n'
                     "throw new Error('preview-only build: BMW oap-sdk not included; not installable');\n")
PREVIEW_SDK_PACKAGE = {'name': 'oap-sdk', 'version': '0.0.0-preview-only'}

LANGS = ['ar_AE', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'fi_FI', 'fr_FR', 'he_IL',
         'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nb_NO', 'nl_NL', 'no_NO', 'pl_PL', 'pt_BR', 'pt_PT',
         'ro_RO', 'ru_RU', 'sk_SK', 'sl_SI', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN', 'zh_CN', 'zh_TW']

NATIVE = ['certmgr', 'codings', 'ecu', 'nare_logging', 'necemapaths', 'personalization',
          'smrf-native-cpp', 'someip', 'wscpp-client']

# Platform proxies every OAP app needs (same set BMW's apps declare).
PLATFORM_PROXIES = {
    "de.bmw.infotainment.hmi.entrypoint.EntryPoint": "*",
    "de.bmw.infotainment.hmi.entrypoint.EntryPointManager": "*",
    "de.bmw.infotainment.hmi.remote.RemoteHmi": "*",
    "de.bmw.infotainment.hmi.remote.RemoteHmiApplication": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceBundle": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceManager": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.StringBundle": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseInstance": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseProvider": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseRegistry": {
        "attributes": {"useCaseIds": "r"}, "broadcasts": ["registryUpdate"], "instances": "*", "methods": ["getProvider"]},
    "de.bmw.infotainment.lifecycle.lifecycle.Lifecycle": {"attributes": {"powerStateDetailed": "rs"}, "instances": "Front"},
    "de.bmw.infotainment.personalization.SessionManager": "*",
    "de.bmw.infotainment.personalization.UserAccount": {
        "attributes": {"firstName": "rs", "gcid": "rs", "id": "r", "name": "rs", "type": "r"},
        "broadcasts": ["requestUpdateConnectedDriveCredentials"], "instances": "*"},
    "de.bmw.infotainment.dataprivacy.privacysettings.PrivacySettings": {
        "attributes": {"allSettings": "rs"}, "instances": "1",
        "methods": ["addOrUpdateSetting", "setDynamicAvailable", "setDynamicEnable"]},
    "de.bmw.infotainment.telematic.oap.AppBookmarks": {"instances": ["${userId}"], "methods": ["registerBookmark"]},
    "de.bmw.infotainment.telematic.oap.PrivateEntryPoint": {
        "instances": ["${userId}"], "methods": ["registerEntryPoint", "unregisterEntryPoint", "setSelected", "setAvailability"]},
    "de.bmw.infotainment.telematic.oap.WakeUpOnDemand": {"instances": ["${userId}"], "methods": ["registerParticipant", "unregisterParticipant"]},
    "de.bmw.infotainment.telematic.oap.WodControl": {"instances": "${userId}", "methods": ["offerService", "stopOfferingService"]},
    "de.bmw.infotainment.telematic.oapcontroller.OAPController": "*",
    "de.bmw.infotainment.telematic.provisioning.Provisioning": {
        "broadcasts": ["provisioningDataJSON"], "instances": "1", "methods": ["getValueJSON", "setFilterForProvisioningData"]},
    "de.bmw.infotainment.vehicle.Vehicle": {"attributes": {"statusNewCurrentUnitsStatusExt": "rs"}, "instances": "1"},
    "de.bmw.infrastructure.EnvironmentalInformation": {"attributes": {"UnitBN2020": "rs"}, "instances": "1"},
    "org.genivi.nodestatemanager.Consumer": {
        "broadcasts": ["ShutdownEvents", "SessionStateChanged"], "instances": "NSMConsumer",
        "methods": ["LifecycleRequestComplete", "RegisterShutdownClient", "UnRegisterShutdownClient"]},
}
PLATFORM_SERVICES = {
    "de.bmw.infotainment.telematic.oap.AppStatus": {"instances": ["${userId}"]},
    "de.bmw.infotainment.telematic.oap.TriggersControl": {"instances": ["${userId}"]},
}

# property ids (RhmiConstants): Enabled=1 Visible=2 Focusable=3 ParentState=9
WIDGETS = {
    'graphic':   ('label', 'LT_Label_1Graphic_Scalable', {2: 1, 3: 0}),
    # Focusable=3: the HMI then reports focus changes (the kit's slim bar shows the focused button)
    'barbutton': ('button', 'LT_Button_1Row_Laptimer', {3: 3}),
    'header':    ('label', 'LT_Label_Header_1Row', {2: 1, 3: 0}),
    'text':      ('label', 'LT_Label_1Row', {2: 1, 3: 0}),
    'text3':     ('label', 'LT_Label_3Row_1TextDyn', {2: 1, 3: 0}),
    # menu rows: Visible=1, Focusable=2 - as in BMW's smartinterior menus
    'button':    ('button', 'LT_Button_1Row', {2: 1, 3: 2}),
    'iconbutton': ('button', 'LT_Button_1Row_1IconLeft', {2: 1, 3: 2}),
    'twocol':    ('button', 'LT_Button_1Row_2Col7030_2Text', {2: 1, 3: 2}),
    # settings: label on the 1st row, value on the 2nd, each the full width (BMW's parking app
    # settings use it in an LT_State_Wide); the 70/30 one-row columns cut both off
    'tworow':    ('button', 'LT_Button_2Row_2Text', {2: 1, 3: 2}),
    'checkbox':  ('checkBox', 'LT_CheckBox_1Row', {2: 1, 3: 2}),
    'scroll':    ('label', 'LT_ScrollLabel_UnlimitedRow_TextDyn', {2: 1, 3: 1}),
    'laptimer':  ('label', 'LT_Label_Laptimer', {3: 0}),
}


def u(app, what):
    return str(uuid.uuid5(NS, app + ':' + what))


class SdkError(Exception):
    pass


def check_sdk(sdk):
    """The SDK folder's package.json, or SdkError when the SDK can't be used."""
    for f in ('index.js', 'package.json'):
        if not os.path.isfile(os.path.join(sdk, f)):
            raise SdkError('%s not found' % os.path.join(sdk, f))
    try:
        with open(os.path.join(sdk, 'package.json'), encoding='utf-8') as fh:
            pkg = json.load(fh)
    except ValueError as e:
        raise SdkError('%s is not valid JSON (%s)' % (os.path.join(sdk, 'package.json'), e))
    if not isinstance(pkg, dict):
        raise SdkError('%s is not a JSON object' % os.path.join(sdk, 'package.json'))
    return pkg


def source_date_epoch():
    """Time stamp of every archive member: SOURCE_DATE_EPOCH, else the HEAD commit's time, else 0."""
    v = os.environ.get('SOURCE_DATE_EPOCH', '').strip()
    if v:
        if not re.match(r'^[0-9]+$', v):
            raise ValueError('SOURCE_DATE_EPOCH must be a whole number of seconds, not %r' % v)
        return int(v)
    try:
        r = subprocess.run(['git', '-C', ROOT, 'log', '-1', '--format=%ct'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        return int(r.stdout.strip()) if r.returncode == 0 else 0
    except (OSError, ValueError, subprocess.SubprocessError):      # no git, not a checkout
        return 0


def add_tree(tf, path, arcname, mtime):
    """Add a file or a folder (recursively, names sorted) with everything that differs between
    machines and checkouts taken out: times, owners, Windows' 0666 / 0777 modes."""
    ti = tf.gettarinfo(path, arcname)
    ti.mtime = mtime
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = ''
    if ti.isdir():
        ti.mode = 0o755
        tf.addfile(ti)
        for n in sorted(os.listdir(path)):
            add_tree(tf, os.path.join(path, n), arcname + '/' + n, mtime)
    elif ti.isreg():
        ti.mode = 0o644
        with open(path, 'rb') as fh:
            tf.addfile(ti, fh)
    else:
        raise ValueError('%s: only files and folders are packed' % path)


def write_archive(out, members, mtime):
    """members: [(path, arcname)] in archive order -> out (.tar.gz, gzip header without time or name)."""
    with open(out, 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as tf:
                for path, arcname in members:
                    add_tree(tf, path, arcname, mtime)


# staged files are written and closed right away: complete on disk before they are archived
def write_json(path, obj, **kw):
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(obj, fh, **kw)


def write_text(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)


MISSING_INTERFACES = 'missing-interfaces.json'


def missing_interfaces(adir):
    """apps/<id>/missing-interfaces.json - {interface: what this head unit does not offer} - checked;
    {} when there is none (every build but the desktop installer's)."""
    p = os.path.join(adir, MISSING_INTERFACES)
    if not os.path.isfile(p):
        return {}
    with open(p, encoding='utf-8') as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not all(isinstance(k, str) and k and isinstance(v, str) for k, v in data.items()):
        raise ValueError(MISSING_INTERFACES + ' is not {interface: text}')
    return data


def replace_dir(new, final):
    """Move a finished stage into place. A folder can't be renamed onto another one on Windows, so
    the old stage is moved aside first, and back again if the move fails."""
    old = None
    if os.path.lexists(final):
        old = os.path.join(os.path.dirname(final), '.%s.old-%d' % (os.path.basename(final), os.getpid()))
        shutil.rmtree(old, ignore_errors=True)
        os.rename(final, old)
    try:
        os.rename(new, final)
    except BaseException:
        if old is not None:
            os.rename(old, final)
        raise
    if old is not None:
        shutil.rmtree(old, ignore_errors=True)
        if os.path.lexists(old):
            print('  note: could not remove the previous stage %s (in use?); delete it by hand' % shown(old))


class Ids:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return self.n


def sid(app, key):
    return 'SID_' + re.sub(r'[^A-Z0-9]+', '_', (app + '_' + key).upper()).strip('_')


def hmi_text(s):
    """Keep Unicode: unicode_resources converts these cells to StringId before packaging."""
    return str(s)


def setting_options(s):
    """(values, labels) of a choice / number setting, in order - the drop-down's rows.
    "markDefault": true adds " (default)" to the default's row; "labels": {"0": "Auto"} names
    single number values (shown as is, no unit)."""
    if s['type'] == 'choice':
        values, labels = [o[0] for o in s['options']], [o[1] for o in s['options']]
    else:
        steps = s.get('steps') or []
        unit = (' ' + s['unit']) if s.get('unit') else ''
        named = s.get('labels') or {}
        values, labels = list(steps), [named.get('%g' % v, ('%g' % v) + unit) for v in steps]
    if s.get('markDefault'):
        labels = [lb + ' (default)' if v == s.get('default') else lb for v, lb in zip(values, labels)]
    return values, labels



PLAIN_NAME = re.compile(r'[A-Za-z0-9_][A-Za-z0-9._+-]*')


def check_assets(app_id, assets):
    """app.json "assets": each "file" is written into the app's folder, so it must be a plain file
    name there - no folders, no '..', no drive - or a downloaded file could land anywhere."""
    if not isinstance(assets, list):
        sys.exit('%s: app.json "assets" must be a list' % app_id)
    for i, a in enumerate(assets):
        name = a.get('file') if isinstance(a, dict) else None
        # fullmatch: '$' would also accept a trailing newline
        if not isinstance(name, str) or not PLAIN_NAME.fullmatch(name):
            sys.exit('%s: app.json assets[%d].file must be a plain file name (letters, digits, . _ + -, '
                     'no folders), not %r' % (app_id, i, name))


def fetch_assets(adir, assets, offline=False):
    """Large files an app needs but git doesn't keep (app.json "assets"): downloaded once, checked by SHA-256.
    offline (--preview-only): nothing is downloaded; a missing asset is reported and left out."""
    import hashlib, io, urllib.request, zipfile
    sha = lambda b: hashlib.sha256(b).hexdigest()
    for a in assets:
        dst = os.path.join(adir, a['file'])
        if os.path.exists(dst):
            with open(dst, 'rb') as fh:
                if sha(fh.read()) == a['sha256']:
                    continue
        if offline:
            print('  %s: missing or not matching its SHA-256, not downloaded (--preview-only stays offline)' % a['file'])
            continue
        print('  fetching %s from %s' % (a['file'], a['url']))
        data = urllib.request.urlopen(a['url'], timeout=300).read()
        if a.get('zipSha256') and sha(data) != a['zipSha256']:
            sys.exit('%s: download does not match its SHA-256' % a['url'])
        if a.get('zipMember'):
            data = zipfile.ZipFile(io.BytesIO(data)).read(a['zipMember'])
        if sha(data) != a['sha256']:
            sys.exit('%s: file does not match its SHA-256' % a['file'])
        with open(dst + '.part', 'wb') as fh:
            fh.write(data)
        os.replace(dst + '.part', dst)


def build_ui(spec, language='en'):
    """screens/settings -> (application.xml, uiDescription.json, strings, screen meta)"""
    app = spec['id']
    nid = Ids()
    strings = {sid(app, 'TITLE'): spec['title']}
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>']
    ui = {'schemaVersion': '1.3.0', 'containers': {}}
    screens = list(spec.get('screens', []))
    # a "menu" screen with "settings": true shows the settings itself: no separate settings screen
    if spec.get('settings') and not any(sc.get('settings') is True for sc in screens):
        screens.append({'name': 'SETTINGS', 'kind': 'settings', 'title': 'Settings'})
    state_ids = {}
    for scr in screens:
        state_ids[scr['name']] = None
    main_id = None

    def comp(kind, name, rows=None, extra_props=None, cells=None):
        ctype, widget, props = WIDGETS[kind]
        cid = nid()
        p = dict(props)
        p.update(extra_props or {})
        x = [f'            <component id="{cid}" type="{ctype}" widget="{widget}">']
        x += [f'                <property id="{k}" value="{v}"/>' for k, v in p.items()]
        x.append('            </component>')
        c = {'type': ctype, 'name': name}
        pj = {}
        if 2 in p: pj['Visible'] = {'value': p[2], 'type': 'UInt'}
        if 3 in p: pj['Focusable'] = {'value': p[3], 'type': 'UInt'}
        if pj: c['properties'] = pj
        if rows is not None: c['rows'] = rows
        if cells is not None: c['cells'] = cells
        return cid, x, c

    def text_row(key, text, cell='Text'):
        s = sid(app, key)
        strings[s] = text
        return {cell: {'value': s, 'type': 'StringId'}}

    def settings_items(items):
        for s in spec['settings']:
            name = 'SET_' + s['key'].upper()
            if s['type'] == 'bool':
                items.append(comp('checkbox', name, rows=[text_row('SET_' + s['key'], s['label'])]))
            elif s['type'] in ('choice', 'number'):
                # a drop-down with every value, as BMW's parking app settings: rows = options
                # (ItemText), HeaderText = the setting, SelectedItem = the chosen row (mgu.js sets it)
                values, labels = setting_options(s)
                did = nid()
                items.append((did, [f'            <component id="{did}" type="dropDownMenu"/>'], {
                    'type': 'dropDownMenu', 'name': name,
                    'rows': [{'ItemText': {'value': hmi_text(lb), 'type': 'Text'}} for lb in labels],
                    'cells': {'HeaderText': {'value': hmi_text(s['label']), 'type': 'Text'},
                              'SelectedItem': {'value': values.index(s['default']) if s['default'] in values else 0, 'type': 'UInt'}},
                }))
            else:
                strings[sid(app, 'SET_' + s['key'])] = s['label']
                items.append(comp('tworow', name, rows=[{'Text1stRow': {'value': s['label'], 'type': 'Text'},
                                                        'Text2ndRow': {'value': '', 'type': 'Text'}}]))
        # Chinese builds only: credit for the Chinese translation (localize.py sets the Chinese title)
        if language == 'zh-CN':
            credit_title, credit_link = sid(app, 'CN_CREDITS_TITLE'), sid(app, 'CN_CREDITS_LINK')
            strings[credit_title] = 'Translation by Douyin 小白科技杂物社 / BiliBili 小白151'
            strings[credit_link] = 'GitHub JackieZ123430 · github.com/JackieZ123430/idrive7-apps-cn'
            items.append(comp('tworow', 'CN_CREDITS', rows=[{
                'Text1stRow': {'value': credit_title, 'type': 'StringId'},
                'Text2ndRow': {'value': credit_link, 'type': 'StringId'},
            }]))
        # the project's own credit, last row
        repo_title, repo_link = sid(app, 'REPO_CREDITS_TITLE'), sid(app, 'REPO_CREDITS_LINK')
        strings[repo_title] = 'iDrive 7 custom apps'
        strings[repo_link] = 'GitHub cauliflowermossgrape · github.com/cauliflowermossgrape/idrive7-apps'
        items.append(comp('tworow', 'REPO_CREDITS', rows=[{
            'Text1stRow': {'value': repo_title, 'type': 'StringId'},
            'Text2ndRow': {'value': repo_link, 'type': 'StringId'},
        }]))

    for scr in screens:
        cid = nid()
        state_ids[scr['name']] = cid
        kind = scr.get('kind', 'list')
        # canvas = M Laptimer's state; menus = the state BMW uses for its
        # clickable lists (LT_State_Wide only renders a single text block)
        # settings: the wide state (full screen width), as BMW's own settings lists
        # menu: an app's own main menu (buttons, then its settings), in the same wide state
        widget = 'LT_State_Laptimer' if kind == 'canvas' else 'LT_State_Wide' if kind in ('settings', 'menu') else 'LT_State_Regular_ContentHidden'
        cont = {'type': 'state', 'name': scr['name'], 'components': {}}
        x = [f'    <container id="{cid}" type="state" widget="{widget}">']
        if main_id is not None and scr.get('parent', True):
            x.append(f'        <property id="9" value="{main_id}"/>')
            cont['properties'] = {'ParentState': {'value': main_id, 'type': 'UInt'}}
        groups = []
        if kind == 'canvas':
            items = []
            gid, gx, gc = comp('graphic', scr.get('graphic', scr['name'] + '_GFX'), rows=[{'Graphic': {'value': '', 'type': 'Text'}}])
            items.append((gid, gx, gc))
            groups.append(('List', items))
            bar = []
            for b in scr.get('buttons', []):
                bid, bx, bc = comp('barbutton', b[0], rows=[text_row(b[0], b[1])])
                bar.append((bid, bx, bc))
            if bar:
                groups.append(('Bar', bar))
        elif kind == 'settings':
            items = []
            settings_items(items)
            groups.append(('List', items))
        else:   # list / menu: components from "items" (a menu adds the settings after them)
            items = []
            for it in scr.get('items', []):
                kindi, name = it[0], it[1]
                label = it[2] if len(it) > 2 else ''
                if kindi == 'twocol':
                    rows = [{'Text1stCol': {'value': label, 'type': 'Text'}, 'Text2ndCol': {'value': '', 'type': 'Text'}}]
                elif kindi in ('graphic',):
                    rows = [{'Graphic': {'value': '', 'type': 'Text'}}]
                elif kindi == 'laptimer':
                    rows = [{}]
                else:
                    rows = [text_row(name, label)] if label else [{'Text': {'value': '', 'type': 'Text'}}]
                items.append(comp(kindi, name, rows=rows))
            if kind == 'menu' and scr.get('settings'):
                settings_items(items)
            groups.append(('List', items))
        tid = nid()
        groups.append(('Titlebar', [(tid, [f'            <component id="{tid}" type="title"/>'],
                                     {'type': 'title', 'name': scr['name'] + '_TITLE', 'rows': [text_row(scr['name'] + '_TITLE', scr.get('title', spec['title']))]})]))
        for gname, items in groups:
            gid = nid()
            x.append(f'        <layoutGroup id="{gid}" name="{gname}">')
            if gname != 'Titlebar':
                x.append('            <property id="3" value="1"/>')
            for (ccid, cx, cc) in items:
                x += cx
                cont['components'][str(ccid)] = cc
            x.append('        </layoutGroup>')
        x.append('    </container>')
        xml += x
        ui['containers'][str(cid)] = cont
        if main_id is None:
            main_id = cid
    xml.append('</application>')
    return '\n'.join(xml) + '\n', ui, strings, state_ids


def manifest_for(spec):
    proxies = dict(PLATFORM_PROXIES)
    for iface, fields in spec.get('signals', {}).items():
        inst = fields.pop('_instances', '1') if isinstance(fields, dict) else '1'
        entry = {'instances': inst}
        if isinstance(fields, dict):
            attrs = {k: v for k, v in fields.items() if not k.startswith('_')}
            meths = fields.get('_methods')
            evts = fields.get('_broadcasts')
            if attrs: entry['attributes'] = attrs
            if meths: entry['methods'] = meths
            if evts: entry['broadcasts'] = evts
        else:
            entry = '*'
        proxies[iface] = entry
    return {'proxies': proxies, 'services': PLATFORM_SERVICES}


def make_icon(spec, out):
    src = os.path.join(APPS, spec['id'], 'icon.png')
    if os.path.exists(src):
        shutil.copy(src, out)
        return
    # rendered by the kit's own canvas (node) so no extra tooling is needed. An argument list, no
    # shell: the glyph comes from app.json (iconGlyph / title) and must never become a command
    node = shutil.which('node')
    if not node:
        raise RuntimeError('%s has no icon.png, and node (to draw one with kit/tools/make_icon.js) is not on PATH' % spec['id'])
    glyph = str(spec.get('iconGlyph', spec['title'][:2]))
    subprocess.run([node, os.path.join(HERE, 'make_icon.js'), glyph, out], check=True)


WIDGET_COMPONENT_ID = 501


def build_start_widget(spec, app_id, icon_src, out):
    """app.json "startWidget" -> rhmiDataStartWidget/ (installed format), the home-screen widget.

    Same shape as BMW's own widgets on this firmware (Drive Recorder, Weather, News): a logical
    container with one startWidget component whose "Widget" cell names an HMI layout template.
    MainApp finds the folder by itself and offers the widget in the home screen's widget list;
    the app fills each placed widget (one "spawn" per widget) at runtime (kit/runtime/mgu.js)."""
    sw = spec['startWidget']
    name = sw.get('name', spec['title'])
    comp = app_id.upper() + '_WIDGET'
    sid_name = sid(app_id, 'WIDGET_NAME')
    icon = app_id + '_widget_icon.png'
    wuuid = u(app_id, 'start-widget')
    shutil.rmtree(out, ignore_errors=True)
    for d in ('uiDescription', 'strings', 'resources'):
        os.makedirs(os.path.join(out, d))
    app_json = {'schemaVersion': '1.3.0', 'application': {
        'uuid': wuuid, 'type': 'StartWidget', 'name': app_id + '_widget', 'vendor': spec.get('vendor', 'custom'),
        'version': '1.0', 'defaultLanguage': 'en_GB',
        'stringBundleUuid': u(app_id, 'sw-strings'), 'resourceBundleUuid': u(app_id, 'sw-resources'), 'entryPoints': [],
        'entryPointsStringBundleUuid': u(app_id, 'sw-ep-strings'), 'entryPointsResourceBundleUuid': u(app_id, 'sw-ep-resources'),
        'externalDialogStringBundleUuid': u(app_id, 'sw-ed-strings'),
        'bookmarkUuidPool': [u(app_id, 'sw-bookmarks'), 1, 2, 3, 4, 5, 6, 7]}}
    write_json(os.path.join(out, 'application.json'), app_json, separators=(',', ':'))
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<application>\n'
           '    <container id="500" type="logical">\n        <layoutGroup id="502">\n'
           f'            <component id="{WIDGET_COMPONENT_ID}" type="startWidget">\n'
           f'                <property id="7" value="{wuuid}"/>\n'
           '            </component>\n        </layoutGroup>\n    </container>\n</application>\n')
    write_text(os.path.join(out, 'uiDescription', 'application.xml'), xml)
    ui = {'schemaVersion': '1.3.0', 'containers': {'500': {'type': 'logical', 'name': 'startWidgetLogical', 'components': {
        str(WIDGET_COMPONENT_ID): {'type': 'startWidget', 'name': comp,
                                   'properties': {'UUID': {'value': wuuid, 'type': 'Text'}},
                                   'cells': {'Widget': {'value': sw.get('layout', 'LT_Table_OnlineApps_DriveRecorderWidget'), 'type': 'Text'},
                                             'SelectionName': {'value': sid_name, 'type': 'StringId'},
                                             'SelectionIcon': {'value': icon, 'type': 'ResourceId'}}}}}}}
    write_json(os.path.join(out, 'uiDescription', 'uiDescription.json'), ui, indent=1)
    for lang in LANGS:
        write_json(os.path.join(out, 'strings', lang + '.json'), {sid_name: name}, ensure_ascii=False)
    shutil.copy(icon_src, os.path.join(out, 'resources', icon))
    return {'component': comp, 'layout': ui['containers']['500']['components'][str(WIDGET_COMPONENT_ID)]['cells']['Widget']['value']}


def build(app_id, language='en', dist=DIST, sdk=SDK, mode='real', mtime=0):
    """mode: 'real' (BMW's SDK), 'placeholder' (a stand-in SDK: NOT-INSTALLABLE archives) or
    'preview' (no SDK, stage only). mtime: time stamp of the archive members.

    The app is staged in a temporary folder next to its output and moved into place only when it is
    complete; archives are written as .part files and renamed. A build that fails leaves no partial
    stage or archive behind, and the previous output of that app as it was."""
    with open(os.path.join(APPS, app_id, 'app.json'), encoding='utf-8') as fh:
        spec = json.load(fh)
    spec = localize_spec(spec, language)
    spec.setdefault('id', app_id)
    ver = spec['version']
    # downloads go to the app's own folder, before anything is staged
    check_assets(app_id, spec.get('assets', []))
    fetch_assets(os.path.join(APPS, app_id), spec.get('assets', []), offline=mode == 'preview')
    os.makedirs(dist, exist_ok=True)
    final = os.path.join(dist, app_id)
    stage = os.path.join(dist, '.%s.staging-%d' % (app_id, os.getpid()))
    suffix = '-NOT-INSTALLABLE' if mode == 'placeholder' else ''
    bundle = os.path.join(dist, f'{app_id}@{ver}{suffix}.mgu')
    npm = os.path.join(dist, f'{app_id}@{ver}{suffix}.tgz')
    parts = []
    try:
        shutil.rmtree(stage, ignore_errors=True)
        uidesc, state_ids = stage_app(spec, app_id, language, stage, sdk, mode)
        if mode != 'preview':
            parts = [bundle + '.part', npm + '.part']
            write_archive(parts[0], [(os.path.join(stage, n), n) for n in ('meta.json', MARKER, 'source', 'rhmiData', 'rhmiDataStartWidget', 'oapgen')
                                     if os.path.exists(os.path.join(stage, n))], mtime)
            write_archive(parts[1], [(os.path.join(stage, 'source'), 'package')], mtime)
        replace_dir(stage, final)
        for p in parts:
            os.replace(p, p[:-len('.part')])
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        for p in parts:
            try:
                os.remove(p)
            except OSError:
                pass
        raise
    if mode == 'preview':
        print(f'{app_id} {ver}: {shown(final)} (preview only, not installable), '
              f'{len(uidesc["containers"])} screens, states {state_ids}')
    else:
        print(f'{app_id} {ver}: {shown(bundle)} ({os.path.getsize(bundle) // 1024} KiB), '
              f'{len(uidesc["containers"])} screens, states {state_ids}'
              + (' - NOT INSTALLABLE (placeholder oap-sdk)' if suffix else ''))


def stage_app(spec, app_id, language, stage, sdk, mode):
    """Write the app's staged tree into `stage` (a new folder). Returns (uiDescription, state ids)."""
    ver = spec['version']
    src = os.path.join(stage, 'source')
    os.makedirs(os.path.join(src, 'javascript', 'kit'))
    os.makedirs(os.path.join(src, 'config'))
    os.makedirs(os.path.join(src, 'node_modules', 'oap-sdk'))

    manifest = manifest_for(json.loads(json.dumps(spec)))
    xml, uidesc, strings, state_ids = build_ui(spec, language)
    unicode_resources(uidesc, strings, language)
    for lang, tbl in spec.get('strings', {}).items():
        strings.update(tbl)

    # --- source/ (the npm package) ---
    pkg = {
        'name': app_id, 'version': ver, 'description': spec.get('description', spec['title']),
        'main': 'javascript/app.js', 'private': False, 'author': spec.get('vendor', 'custom'), 'license': 'UNLICENSED',
        'engines': {'node': '>=8.7.0'},
        'oapAppSettings': {
            'maxDiskUsage': spec.get('maxDiskUsage', 20971520), 'cpuLimit': spec.get('cpuLimit', 60),
            'memoryThresholdKB': spec.get('memoryKB', 196608), 'priority': 'PRIO_LOW',
            'visibility': 'FOREGROUND', 'latencyClass': 'FOREGROUND', 'loggingId': spec['loggingId'],
            'userLoginRequired': False, 'backgroundPriority': 200, 'someipManifest': 'manifest.json',
        },
    }
    write_json(os.path.join(src, 'package.json'), pkg, indent=2)
    write_json(os.path.join(src, 'manifest.json'), manifest, indent=2)
    shutil.copy(os.path.join(KIT, 'platform', 'permissions.json'), os.path.join(src, 'permissions.json'))
    write_json(os.path.join(src, 'npm-shrinkwrap.json'), {'name': app_id, 'version': ver, 'lockfileVersion': 1})
    # the SDK merges this over its own config. Newer SDKs (27.x, extracted from a newer donor app) build the
    # app's screens and entry point only with these on, and some donors ship them off: the app then had no
    # screens and crashed (upstream #39; kit/runtime/mgu.js now stays idle then). Older SDKs (24.x) ignore them.
    write_json(os.path.join(src, 'config', 'base.json'),
               {'rhmiLoadingEnabled': True, 'entryPointLoadingEnabled': True, 'settings': {app_id: spec.get('config', {})}},
               indent=2)
    # app code
    adir = os.path.join(APPS, app_id)
    asset_hashes = {a['file']: a.get('sha256') for a in spec.get('assets', [])}
    for f in os.listdir(adir):
        if f in asset_hashes:
            with open(os.path.join(adir, f), 'rb') as asset:
                valid = hashlib.sha256(asset.read()).hexdigest() == asset_hashes[f]
            if not valid:
                if mode == 'preview':
                    continue  # A mismatched local WAD must not silently reach the offline stage.
                raise ValueError('asset changed after verification: ' + f)
        if f.endswith('.js'):
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', 'app.js' if f == 'main.js' else f))
        elif f.endswith(('.wasm', '.wad')) or f in ('LICENSE', 'NOTICE'):
            # files the app reads as they are (doom: the game as WebAssembly, its data, its licences)
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', f))
        elif os.path.isdir(os.path.join(adir, f)):
            # data folders go along as one compressed file, read with kit/runtime/pack.js
            # (e.g. dtc_scanner/dtc_db, the fault text database -> dtc_db.pack)
            raw, size, _ = pack_data.pack(os.path.join(adir, f), os.path.join(src, 'javascript', f + '.pack'))
            print('  %s/: %.1f MB packed to %.2f MB' % (f, raw / 1e6, size / 1e6))
        elif f.endswith('.pack') and not os.path.isdir(os.path.join(adir, f[:-5])):
            # a committed pack (e.g. dtc_scanner/dtc_db.pack); a local folder of the same name replaces it
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', f))
            print('  %s (committed)' % f)
    # kit runtime
    kr = os.path.join(KIT, 'runtime')
    for f in os.listdir(kr):
        p = os.path.join(kr, f)
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(src, 'javascript', 'kit', f))
        else:
            shutil.copy(p, os.path.join(src, 'javascript', 'kit', f))
    # signals the head unit does not offer, left out of this app's manifest by the desktop installer: it
    # writes apps/<id>/missing-interfaces.json into its own staged copy of the sources only
    # (desktop/engine/engine.py adapt_read_signals). The app logs them when it starts (kit/runtime/mgu.js).
    missing = missing_interfaces(adir)
    if missing:
        write_json(os.path.join(src, 'javascript', 'kit', MISSING_INTERFACES), missing, indent=1, sort_keys=True)
    if language == 'zh-CN':
        # Retain localization authorship in the installed Chinese entry code as plain comments.
        entry = os.path.join(src, 'javascript', 'app.js')
        credit = ('// 中文汉化署名：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430\n'
                  '// 汉化仓库：https://github.com/JackieZ123430/idrive7-apps-cn\n')
        with open(entry, 'rb') as file:
            body = file.read()
        with open(entry, 'wb') as file:
            file.write(credit.encode('utf-8') + body)
    rt_spec = {k: spec.get(k) for k in ('id', 'title', 'version', 'screens', 'settings', 'config', 'startWidget')}
    rt_spec['stateIds'] = state_ids
    write_json(os.path.join(src, 'javascript', 'kit', 'app-spec.json'), rt_spec, indent=1)
    write_json(os.path.join(src, 'javascript', 'kit', 'locale.json'), {'language': language, 'strings': load_locale(language)}, ensure_ascii=False)
    if mode == 'preview':
        # never BMW's code, even when an SDK is there: a preview stage may be shared
        write_text(os.path.join(src, 'node_modules', 'oap-sdk', 'index.js'), PREVIEW_SDK_INDEX)
        write_json(os.path.join(src, 'node_modules', 'oap-sdk', 'package.json'), PREVIEW_SDK_PACKAGE, indent=2)
    else:
        shutil.copy(os.path.join(sdk, 'index.js'), os.path.join(src, 'node_modules', 'oap-sdk', 'index.js'))
        shutil.copy(os.path.join(sdk, 'package.json'), os.path.join(src, 'node_modules', 'oap-sdk', 'package.json'))

    # --- rhmiData: package format (inside source/) and installed format ---
    icon = spec['id'] + '_icon.png'
    app_json = {
        'schemaVersion': '1.3.0',
        'application': {
            'uuid': u(app_id, 'app'), 'type': 'OnlineApp', 'name': app_id, 'vendor': spec.get('vendor', 'custom'),
            'version': ver, 'defaultLanguage': 'en_GB',
            'stringBundleUuid': u(app_id, 'strings'), 'resourceBundleUuid': u(app_id, 'resources'),
            'entryPoints': [{
                'name': app_id.upper() + '_ENTRY', 'uuid': u(app_id, 'entry'), 'textId': sid(app_id, 'TITLE'),
                'icon': icon, 'insertionStateId': 20974, 'insertionFocusId': 2, 'insertionMode': 'INSERT_BELOW',
                'insertionOrder': 0, 'insertionPriority': 0, 'previewType': 'NONE', 'bookmarkable': True,
                'private': False, 'appearance': 'DEFAULT', 'isGroupHeader': False, 'insertionGroup': 0,
            }],
        },
    }
    pr = os.path.join(src, 'rhmiData')
    os.makedirs(os.path.join(pr, 'uiDescriptions', 'ID7'))
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'texts'))
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'images'))
    pj = json.loads(json.dumps(app_json))
    pj['application']['uiDescriptions'] = [{'applicationFilePath': './uiDescriptions/ID7/application.xml',
                                            'uiDescriptionFilePath': './uiDescriptions/ID7/uiDescription.json', 'hmi': ['ID7']}]
    pj['application']['variantGroups'] = [{'stringsPath': './variantGroups/Common/texts',
                                           'resourcesPath': './variantGroups/Common/images', 'hmi': ['ID7'], 'brands': ['BMW']}]
    write_json(os.path.join(pr, 'application.json'), pj, indent=2)
    write_text(os.path.join(pr, 'uiDescriptions', 'ID7', 'application.xml'), xml)
    write_json(os.path.join(pr, 'uiDescriptions', 'ID7', 'uiDescription.json'), uidesc, indent=1)
    for lang in LANGS:
        write_json(os.path.join(pr, 'variantGroups', 'Common', 'texts', lang + '.json'), strings, ensure_ascii=False)
    make_icon(spec, os.path.join(pr, 'variantGroups', 'Common', 'images', icon))

    ir = os.path.join(stage, 'rhmiData')
    os.makedirs(os.path.join(ir, 'uiDescription'))
    os.makedirs(os.path.join(ir, 'strings'))
    os.makedirs(os.path.join(ir, 'resources'))
    ij = json.loads(json.dumps(app_json))
    ij['application'].update({
        'entryPointsStringBundleUuid': u(app_id, 'ep-strings'), 'entryPointsResourceBundleUuid': u(app_id, 'ep-resources'),
        'externalDialogStringBundleUuid': u(app_id, 'ed-strings'),
        'bookmarkUuidPool': [u(app_id, 'bookmarks'), 1, 2, 3, 4, 5, 6, 7],
    })
    write_json(os.path.join(ir, 'application.json'), ij, separators=(',', ':'))
    write_text(os.path.join(ir, 'uiDescription', 'application.xml'), xml)
    write_json(os.path.join(ir, 'uiDescription', 'uiDescription.json'), uidesc, indent=1)
    for lang in LANGS:
        write_json(os.path.join(ir, 'strings', lang + '.json'), strings, ensure_ascii=False)
    shutil.copy(os.path.join(pr, 'variantGroups', 'Common', 'images', icon), os.path.join(ir, 'resources', icon))
    if spec.get('startWidget'):
        info = build_start_widget(spec, app_id, os.path.join(ir, 'resources', icon), os.path.join(stage, 'rhmiDataStartWidget'))
        print('  home-screen widget: %s (%s)' % (info['component'], info['layout']))

    # --- installer helpers + metadata ---
    shutil.copytree(os.path.join(KIT, 'tools', 'oapgen'), os.path.join(stage, 'oapgen'))
    meta = {'id': app_id, 'version': ver, 'title': spec['title'], 'native': NATIVE, 'kit': 1}
    if mode != 'real':
        meta['previewOnly'] = True
        for d in (stage, src):
            write_text(os.path.join(d, MARKER), MARKER_TEXT[mode])
    write_json(os.path.join(stage, 'meta.json'), meta, indent=1)
    return uidesc, state_ids


def shown(p):
    """A path for messages: relative to the repository when inside it (as before), else as given."""
    try:
        rel = os.path.relpath(p, ROOT)
    except ValueError:              # another drive (Windows)
        return p
    return p if rel == '..' or rel.startswith('..' + os.sep) else rel


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--language', choices=languages(), default='en')
    parser.add_argument('--sdk', type=os.path.abspath, default=SDK, help="BMW's oap-sdk folder (default: oap-sdk/)")
    parser.add_argument('--dist', type=os.path.abspath, default=None,
                        help='output folder (default: dist/, or dist-preview/ with --preview-only)')
    parser.add_argument('--preview-only', action='store_true',
                        help="stage only, without BMW's SDK (offline, never installable)")
    parser.add_argument('apps', nargs='*')
    args = parser.parse_args()
    dist = args.dist or (PREVIEW_DIST if args.preview_only else DIST)
    mode = 'preview'
    if not args.preview_only:
        # before anything is created or deleted in the output folder: without the SDK there is
        # nothing installable to build (a partial stage and a traceback helped nobody)
        try:
            pkg = check_sdk(args.sdk)
        except SdkError as e:
            print('build.py: no usable BMW oap-sdk: %s\n'
                  "Extract it from your own head unit's x_call app (README 3.1, kit/tools/extract_sdk.js), or use\n"
                  '--preview-only for an offline, non-installable build. Nothing was built; %s was not touched.'
                  % (e, shown(dist)), file=sys.stderr)
            sys.exit(2)
        mode = 'placeholder' if pkg.get('mguPlaceholder') is True else 'real'
    try:
        mtime = source_date_epoch()
    except ValueError as e:
        print('build.py: %s. Nothing was built.' % e, file=sys.stderr)
        sys.exit(2)
    ids = args.apps or sorted(d for d in os.listdir(APPS) if os.path.exists(os.path.join(APPS, d, 'app.json')))
    for i in ids:
        build(i, args.language, dist=dist, sdk=args.sdk, mode=mode, mtime=mtime)


if __name__ == '__main__':
    main()
