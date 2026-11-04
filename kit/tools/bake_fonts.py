#!/usr/bin/env python3
"""Bake font atlases for kit/runtime/canvas.js (the head unit has no font
rasteriser available to apps, so glyphs are pre-rendered here at build time).

Output: kit/runtime/fonts/<family>.json  =  {"family", "source", "axes", "cacheKey", "sizes": [{size,
ascent, descent, atlasW, atlasH, alpha: base64(zlib(8-bit alpha)), glyphs: {code: [x,y,w,h,ox,oy,adv]}}]}
ox/oy = glyph bitmap offset from (pen x, baseline y); adv = the font's own (unhinted) advance.

Font: Ubuntu Sans 1.006, the variable UbuntuSans[wdth,wght].ttf from the google/fonts repository,
checked against the SHA-256 below and kept in kit/tools/.font-cache/ (not in git). Its licence is the
Ubuntu Font Licence 1.0 (google/fonts files the family under ufl/, not ofl/), shipped next to the
atlases as kit/runtime/fonts/UFL-UbuntuSans.txt.

    python kit/tools/bake_fonts.py [font] [--out DIR] [--check]

Without a font path the file is downloaded once into the cache. --out bakes elsewhere; --check bakes
into a temporary folder and compares with the committed atlases. Needs Pillow (requirements-dev.txt):
the committed atlases were made with Pillow 13.0.0 / FreeType 2.14.3, other versions may rasterise a
pixel differently. Same font and Pillow -> same JSON bytes (tests/l10n/test_bake_determinism.py).
"""
import argparse
import base64
import hashlib
import json
import os
import shutil
import struct
import sys
import tempfile
import urllib.request
import zlib

import PIL
from PIL import Image, ImageDraw, ImageFont, features

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'runtime', 'fonts')
CACHE = os.path.join(HERE, '.font-cache')
FONT = 'UbuntuSans[wdth,wght].ttf'
URL = 'https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntusans/UbuntuSans%5Bwdth,wght%5D.ttf'
SHA256 = '37e90bba45a2a1172d9f6078e45daebaa1b4e537943205cc1309f142a254fe40'
SOURCE = 'Ubuntu Sans 1.006 (Ubuntu Font Licence 1.0)'
FONTDIR = CACHE                       # bake_cjk.py points this at its own font's folder
BAKED_WITH = ('13.0.0', '2.14.3')     # Pillow, FreeType of the committed atlases

# the charset before Cyrillic; bake_cjk.py still bakes its atlas from it. The Ubuntu fonts have no
# │ ↑ ↓ → ← ✕: the old Latin atlases held empty .notdef boxes for them, nothing drew them.
LATIN_TEXT = ''.join(chr(c) for c in range(32, 127)) + '°μ│·–—…×±²³€↑↓→←✓✕'
ASCII = ''.join(chr(c) for c in range(32, 127))
# U+00A0: Russian keeps a number and its unit together with a no-break space (locales/ru.json)
SYMBOLS = ' °μ·–—…×±²³€✓'
# Russian: the alphabet with Ё/ё, «» and „“ quotes, the numero sign
RUSSIAN = ''.join(chr(c) for c in range(0x410, 0x450)) + 'Ёё«»„“№'
TEXT = ASCII + SYMBOLS + RUSSIAN
# Large number sizes: digits, unit symbols and the letters of short labels drawn next to numbers.
# DIGITS_RU = the letters of the Russian unit symbols in locales/ru.json (км/ч, об/мин, бар, кВт,
# кВт·ч, л.с., Нм, В, мВ, с, мс, мин, ч, дн., м, км, фут, миль/ч, кг, кадр/с);
# tests/l10n/glyphs.test.js fails when a translation needs one that is missing.
DIGITS_RU = 'абгдиклмнорстуфчьВН ·'
DIGITS = '0123456789.,:-+%°/ ' + 'kmhKMHrpmbarpsiVNCFgsxµRPDSWLOT' + DIGITS_RU
GEAR = '0123456789NRPDSM-'                 # the selector letters stay Latin (P R N D S M)

# Axis values as the old Ubuntu atlases had them: Ubuntu Sans 1.006 at the same values draws the
# same Latin glyphs as Ubuntu 0.869 did (identical advances, bitmaps equal but for a few pixels).
FAMILIES = {
    # family: (file, (wdth, wght) or None, [(size, charset)])
    'label': (FONT, (85, 400), [(18, TEXT), (24, TEXT), (32, TEXT), (44, TEXT)]),
    'bold':  (FONT, (85, 700), [(24, TEXT), (32, TEXT), (44, TEXT), (64, TEXT)]),
    'num':   (FONT, (75, 500), [(40, TEXT), (64, DIGITS), (96, DIGITS), (150, DIGITS)]),
    'light': (FONT, (85, 300), [(32, TEXT), (64, TEXT), (110, DIGITS)]),
    'gear':  (FONT, (75, 700), [(200, GEAR), (300, GEAR)]),
}

