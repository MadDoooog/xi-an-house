#!/usr/bin/env node
/* ============================================================
   Shadow probe — does Amap satellite imagery actually contain
   detectable large shadow patches?

   Zero dependencies: PNG decode/encode via node:zlib, and the
   detector under test is the real extension implementation
   (extension/app/lib/imagery.js, loaded into globalThis).

   Usage:
     node shadow_probe.mjs --lng 108.9647 --lat 34.2186 --radius 400 \
       --zoom 18 --out /tmp/probe/dayanta
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTile, encodePng } from "./png.mjs";
import { detect as detectLocal, shadowEvidence, sunVector } from "./shadow_detect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMAGERY_JS = join(HERE, "../../extension/app/lib/imagery.js");

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const out = {
    lng: 108.9647,
    lat: 34.2186,
    radius: 400,
    zoom: 18,
    out: "/tmp/shadow-probe",
    delay: 250,
    nocache: 0,
    source: "amap",
    crs: "wgs84",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    const val = argv[i + 1];
    if (!(key in out)) throw new Error(`unknown flag --${key}`);
    out[key] = ["out", "source", "crs"].includes(key) ? val : Number(val);
    i += 1;
  }
  return out;
}

/* ---------------- tiles ---------------- */

const SUBDOMAINS = [1, 2, 3, 4];

/** Bing quadkey for slippy coordinates. */
function quadkey(z, x, y) {
  let key = "";
  for (let i = z; i > 0; i -= 1) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if (x & mask) digit += 1;
    if (y & mask) digit += 2;
    key += digit;
  }
  return key;
}

function tileUrl(source, z, x, y) {
  if (source === "bing") {
    return `https://ecn.t${(x + y) % 4}.tiles.virtualearth.net/tiles/a${quadkey(z, x, y)}.jpeg?g=1`;
  }
  const sub = SUBDOMAINS[(x + y) % 4];
  return `https://webst0${sub}.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`;
}

const CACHE_DIR = process.env.XAT_TILE_CACHE || "/home/lvwu/py/xi-an-house/spike_results/.tilecache";

function cachePath(source, z, x, y) {
  return join(CACHE_DIR, `${source}_${z}_${x}_${y}.raw`);
}

