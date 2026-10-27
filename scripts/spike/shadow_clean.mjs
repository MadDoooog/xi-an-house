/* ============================================================
   Shadow cleanup in the order the user asked for:

     1. detect shadows normally (dark relative to a 250 m background)
     2. DELETE isolated blobs whose longest side is under 20 m
     3. THEN smooth (majority vote in a 20 m window)

   Writes three images so each stage can be judged:
     1-original.png  raw detections
     2-removed.png   kept (blue) vs to-be-removed (red)
     3-smoothed.png  final result

   node scripts/spike/shadow_clean.mjs --in mosaic.png --mpp 0.494 \
     --az 352 --out DIR [--ratio 0.62] [--smallm 20] [--smoothm 20]
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "./png.mjs";
import { boxBlurF } from "./shadow_detect.mjs";

const FONT = {
  0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"], 9: ["111", "101", "111", "001", "111"],
  A: ["111", "101", "111", "101", "101"], B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"], D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "111", "100", "111"], "-": ["000", "000", "111", "000", "000"],
  " ": ["000", "000", "000", "000", "000"],
};

function fillRect(buf, W, H, x0, y0, w, h, rgb, alpha) {
  const [r, g, b] = rgb;
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x += 1) {
      const o = (y * W + x) * 4;
      buf[o] = Math.round(buf[o] * (1 - alpha) + r * alpha);
      buf[o + 1] = Math.round(buf[o + 1] * (1 - alpha) + g * alpha);
      buf[o + 2] = Math.round(buf[o + 2] * (1 - alpha) + b * alpha);
    }
  }
}

function drawText(buf, W, H, text, x0, y0, s, rgb = [255, 255, 255]) {
  let x = x0;
  for (const ch of text) {
    const g = FONT[ch] || FONT[" "];
    for (let gy = 0; gy < 5; gy += 1) for (let gx = 0; gx < 3; gx += 1) {
      if (g[gy][gx] === "1") fillRect(buf, W, H, x + gx * s - 1, y0 + gy * s - 1, s + 2, s + 2, [0, 0, 0], 0.55);
    }
    x += 4 * s;
  }
  x = x0;
  for (const ch of text) {
    const g = FONT[ch] || FONT[" "];
    for (let gy = 0; gy < 5; gy += 1) for (let gx = 0; gx < 3; gx += 1) {
      if (g[gy][gx] === "1") fillRect(buf, W, H, x + gx * s, y0 + gy * s, s, s, rgb, 0.95);
    }
    x += 4 * s;
  }
}

function downscale(rgba, w, h, f) {
  const w2 = Math.floor(w / f), h2 = Math.floor(h / f);
  const out = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y += 1) for (let x = 0; x < w2; x += 1) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < f; dy += 1) {
      const row = ((y * f + dy) * w + x * f) * 4;
      for (let dx = 0; dx < f; dx += 1) { r += rgba[row + dx * 4]; g += rgba[row + dx * 4 + 1]; b += rgba[row + dx * 4 + 2]; }
    }
    const o = (y * w2 + x) * 4;
    out[o] = r / (f * f); out[o + 1] = g / (f * f); out[o + 2] = b / (f * f); out[o + 3] = 255;
  }
  return { rgba: out, w: w2, h: h2 };
}

/** separable square erode (dilate=false) / dilate (dilate=true) */
function morph(src, w, h, r, dilateIt) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = dilateIt ? 0 : 1;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i += 1) {
        const j = y * w + i;
        if (dilateIt) { if (src[j]) { v = 1; break; } } else if (!src[j]) { v = 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = dilateIt ? 0 : 1;
      for (let i = Math.max(0, y - r); i <= Math.min(h - 1, y + r); i += 1) {
        const j = i * w + x;
        if (dilateIt) { if (tmp[j]) { v = 1; break; } } else if (!tmp[j]) { v = 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** 4-connected components with bboxes; returns labels + stats */
function label(mask, w, h, mpp) {
  const lab = new Int32Array(w * h).fill(-1);
  const stack = [];
  const out = [];
  let next = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = next;
    next += 1;
    stack.length = 0;
    stack.push(i);
    lab[i] = id;
    const px = [];
    let minX = w, maxX = 0, minY = h, maxY = 0;
    let sumX = 0, sumY = 0;
    while (stack.length) {
      const cur = stack.pop();
      px.push(cur);
      const x = cur % w, y = (cur / w) | 0;
      sumX += x; sumY += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const push = (j) => { if (lab[j] === -1 && mask[j]) { lab[j] = id; stack.push(j); } };
      if (x > 0) push(cur - 1);
      if (x < w - 1) push(cur + 1);
      if (y > 0) push(cur - w);
      if (y < h - 1) push(cur + w);
    }
    out.push({
      id, px,
      areaM2: px.length * mpp * mpp,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      cx: Math.round(sumX / px.length), cy: Math.round(sumY / px.length),
    });
  }
  return { lab, comps: out };
}

const T0 = performance.now();
const stages = [];
const tmark = (label) => stages.push([label, performance.now() - T0]);

function main() {
  const args = (() => {
    const o = { in: null, mpp: 0.494, az: 352, out: null, max: 1152, ratio: 0.62, bgm: 250, drop: 18, smallm: 20, gapm: 3, smoothm: 20, bgmode: 'mean', requireisolated: 1, norm: 0, maxgain: 1.6, minshow: 0, openm: 2 };
    for (let i = 2; i < process.argv.length; i += 1) {
      const k = process.argv[i].replace(/^--/, "");
      if (!(k in o)) throw new Error(`unknown flag --${k}`);
      o[k] = ["in", "out", "bgmode"].includes(k) ? process.argv[i + 1] : Number(process.argv[i + 1]);
      i += 1;
    }
    if (!o.in) throw new Error("--in mosaic.png required");
    return o;
  })();

  const tRead = performance.now();
  const { width: W, height: H, rgba } = decodePng(readFileSync(args.in));
  tmark("decode png");
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    lum[i] = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
  }

  // Optional 9-tile exposure normalisation: each 256 px tile is pulled towards
  // the median p95 of its 3x3 neighbourhood, so a dark tile stops reading as
  // "all shadow". This was ON in the version that produced the giant blobs.
  if (args.norm) {
    const NT = 256;
    const ntx = Math.ceil(W / NT), nty = Math.ceil(H / NT);
    const p95 = new Float32Array(ntx * nty);
    for (let ty = 0; ty < nty; ty += 1) {
      for (let tx = 0; tx < ntx; tx += 1) {
        const hist = new Uint32Array(256);
        let total = 0;
        for (let y = ty * NT; y < Math.min(H, ty * NT + NT); y += 1) {
          for (let x = tx * NT; x < Math.min(W, tx * NT + NT); x += 1) { hist[lum[y * W + x]] += 1; total += 1; }
        }
        let acc = 0, v = 255;
        for (let k = 0; k < 256; k += 1) { acc += hist[k]; if (acc >= total * 0.95) { v = k; break; } }
        p95[ty * ntx + tx] = v;
      }
    }
    const gains = new Float32Array(ntx * nty).fill(1);
    for (let ty = 0; ty < nty; ty += 1) {
      for (let tx = 0; tx < ntx; tx += 1) {
        const nb = [];
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const y = ty + dy, x = tx + dx;
          if (y < 0 || x < 0 || y >= nty || x >= ntx) continue;
          nb.push(p95[y * ntx + x]);
        }
        nb.sort((a, b) => a - b);
        const ctx = nb[Math.floor(nb.length / 2)];
        const own = Math.max(8, p95[ty * ntx + tx]);
        gains[ty * ntx + tx] = Math.min(args.maxgain, Math.max(1 / args.maxgain, ctx / own));
      }
    }
    for (let y = 0; y < H; y += 1) {
      const ty = Math.floor(y / NT);
      for (let x = 0; x < W; x += 1) {
        const g = gains[ty * ntx + Math.floor(x / NT)];
        if (g === 1) continue;
        const v = lum[y * W + x] * g;
        lum[y * W + x] = v > 255 ? 255 : v < 0 ? 0 : Math.round(v);
      }
    }
    const gs = Array.from(gains).sort((a, b) => a - b);
    console.log(`exposure gains: min=${gs[0].toFixed(2)} median=${gs[Math.floor(gs.length / 2)].toFixed(2)} max=${gs[gs.length - 1].toFixed(2)}`);
  }
  // Two reference modes:
  //   mean : luminance vs a 250 m box mean  (strict, fragments at low ratios)
  //   p95  : luminance vs the 95th percentile of each 256 px tile (the mode that
  //          produced the "giant connected blobs")
  const rawMask = new Uint8Array(W * H);
  if (args.bgmode === "p95") {
    const NT = 256;
    const ntx = Math.ceil(W / NT), nty = Math.ceil(H / NT);
    const ref = new Float32Array(ntx * nty);
    for (let ty = 0; ty < nty; ty += 1) {
      for (let tx = 0; tx < ntx; tx += 1) {
        const hist = new Uint32Array(256);
        let total = 0;
        for (let y = ty * NT; y < Math.min(H, ty * NT + NT); y += 1) {
          for (let x = tx * NT; x < Math.min(W, tx * NT + NT); x += 1) { hist[lum[y * W + x]] += 1; total += 1; }
        }
        let acc = 0, v = 255;
        for (let k = 0; k < 256; k += 1) { acc += hist[k]; if (acc >= total * 0.95) { v = k; break; } }
        ref[ty * ntx + tx] = v;
      }
    }
    for (let y = 0; y < H; y += 1) {
      const ty = Math.floor(y / NT);
      for (let x = 0; x < W; x += 1) {
        const r = ref[ty * ntx + Math.floor(x / NT)];
        if (lum[y * W + x] < args.ratio * r) rawMask[y * W + x] = 1;
      }
    }
  } else {
    const bg = boxBlurF(Float32Array.from(lum), W, H, Math.round(args.bgm / 2 / args.mpp));
    for (let i = 0; i < W * H; i += 1) {
      if (lum[i] < args.ratio * bg[i] && bg[i] - lum[i] >= args.drop) rawMask[i] = 1;
    }
  }

  tmark("luminance + reference + raw mask");

  // the version that produced the giant blobs ran a 2 m opening on the raw mask
  if (args.openm > 0) {
    const r = Math.max(1, Math.round(args.openm / args.mpp));
    const opened = morph(morph(rawMask, W, H, r, false), W, H, r, true);
    rawMask.set(opened);
  }

  tmark("morphology (open)");

  // stage 1: raw
  const s1 = label(rawMask, W, H, args.mpp);
  tmark("label raw blobs (stage 1)");
  console.log(`stage 1 raw: ${s1.comps.length} blobs, ${(s1.comps.reduce((a, c) => a + c.areaM2, 0) / (W * H * args.mpp * args.mpp) * 100).toFixed(1)}% of frame`);
  const top5 = [...s1.comps].sort((a, b) => b.areaM2 - a.areaM2).slice(0, 6);
  console.log('  largest: ' + top5.map((c) => `${Math.round(c.areaM2)}m2(${Math.round(c.bbox.w * args.mpp)}x${Math.round(c.bbox.h * args.mpp)}m)`).join(' '));

  // stage 2: drop isolated blobs whose longest bbox side < smallm
  const gapPx = Math.round(args.gapm / args.mpp);
  const removed = [];
  const kept = [];
  for (const c of s1.comps) {
    const side = Math.max(c.bbox.w, c.bbox.h) * args.mpp;
    const isolated = !s1.comps.some((o) => o.id !== c.id && !(
      o.bbox.x > c.bbox.x + c.bbox.w + gapPx || o.bbox.x + o.bbox.w + gapPx < c.bbox.x ||
      o.bbox.y > c.bbox.y + c.bbox.h + gapPx || o.bbox.y + o.bbox.h + gapPx < c.bbox.y
    ));
    const hitSmall = side < args.smallm;
    const hit = args.requireisolated ? (hitSmall && isolated) : hitSmall;
    if (hit) removed.push(c); else kept.push(c);
  }
  console.log(`stage 2 remove: ${removed.length} blobs (side<${args.smallm} m and isolated), ${removed.reduce((a, c) => a + c.areaM2, 0).toFixed(0)} m2`);
  console.log(`           keep: ${kept.length} blobs, ${kept.reduce((a, c) => a + c.areaM2, 0).toFixed(0)} m2`);

  tmark("remove small/unconnected (stage 2)");

  const keptMask = new Uint8Array(W * H);
  for (const c of kept) for (const q of c.px) keptMask[q] = 1;

  // stage 3: majority smoothing in a 20 m window
  const r = Math.max(1, Math.round(args.smoothm / 2 / args.mpp));
  const smMask = new Uint8Array(W * H);
  // separable majority approximation: horizontal then vertical mean
  const hCount = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) {
    let acc = 0;
    for (let x = -r; x <= r; x += 1) acc += keptMask[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x += 1) {
      hCount[y * W + x] = acc;
      acc += keptMask[y * W + Math.min(W - 1, x + r + 1)] - keptMask[y * W + Math.max(0, x - r)];
    }
  }
  const vCount = new Float32Array(W * H);
  for (let x = 0; x < W; x += 1) {
    let acc = 0;
    for (let y = -r; y <= r; y += 1) acc += hCount[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y += 1) {
      vCount[y * W + x] = acc;
      acc += hCount[Math.min(H - 1, y + r + 1) * W + x] - hCount[Math.max(0, y - r) * W + x];
    }
  }
  const win = (2 * r + 1) * (2 * r + 1);
  for (let i = 0; i < W * H; i += 1) if (vCount[i] * 2 > win) smMask[i] = 1;

  tmark("smoothing (stage 3)");
  const s3 = label(smMask, W, H, args.mpp);
  tmark("label smoothed blobs");
  const big = s3.comps.filter((c) => c.areaM2 >= 1000).sort((a, b) => b.areaM2 - a.areaM2);
  let covN = 0;
  for (let i = 0; i < W * H; i += 1) covN += smMask[i];
  const cov = (covN / (W * H)) * 100;
  console.log(`stage 3 smoothed: ${s3.comps.length} blobs, coverage ${cov.toFixed(1)}%, >=1000 m2: ${big.length}`);

  // ---- render three images ----
  const f = Math.max(1, Math.ceil(Math.max(W, H) / args.max));
  const base = downscale(rgba, W, H, f);
  const SW = base.w, SH = base.h;

  const paint = (src, target, rgb, alpha, maskPx) => {
    for (let y = 0; y < SH; y += 1) for (let x = 0; x < SW; x += 1) {
      const si = (y * f) * W + x * f;
      if (maskPx[si]) {
        const o = (y * SW + x) * 4;
        const [r2, g2, b2] = rgb;
        target[o] = Math.round(target[o] * (1 - alpha) + r2 * alpha);
        target[o + 1] = Math.round(target[o + 1] * (1 - alpha) + g2 * alpha);
        target[o + 2] = Math.round(target[o + 2] * (1 - alpha) + b2 * alpha);
      }
    }
  };

  const showMask = (comps, minArea) => {
    const m = new Uint8Array(W * H);
    for (const c of comps) if (c.areaM2 >= minArea) for (const q of c.px) m[q] = 1;
    return m;
  };

  // 1-original
  const img1 = new Uint8Array(base.rgba);
  paint(null, img1, [80, 170, 255], 0.62, showMask(s1.comps, args.minshow));
  // 2-removed: kept in blue, removed in red
  const img2 = new Uint8Array(base.rgba);
  paint(null, img2, [80, 170, 255], 0.62, showMask(kept, args.minshow));
  const remMask = new Uint8Array(W * H);
  for (const c of removed) for (const q of c.px) remMask[q] = 1;
  paint(null, img2, [255, 50, 50], 0.85, remMask);
  // 3-smoothed: final blobs, distinct colours
  const img3 = new Uint8Array(base.rgba);
  const COLORS = [[255, 70, 70], [70, 150, 255], [90, 220, 120], [255, 190, 40], [200, 100, 255], [60, 230, 230]];
  const pad = r;
  for (let k = 0; k < Math.min(big.length, 24); k += 1) {
    const c = big[k];
    paint(null, img3, COLORS[k % COLORS.length], 0.7, (() => {
      const m = new Uint8Array(W * H);
      for (const q of c.px) m[q] = 1;
      return m;
    })());
    drawText(img3, SW, SH, String(k + 1), Math.round(c.cx / f) - 5, Math.round(c.cy / f) - 8, 4, COLORS[k % COLORS.length]);
  }

  tmark("render + encode");
  const outDir = args.out || args.in.replace(/\/[^/]+$/, "");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "1-original.png"), encodePng(SW, SH, img1));
  writeFileSync(join(outDir, "2-removed.png"), encodePng(SW, SH, img2));
  writeFileSync(join(outDir, "3-smoothed.png"), encodePng(SW, SH, img3));
  console.log(`wrote ${outDir}/{1-original,2-removed,3-smoothed}.png (${SW}x${SH})`);
  console.log("timings:");
  let prev = 0;
  for (const [k, v] of stages) { console.log(`  ${(v - prev).toFixed(1).padStart(8)} ms  ${k}`); prev = v; }
  const km2 = (W * args.mpp * H * args.mpp) / 1e6;
  console.log(`  ${prev.toFixed(1).padStart(8)} ms  TOTAL  (${km2.toFixed(2)} km2, ${(prev / km2).toFixed(0)} ms/km2)`);
}

main();