# GPU budget (kit/renderd/src/gfx.c gfx_atlas): one 2048 x 4096 alpha texture as two 1024-wide
# columns; each atlas goes into the less full column, first come first served, for all apps.
ATLAS_W, COLUMN_H, MAX_ATLASES = 1024, 4096, 64


def font_tables(path):
    data = open(path, 'rb').read()
    n = struct.unpack('>H', data[4:6])[0]
    out = {}
    for i in range(n):
        tag, _, off, length = struct.unpack('>4sIII', data[12 + 16 * i:28 + 16 * i])
        out[tag.decode('latin-1')] = data[off:off + length]
    return out


def cmap(path):
    """Code points the font maps to a glyph (cmap format 4 or 12)."""
    t = font_tables(path)['cmap']
    best = None
    for i in range(struct.unpack('>H', t[2:4])[0]):
        pid, eid, off = struct.unpack('>HHI', t[4 + 8 * i:12 + 8 * i])
        fmt = struct.unpack('>H', t[off:off + 2])[0]
        if fmt == 12 and (pid, eid) in ((3, 10), (0, 4), (0, 6)):
            best = (12, off)
        elif fmt == 4 and (pid, eid) in ((3, 1), (0, 3)) and best is None:
            best = (4, off)
    fmt, o = best
    mapped = set()
    if fmt == 12:
        for k in range(struct.unpack('>I', t[o + 12:o + 16])[0]):
            start, end, _ = struct.unpack('>III', t[o + 16 + 12 * k:o + 28 + 12 * k])
            mapped.update(range(start, end + 1))
        return mapped
    seg = struct.unpack('>H', t[o + 6:o + 8])[0] // 2
    ends = struct.unpack('>%dH' % seg, t[o + 14:o + 14 + 2 * seg])
    starts = struct.unpack('>%dH' % seg, t[o + 16 + 2 * seg:o + 16 + 4 * seg])
    deltas = struct.unpack('>%dh' % seg, t[o + 16 + 4 * seg:o + 16 + 6 * seg])
    ro = o + 16 + 6 * seg
    ranges = struct.unpack('>%dH' % seg, t[ro:ro + 2 * seg])
    for k in range(seg):
        for c in range(starts[k], ends[k] + 1):
            if c == 0xFFFF:
                continue
            if ranges[k]:
                a = ro + 2 * k + ranges[k] + 2 * (c - starts[k])
                g = struct.unpack('>H', t[a:a + 2])[0]
                g = (g + deltas[k]) & 0xFFFF if g else 0
            else:
                g = (c + deltas[k]) & 0xFFFF
            if g:
                mapped.add(c)
    return mapped


def units_per_em(path):
    return struct.unpack('>H', font_tables(path)['head'][18:20])[0]


def load(fname, var, size):
    f = ImageFont.truetype(os.path.join(FONTDIR, fname), size)
    if var:
        try:
            f.set_variation_by_axes(list(var))
        except Exception as e:  # static font
            print('  (no variations:', e, ')')
    return f


def bake(fname, var, size, charset, mapped=None, upm=None):
    """One atlas. mapped: the font's code points; a character outside them is refused instead of
    baking the font's empty .notdef box under its code. upm: units per em; advances are then
    measured at that size, where hinting cannot round them, and scaled down: the font's own widths,
    as the old atlases had them (Pillow 13 / FreeType 2.14 report hinted whole pixels at small sizes)."""
    font = load(fname, var, size)
    ascent, descent = font.getmetrics()
    if mapped is not None:
        missing = ''.join(ch for ch in dict.fromkeys(charset) if ord(ch) not in mapped)
        if missing:
            raise SystemExit('%s has no glyph for %r; take them out of the charset' % (fname, missing))
    big = load(fname, var, upm) if upm else None
    glyphs, imgs = {}, []
    for ch in dict.fromkeys(charset):
        try:
            bbox = font.getbbox(ch, anchor='ls')       # relative to baseline
        except Exception:
            continue
        adv = big.getlength(ch) * size / upm if big else font.getlength(ch)
        w, h = max(0, bbox[2] - bbox[0]), max(0, bbox[3] - bbox[1])
        if w and h:
            im = Image.new('L', (w, h), 0)
            ImageDraw.Draw(im).text((-bbox[0], -bbox[1]), ch, font=font, fill=255, anchor='ls')
        else:
            im = None
        imgs.append((ch, im, bbox, adv))
    # shelf-pack
    W = ATLAS_W
    x = y = rowh = 0
    place = {}
    for ch, im, bbox, adv in imgs:
        if im is None:
            place[ch] = (0, 0, 0, 0)
            continue
        if x + im.width > W:
            x, y, rowh = 0, y + rowh + 1, 0
        place[ch] = (x, y, im.width, im.height)
        x += im.width + 1
        rowh = max(rowh, im.height)
    H = y + rowh + 1
    atlas = Image.new('L', (W, H), 0)
    for ch, im, bbox, adv in imgs:
        px, py, pw, ph = place[ch]
        if im is not None:
            atlas.paste(im, (px, py))
        glyphs[ord(ch)] = [px, py, pw, ph, bbox[0], bbox[1], round(adv, 2)]
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': W, 'atlasH': H,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs}


