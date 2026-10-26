/* ============================================================
   西接通勤 · 几何与坐标工具
   在 content script 与 options 页面共用；无依赖，纯函数。
   ============================================================ */
(function () {
  "use strict";

  const XAT = (window.__XAT = window.__XAT || {});

  const PI = Math.PI;
  const A = 6378245.0;          // 克拉索夫斯基椭球长半轴
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

  /** WGS84 → GCJ-02（高德用的坐标） */
  function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
    dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }

  /** GCJ-02 → WGS84（选点回填时用，近似迭代一次） */
  function gcj02ToWgs84(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    const [gLng, gLat] = wgs84ToGcj02(lng, lat);
    return [lng * 2 - gLng, lat * 2 - gLat];
  }

  const R_EARTH = 6371008.8;
  const rad = (d) => (d * PI) / 180;

  /** 两点距离（米），输入 [lng, lat] */
  function haversine(a, b) {
    const dLat = rad(b[1] - a[1]);
    const dLng = rad(b[0] - a[0]);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /**
   * 最小外接圆（暴力枚举；点数 ≤ 8，扩展用点通常 ≤5）
   * 输入 [[lng,lat]]，输出 { center:[lng,lat], radius: 米 }
   */
  function minEnclosingCircle(points) {
    if (!points.length) return { center: [0, 0], radius: 0 };
    if (points.length === 1) return { center: points[0], radius: 0 };

    // 用局部平面坐标算，避免经纬度单位不一致
    const lat0 = points.reduce((s, p) => s + p[1], 0) / points.length;
    const mPerDegLat = 111132.92;
    const mPerDegLng = 111412.84 * Math.cos(rad(lat0));
    const xy = points.map((p) => [(p[0] - points[0][0]) * mPerDegLng, (p[1] - points[0][1]) * mPerDegLat]);

    const contains = (c, r) => xy.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r + 1e-6);
    const fromPair = (p, q) => ({
      c: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
      r: Math.hypot(p[0] - q[0], p[1] - q[1]) / 2,
    });
    const fromTriple = (p, q, s) => {
      const d = 2 * (p[0] * (q[1] - s[1]) + q[0] * (s[1] - p[1]) + s[0] * (p[1] - q[1]));
      if (Math.abs(d) < 1e-9) return null;
      const p2 = p[0] * p[0] + p[1] * p[1];
      const q2 = q[0] * q[0] + q[1] * q[1];
      const s2 = s[0] * s[0] + s[1] * s[1];
      const c = [
        (p2 * (q[1] - s[1]) + q2 * (s[1] - p[1]) + s2 * (p[1] - q[1])) / d,
        (p2 * (s[0] - q[0]) + q2 * (p[0] - s[0]) + s2 * (q[0] - p[0])) / d,
      ];
      return { c, r: Math.hypot(p[0] - c[0], p[1] - c[1]) };
    };

    let best = null;
    for (let i = 0; i < xy.length; i += 1) {
      for (let j = i + 1; j < xy.length; j += 1) {
        const cand = fromPair(xy[i], xy[j]);
        if (contains(cand.c, cand.r) && (!best || cand.r < best.r)) best = cand;
      }
    }
    for (let i = 0; i < xy.length; i += 1) {
      for (let j = i + 1; j < xy.length; j += 1) {
        for (let k = j + 1; k < xy.length; k += 1) {
          const cand = fromTriple(xy[i], xy[j], xy[k]);
          if (cand && contains(cand.c, cand.r) && (!best || cand.r < best.r)) best = cand;
        }
      }
    }
    if (!best) best = fromPair(xy[0], xy[1]);

    return {
      center: [points[0][0] + best.c[0] / mPerDegLng, points[0][1] + best.c[1] / mPerDegLat],
      radius: best.r,
    };
  }

  /** 由一组 [lng,lat] 生成圆上 64 个点，便于用像素画圆 */
  function circlePoints(center, radiusMeters, segments) {
    const n = segments || 64;
    const mPerDegLat = 111132.92;
    const mPerDegLng = 111412.84 * Math.cos(rad(center[1]));
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const t = (i / n) * 2 * PI;
      out.push([
        center[0] + (Math.cos(t) * radiusMeters) / mPerDegLng,
        center[1] + (Math.sin(t) * radiusMeters) / mPerDegLat,
      ]);
    }
    return out;
  }

  /** 通勤分钟 → 档位色（与图例一致） */
  function tierColor(min) {
    if (min == null) return "#b9b2a5";
    if (min <= 15) return "#126e5b";
    if (min <= 25) return "#6f9a5e";
    if (min <= 35) return "#b9852b";
    return "#9c2a22";
  }

  /** 直线估算分钟（无 API 时的占位，显式标 ~） */
  const SPEED_KMH = { drive: 22, transit: 18, walk: 4.6 };
  const FIXED_MIN = { drive: 5, transit: 8, walk: 0 };
  function estimateMinutes(distanceMeters, mode) {
    const km = distanceMeters / 1000;
    const v = SPEED_KMH[mode] || SPEED_KMH.drive;
    return Math.max(3, Math.round((km / v) * 60 + (FIXED_MIN[mode] || 0)));
  }

  XAT.geo = {
    wgs84ToGcj02,
    gcj02ToWgs84,
    haversine,
    minEnclosingCircle,
    circlePoints,
    tierColor,
    estimateMinutes,
    SPEED_KMH,
  };

  XAT.geoReady = true;
})();
