# Tests for `extension/app`

Two levels. Both load the **real** source in `../app` — nothing is mocked except the browser/DB layer.

## 1. Unit: background / storage / import (`unit-background.mjs`)

Runs the real `background.js` inside a `node:vm` sandbox with
[fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) and a tiny `chrome.*` stub.
`importScripts` is stubbed so `lib/imagery.js` still loads for real.

```bash
npm install          # fake-indexeddb
node unit-background.mjs
```

Covers:

- DB v1 → v2 → v3 migration: only the legacy sample rows (`c1..c12` / `d1..d3`) are deleted, user rows survive
- `data.import`: GeoJSON / plugin export / bare array, name + 200 m dedupe, area-weighted polygon centroid
- `community.put` / `community.del`, source merging on edit
- `settings.set` patch merge, `data.reset`, error message for unrecognised imports

Expected: `===== 13/13 通过 =====`

## 2. End-to-end: real Amap page (`e2e-amap.mjs`)

Launches Chromium with `--load-extension=../app`, opens `https://www.amap.com/`, and drives the injected UI.

```bash
npm install          # playwright
# optional: point at a Chrome for Testing binary instead of Playwright's chromium
XAT_CHROME=/path/to/chrome-linux64/chrome node e2e-amap.mjs
```

Expected: `===== 39/39 通过 =====` (~6–8 min; it fetches real satellite tiles).

Checks: clean default state, GeoJSON import, collapsed drawer + insets (72/24 px, persisted),
right-click menu item injected into Amap's own `ul.context_menu` + clipboard content in WGS84,
destination paste-to-locate, community create/edit, satellite crop + metrics + verdict buttons,
big-circle scan, adopt-as-community, persistence across a browser restart, no extension-side JS errors.

Notes for CI / other machines:

- Network must reach `www.amap.com` and `webst0X.is.autonavi.com`.
- When not logged into Amap, a login modal or a `baxia-dialog` can intercept clicks; the script removes
  those overlays before acting. That is test scaffolding only — the product does not do this.
- Screenshots land in `./out/`.
- If Playwright's Chromium download is blocked, grab Chrome for Testing from the npmmirror mirror
  (`https://cdn.npmmirror.com/binaries/playwright/builds/cft/<version>/linux64/chrome-linux64.zip`)
  and pass `XAT_CHROME`.