def cache_key(family, sizes):
    """Content hash: record.js builds the renderer's atlas id from family, size and this key, so a
    re-baked atlas never reuses a texture the running daemon still holds from the old one. Hashes
    the pixels, not the zlib stream (another zlib may compress the same pixels differently)."""
    h = hashlib.sha256(family.encode())
    for s in sizes:
        meta = {k: v for k, v in s.items() if k != 'alpha'}
        h.update(json.dumps(meta, sort_keys=True, separators=(',', ':')).encode())
        h.update(hashlib.sha256(zlib.decompress(base64.b64decode(s['alpha']))).digest())
    return h.hexdigest()[:16]


def fetch(path=None):
    """The font file, checked against SHA256 before anything is baked (and before it is cached)."""
    if path is None:
        path = os.path.join(CACHE, FONT)
        if not os.path.exists(path):
            print('downloading', URL)
            with urllib.request.urlopen(URL, timeout=120) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != SHA256:
                raise SystemExit('Ubuntu Sans download does not match its SHA-256; refusing to use it')
            os.makedirs(CACHE, exist_ok=True)
            with open(path + '.tmp', 'wb') as f:
                f.write(data)
            os.replace(path + '.tmp', path)
    digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if digest != SHA256:
        raise SystemExit('%s: SHA-256 %s, expected %s; refusing to bake a different font' % (path, digest, SHA256))
    return os.path.abspath(path)


def check_budget(atlases):
    """Every atlas set the renderer could be asked for at once must fit its texture."""
    heights = [s['atlasH'] for s in atlases]
    if any(s['atlasW'] > ATLAS_W for s in atlases) or len(atlases) > MAX_ATLASES:
        raise SystemExit('atlas too wide or too many atlases for the renderer')
    # first come first served into the less full column: whatever the order, no column ends up
    # fuller than half of all rows plus half of the tallest atlas
    rows = sum(h + 1 for h in heights)
    worst = rows / 2 + (max(heights) + 1) / 2
    if worst > COLUMN_H:
        raise SystemExit('atlases need up to %d rows of a %d-row texture column' % (worst, COLUMN_H))
    return rows, worst


def main(argv=None):
    global FONTDIR
    ap = argparse.ArgumentParser(description='Bake the Latin/Cyrillic glyph atlases from Ubuntu Sans.')
    ap.add_argument('font', nargs='?', help='UbuntuSans[wdth,wght].ttf (default: download into kit/tools/.font-cache)')
    ap.add_argument('--out', default=OUT, help='folder for the atlases (default: kit/runtime/fonts)')
    ap.add_argument('--check', action='store_true', help='bake into a temporary folder and compare with the committed atlases')
    args = ap.parse_args(argv)
    font = fetch(args.font)
    FONTDIR = os.path.dirname(font)
    mapped, upm = cmap(font), units_per_em(font)
    env = (PIL.__version__, features.version('freetype2'))
    if env != BAKED_WITH:
        print('note: Pillow %s / FreeType %s here; the committed atlases came from Pillow %s / FreeType %s, '
              'so pixels may differ slightly' % (env + BAKED_WITH))
    out = tempfile.mkdtemp(prefix='mgu-fonts-') if args.check else args.out
    os.makedirs(out, exist_ok=True)
    every = []
    try:
        for fam, (fname, var, sizes) in FAMILIES.items():
            baked = [bake(os.path.basename(font) if fname == FONT else fname, var, s, cs, mapped, upm) for s, cs in sizes]
            data = {'family': fam, 'source': SOURCE, 'axes': {'wdth': var[0], 'wght': var[1]},
                    'cacheKey': cache_key(fam, baked), 'sizes': baked}
            p = os.path.join(out, fam + '.json')
            with open(p, 'w', encoding='utf-8', newline='\n') as f:
                f.write(json.dumps(data, separators=(',', ':')) + '\n')
            every += baked
            print('%-5s %s -> %d KiB' % (fam, ', '.join('%d: %dx%d %d glyphs' % (s['size'], s['atlasW'], s['atlasH'], len(s['glyphs'])) for s in baked), os.path.getsize(p) // 1024))
        cjk = os.path.join(OUT, 'cjk.json')
        if os.path.exists(cjk):
            every += json.load(open(cjk, encoding='utf-8'))['sizes']
        rows, worst = check_budget(every)
        print('GPU atlas texture: %d atlases, %d rows of 2 x %d; a column holds at most %d of them' % (len(every), rows, COLUMN_H, worst))
        if args.check:
            changed = [fam for fam in FAMILIES if open(os.path.join(out, fam + '.json'), 'rb').read() != open(os.path.join(OUT, fam + '.json'), 'rb').read()]
            if changed:
                raise SystemExit('baked atlases differ from the committed ones: ' + ', '.join(changed))
            print('committed atlases reproduced byte for byte')
    finally:
        if args.check:
            shutil.rmtree(out, ignore_errors=True)


if __name__ == '__main__':
    main()
