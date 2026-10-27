/* ============================================================
   Shadow detection, v2 — local contrast + sun-vector estimation.

   Why not the global-Otsu approach in extension/lib/imagery.js:
   Amap mosaics mix tiles captured on different dates, so a single
   brightness threshold splits the image into "old dark imagery"
   and "new bright imagery" rather than shadow / no-shadow.

   Here:
     1. background  = max-filtered luminance (what sunlit ground
        looks like within ~12 m)
     2. shadow      = luminance well below that background, i.e.
        a *local* contrast test, which is invariant to the tile's
        overall brightness/saturation
     3. opening     = drop thin dark things (kerbs, wires, tree edges)
     4. components  = patches with area/fill/orientation
     5. sun vector  = shift-correlate shadow mask against bright-roof
        mask; the offset that maximises overlap is the direction the
        sun casts toward, and gives shadow length.

   Outputs are diagnostic; nothing here is wired into the extension yet.
   ============================================================ */

const DEFAULTS = {
  bgRadiusPx: 20, // ~10 m at 0.5 m/px
  shadowRatio: 0.55, // pixel must be <= 55% of local sunlit reference
  shadowAbsDrop: 26, // ...and at least this many levels darker (0-255)
  minLum: 12, // ignore near-black (TIFF/nodata, deep water)
  openRadiusPx: 5, // ~2.5 m: narrower dark things get erased
  minPatchAreaM2: 300,
  maxPatchAreaM2: 30000,
  minFill: 0.45,
  greenExg: 16,
  roofRatio: 0.86, // bright-roof mask: >= 86% of local reference
};

function buildLum(rgba, w, h) {
  const n = w * h;
  const lum = new Uint8Array(n);
  const green = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    lum[i] = Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b));
    if (2 * g - r - b > DEFAULTS.greenExg && lum[i] > 30) green[i] = 1;
  }
  return { lum, green };
}

/** Separable sliding-window max, O(n) per axis via monotonic deque. */
function maxFilter(src, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const dq = new Int32Array(Math.max(w, h));
  for (let y = 0; y < h; y += 1) {
    let head = 0;
    let tail = 0;
    const row = y * w;
    for (let x = 0; x < w + r; x += 1) {
      if (x < w) {
        while (tail > head && src[row + dq[tail - 1]] <= src[row + x]) tail -= 1;
        dq[tail++] = x;
      }
      const left = x - r;
      if (left >= 0) {
        while (tail > head && dq[head] < left - r) head += 1;
        tmp[row + left] = src[row + dq[head]];
      }
    }
  }
  for (let x = 0; x < w; x += 1) {
    let head = 0;
    let tail = 0;
    for (let y = 0; y < h + r; y += 1) {
      if (y < h) {
        while (tail > head && tmp[dq[tail - 1] * w + x] <= tmp[y * w + x]) tail -= 1;
        dq[tail++] = y;
      }
      const top = y - r;
      if (top >= 0) {
        while (tail > head && dq[head] < top - r) head += 1;
        out[top * w + x] = tmp[dq[head] * w + x];
      }
    }
  }
  return out;
}

/** Separable square erosion then dilation (morphological opening). */
function erodeSquare(mask, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let ok = 1;
      const from = Math.max(0, x - r);
      const to = Math.min(w - 1, x + r);
      for (let xx = from; xx <= to; xx += 1) {
        if (!mask[y * w + xx]) {
          ok = 0;
          break;
        }
      }
      tmp[y * w + x] = ok;
    }
  }
  for (let y = 0; y < h; y += 1) {
    const from = Math.max(0, y - r);
    const to = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x += 1) {
      let ok = 1;
      for (let yy = from; yy <= to; yy += 1) {
        if (!tmp[yy * w + x]) {
          ok = 0;
          break;
        }
      }
      out[y * w + x] = ok;
    }
  }
  return out;
}

