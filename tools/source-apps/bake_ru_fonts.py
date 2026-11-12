"""Build Cyrillic-only additions to the authors' bitmap/SDF font resources.

This is an offline resource generator; MGU Store uses the committed results.
The original Latin glyphs, metrics and pixels are retained.
"""
from pathlib import Path
import base64, hashlib, json, math, re, zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent / 'localization'
FONT = HERE / 'fonts/NotoSans-Regular.ttf'
ASSETS = HERE / 'assets'
CHARS = ''.join(chr(n) for n in range(0x410, 0x450)) + 'Ёё–—№·×«»'


def append_kit_font(source):
    obj = json.loads(source.read_text(encoding='utf8'))
    for size in obj['sizes']:
        original = Image.frombytes('L', (size['atlasW'], size['atlasH']), zlib.decompress(base64.b64decode(size['alpha'])))
        font = ImageFont.truetype(str(FONT), size['size'])
        x, y, row = 0, size['atlasH'] + 1, 0
        additions = []
        for ch in CHARS:
            if str(ord(ch)) in size['glyphs']:
                continue
            box = font.getbbox(ch, anchor='ls')
            w, h = box[2] - box[0], box[3] - box[1]
            if x + w >= original.width:
                x, y, row = 0, y + row + 1, 0
            tile = Image.new('L', (w, h))
            ImageDraw.Draw(tile).text((-box[0], -box[1]), ch, font=font, fill=255, anchor='ls')
            size['glyphs'][str(ord(ch))] = [x, y, w, h, box[0], box[1], round(font.getlength(ch), 2)]
            additions.append((tile, x, y))
            x += w + 1
            row = max(row, h)
        atlas = Image.new('L', (original.width, y + row + 1))
        atlas.paste(original)
        for tile, x, y in additions:
            atlas.paste(tile, (x, y))
        size['atlasH'] = atlas.height
        size['alpha'] = base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode()
    return obj


def sdf_assets():
    source = ROOT / 'third_party/eroobeeroo-cluster/shared'
    raw = (source / 'font_baked.js').read_text(encoding='utf8')
    meta = json.loads(re.search(r'module\.exports\s*=\s*(\{.*\});?\s*$', raw, re.S)[1].rstrip(';'))
    out = ASSETS / 'cluster-sdf'
    out.mkdir(parents=True, exist_ok=True)
    for name, value in meta.items():
        w, ch = value['cellW'] * value['cols'], value['cellH']
        old = np.frombuffer((source / ('font_' + name + '.wad')).read_bytes(), dtype=np.uint8).reshape(value['rows'] * ch, w)
        extra = ''.join(c for c in CHARS if c not in value['chars'])
        rows = math.ceil((len(value['chars']) + len(extra)) / value['cols'])
        atlas = np.zeros((rows * ch, w), dtype=np.uint8)
        atlas[:old.shape[0], :] = old
        font = ImageFont.truetype(str(FONT), round(ch * .92 * 4))
        for k, c in enumerate(extra, len(value['chars'])):
            tile = Image.new('L', (value['cellW'] * 4, ch * 4))
            draw = ImageDraw.Draw(tile)
            box = font.getbbox(c, anchor='ls')
            draw.text(((tile.width - (box[2] - box[0])) / 2 - box[0], ch * .79 * 4), c, font=font, fill=255, anchor='ls')
            small = np.asarray(tile.resize((value['cellW'], ch), Image.Resampling.LANCZOS)) >= 128
            distance = ndimage.distance_transform_edt(small) - ndimage.distance_transform_edt(~small)
            pixels = np.clip(128 + distance * 127 / value['spread'], 0, 255).astype(np.uint8)
            y, x = (k // value['cols']) * ch, (k % value['cols']) * value['cellW']
            atlas[y:y + ch, x:x + value['cellW']] = pixels
            value['adv'].append(round(font.getlength(c) / (ch * 4), 4))
        value['chars'] += extra
        value['rows'] = rows
        (out / ('font_' + name + '.wad')).write_bytes(atlas.tobytes())
    prefix = raw[:raw.index('module.exports')]
    (out / 'font_baked.js').write_text(prefix + 'module.exports = ' + json.dumps(meta, ensure_ascii=False) + ';\n', encoding='utf8')


def bitmap_assets():
    source = ROOT / 'third_party/bimmer-lab/apps'
    for app in source.iterdir():
        if not app.is_dir():
            continue
        for p in (app / 'hud/fonts').glob('*.json'):
            obj = json.loads(p.read_text())
            if sum(c in obj['glyphs'] for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') < 12:
                continue  # Numeric and gear-only faces remain byte-identical.
            old = Image.frombytes('L', (obj['width'], obj['height']), base64.b64decode(obj['alpha']))
            # Keep the author's text box and Latin baseline. Fit the added face
            # (including Cyrillic ascenders/descenders) into that existing cell.
            px = obj['size']
            while True:
                font = ImageFont.truetype(str(FONT), px)
                boxes = [font.getbbox(c, anchor='ls') for c in CHARS]
                if all(0 <= obj['baseline'] + b[1] and obj['baseline'] + b[3] <= obj['cellHeight'] for b in boxes):
                    break
                px -= 1
                assert px > 2
            x, y, row = 0, obj['height'] + 1, 0
            added = []
            for c in CHARS:
                if c in obj['glyphs']:
                    continue
                box = font.getbbox(c, anchor='ls')
                w, h = box[2] - box[0], box[3] - box[1]
                if x + w >= old.width:
                    x, y, row = 0, y + row + 1, 0
                im = Image.new('L', (w, h))
                ImageDraw.Draw(im).text((-box[0], -box[1]), c, font=font, fill=255, anchor='ls')
                obj['glyphs'][c] = dict(x=x, y=y, w=w, h=h, ox=box[0], oy=obj['baseline'] + box[1], advance=round(font.getlength(c), 3))
                added.append((im, x, y)); x += w + 1; row = max(row, h)
            atlas = Image.new('L', (old.width, y + row + 1)); atlas.paste(old)
            for im, x, y in added:
                atlas.paste(im, (x, y))
            obj['height'] = atlas.height
            obj['alpha'] = base64.b64encode(atlas.tobytes()).decode()
            out = ASSETS / 'bimmer-hud' / app.name / 'fonts' / p.name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf8')


def main():
    out = ASSETS / 'cluster-kit'
    out.mkdir(parents=True, exist_ok=True)
    index = {}
    for p in (ROOT / 'third_party/eroobeeroo-cluster/kit/runtime/fonts').glob('*.json'):
        if p.stem == 'cjk':
            continue
        obj = append_kit_font(p)
        dest = out / p.name
        dest.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
        index[p.stem] = {'sizes': [s['size'] for s in obj['sizes']], 'cacheKey': 'ru-' + hashlib.sha256(dest.read_bytes()).hexdigest()[:16]}
    (out / 'index.json').write_text(json.dumps(index, indent=2) + '\n', encoding='utf8')
    # This author's builder already supports Russian but its repository omits
    # the referenced cyrillic-ru.json. Supply the missing translation resource.
    out = ASSETS / 'bimmer-kit'
    out.mkdir(parents=True, exist_ok=True)
    obj = append_kit_font(ROOT / 'third_party/bimmer-lab/kit/runtime/fonts/label.json')
    obj['family'] = 'cyrillic'
    obj['cacheKey'] = 'bimmer-ru-noto-v1'
    (out / 'cyrillic-ru.json').write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    sdf_assets()
    bitmap_assets()
    print('Russian font resources built; original vendor kit files were not modified.')


if __name__ == '__main__':
    main()
