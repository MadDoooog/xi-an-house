/* ============================================================
   Contiguous shadow patches ("连片阴影") — blob level.

   History of this metric, so the next person does not re-walk it:
     1. per-pixel darkness            -> flags roofs, asphalt, water
     2. dark->bright asymmetry        -> wrong quantity (a shadow abuts its
                                         own dark building on the sun side)
     3. per-column dark runs, 25 m    -> measures N-S alleys as well; dense
                                         low-rise and high-rise score alike
     4. dark runs, 60 m               -> separates 7x, but still line-based
     5. THIS: connected dark blobs, qualified by length AND width AND area.
        A tall building casts one wide, long, contiguous patch; the dense
        low-rise old town only produces small fragments (max ~1900 m2 vs
        6200 m2 in the CBD).

   Axis math: u runs along the shadow azimuth (compass), p across it.
   Earlier code reported the PCA angle as a bearing and was 90 deg off.

   node scripts/spike/shadow_patches.mjs --in mosaic.png --mpp 0.494 \
     --az 352 --block 200 --out DIR
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "./png.mjs";
import { boxBlurF, maxFilter } from "./shadow_detect.mjs";

const t0 = performance.now();
const marks = [];
const mark = (l) => marks.push({ l, ms: +(performance.now() - t0).toFixed(1) });

const FONT = {
  0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"], 9: ["111", "101", "111", "001", "111"],
  "-": ["000", "000", "111", "000", "000"], " ": ["000", "000", "000", "000", "000"],
  A: ["111", "101", "111", "101", "101"], B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"], D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "111", "100", "111"],
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
      if (g[gy][gx] === "1") fillRect(buf, W, H, x + gx * s - 1, y0 + gy * s - 1, s + 2, s + 2, [0, 0, 0], 0.5);
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

function morph(mask, w, h, r, dilateFirst) {
  const pass = (src, horizontal) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      let v = dilateFirst ? 0 : 1;
      const a = horizontal ? Math.max(0, x - r) : Math.max(0, y - r);
      const b = horizontal ? Math.min(w - 1, x + r) : Math.min(h - 1, y + r);
      for (let i = a; i <= b; i += 1) {
        const j = horizontal ? y * w + i : i * w + x;
        if (dilateFirst) { if (src[j]) { v = 1; break; } } else if (!src[j]) { v = 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  };
  const a = pass(mask, true);
  const b = pass(a, false);
  return b;
}

/** dark blobs, qualified by length/width/area along the shadow axis */
function patches(mask, w, h, mpp, az, opts, exg, tex) {
  const rad = (az * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const out = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || seen[i]) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    const px = [];
    let minU = Infinity, maxU = -Infinity, minP = Infinity, maxP = -Infinity;
    let minX = w, maxX = 0, minY = h, maxY = 0, sumX = 0, sumY = 0;
    while (stack.length) {
      const cur = stack.pop();
      px.push(cur);
      const x = cur % w, y = (cur / w) | 0;
      sumX += x; sumY += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const u = x * ux + y * uy;
      const p = -x * uy + y * ux;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (p < minP) minP = p; if (p > maxP) maxP = p;
      const push = (j) => { if (!seen[j] && mask[j]) { seen[j] = 1; stack.push(j); } };
      if (x > 0) push(cur - 1);
      if (x < w - 1) push(cur + 1);
      if (y > 0) push(cur - w);
      if (y < h - 1) push(cur + w);
    }
    const areaM2 = px.length * mpp * mpp;
    if (areaM2 < opts.minAreaM2) continue;
    const lengthM = (maxU - minU) * mpp;
    const widthM = (maxP - minP) * mpp;
    const fill = areaM2 / Math.max(1e-6, lengthM * widthM);
    const elong = lengthM / Math.max(1e-6, widthM);
    const sol = solidity(px, w);
    // Compactness 4*pi*A/P^2: a cast shadow has a clean boundary (0.3-0.6);
    // tree canopies and textured/broken ground have long ragged perimeters.
    let perimeter = 0;
    const inSet = new Set(px);
    for (const q of px) {
      const x = q % w, y = (q / w) | 0;
      if (x === 0 || !inSet.has(q - 1)) perimeter += 1;
      if (x === w - 1 || !inSet.has(q + 1)) perimeter += 1;
      if (y === 0 || !inSet.has(q - w)) perimeter += 1;
      if (y === h - 1 || !inSet.has(q + w)) perimeter += 1;
    }
    const compact = perimeter > 0 ? (4 * Math.PI * px.length) / (perimeter * perimeter) : 0;
    // Vegetation rejection: a shadow on pavement is grey/blue; a tree row is
    // strongly green. ExG = 2G - R - B separates them cheaply.
    let exgSum = 0;
    let texSum = 0;
    for (const q of px) { exgSum += exg[q]; texSum += tex[q]; }
    const meanExg = exgSum / px.length;
    const grain = texSum / px.length;
    // A cast shadow is a parallelogram (length/width roughly 1.4-6); a dark
    // park reads as a compact square, which elongation rejects.
    const ok =
      lengthM >= opts.minLenM &&
      widthM >= opts.minWidthM &&
      lengthM <= opts.maxLenM &&
      areaM2 <= opts.maxAreaM2 &&
      meanExg <= opts.maxExg &&
      grain <= opts.maxGrain &&
      sol >= opts.minSolidity &&
      compact >= opts.minCompact &&
      elong >= opts.minElong &&
      elong <= opts.maxElong &&
      fill >= opts.minFill;
    out.push({ solidity: +sol.toFixed(2), compact: +compact.toFixed(2), areaM2: Math.round(areaM2), lengthM: +lengthM.toFixed(1), widthM: +widthM.toFixed(1), elong: +elong.toFixed(2), fill: +fill.toFixed(2), meanExg: Math.round(meanExg), grain: Math.round(grain), cx: Math.round(sumX / px.length), cy: Math.round(sumY / px.length), bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, ok, px });
  }
  return out;
}