function dilateSquare(mask, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      const from = Math.max(0, x - r);
      const to = Math.min(w - 1, x + r);
      for (let xx = from; xx <= to; xx += 1) {
        if (mask[y * w + xx]) {
          v = 1;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y += 1) {
    const from = Math.max(0, y - r);
    const to = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let yy = from; yy <= to; yy += 1) {
        if (tmp[yy * w + x]) {
          v = 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Estimate the sun-cast direction by sliding the bright-roof mask over the
 * shadow mask: the offset with most shadow pixels "downhill" of a bright roof
 * is the direction shadows point.
 */
function estimateSunVector(shadowMask, roofMask, w, h, mPerPx) {
  const radiiPx = [16, 24, 32, 44, 60, 80, 104];
  const shadowPts = [];
  for (let i = 0; i < w * h; i += 1) if (shadowMask[i]) shadowPts.push(i);
  if (shadowPts.length < 500) return null;

  const step = Math.max(1, Math.floor(shadowPts.length / 60000));
  const sample = [];
  for (let k = 0; k < shadowPts.length; k += step) sample.push(shadowPts[k]);

  let best = null;
  const scored = [];
  for (const r of radiiPx) {
    for (let a = 0; a < 360; a += 10) {
      const rad = (a * Math.PI) / 180;
      const dx = Math.round(Math.sin(rad) * r);
      const dy = Math.round(-Math.cos(rad) * r);
      let hits = 0;
      for (let k = 0; k < sample.length; k += 1) {
        const p = sample[k];
        const x = (p % w) + dx;
        const y = ((p / w) | 0) + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (roofMask[y * w + x]) hits += 1;
      }
      const frac = hits / sample.length;
      scored.push({ azimuthDeg: a, radiusPx: r, frac });
      if (!best || frac > best.frac) best = { azimuthDeg: a, radiusPx: r, frac };
    }
  }

  const fr = scored.map((s) => s.frac).sort((a, b) => a - b);
  const p50 = fr[Math.floor(fr.length * 0.5)];
  const p95 = fr[Math.floor(fr.length * 0.95)];
  return {
    azimuthDeg: best.azimuthDeg,
    lengthPx: best.radiusPx,
    lengthM: +(best.radiusPx * mPerPx).toFixed(1),
    frac: +best.frac.toFixed(3),
    backgroundP50: +p50.toFixed(3),
    // separation of the peak from the field: <1.5 means "no clear direction"
    peakRatio: +(best.frac / Math.max(p50, 1e-6)).toFixed(2),
    p95: +p95.toFixed(3),
  };
}

function traceComponents(mask, w, h, originIndex, out) {
  const stack = [originIndex];
  const visited = out.visited;
  const px = [];
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  while (stack.length) {
    const cur = stack.pop();
    if (visited[cur]) continue;
    visited[cur] = 1;
    px.push(cur);
    const x = cur % w;
    const y = (cur / w) | 0;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x > 0 && mask[cur - 1]) stack.push(cur - 1);
    if (x < w - 1 && mask[cur + 1]) stack.push(cur + 1);
    if (y > 0 && mask[cur - w]) stack.push(cur - w);
    if (y < h - 1 && mask[cur + w]) stack.push(cur + w);
  }
  return { px, minX, maxX, minY, maxY, sumX, sumY, sumXX, sumYY, sumXY };
}

function principalAngle(c) {
  const n = c.px.length;
  const mx = c.sumX / n;
  const my = c.sumY / n;
  const cxx = c.sumXX / n - mx * mx;
  const cyy = c.sumYY / n - my * my;
  const cxy = c.sumXY / n - mx * my;
  // eigenvector of the largest eigenvalue of [[cxx,cxy],[cxy,cyy]]
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const l1 = (cxx + cyy) / 2 + Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy ** 2);
  const l2 = (cxx + cyy) / 2 - Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy ** 2);
  const elongation = l2 > 0.01 ? Math.sqrt(l1 / l2) : 20;
  return { majorAxisDeg: ((theta * 180) / Math.PI + 180) % 180, elongation };
}

/**
 * @param {Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @param {object} opts  mPerPx required
 */
function detect(rgba, w, h, opts) {
  const P = Object.assign({}, DEFAULTS, opts || {});
  const mPerPx = Number(P.mPerPx) > 0 ? Number(P.mPerPx) : 0.5;
  const n = w * h;
  const { lum, green } = buildLum(rgba, w, h);
  const bg = maxFilter(lum, w, h, P.bgRadiusPx);

  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (green[i]) continue;
    if (lum[i] < P.minLum) continue;
    if (lum[i] <= bg[i] * P.shadowRatio && bg[i] - lum[i] >= P.shadowAbsDrop) raw[i] = 1;
  }

  const opened = P.openRadiusPx > 0
    ? dilateSquare(erodeSquare(raw, w, h, P.openRadiusPx), w, h, P.openRadiusPx)
    : raw;

  const roofMask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (green[i]) continue;
    if (lum[i] >= bg[i] * P.roofRatio && !raw[i]) roofMask[i] = 1;
  }

  const visited = new Uint8Array(n);
  const patchMask = new Uint8Array(n);
  const patches = [];
  for (let i = 0; i < n; i += 1) {
    if (!opened[i] || visited[i]) continue;
    const c = traceComponents(opened, w, h, i, { visited });
    const areaM2 = c.px.length * mPerPx * mPerPx;
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const fill = c.px.length / (bw * bh);
    if (areaM2 < P.minPatchAreaM2 || areaM2 > P.maxPatchAreaM2 || fill < P.minFill) continue;
    const { majorAxisDeg, elongation } = principalAngle(c);
    let sumL = 0;
    for (const p of c.px) sumL += lum[p];
    patches.push({
      areaM2: Math.round(areaM2),
      cx: c.sumX / c.px.length,
      cy: c.sumY / c.px.length,
      lngLatHint: null,
      fill: +fill.toFixed(2),
      elongation: +elongation.toFixed(2),
      majorAxisDeg: Math.round(majorAxisDeg),
      meanLum: Math.round(sumL / c.px.length),
      bgLum: Math.round(bg[c.px[0]]),
      bbox: { x: c.minX, y: c.minY, w: bw, h: bh },
    });
    for (const p of c.px) patchMask[p] = 1;
  }

  patches.sort((a, b) => b.areaM2 - a.areaM2);
  const sun = estimateSunVector(raw, roofMask, w, h, mPerPx);

  // Orientation agreement: how many big patches' long axis is within 20 deg of
  // the sun azimuth (a shadow band points along the sun ray).
  let aligned = 0;
  let considered = 0;
  if (sun) {
    for (const p of patches) {
      if (p.elongation < 1.6) continue;
      considered += 1;
      const raw = (p.majorAxisDeg - sun.azimuthDeg + 90) % 180;
      const diff = Math.abs(((raw + 180) % 180) - 90);
      if (diff <= 20) aligned += 1;
    }
  }

  const totalArea = patches.reduce((a, p) => a + p.areaM2, 0);
  return {
    features: {
      mPerPx,
      rawRatio: +((raw.reduce((a, v) => a + v, 0) / n) || 0).toFixed(4),
      openedRatio: +((opened.reduce((a, v) => a + v, 0) / n) || 0).toFixed(4),
      patches: patches.length,
      totalPatchM2: totalArea,
      maxPatchM2: patches.length ? patches[0].areaM2 : 0,
      sun,
      orientAligned: aligned,
      orientConsidered: considered,
    },
    patches: patches.slice(0, 25),
    patchMask,
    roofMask,
  };
}

