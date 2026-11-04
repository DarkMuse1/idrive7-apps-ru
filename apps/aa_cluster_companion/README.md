# AA Cluster Companion

Sets how Android Auto's Google Maps looks on the instrument cluster: the map density (150-300 dpi,
presets 180 / 200 / 240) and whether the phone's turn card shows. A change waits for a head-unit
restart, which the app offers.

## Dependency: aa-on-cluster

This app only **controls** the **aa-on-cluster** tool; it does not put the map on the cluster itself.
aa-on-cluster is in the [idrive-apps](https://github.com/robertnisipeanu/idrive-apps) repository
(`native/aa-on-cluster`, [pull request 44](https://github.com/robertnisipeanu/idrive-apps/pull/44))
and must be installed first, version 0.5.0 or newer. The app talks to the tool's control socket
(`/dev/shm/aa-on-cluster/ctl.sock`), which changes the density and turn card as root. Without the tool
the app says what to install (in MGU Tools a demo only with *Demo data* on, see below).

- `main.js` the screen, `ctl.js` the client for the tool's socket (`/dev/shm/aa-on-cluster/ctl.sock`).
- Build and preview as any app: `python3 kit/tools/build.py aa_cluster_companion`.

## MGU Tools

Upstream 0.3.3 (idrive7-apps `origin/main`) on this project's kit. The code is upstream's; every check is
upstream's too (customer directive 2026-11-03: upstream's checks are proven on real cars). The project keeps
only two things, neither of them a check:

- `ui.json` (the last applied Custom density) through `kit/store.js`: written atomically, a corrupt file
  moved aside and logged. An upstream `ui.json` (`{"custom": 220}` / `{"custom": null}`) is read as is.
- The user strings through the kit RU path (`kit/runtime/i18n.js`): a small `{name}`-placeholder helper
  feeds `t()` the lines it builds (`Selected: {set}`, `about {p}% more map`, ...), so Russian fits.

Behaviour is upstream's: `"bar": false` (the renderer routes touch, so where the kit runs the screen the
page's tiles and buttons are pressed and *Settings* is the header's last tab; the HMI's own bar where it
draws the screen). Without aa-on-cluster the screen shows a demo state and says what to install - no demo
setting, no RT-01 gate. *Restart head unit to apply changes* restarts with one press (MGU Tools' second
press within 5 s is gone). Tests: `node tests/diag/aa_cluster_companion.test.js` (a fake control socket, no
car), and the touch screen in `node tests/diag/small_touch.test.js`.

Copyright (C) 2026 mlurker@gmail.com. GPL-3.0-or-later.
