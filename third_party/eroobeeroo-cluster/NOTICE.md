# Notices

- `kit/` is the MGU App Kit from
  [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (as in
  eroobeeroo/idrive7-apps at 0649fe6), MIT licence: `kit/LICENSE`. Its fonts keep their own licences
  (`kit/runtime/fonts`).
- `cluster_render_client.js` (in `shared/` and each app that draws on the cluster) is the cluster render service's
  Node client from
  [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (`native/cluster-render`),
  MPL-2.0, as its header says.
- The GT3, M and Sport layouts of Cluster Layouts (`layout_gt3.js`, `layout_m.js`, `layout_sport.js`, `bimmer.js`),
  the M and Sport shaders and line icons (`MDASH_FS`, `MTACH_FS`, `SDASH_FS`, `LICON_FS` in `shared/shaders.js`) and
  the tyre readings come from or follow bimmer-lab's Cluster Themes
  ([bimmer-lab/apps](https://github.com/bimmer-lab/apps)), MIT licence: its notice ships with each app in `NOTICE`
  (`shared/NOTICE`).
- Everything else: Copyright (C) 2026 eroobeeroo, PolyForm Noncommercial License 1.0.0 (`LICENSE`): noncommercial
  use only; no selling, no paid installation. Versions published before 10 November 2026: GPL-3.0-or-later, as
  published.

## Barlow, Michroma and Orbitron (the cluster fonts)

The cluster glyph atlases (`shared/font_bold.wad`, `font_light.wad`, `font_wide.wad`, `font_orb.wad`, made by
`tools/bake_font.py`) are drawn from Barlow Semi Condensed and Barlow, Copyright 2017 The Barlow Project Authors
(https://github.com/jpt/barlow), Michroma, Copyright 2011 The Michroma Project Authors
(https://github.com/googlefonts/Michroma-font), and Orbitron, Copyright 2018 The Orbitron Project Authors
(https://github.com/theleagueof/orbitron, Reserved Font Name "Orbitron"), used under the SIL Open Font License 1.1. The licence's full text ships with each app as `NOTICE`
(`shared/NOTICE`).