export { detect, DEFAULTS as DETECT_DEFAULTS };

/* ============================================================
   Sun vector by directional contrast.

   Roads and roofs are (statistically) symmetric: a dark strip next
   to a bright strip looks the same from both sides. A cast shadow is
   asymmetric — dark at x, sunlit at x+v, and almost never the mirror.
   So summing max(0, L(x+v) - L(x)) over the image peaks at the sun
   azimuth. This needs no threshold on absolute brightness, which is
   what makes it survive the mixed-exposure mosaics.
   ============================================================ */

function boxDownsample(lum, w, h, f) {
  const wd = Math.floor(w / f);
  const hd = Math.floor(h / f);
  const out = new Float32Array(wd * hd);
  for (let y = 0; y < hd; y += 1) {
    for (let x = 0; x < wd; x += 1) {
      let s = 0;
      for (let dy = 0; dy < f; dy += 1) {
        const row = (y * f + dy) * w + x * f;
        for (let dx = 0; dx < f; dx += 1) s += lum[row + dx];
      }
      out[y * wd + x] = s / (f * f);
    }
  }
  return { lum: out, w: wd, h: hd };
}

/**
 * @param {Float32Array|Uint8Array} lum
 * @param {number} w
 * @param {number} h
 * @param {number} mPerPx
 * @returns {{azimuthDeg:number,lengthM:number,peak:number,
 *            sharpness:number,samples:number,lengthsM:number[]}}
 */