/** convex-hull solidity: a shadow is a solid parallelogram, a tree row is ragged */
function solidity(px, w) {
  const pts = px.map((i) => [i % w, (i / w) | 0]);
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const pt of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const pt = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  const hull = lower.concat(upper.slice(1, -1));
  let hullArea = 0;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    hullArea += a[0] * b[1] - b[0] * a[1];
  }
  hullArea = Math.abs(hullArea) / 2;
  return hullArea > 0 ? px.length / hullArea : 0;
}

function main() {
  const args = (() => {
    const o = { in: null, mpp: 0.494, block: 200, out: null, max: 1300, az: null, blurM: 40, bgm: 250, ratio: 0.40, drop: 18, bgmode: "p95", norm: 0, maxgain: 1.6, topblobs: 5, smooth: 2, maxgrain: 999, minsolidity: 0, mincompact: 0, openm: 10, closem: 6, thr: 8, minlen: 0, minwidth: 0, minarea: 5000, minfill: 0.35, maxlen: 1200, maxarea: 400000, minelong: 0, maxelong: 99, maxexg: 999, maxexgpx: 16, overlay: 1 };
    for (let i = 2; i < process.argv.length; i += 1) {
      const k = process.argv[i].replace(/^--/, "");
      if (!(k in o)) throw new Error(`unknown flag --${k}`);
      o[k] = ["in", "out", "bgmode"].includes(k) ? process.argv[i + 1] : Number(process.argv[i + 1]);
      i += 1;
    }
    if (!o.in) throw new Error("--in mosaic.png required");
    return o;
  })();

  const { width: W, height: H, rgba } = decodePng(readFileSync(args.in));
  mark("decode png");
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    lum[i] = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
  }
  const exg = new Int16Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    exg[i] = 2 * rgba[o + 1] - rgba[o] - rgba[o + 2];
  }
  // Reference brightness must come from a window WIDER than the shadow, or the
  // interior of a large contiguous shadow reads as "not locally dark" (that was
  // the miss the user spotted: whole halves of A1/A2/A3 and the middle of B2).
  // ---- two-pass exposure normalisation (single tile, then 3x3 context) ----
  // Pass 1: each 256 px tile gets its own sunlit reference p95.
  // Pass 2: the tile's reference is compared with the median of its 8 neighbours
  //         plus itself; the ratio becomes a gain that pulls dark tiles up and
  //         bright tiles down, so one fixed threshold works across the mosaic.
  const NT = 256;
  const ntx = Math.ceil(W / NT), nty = Math.ceil(H / NT);
  const tileP95 = new Float32Array(ntx * nty);
  for (let ty = 0; ty < nty; ty += 1) {
    for (let tx = 0; tx < ntx; tx += 1) {
      const hist = new Uint32Array(256);
      let total = 0;
      for (let y = ty * NT; y < Math.min(H, ty * NT + NT); y += 1) {
        for (let x = tx * NT; x < Math.min(W, tx * NT + NT); x += 1) { hist[lum[y * W + x]] += 1; total += 1; }
      }
      let acc = 0, v = 255;
      for (let k = 0; k < 256; k += 1) { acc += hist[k]; if (acc >= total * 0.95) { v = k; break; } }
      tileP95[ty * ntx + tx] = v;
    }
  }
  const gains = new Float32Array(ntx * nty).fill(1);
  if (args.norm) {
    for (let ty = 0; ty < nty; ty += 1) {
      for (let tx = 0; tx < ntx; tx += 1) {
        const nb = [];
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const y = ty + dy, x = tx + dx;
            if (y < 0 || x < 0 || y >= nty || x >= ntx) continue;
            nb.push(tileP95[y * ntx + x]);
          }
        }
        nb.sort((a, b) => a - b);
        const ctx = nb[Math.floor(nb.length / 2)];
        const own = Math.max(8, tileP95[ty * ntx + tx]);
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
    console.log(`exposure gains: min=${gs[0].toFixed(2)} median=${gs[Math.floor(gs.length / 2)].toFixed(2)} max=${gs[gs.length - 1].toFixed(2)} (${ntx}x${nty} tiles)`);
  }

  // Background = max over a window wider than the shadow. A mean is dragged
  // down by the shadow's own pixels, which is why the darkest, widest bands
  // stayed undetected; the max fills them with the surrounding sunlit value.
  const bgRadius = Math.max(4, Math.round(args.bgm / 2 / args.mpp));
  const bg = args.bgmode === "mean"
    ? boxBlurF(Float32Array.from(lum), W, H, bgRadius)
    : maxFilter(lum, W, H, bgRadius);
  mark("high-pass");

  const raw = new Uint8Array(W * H);
  // Exclude green pixels at the pixel level: a tree row should not survive as a
  // dark blob at all. Patch-level averaging of ExG was too weak (all patches
  // sat at 10-15) because shadow and greenery merge into one blob.
  // Per-tile Otsu: exposure is constant within one 256 px tile, so thresholding
  // each tile against its own histogram avoids both the mixed-date problem and
  // the "large shadow interior is not darker than its own neighbourhood" issue.
  const tileThr = new Uint8Array(Math.ceil(W / 256) * Math.ceil(H / 256));
  const tw = Math.ceil(W / 256);
  for (let ty = 0; ty < Math.ceil(H / 256); ty += 1) {
    for (let tx = 0; tx < tw; tx += 1) {
      const hist = new Uint32Array(256);
      let total = 0;
      for (let y = ty * 256; y < Math.min(H, ty * 256 + 256); y += 1) {
        for (let x = tx * 256; x < Math.min(W, tx * 256 + 256); x += 1) { hist[lum[y * W + x]] += 1; total += 1; }
      }
      let sum = 0;
      for (let v = 0; v < 256; v += 1) sum += v * hist[v];
      let sumB = 0, wB = 0, best = 0, bestT = 128;
      for (let v = 0; v < 256; v += 1) {
        wB += hist[v];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += v * hist[v];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; bestT = v; }
      }
      tileThr[ty * tw + tx] = bestT;
    }
  }

  // p95 reference: the brightest surfaces in a tile are sunlit roofs. Using a
  // high percentile instead of the mean survives districts that are mostly in
  // shadow (where the mean is dragged down to the shadow level itself).
  const pTile = 256;
  const pw = Math.ceil(W / pTile);
  const pRef = new Uint8Array(pw * Math.ceil(H / pTile));
  for (let ty = 0; ty < Math.ceil(H / pTile); ty += 1) {
    for (let tx = 0; tx < pw; tx += 1) {
      const hist = new Uint32Array(256);
      let total = 0;
      for (let y = ty * pTile; y < Math.min(H, ty * pTile + pTile); y += 1) {
        for (let x = tx * pTile; x < Math.min(W, tx * pTile + pTile); x += 1) { hist[lum[y * W + x]] += 1; total += 1; }
      }
      let acc = 0, v95 = 255;
      for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= total * 0.95) { v95 = v; break; } }
      pRef[ty * pw + tx] = v95;
    }
  }

  let greenDropped = 0;
  let otsuHit = 0;
  let p95Hit = 0;
  for (let i = 0; i < W * H; i += 1) {
    if (args.bgmode === "p95") {
      const x = i % W, y = (i / W) | 0;
      const ref = pRef[Math.floor(y / pTile) * pw + Math.floor(x / pTile)];
      if (!(lum[i] < args.ratio * ref)) continue;
      p95Hit += 1;
    } else if (args.bgmode === "otsu") {
      const x = i % W, y = (i / W) | 0;
      const thr = tileThr[Math.floor(y / 256) * tw + Math.floor(x / 256)];
      if (!(lum[i] < thr - args.drop)) continue;
      otsuHit += 1;
    } else if (!(lum[i] < args.ratio * bg[i] && bg[i] - lum[i] >= args.drop)) continue;
    // Only reject SUNLIT vegetation. Shadowed trees still read green (ExG does
    // not vanish with darkening), so dropping all green pixels deleted whole
    // shadow areas that happen to fall on greenery.
    if (exg[i] > args.maxexgpx && lum[i] > 0.72 * bg[i]) { greenDropped += 1; continue; }
    raw[i] = 1;
  }
  console.log(`p95-dark pixels: ${p95Hit} (${(p95Hit / (W * H) * 100).toFixed(1)}%)`);
  console.log(`otsu-dark pixels: ${otsuHit} (${(otsuHit / (W * H) * 100).toFixed(1)}%)`);
  console.log(`pixels dropped as vegetation: ${greenDropped} (${(greenDropped / (W * H) * 100).toFixed(1)}% of frame)`);
  // Coarse-scale morphology: an opening with radius R deletes anything thinner
  // than 2R, so R = 10 m removes streets/narrow alleys (<20 m) while leaving
  // building shadows (30-100 m wide). A closing then fills pinholes.
  const openPx = Math.max(1, Math.round(args.openm / args.mpp));
  const closePx = Math.max(1, Math.round(args.closem / args.mpp));
  let mask = morph(morph(raw, W, H, closePx, true), W, H, closePx, false);
  mask = morph(morph(mask, W, H, openPx, false), W, H, openPx, true);

  // Smoothing: majority filter removes salt-and-pepper so a shadow does not
  // fragment into speckle (and a tree canopy does not merge into one blob).
  if (args.smooth > 0) {
    const r = args.smooth;
    const sm = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let c = 0, n = 0;
        for (let dy = -r; dy <= r; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -r; dx <= r; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            c += mask[yy * W + xx];
            n += 1;
          }
        }
        sm[y * W + x] = c * 2 > n ? 1 : 0;
      }
    }
    mask = sm;
  }

  // Graininess: mean local range (5x5) inside a blob. A cast shadow on pavement
  // is smooth; a tree canopy or a textured facade is grainy.
  const texR = Math.max(1, Math.round(2.5 / args.mpp));
  const tmax = maxFilter(lum, W, H, texR);
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) inv[i] = 255 - lum[i];
  const tminInv = maxFilter(inv, W, H, texR);
  const tex = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) tex[i] = tmax[i] - (255 - tminInv[i]);
  let maskOn = 0;
  for (let i = 0; i < W * H; i += 1) maskOn += mask[i];
  const boxCov = (x0, y0, x1, y1) => {
    let hit = 0, n = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { hit += mask[y * W + x]; n += 1; }
    return (hit / n * 100);
  };
  console.log(
    `mask coverage ${(maskOn / (W * H) * 100).toFixed(1)}%  |  user-flagged areas: ` +
    `A-right-half ${boxCov(200, 0, 404, 606).toFixed(0)}%  B2-column ${boxCov(550, 404, 660, 808).toFixed(0)}%`,
  );
  mark("dark mask + smoothing + texture");

  // azimuth: given, or the one that yields the most qualifying area
  let az = args.az;
  if (az == null) {
    let bestTot = -1;
    for (let a = 0; a < 360; a += 5) {
      const critA = { minAreaM2: args.minarea, minLenM: args.minlen, maxLenM: args.maxlen, minWidthM: args.minwidth, minFill: args.minfill, maxAreaM2: args.maxarea, minElong: args.minelong, maxElong: args.maxelong, maxExg: args.maxexg, maxGrain: args.maxgrain, minSolidity: args.minsolidity, minCompact: args.mincompact };
      const tot = patches(mask, W, H, args.mpp, a, critA, exg, tex).filter((p) => p.ok).reduce((s, p) => s + p.areaM2, 0);
      if (tot > bestTot) { bestTot = tot; az = a; }
    }
  }
  const crit = { minAreaM2: args.minarea, minLenM: args.minlen, maxLenM: args.maxlen, minWidthM: args.minwidth, minFill: args.minfill, maxAreaM2: args.maxarea, minElong: args.minelong, maxElong: args.maxelong, maxExg: args.maxexg, maxGrain: args.maxgrain, minSolidity: args.minsolidity, minCompact: args.mincompact };
  const all = patches(mask, W, H, args.mpp, az, crit, exg, tex);
  const good = all.filter((p) => p.ok).sort((a, b) => b.areaM2 - a.areaM2);
  mark(`patches (${all.length} blobs)`);

  const blockPx = Math.round(args.block / args.mpp);
  const cols = Math.floor(W / blockPx), rows = Math.floor(H / blockPx);
  const areaGrid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const cntGrid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (const p of good) {
    const bx = Math.min(cols - 1, Math.max(0, Math.floor(p.cx / blockPx)));
    const by = Math.min(rows - 1, Math.max(0, Math.floor(p.cy / blockPx)));
    areaGrid[by][bx] += p.areaM2;
    cntGrid[by][bx] += 1;
  }

  const goodArea = good.reduce((s, p) => s + p.areaM2, 0);
  console.log(`mosaic ${W}x${H} @ ${args.mpp} m/px = ${Math.round(W * args.mpp)} x ${Math.round(H * args.mpp)} m`);
  console.log(`shadow azimuth ${az} deg | blobs ${all.length} | qualified ${good.length} | qualified area ${goodArea} m2 (${(goodArea / (W * H * args.mpp * args.mpp) * 100).toFixed(1)}% of frame)`);
  console.log(`criteria: length>=${args.minlen} m, width>=${args.minwidth} m, area>=${args.minarea} m2, fill>=${args.minfill}`);
  console.log('largest qualified patches:');
  for (const p of good.slice(0, 10)) console.log(`  ${String(p.areaM2).padStart(7)} m2  grain=${String(p.grain).padStart(3)}  comp=${String(p.compact).padStart(5)}  sol=${String(p.solidity).padStart(5)}  exg=${String(p.meanExg).padStart(3)}  fill=${String(p.fill).padStart(4)}  ${p.lengthM}x${p.widthM} m  at (${p.cx},${p.cy})`);
  console.log(`block grid (${args.block} m) — qualified shadow area x100 m2:`);
  for (const r of areaGrid) console.log('  ' + r.map((v) => String(Math.round(v / 100)).padStart(4)).join(''));
  console.log(`block grid — patch count:`);
  for (const r of cntGrid) console.log('  ' + r.map((v) => String(v).padStart(4)).join(''));
  const flagged = cntGrid.flat().filter((v) => v > 0).length;
  console.log(`blocks with >=1 qualified patch: ${flagged}/${cols * rows}`);

  // --- optional: paint the N largest blobs in distinct colours ---
  const top = [...all].sort((a, b) => b.areaM2 - a.areaM2).slice(0, args.topblobs);
  if (args.topblobs > 0) {
    const COLORS = [[255, 60, 60], [70, 150, 255], [90, 220, 120], [255, 190, 40], [200, 100, 255]];
    for (let k = 0; k < top.length; k += 1) {
      const b = top[k];
      const tx0 = Math.floor(b.bbox.x / NT), tx1 = Math.floor((b.bbox.x + b.bbox.w - 1) / NT);
      const ty0 = Math.floor(b.bbox.y / NT), ty1 = Math.floor((b.bbox.y + b.bbox.h - 1) / NT);
      const tilesCovered = [];
      for (let ty = ty0; ty <= ty1; ty += 1) for (let tx = tx0; tx <= tx1; tx += 1) tilesCovered.push(`t${ty}.${tx}`);
      const bx0 = Math.floor(b.bbox.x / blockPx), bx1 = Math.floor((b.bbox.x + b.bbox.w - 1) / blockPx);
      const by0 = Math.floor(b.bbox.y / blockPx), by1 = Math.floor((b.bbox.y + b.bbox.h - 1) / blockPx);
      const blocksCovered = [];
      for (let by = by0; by <= Math.min(rows - 1, by1); by += 1) {
        for (let bx = bx0; bx <= Math.min(cols - 1, bx1); bx += 1) blocksCovered.push(`${"ABCDE"[bx] || "?"}${by + 1}`);
      }
      console.log(
        `blob#${k + 1} ${String(Math.round(b.areaM2)).padStart(7)} m2  ${b.lengthM} x ${b.widthM} m  ` +
        `bbox ${b.bbox.w}x${b.bbox.h}px  tiles: ${tilesCovered.join(' ')}  blocks: ${blocksCovered.join(' ')}`,
      );
    }
  }

  // render
  const f = Math.max(1, Math.ceil(Math.max(W, H) / args.max));
  const small = downscale(rgba, W, H, f);
  const buf = small.rgba, SW = small.w, SH = small.h;
  const goodMask = new Uint8Array(W * H);
  for (const p of good) for (const q of p.px) goodMask[q] = 1;
  const topMask = new Int16Array(W * H).fill(-1);
  if (args.topblobs > 0) {
    for (let k = 0; k < top.length; k += 1) for (const q of top[k].px) topMask[q] = k;
  }
  const COLORS = [[255, 60, 60], [70, 150, 255], [90, 220, 120], [255, 190, 40], [200, 100, 255]];
  for (let y = 0; y < SH; y += 1) for (let x = 0; x < SW; x += 1) {
    const si = (y * f) * W + x * f;
    const o = (y * SW + x) * 4;
    const k = topMask[si];
    if (k >= 0) {
      const c = COLORS[k % COLORS.length];
      buf[o] = Math.round(buf[o] * 0.25 + c[0] * 0.75);
      buf[o + 1] = Math.round(buf[o + 1] * 0.25 + c[1] * 0.75);
      buf[o + 2] = Math.round(buf[o + 2] * 0.25 + c[2] * 0.75);
    } else if (goodMask[si]) {
      buf[o] = Math.round(buf[o] * 0.3 + 255 * 0.7);
      buf[o + 1] = Math.round(buf[o + 1] * 0.3 + 40 * 0.7);
      buf[o + 2] = Math.round(buf[o + 2] * 0.3 + 40 * 0.7);
    }
  }
  if (args.topblobs > 0) {
    for (let k = 0; k < top.length; k += 1) {
      const b = top[k];
      drawText(buf, SW, SH, String(k + 1), Math.round(b.cx / f) - 6, Math.round(b.cy / f) - 10, 6, COLORS[k % COLORS.length]);
    }
  }
  for (let r = 0; r <= rows; r += 1) fillRect(buf, SW, SH, 0, Math.round((r * blockPx) / f), SW, 1, [255, 255, 255], 0.2);
  for (let c = 0; c <= cols; c += 1) fillRect(buf, SW, SH, Math.round((c * blockPx) / f), 0, 1, SH, [255, 255, 255], 0.2);
  const s2 = Math.max(2, Math.round(blockPx / f / 60));
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
    const bx0 = Math.round((c * blockPx) / f), by0 = Math.round((r * blockPx) / f);
    drawText(buf, SW, SH, `${"ABCDE"[c] || "?"}${r + 1}`, bx0 + 6, by0 + 6, s2, [235, 235, 235]);
    drawText(buf, SW, SH, `${Math.round(areaGrid[r][c] / 100)}`, bx0 + 6, by0 + 8 + 5 * s2, s2, [255, 245, 170]);
  }
  if (az != null) {
    const rad = (az * Math.PI) / 180;
    const ax = SW - 80, ay = 55;
    const tipX = ax + Math.sin(rad) * 55, tipY = ay - Math.cos(rad) * 55;
    for (let t = 0; t <= 1; t += 0.004) {
      const x = Math.round(ax + (tipX - ax) * t), y = Math.round(ay + (tipY - ay) * t);
      fillRect(buf, SW, SH, x - 2, y - 2, 5, 5, [0, 0, 0], 0.5);
      fillRect(buf, SW, SH, x - 1, y - 1, 3, 3, [255, 210, 0], 0.95);
    }
  }
  mark("render");

  const outDir = args.out || args.in.replace(/\/[^/]+$/, "");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "patches.png"), encodePng(SW, SH, buf));
  writeFileSync(join(outDir, "patches.json"), JSON.stringify({
    input: args.in, mpp: args.mpp, shadowAzimuthDeg: az, blockM: args.block,
    criteria: { minLenM: args.minlen, minWidthM: args.minwidth, minAreaM2: args.minarea, minFill: args.minfill },
    blobCount: all.length, qualified: good.length, qualifiedAreaM2: goodArea,
    areaGrid, cntGrid,
    largest: good.slice(0, 30).map(({ px, ...rest }) => rest),
  }, null, 2));
  mark("encode");
  console.log(`patches -> ${outDir}/patches.png (${SW}x${SH})`);
  console.log('timings:');
  let prev = 0;
  for (const m of marks) { console.log(`  ${String((m.ms - prev).toFixed(1)).padStart(8)} ms  ${m.l}`); prev = m.ms; }
  console.log(`  ${String(marks[marks.length - 1].ms.toFixed(1)).padStart(8)} ms  TOTAL`);
}

main();
