/* ============================================================
   西接通勤 · 单瓦片阴影分析（连片阴影）

   与 lib/imagery.js 的区别：那个是"长暗带"粗判，这个是这一轮实测出来的
   连片阴影方案：
     1. 参考亮度 = 该瓦片自身的 p95（受光屋面），不受整幅拼图混时相影响
     2. 暗像素 = 亮度 < ref * ratio
     3. 开运算 5 m  → 剪断 10 m 以下的细颈（街道、巷子）
     4. 连通块 → 丢掉最长边 < 20 m 的小块（颗粒/树冠）
     5. 多数投票平滑 20 m → 补洞、去毛边
     6. 保留面积 >= 1500 m² 的块，输出外轮廓（凸包简化）供地图绘制

   输出坐标：像素 → GCJ-02 经纬度（高德底图直接用）

   纯函数，无 DOM/网络依赖，background 与测试都可直接用。
   ============================================================ */
(function () {
  "use strict";
  const G = typeof self !== "undefined" ? self : globalThis;

  const DEFAULTS = {
    ratio: 0.40,      // 亮度 / 瓦片 p95
    openM: 5,         // 开运算半径（米）
    smallSideM: 20,   // 最长边小于此值的孤立块删除
    smoothM: 20,      // 平滑窗口（米）
    minAreaM2: 1500,  // 最终保留的最小面积
    maxHullPoints: 16,
  };

  /* ---------------- 形态学 ---------------- */

  function morph(src, w, h, r, dilateIt) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let v = dilateIt ? 0 : 1;
        const a = Math.max(0, x - r);
        const b = Math.min(w - 1, x + r);
        for (let i = a; i <= b; i += 1) {
          const j = y * w + i;
          if (dilateIt) { if (src[j]) { v = 1; break; } } else if (!src[j]) { v = 0; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let v = dilateIt ? 0 : 1;
        const a = Math.max(0, y - r);
        const b = Math.min(h - 1, y + r);
        for (let i = a; i <= b; i += 1) {
          const j = i * w + x;
          if (dilateIt) { if (tmp[j]) { v = 1; break; } } else if (!tmp[j]) { v = 0; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  /** 可分的大窗口多数投票（等价于方形均值阈值） */
  function majority(src, w, h, r) {
    const hc = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      let acc = 0;
      for (let x = -r; x <= r; x += 1) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x += 1) {
        hc[y * w + x] = acc;
        acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    const out = new Uint8Array(w * h);
    const win = 2 * r + 1;
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      for (let y = -r; y <= r; y += 1) acc += hc[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y += 1) {
        out[y * w + x] = acc * 2 > win * win ? 1 : 0;
        acc += hc[Math.min(h - 1, y + r + 1) * w + x] - hc[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  /* ---------------- 连通块 ---------------- */

  function components(mask, w, h) {
    const lab = new Int32Array(w * h).fill(-1);
    const stack = [];
    const comps = [];
    for (let i = 0; i < w * h; i += 1) {
      if (!mask[i] || lab[i] !== -1) continue;
      const id = comps.length;
      lab[i] = id;
      stack.length = 0;
      stack.push(i);
      const px = [];
      let minX = w, maxX = 0, minY = h, maxY = 0;
      while (stack.length) {
        const cur = stack.pop();
        px.push(cur);
        const x = cur % w;
        const y = (cur / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const push = (j) => { if (lab[j] === -1 && mask[j]) { lab[j] = id; stack.push(j); } };
        if (x > 0) push(cur - 1);
        if (x < w - 1) push(cur + 1);
        if (y > 0) push(cur - w);
        if (y < h - 1) push(cur + w);
      }
      comps.push({ id, px, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
    }
    return { lab, comps };
  }

  /* ---------------- 轮廓：凸包 + 抽稀 ---------------- */

  function hull(px, w, maxPoints) {
    const pts = px.map((i) => [i % w, (i / w) | 0]);
    pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    const upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    const ring = lower.concat(upper.slice(1, -1));
    if (ring.length <= maxPoints) return ring;
    // 均匀抽稀（凸包上的等步长取样即可，形状误差可接受）
    const out = [];
    const step = ring.length / maxPoints;
    for (let i = 0; i < maxPoints; i += 1) out.push(ring[Math.floor(i * step)]);
    return out;
  }

  /* ---------------- 坐标 ---------------- */

  function tilePixelToGcj(x, y, px, py, tilePx) {
    const n = 2 ** 8;
    return [0, 0]; // 占位，实际用下面的函数
  }

  /** 像素 → GCJ 经纬度（Web 墨卡托，瓦片像素坐标） */
  function pxToGcj(z, tx, ty, px, py, tilePx) {
    const n = 2 ** z;
    const wx = tx + px / tilePx;
    const wy = ty + py / tilePx;
    const lng = (wx / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / n)));
    return [lng, (latRad * 180) / Math.PI];
  }

  /* ---------------- 主入口 ---------------- */

  /**
   * @param {Uint8ClampedArray|Uint8Array} rgba 瓦片像素（tilePx × tilePx）
   * @param {number} tilePx
   * @param {object} opts { mPerPx, z, tx, ty, ...DEFAULTS }
   * @returns {{coverage:number, blobs:Array<{areaM2:number, hull:number[][], pts:number}>, ms:number}}
   */
  function analyzeTile(rgba, tilePx, opts) {
    const P = Object.assign({}, DEFAULTS, opts || {});
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const n = tilePx * tilePx;
    const mpp = Number(P.mPerPx) > 0 ? Number(P.mPerPx) : 0.6;

    // 亮度直方图 → p95 参考
    const lum = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i += 1) {
      const o = i * 4;
      const L = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
      lum[i] = L;
      hist[L] += 1;
    }
    let acc = 0;
    let ref = 255;
    for (let v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc >= n * 0.95) { ref = v; break; }
    }
    const thr = Math.max(8, ref) * P.ratio;

    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) if (lum[i] < thr) raw[i] = 1;

    const openPx = Math.max(1, Math.round(P.openM / mpp));
    const opened = morph(morph(raw, tilePx, tilePx, openPx, false), tilePx, tilePx, openPx, true);

    // 丢小块
    const c1 = components(opened, tilePx, tilePx);
    const kept = new Uint8Array(n);
    for (const c of c1.comps) {
      const side = Math.max(c.bbox.w, c.bbox.h) * mpp;
      if (side < P.smallSideM) continue;
      for (const q of c.px) kept[q] = 1;
    }

    const smoothPx = Math.max(1, Math.round(P.smoothM / 2 / mpp));
    const smoothed = majority(kept, tilePx, tilePx, smoothPx);

    const c2 = components(smoothed, tilePx, tilePx);
    const blobs = [];
    const keep = new Uint8Array(n);
    let covered = 0;
    for (const c of c2.comps) {
      const areaM2 = c.px.length * mpp * mpp;
      if (areaM2 < P.minAreaM2) continue;
      covered += c.px.length;
      for (const q of c.px) keep[q] = 1;
      const h = hull(c.px, tilePx, P.maxHullPoints);
      const poly = h.map((p) => pxToGcj(P.z, P.tx, P.ty, p[0] + 0.5, p[1] + 0.5, tilePx));
      blobs.push({ areaM2: Math.round(areaM2), pts: h.length, hull: poly });
    }
    // 掩膜像素（红/透明），供地图按瓦片贴图直接绘制——比凸包准确得多
    const maskRgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i += 1) {
      if (!keep[i]) continue;
      const o = i * 4;
      maskRgba[o] = 236;
      maskRgba[o + 1] = 74;
      maskRgba[o + 2] = 58;
      maskRgba[o + 3] = 255; // 不透明度交给地图层控制（填充淡、描边实）
    }

    const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    return {
      maskRgba,
      coverage: +((covered / n) * 100).toFixed(1),
      ref,
      thr: Math.round(thr),
      blobs,
      ms: Math.round(t1 - t0),
    };
  }

  G.XAT_SHADOW = { analyzeTile, pxToGcj, DEFAULTS };
})();