function sunVector(lum, w, h, mPerPx, opts = {}) {
  const down = opts.down || 4;
  const minDrop = opts.minDrop == null ? 12 : opts.minDrop;
  const { lum: d, w: wd, h: hd } = boxDownsample(lum, w, h, down);
  const mPerDownPx = mPerPx * down;
  const lengthsPx = [4, 6, 9, 13, 18, 26, 36, 50];
  const azimuths = [];
  for (let a = 0; a < 360; a += 10) azimuths.push(a);

  let best = null;
  const all = [];
  for (const len of lengthsPx) {
    for (const a of azimuths) {
      const rad = (a * Math.PI) / 180;
      const dx = Math.round(Math.sin(rad) * len);
      const dy = Math.round(-Math.cos(rad) * len);
      if (dx === 0 && dy === 0) continue;
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(wd, wd - dx);
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(hd, hd - dy);
      let sum = 0;
      let hits = 0;
      for (let y = y0; y < y1; y += 1) {
        const rowA = y * wd;
        const rowB = (y + dy) * wd;
        for (let x = x0; x < x1; x += 1) {
          const drop = d[rowB + x + dx] - d[rowA + x];
          if (drop > minDrop) {
            sum += drop;
            hits += 1;
          }
        }
      }
      const norm = sum / ((x1 - x0) * (y1 - y0));
      all.push({ azimuthDeg: a, lengthPx: len, lengthM: len * mPerDownPx, norm });
      if (!best || norm > best.norm) {
        best = { azimuthDeg: a, lengthPx: len, lengthM: len * mPerDownPx, norm };
      }
    }
  }

  const norms = all.map((s) => s.norm).sort((a, b) => a - b);
  const p50 = norms[Math.floor(norms.length * 0.5)];
  const p99 = norms[Math.floor(norms.length * 0.99)];
  // Circular mean of the top 5% directions: robust against a single lucky bin.
  const top = all.filter((s) => s.norm >= p99);
  let sx = 0;
  let sy = 0;
  for (const t of top) {
    const rad = (t.azimuthDeg * Math.PI) / 180;
    sx += Math.sin(rad) * t.norm;
    sy += Math.cos(rad) * t.norm;
  }
  const meanAz = ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
  return {
    azimuthDeg: Math.round(best.azimuthDeg),
    meanTopAzimuthDeg: Math.round(meanAz),
    lengthM: +best.lengthM.toFixed(1),
    peakNorm: +best.norm.toFixed(2),
    p50Norm: +p50.toFixed(2),
    sharpness: +(best.norm / Math.max(p50, 1e-6)).toFixed(2),
    bins: all.length,
  };
}

/** Shadow evidence at a given sun vector (x dark, x+v bright). */
function shadowEvidence(lum, w, h, azimuthDeg, lengthPx, minDrop = 14) {
  const rad = (azimuthDeg * Math.PI) / 180;
  const dx = Math.round(Math.sin(rad) * lengthPx);
  const dy = Math.round(-Math.cos(rad) * lengthPx);
  const ev = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let x = 0; x < w; x += 1) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const drop = lum[yy * w + xx] - lum[y * w + x];
      if (drop > minDrop) {
        ev[y * w + x] = Math.min(255, drop);
        count += 1;
      }
    }
  }
  return { ev, ratio: count / (w * h) };
}

export { sunVector, shadowEvidence, boxDownsample };

/* ============================================================
   High-pass front end.

   The earlier attempt fed raw luminance into the directional test, so
   scene-wide illumination gradients (bright construction site next to
   dark ground, tile seams) dominated and the "sun vector" followed the
   gradient instead of the shadows. Removing a ~40 m low-frequency
   background keeps sharp-edged cast shadows and kills the gradients.
   ============================================================ */

function boxBlurF(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x += 1) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = acc / win;
      const add = Math.min(w - 1, x + r + 1);
      const sub = Math.max(0, x - r);
      acc += src[row + add] - src[row + sub];
    }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    for (let y = -r; y <= r; y += 1) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = acc / win;
      const add = Math.min(h - 1, y + r + 1);
      const sub = Math.max(0, y - r);
      acc += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

/** sub = lum - blur(lum, r) : bright positives are sunlit, negatives are shaded */
function highPass(lum, w, h, r) {
  const bg = boxBlurF(Float32Array.from(lum), w, h, r);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) out[i] = lum[i] - bg[i];
  return out;
}

/**
 * Sun vector on high-passed luminance. Returns the direction (toward the sun,
 * i.e. shadow → building) and its 180° opposite so callers can pick.
 */