async function fetchTile(source, z, x, y, attempt = 0) {
  const cp = cachePath(source, z, x, y);
  if (existsSync(cp)) {
    try {
      return decodeTile(readFileSync(cp));
    } catch {
      /* corrupt cache entry: fall through to network */
    }
  }
  const url = tileUrl(source, z, x, y);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Referer: "https://www.amap.com/",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cp, body);
    return decodeTile(body);
  } catch (err) {
    if (attempt < 2) {
      await sleep(400 * (attempt + 1));
      return fetchTile(source, z, x, y, attempt + 1);
    }
    throw new Error(`tile ${z}/${x}/${y}: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- main ---------------- */

const I = (() => {
  const code = readFileSync(IMAGERY_JS, "utf8");
  // eslint-disable-next-line no-new-func
  new Function(code)();
  return globalThis.XAT_IMAGERY;
})();

function loadArgs() {
  const a = parseArgs(process.argv);
  if (!Number.isFinite(a.lng) || !Number.isFinite(a.lat)) {
    throw new Error("--lng/--lat required (WGS84)");
  }
  mkdirSync(a.out, { recursive: true });
  return a;
}

async function main() {
  const args = loadArgs();
  // Amap tiles are GCJ-02 aligned; Bing is WGS84. --crs says what --lng/--lat are.
  const toWgs84 = ([lng, lat]) => (args.crs === "gcj02" ? I.gcj02ToWgs84(lng, lat) : [lng, lat]);
  const toGcj02 = ([lng, lat]) => (args.crs === "gcj02" ? [lng, lat] : I.wgs84ToGcj02(lng, lat));
  const [glng, glat] = args.source === "bing" ? toWgs84([args.lng, args.lat]) : toGcj02([args.lng, args.lat]);
  const tiles = I.tilesForCircle(glng, glat, args.radius, args.zoom);
  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const cols = Math.max(...xs) - x0 + 1;
  const rows = Math.max(...ys) - y0 + 1;
  const W = cols * 256;
  const H = rows * 256;
  const mosaic = new Uint8Array(W * H * 4);

  console.log(
    `center ${args.source} ${glng.toFixed(6)},${glat.toFixed(6)} z${args.zoom} ` +
      `${cols}x${rows} tiles -> ${W}x${H}px`,
  );

  let fetched = 0;
  for (const t of tiles) {
    let img;
    try {
      img = await fetchTile(args.source, t.z, t.x, t.y);
    } catch (err) {
      console.warn(`skip: ${err.message}`);
      continue;
    }
    fetched += 1;
    const ox = (t.x - x0) * 256;
    const oy = (t.y - y0) * 256;
    for (let y = 0; y < 256; y += 1) {
      const dst = ((oy + y) * W + ox) * 4;
      const src = y * 256 * 4;
      mosaic.set(img.rgba.subarray(src, src + 256 * 4), dst);
    }
    await sleep(args.delay);
  }
  console.log(`fetched ${fetched}/${tiles.length} tiles`);

  const mPerTile = I.metersPerTile(args.zoom, args.lat);
  const mPerPx = mPerTile / 256;
  console.log(`resolution: ${mPerTile.toFixed(1)} m/tile, ${mPerPx.toFixed(3)} m/px`);

  writeFileSync(join(args.out, "mosaic.png"), encodePng(W, H, mosaic));

  // Per-tile brightness spread: proves whether the mosaic is one capture date
  // (global threshold is meaningful) or several (it is not).
  const perTile = [];
  for (const t of tiles) {
    const ox = (t.x - x0) * 256;
    const oy = (t.y - y0) * 256;
    let sum = 0;
    let sq = 0;
    const hist = new Uint32Array(256);
    let count = 0;
    for (let y = 0; y < 256; y += 2) {
      for (let x = 0; x < 256; x += 2) {
        const i = ((oy + y) * W + ox + x) * 4;
        const L = Math.round(0.299 * mosaic[i] + 0.587 * mosaic[i + 1] + 0.114 * mosaic[i + 2]);
        hist[L] += 1;
        sum += L;
        sq += L * L;
        count += 1;
      }
    }
    const mean = sum / count;
    let acc = 0;
    let median = 0;
    for (let L = 0; L < 256; L += 1) {
      acc += hist[L];
      if (acc >= count / 2) {
        median = L;
        break;
      }
    }
    perTile.push({
      z: t.z,
      x: t.x,
      y: t.y,
      meanL: Math.round(mean),
      medianL: median,
      sdL: Math.round(Math.sqrt(Math.max(0, sq / count - mean * mean))),
    });
  }
  const medians = perTile.map((t) => t.medianL).sort((a, b) => a - b);
  const tileMedianSpread = { min: medians[0], max: medians[medians.length - 1] };
  console.log(
    `tile median luminance: ${tileMedianSpread.min}..${tileMedianSpread.max} ` +
      `(${perTile.length} tiles)`,
  );

  // --- detector A: the extension's current global-Otsu implementation ---
  const t0 = Date.now();
  const { features: stock, bandMask } = I.analyzeRgba(mosaic, W, H, { mPerPx });
  const stockMs = Date.now() - t0;

  // Luminance plane, shared by the sun-vector and evidence passes.
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    lum[i] = Math.round(0.299 * mosaic[o] + 0.587 * mosaic[o + 1] + 0.114 * mosaic[o + 2]);
  }

  // --- sun vector by directional contrast (threshold-free) ---
  const t2 = Date.now();
  const sun = sunVector(lum, W, H, mPerPx, { down: 4 });
  const sunMs = Date.now() - t2;
  const ev = shadowEvidence(lum, W, H, sun.azimuthDeg, Math.max(8, Math.round(sun.lengthM / (mPerPx * 4))) * 4);
  console.log('sun    ' + JSON.stringify({ ...sun, evidenceRatio: +ev.ratio.toFixed(4), ms: sunMs }));

  const evOverlay = new Uint8Array(mosaic);
  for (let i = 0; i < W * H; i += 1) {
    if (!ev.ev[i]) continue;
    const o = i * 4;
    const a = Math.min(1, ev.ev[i] / 70);
    evOverlay[o] = Math.round(evOverlay[o] * (1 - a) + 255 * a);
    evOverlay[o + 1] = Math.round(evOverlay[o + 1] * (1 - a) + 0 * a);
    evOverlay[o + 2] = Math.round(evOverlay[o + 2] * (1 - a) + 64 * a);
  }
  writeFileSync(join(args.out, 'sun-evidence.png'), encodePng(W, H, evOverlay));

  // --- detector B: local contrast + sun vector ---
  const t1 = Date.now();
  const local = detectLocal(mosaic, W, H, { mPerPx });
  const localMs = Date.now() - t1;

  const stockSummary = {
    score: Number(stock.score.toFixed(3)),
    patches: stock.patches,
    maxPatchM2: Math.round(stock.maxPatchM2),
    patchAreaRatio: Number(stock.patchAreaRatio.toFixed(4)),
    shadowThr: Math.round(stock.shadowThr),
    medianL: Math.round(stock.medianL),
    roofRatio: Number(stock.roofRatio.toFixed(4)),
    greenRatio: Number(stock.greenRatio.toFixed(4)),
    ms: stockMs,
  };
  console.log('stock  ' + JSON.stringify(stockSummary));
  console.log('local  ' + JSON.stringify(local.features));

  const stockOverlay = new Uint8Array(mosaic);
  for (let i = 0; i < W * H; i += 1) {
    if (!bandMask[i]) continue;
    stockOverlay[i * 4] = 255;
    stockOverlay[i * 4 + 1] = 0;
    stockOverlay[i * 4 + 2] = 0;
  }
  writeFileSync(join(args.out, 'mask-overlay.png'), encodePng(W, H, stockOverlay));

  // Local overlay: shadow patches red, bright-roof reference cyan.
  const localOverlay = new Uint8Array(mosaic);
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    if (local.patchMask[i]) {
      localOverlay[o] = 255;
      localOverlay[o + 1] = 0;
      localOverlay[o + 2] = 0;
    } else if (local.roofMask[i]) {
      localOverlay[o] = Math.round(localOverlay[o] * 0.45 + 0 * 0.55);
      localOverlay[o + 1] = Math.round(localOverlay[o + 1] * 0.45 + 240 * 0.55);
      localOverlay[o + 2] = Math.round(localOverlay[o + 2] * 0.45 + 255 * 0.55);
    }
  }
  writeFileSync(join(args.out, 'local-mask.png'), encodePng(W, H, localOverlay));

  writeFileSync(
    join(args.out, 'report.json'),
    JSON.stringify(
      {
        probe: {
          lng: args.lng,
          lat: args.lat,
          radius: args.radius,
          zoom: args.zoom,
          source: args.source,
          crs: args.crs,
          width: W,
          height: H,
          mPerPx,
          tilesFetched: fetched,
          tilesTotal: tiles.length,
        },
        tileMedianSpread,
        perTile,
        stock: { features: stock, ms: stockMs },
        local: { features: local.features, patches: local.patches, ms: localMs },
        sun: { ...sun, evidenceRatio: ev.ratio, ms: sunMs },
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${args.out}/{mosaic,mask-overlay,local-mask,sun-evidence}.png, report.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
