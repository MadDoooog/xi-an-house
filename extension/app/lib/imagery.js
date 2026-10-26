/* ============================================================
   西接通勤 · 卫星影像特征（纯函数，background 里用）
   - 坐标：库内 WGS84；高德影像瓦片是 GCJ-02 对齐，取瓦片前必须转换
   - 特征：自适应阈值分出 暗区(影子/暗屋顶/沥青) / 亮区(屋顶) / 绿化 / 水面，
           再做连通域 + PCA 找"细长暗带"（高层楼体拖出的影子是这类形状），
           输出阴影占比、长暗带数量与长度、方向一致度等
   - 注意：这是粗判，道路与暗屋顶会混进来，最终以人工看图为准
   ============================================================ */
(function () {
  "use strict";
  const G = typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis;

  /* ---------------- 坐标 ---------------- */

  const PI = Math.PI;
  const AXIS = 6378245.0;
  const EE = 0.00669342162296594323;

  function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function transformLat(x, y) {
    let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    r += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
    r += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
    return r;
  }
  function transformLng(x, y) {
    let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
    r += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
    r += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
    return r;
  }
  function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((AXIS * (1 - EE)) / (magic * sqrtMagic)) * PI);
    dLng = (dLng * 180.0) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }

  /** GCJ-02 经纬度 → 瓦片坐标（浮点） */
  function lonLatToTileFloat(lng, lat, z) {
    const n = 2 ** z;
    const latRad = (lat * PI) / 180;
    const x = ((lng + 180) / 360) * n;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / PI) / 2) * n;
    return [x, y];
  }

  /** 瓦片坐标 → WGS84（反向要再转一次 GCJ→WGS，这里给出近似反算） */
  function tileToLonLatFloat(x, y, z) {
    const n = 2 ** z;
    const lng = (x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(PI * (1 - (2 * y) / n)));
    const lat = (latRad * 180) / PI;
    return [lng, lat];
  }

  function gcj02ToWgs84(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    const [gLng, gLat] = wgs84ToGcj02(lng, lat);
    return [lng * 2 - gLng, lat * 2 - gLat];
  }

  /** 覆盖一个圆（圆心 WGS84 + 半径米）所需的 z 级瓦片 */
  function tilesForCircle(centerLng, centerLat, radiusM, zoom) {
    const [glng, glat] = wgs84ToGcj02(centerLng, centerLat);
    const lat0 = (glat * PI) / 180;
    const mPerDegLng = 111412.84 * Math.cos(lat0);
    const mPerDegLat = 111132.92;
    const dLng = (radiusM / mPerDegLng) * 1.05;
    const dLat = (radiusM / mPerDegLat) * 1.05;
    const [x1, y1] = lonLatToTileFloat(glng - dLng, glat + dLat, zoom);
    const [x2, y2] = lonLatToTileFloat(glng + dLng, glat - dLat, zoom);
    const tx1 = Math.floor(Math.min(x1, x2));
    const tx2 = Math.floor(Math.max(x1, x2));
    const ty1 = Math.floor(Math.min(y1, y2));
    const ty2 = Math.floor(Math.max(y1, y2));
    const out = [];
    for (let ty = ty1; ty <= ty2; ty += 1) {
      for (let tx = tx1; tx <= tx2; tx += 1) out.push({ z: zoom, x: tx, y: ty });
    }
    return out;
  }

  /** 该 zoom 在该纬度下一张瓦片覆盖多少米 */
  function metersPerTile(zoom, lat) {
    return (40075016.686 * Math.cos(((lat || 34.25) * PI) / 180)) / 2 ** zoom;
  }

  /**
   * 给半径挑 zoom：瓦片数不超过 maxTiles，且不低于 minZoom
   * （低于 z16 就看不清楼影了，宁可缩小覆盖范围）
   */
  function pickZoom(radiusM, maxTiles, minZoom) {
    const floorZ = Number.isFinite(minZoom) ? minZoom : 12;
    for (let z = 18; z >= floorZ; z -= 1) {
      const mPerTile = metersPerTile(z);
      const across = Math.ceil((radiusM * 2 * 1.05) / mPerTile);
      if (across * across <= maxTiles) return z;
    }
    return floorZ;
  }

  /** 在给定 zoom 下，最多 maxTiles 张瓦片能覆盖多大的半径 */
  function radiusForTiles(zoom, maxTiles) {
    const mPerTile = metersPerTile(zoom);
    const across = Math.max(1, Math.floor(Math.sqrt(maxTiles)));
    return (across * mPerTile) / (2 * 1.05);
  }

  /* ---------------- 图像特征 ---------------- */

  const DEFAULTS = {
    // 形态学开运算的尺度（米）：窄于 ~2×openRadiusM 的细影会被整块抹掉
    openRadiusM: 5,
    // 片状筛选（只做下限，不设面积上限——大片阴影本身就是"明显的片状"）
    minPatchAreaM2: 150,
    minFill: 0.35,
    maxAspect: 8,
    // 打分时单块面积的封顶，避免一整片连着的大暗区把分数拉爆
    scoreAreaCapM2: 20000,
    waterBlueDelta: 10,
    greenExg: 16,
  };

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  }

  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let bestT = 128;
    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        bestT = t;
      }
    }
    return bestT;
  }

  /* 可分离的方形腐蚀/膨胀：O(n·k)，768² 也只要几十毫秒 */
  function erodeSquare(mask, w, h, r) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let ok = 1;
        for (let d = -r; d <= r; d += 1) {
          const xx = x + d;
          if (xx < 0 || xx >= w || !mask[y * w + xx]) {
            ok = 0;
            break;
          }
        }
        tmp[y * w + x] = ok;
      }
    }
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let ok = 1;
        for (let d = -r; d <= r; d += 1) {
          const yy = y + d;
          if (yy < 0 || yy >= h || !tmp[yy * w + x]) {
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
        for (let d = -r; d <= r; d += 1) {
          const xx = x + d;
          if (xx >= 0 && xx < w && mask[y * w + xx]) {
            v = 1;
            break;
          }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let v = 0;
        for (let d = -r; d <= r; d += 1) {
          const yy = y + d;
          if (yy >= 0 && yy < h && tmp[yy * w + x]) {
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
   * 流程：分绿/水 → Otsu 二值化 → 开运算（细影消失）→ 连通域 → 片状筛选 → 打分
   * @param {Uint8ClampedArray|Uint8Array} rgba
   * @param {number} w
   * @param {number} h
   * @param {object} opts 可覆盖 DEFAULTS；mPerPx 必填
   */
  function analyzeRgba(rgba, w, h, opts) {
    const P = Object.assign({}, DEFAULTS, opts || {});
    const mPerPx = Number(P.mPerPx) > 0 ? Number(P.mPerPx) : 0.5;
    const n = w * h;
    const lum = new Float32Array(n);
    const green = new Uint8Array(n);
    const water = new Uint8Array(n);
    const hist = new Uint32Array(256);
    let urbanN = 0;

    for (let i = 0; i < n; i += 1) {
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      lum[i] = L;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const S = mx === 0 ? 0 : (mx - mn) / mx;
      const exg = 2 * g - r - b;
      // 水面：明显偏青蓝（b 比 g 也高），而不是"偏蓝的阴影"（阴影 b-g≈0）
      if (b > r + 12 && b - g >= 4 && L < 110 && S > 0.18 && exg <= 2) {
        water[i] = 1;
        continue;
      }
      if (exg > P.greenExg && L > 30) {
        green[i] = 1;
        continue;
      }
      hist[Math.min(255, Math.max(0, Math.round(L)))] += 1;
      urbanN += 1;
    }

    const thr = Math.min(210, Math.max(18, otsuThreshold(hist, urbanN || n)));
    const dark = new Uint8Array(n);
    let darkCount = 0;
    for (let i = 0; i < n; i += 1) {
      if (green[i] || water[i]) continue;
      if (lum[i] <= thr) {
        dark[i] = 1;
        darkCount += 1;
      }
    }

    // 开运算：细影（街巷、电线、树列）在这里被抹掉，只留"成片"的暗区
    const openPx = Math.max(1, Math.round((Number(P.openRadiusM) || 0) / mPerPx));
    const core = openPx > 0 ? dilateSquare(erodeSquare(dark, w, h, openPx), w, h, openPx) : dark;

    /* 画面中位数亮度（只算城市像素）：用来判断"这块是不是真的比周围暗" */
    const urbanLum = [];
    const stride = Math.max(1, Math.round(Math.sqrt(n / 40000)));
    for (let i = 0; i < n; i += stride) {
      if (green[i] || water[i]) continue;
      urbanLum.push(lum[i]);
    }
    urbanLum.sort((a, b) => a - b);
    const medianL = quantile(urbanLum, 0.5) || 1;

    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const patchMask = new Uint8Array(n);
    const patches = [];
    for (let i = 0; i < n; i += 1) {
      if (!core[i] || seen[i]) continue;
      let sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      const px = [];
      let minX = w;
      let maxX = 0;
      let minY = h;
      let maxY = 0;
      let sumL = 0;
      while (sp) {
        const cur = stack[--sp];
        px.push(cur);
        sumL += lum[cur];
        const x = cur % w;
        const y = (cur / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && core[cur - 1] && !seen[cur - 1]) { seen[cur - 1] = 1; stack[sp++] = cur - 1; }
        if (x < w - 1 && core[cur + 1] && !seen[cur + 1]) { seen[cur + 1] = 1; stack[sp++] = cur + 1; }
        if (y > 0 && core[cur - w] && !seen[cur - w]) { seen[cur - w] = 1; stack[sp++] = cur - w; }
        if (y < h - 1 && core[cur + w] && !seen[cur + w]) { seen[cur + w] = 1; stack[sp++] = cur + w; }
      }
      const areaM2 = px.length * mPerPx * mPerPx;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const fill = px.length / (bw * bh);
      const aspect = Math.max(bw, bh) / Math.min(bw, bh);
      if (areaM2 < P.minPatchAreaM2 || fill < P.minFill || aspect > P.maxAspect) continue;
      const meanL = sumL / px.length;
      // 相对亮度：比画面中位数暗得越多，越像真阴影（整体偏暗的画面里这个值会变小）
      const darkF = Math.max(0, Math.min(1, (medianL - meanL) / (0.3 * medianL)));
      patches.push({ areaM2, fill, aspect, meanL, darkF });
      for (const p of px) patchMask[p] = 1;
    }

    const patchAreaM2 = patches.reduce((acc, p) => acc + p.areaM2, 0);
    const effAreaM2 = patches.reduce((acc, p) => acc + p.areaM2 * p.darkF, 0);
    const maxPatchM2 = patches.reduce((acc, p) => Math.max(acc, p.areaM2), 0);
    const meanFill = patches.length ? patches.reduce((acc, p) => acc + p.fill, 0) / patches.length : 0;
    const meanDarkF = patches.length ? patches.reduce((acc, p) => acc + p.darkF, 0) / patches.length : 0;

    // 亮屋顶占比：有受光屋面的地方才谈得上"楼的影子"
    const roofThr = Math.min(245, medianL + 0.55 * (255 - medianL));
    let roofCount = 0;
    let greenCount = 0;
    let waterCount = 0;
    for (let i = 0; i < n; i += 1) {
      greenCount += green[i];
      waterCount += water[i];
      if (green[i] || water[i]) continue;
      if (lum[i] >= roofThr) roofCount += 1;
    }

    const imgAreaM2 = n * mPerPx * mPerPx;
    const features = {
      mPerPx,
      openPx,
      shadowThr: thr,
      medianL,
      darkRatio: darkCount / n,
      patches: patches.length,
      patchAreaM2,
      patchAreaRatio: effAreaM2 / imgAreaM2,
      maxPatchM2,
      meanFill,
      meanDarkF,
      roofRatio: roofCount / n,
      greenRatio: greenCount / n,
      waterRatio: waterCount / n,
      imgAreaM2,
    };
    features.score = scoreOf(features);
    return { features, bandMask: patchMask };
  }

  /**
   * 粗判打分 0~1：片状阴影"大、多、成型、够暗"，且附近有受光屋面。
   * 只用来排序，不是判决。
   */
  function scoreOf(f) {
    const areaS = Math.min(1, (f.patchAreaRatio || 0) / 0.06);
    const maxS = Math.min(1, Math.min(f.maxPatchM2 || 0, 20000) / 8000);
    const cntS = Math.min(1, (f.patches || 0) / 6);
    const fillS = Math.min(1, (f.meanFill || 0) / 0.75);
    const darkS = Math.min(1, (f.meanDarkF || 0) / 0.5);
    const roofS = Math.min(1, (f.roofRatio || 0) / 0.15);
    let s = 0.32 * areaS + 0.2 * maxS + 0.14 * cntS + 0.12 * fillS + 0.12 * darkS + 0.1 * roofS;
    if (f.waterRatio > 0.25) s *= 0.35;
    if (f.greenRatio > 0.62 && (f.patches || 0) < 2) s *= 0.5;
    return Math.max(0, Math.min(1, s));
  }

  G.XAT_IMAGERY = {
    wgs84ToGcj02,
    gcj02ToWgs84,
    lonLatToTileFloat,
    tileToLonLatFloat,
    tilesForCircle,
    pickZoom,
    metersPerTile,
    radiusForTiles,
    analyzeRgba,
    scoreOf,
    DEFAULTS,
  };
})();