function sunVectorHighPass(hp, w, h, mPerPx, opts = {}) {
  const down = opts.down || 4;
  const minDrop = opts.minDrop == null ? 10 : opts.minDrop;
  const wd = Math.floor(w / down);
  const hd = Math.floor(h / down);
  const d = new Float32Array(wd * hd);
  for (let y = 0; y < hd; y += 1) {
    for (let x = 0; x < wd; x += 1) {
      let s = 0;
      for (let dy = 0; dy < down; dy += 1) {
        const row = (y * down + dy) * w + x * down;
        for (let dx = 0; dx < down; dx += 1) s += hp[row + dx];
      }
      d[y * wd + x] = s / (down * down);
    }
  }
  const mPerDownPx = mPerPx * down;
  const lengthsPx = [2, 3, 4, 6, 8, 11, 15, 20, 27, 36];
  const bins = [];
  for (const len of lengthsPx) {
    for (let a = 0; a < 360; a += 10) {
      const rad = (a * Math.PI) / 180;
      const dx = Math.round(Math.sin(rad) * len);
      const dy = Math.round(-Math.cos(rad) * len);
      if (!dx && !dy) continue;
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(wd, wd - dx);
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(hd, hd - dy);
      let sum = 0;
      let hits = 0;
      const total = (x1 - x0) * (y1 - y0);
      for (let y = y0; y < y1; y += 1) {
        const rowA = y * wd;
        const rowB = (y + dy) * wd;
        for (let x = x0; x < x1; x += 1) {
          const drop = d[rowB + x + dx] - d[rowA + x];
          if (drop > minDrop) {
            sum += drop;
            hits += 1;
          }
        }
      }
      bins.push({ azimuthDeg: a, lengthPx: len, lengthM: len * mPerDownPx, score: sum / total, frac: hits / Math.max(1, total) });
    }
  }
  bins.sort((a, b) => b.score - a.score);
  const best = bins[0];
  // Sharpness against the opposite direction and against the field median.
  const opp = bins.find((b) => b.azimuthDeg === (best.azimuthDeg + 180) % 360 && b.lengthPx === best.lengthPx);
  const scores = bins.map((b) => b.score).sort((a, b) => a - b);
  const p50 = scores[Math.floor(scores.length * 0.5)];
  const azimuthDeg = Math.round(best.azimuthDeg);
  return {
    azimuthDeg, // toward the sun
    shadowAzimuthDeg: (azimuthDeg + 180) % 360,
    lengthM: +best.lengthM.toFixed(1),
    lengthPx: best.lengthPx,
    score: +best.score.toFixed(2),
    oppositeScore: opp ? +opp.score.toFixed(2) : null,
    asymmetry: opp ? +(best.score / Math.max(opp.score, 1e-6)).toFixed(2) : null,
    sharpness: +(best.score / Math.max(p50, 1e-6)).toFixed(2),
    top5: bins.slice(0, 5).map((b) => ({ az: b.azimuthDeg, lenM: Math.round(b.lengthM), s: +b.score.toFixed(2) })),
  };
}

/**
 * Connected shadow components from a high-pass evidence map, with the extent
 * along the shadow direction (that extent ≈ shadow length ⇒ building height).
 */
function shadowComponents(ev, w, h, mPerPx, shadowAzimuthDeg, opts = {}) {
  const minAreaM2 = opts.minAreaM2 || 120;
  const thr = opts.evidenceThr || 0.5;
  const maxEv = opts.maxEv || 255;
  const rad = (shadowAzimuthDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const visited = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let i = 0; i < w * h; i += 1) {
    if (visited[i] || ev[i] < thr * maxEv) continue;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    let n = 0;
    let minU = Infinity;
    let maxU = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    let sumEv = 0;
    while (stack.length) {
      const cur = stack.pop();
      n += 1;
      const x = cur % w;
      const y = (cur / w) | 0;
      sumX += x;
      sumY += y;
      sumEv += ev[cur];
      const u = x * ux + y * uy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const push = (j) => {
        if (!visited[j] && ev[j] >= thr * maxEv) {
          visited[j] = 1;
          stack.push(j);
        }
      };
      if (x > 0) push(cur - 1);
      if (x < w - 1) push(cur + 1);
      if (y > 0) push(cur - w);
      if (y < h - 1) push(cur + w);
    }
    const areaM2 = n * mPerPx * mPerPx;
    if (areaM2 < minAreaM2) continue;
    out.push({
      areaM2: Math.round(areaM2),
      shadowLengthM: +((maxU - minU) * mPerPx).toFixed(1),
      cx: Math.round(sumX / n),
      cy: Math.round(sumY / n),
      meanEv: +(sumEv / n).toFixed(1),
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    });
  }
  out.sort((a, b) => b.shadowLengthM - a.shadowLengthM);
  return out;
}

export { maxFilter, boxBlurF, highPass, sunVectorHighPass, shadowComponents };

/* ============================================================
   Shadow mask with two discriminators on top of local contrast:

     1. ratio to the local sunlit reference, where the reference is a
        max filter wide enough to span a shadow (≈30 m)
     2. sunward-edge test: a cast shadow must border sunlit ground on
        the side the sun is on. Railways, pitches, water, dark roofs
        do not.

   ============================================================ */

function shadowMaskClosing(lum, w, h, mPerPx, opts = {}) {
  const refM = opts.refM == null ? 30 : opts.refM;
  const ratio = opts.ratio == null ? 0.5 : opts.ratio;
  const minDrop = opts.minDrop == null ? 26 : opts.minDrop;
  const openM = opts.openM == null ? 3 : opts.openM;
  const r = Math.max(2, Math.round(refM / mPerPx));
  const bg = maxFilter(lum, w, h, r);
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    if (lum[i] > bg[i] * ratio) continue;
    if (bg[i] - lum[i] < minDrop) continue;
    raw[i] = 1;
  }
  const o = Math.max(1, Math.round(openM / mPerPx));
  const opened = o > 0 ? dilateSquare(erodeSquare(raw, w, h, o), w, h, o) : raw;
  return { mask: opened, bg, rawRatio: raw.reduce((a, v) => a + v, 0) / (w * h) };
}

/**
 * Keep only components that border sunlit ground on the sun side.
 * @param {Uint8Array} mask
 * @param {Uint8Array} lum
 * @param {Uint8Array} bg
 * @param {number} sunAzimuthDeg direction from shadow toward the sun
 */
function filterBySunwardEdge(mask, lum, bg, w, h, mPerPx, sunAzimuthDeg, opts = {}) {
  const reach = Math.max(3, Math.round((opts.reachM || 12) / mPerPx));
  const minFrac = opts.minFrac == null ? 0.3 : opts.minFrac;
  const minAreaM2 = opts.minAreaM2 == null ? 200 : opts.minAreaM2;
  const rad = (sunAzimuthDeg * Math.PI) / 180;
  const dx = Math.round(Math.sin(rad) * reach);
  const dy = Math.round(-Math.cos(rad) * reach);

  const visited = new Uint8Array(w * h);
  const keep = new Uint8Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || visited[i]) continue;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    const px = [];
    let lit = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    while (stack.length) {
      const cur = stack.pop();
      px.push(cur);
      const x = cur % w;
      const y = (cur / w) | 0;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) {
        const j = yy * w + xx;
        if (lum[j] >= bg[j] * 0.82 && !mask[j]) lit += 1;
      }
      const push = (k) => {
        if (!visited[k] && mask[k]) {
          visited[k] = 1;
          stack.push(k);
        }
      };
      if (x > 0) push(cur - 1);
      if (x < w - 1) push(cur + 1);
      if (y > 0) push(cur - w);
      if (y < h - 1) push(cur + w);
    }
    const areaM2 = px.length * mPerPx * mPerPx;
    if (areaM2 < minAreaM2) continue;
    const litFrac = lit / px.length;
    comps.push({
      areaM2: Math.round(areaM2),
      litFrac: +litFrac.toFixed(2),
      cx: Math.round(sumX / px.length),
      cy: Math.round(sumY / px.length),
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    });
    if (litFrac >= minFrac) for (const p of px) keep[p] = 1;
  }
  const kept = comps.filter((c) => c.litFrac >= minFrac);
  return { keep, comps, kept, total: comps.length };
}

export { shadowMaskClosing, filterBySunwardEdge };

/* ============================================================
   Block asymmetry index — threshold-free "how tall is this block".

   Within a block, score the mean positive drop hp(x+v) - hp(x) for
   v along the sun direction and along its opposite. Roads, pitches,
   bare ground and flat roofs are symmetric under v ↔ -v, so they
   cancel; cast shadows do not. The ratio

       (S_sun - S_anti) / (S_sun + S_anti)

   is exposure-invariant and needs no absolute threshold — which is
   what the earlier attempts kept tripping over.
   ============================================================ */

function blockAsymmetry(lum, w, h, mPerPx, sunAzimuthDeg, opts = {}) {
  const blockM = opts.blockM || 200;
  const lengthsM = opts.lengthsM || [10, 20, 35, 60, 90];
  const blockPx = Math.round(blockM / mPerPx);
  const cols = Math.floor(w / blockPx);
  const rows = Math.floor(h / blockPx);
  const out = [];

  const samplesFor = (azDeg, lenM) => {
    const rad = (azDeg * Math.PI) / 180;
    return {
      dx: Math.round((Math.sin(rad) * lenM) / mPerPx),
      dy: Math.round((-Math.cos(rad) * lenM) / mPerPx),
    };
  };

  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      const x0 = bx * blockPx;
      const y0 = by * blockPx;
      let sSun = 0;
      let sAnti = 0;
      let n = 0;
      for (const lenM of lengthsM) {
        const a = samplesFor(sunAzimuthDeg, lenM);
        const b = samplesFor((sunAzimuthDeg + 180) % 360, lenM);
        for (let y = y0; y < y0 + blockPx; y += 2) {
          for (let x = x0; x < x0 + blockPx; x += 2) {
            const ax = x + a.dx;
            const ay = y + a.dy;
            const bx2 = x + b.dx;
            const by2 = y + b.dy;
            if (ax >= 0 && ay >= 0 && ax < w && ay < h) {
              const d = lum[ay * w + ax] - lum[y * w + x];
              if (d > 0) sSun += d;
            }
            if (bx2 >= 0 && by2 >= 0 && bx2 < w && by2 < h) {
              const d = lum[by2 * w + bx2] - lum[y * w + x];
              if (d > 0) sAnti += d;
            }
            n += 1;
          }
        }
      }
      const sun = sSun / Math.max(1, n);
      const anti = sAnti / Math.max(1, n);
      const asym = (sun - anti) / Math.max(1e-6, sun + anti);
      out.push({
        bx,
        by,
        x: x0,
        y: y0,
        sizePx: blockPx,
        sunEnergy: +sun.toFixed(2),
        antiEnergy: +anti.toFixed(2),
        asymmetry: +asym.toFixed(3),
      });
    }
  }
  return { blocks: out, cols, rows, blockPx };
}

export { blockAsymmetry };

/* ============================================================
   Self-calibrated sun azimuth.

   Per-scene sun estimation from whole-image directional contrast was
   unstable (60 deg and 130 deg on two mosaics of the same district).
   Instead, sweep the azimuth and pick the one that maximises the
   *spread* of the block asymmetry index. At the true azimuth some
   blocks (tall buildings) become strongly asymmetric while parks,
   roads and flat ground stay near zero; at a wrong azimuth every
   block shifts together and the spread collapses.
   ============================================================ */

function calibrateSunAzimuth(lum, w, h, mPerPx, opts = {}) {
  const step = opts.stepDeg || 10;
  const candidates = [];
  for (let a = 0; a < 360; a += step) candidates.push(a);

  const results = [];
  for (const az of candidates) {
    const { blocks } = blockAsymmetry(lum, w, h, mPerPx, az, opts);
    if (blocks.length < 4) continue;
    const vals = blocks.map((b) => b.asymmetry);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    const sorted = [...vals].sort((a, b) => a - b);
    const spread = sorted[sorted.length - 1] - sorted[0];
    results.push({ azimuthDeg: az, meanAsym: +mean.toFixed(3), sd: +sd.toFixed(3), spread: +spread.toFixed(3) });
  }
  // sd is identical for az and az+180 (the sign flips), so break the tie with
  // the sun's plausible range at 34 deg N: it is never north at midday.
  const plausible = results.filter((r) => r.azimuthDeg >= 90 && r.azimuthDeg <= 270);
  const pool = plausible.length ? plausible : results;
  const ranked = [...pool].sort((a, b) => b.sd - a.sd);
  const best = ranked[0] ?? results.sort((a, b) => b.sd - a.sd)[0];
  const { blocks, cols, rows } = blockAsymmetry(lum, w, h, mPerPx, best.azimuthDeg, opts);
  return { ...best, shadowAzimuthDeg: (best.azimuthDeg + 180) % 360, cols, rows, blocks, ranking: ranked.slice(0, 5) };
}

export { calibrateSunAzimuth };
