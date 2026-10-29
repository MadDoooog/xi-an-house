/* ============================================================
   西接通勤 · background service worker
   职责：
   1) 唯一的本地数据库（IndexedDB），避免数据绑在 amap.com 的 origin 上
   2) 日志落库 + 诊断信息汇聚（远程排错靠它）
   3) 打开"去高德算路"的标签页
   所有调用都走 {type:'xat.rpc', method, params}，返回 {ok,data}|{ok:false,error}
   数据默认是空的：不预置任何小区与目的地，由你自己录入 / 导入。
   ============================================================ */
"use strict";

// 纯函数影像分析（瓦片对齐、阈值、长暗带 PCA）
importScripts("lib/imagery.js");
importScripts("lib/shadow.js");

const DB_NAME = "xat";
const DB_VERSION = 3;
const LOG_LIMIT = 2000;

/* 0.1.0 预置过的虚构样例：升级到 2 版时清掉，让老用户也回到干净状态 */
const SAMPLE_COMMUNITY_IDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"];
const SAMPLE_DEST_IDS = ["d1", "d2", "d3"];

const DEFAULT_LAYOUT = { top: 72, bottom: 24 };

/* ---------------- IndexedDB ---------------- */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const t = req.transaction;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("communities")) db.createObjectStore("communities", { keyPath: "id" });
      if (!db.objectStoreNames.contains("logs")) {
        const s = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        s.createIndex("ts", "ts");
      }
      if (!db.objectStoreNames.contains("diag")) db.createObjectStore("diag", { keyPath: "tabId" });
      if (!db.objectStoreNames.contains("commute")) db.createObjectStore("commute", { keyPath: "id" });
      if (!db.objectStoreNames.contains("tiles")) db.createObjectStore("tiles", { keyPath: "key" });
      if (!db.objectStoreNames.contains("verdicts")) db.createObjectStore("verdicts", { keyPath: "key" });

      // v1 → v2：去掉 0.1.0 的 12 条虚构样例 + 3 个虚构目的地
      if (ev.oldVersion >= 1 && ev.oldVersion < 2) {
        try {
          const cs = t.objectStore("communities");
          SAMPLE_COMMUNITY_IDS.forEach((id) => cs.delete(id));
          const ss = t.objectStore("settings");
          const g = ss.get("main");
          g.onsuccess = () => {
            const s = g.result;
            if (!s) return;
            const dests = Array.isArray(s.destinations) ? s.destinations : [];
            const onlySample = dests.length > 0 && dests.every((d) => d && SAMPLE_DEST_IDS.indexOf(d.id) >= 0);
            const next = Object.assign({}, s);
            if (onlySample) {
              next.destinations = [];
              next.destinationCount = 0;
            }
            if (!next.layout) next.layout = Object.assign({}, DEFAULT_LAYOUT);
            ss.put(next);
          };
        } catch (e) {
          console.warn("[XAT][bg] v1→v2 迁移失败", e);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let out;
        try {
          out = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const req = (r) => ({ __req: r });

const idb = {
  getAll: (store) => tx(store, "readonly", (os) => req(os.getAll())),
  get: (store, key) => tx(store, "readonly", (os) => req(os.get(key))),
  put: (store, value) => tx(store, "readwrite", (os) => req(os.put(value))),
  del: (store, key) => tx(store, "readwrite", (os) => req(os.delete(key))),
  clear: (store) => tx(store, "readwrite", (os) => req(os.clear())),
  count: (store) =>
    tx(store, "readonly", (os) => req(os.count())).catch(() => 0),
};

/* ---------------- 默认设置 ---------------- */

// 高德「Web 服务」key（POI 反查小区用）。可在设置页覆盖；留空则用这个内置值。
const DEFAULT_AMAP_KEY = "b58587dccf8efd1021dee8dcdbc43845";

const DEFAULT_SETTINGS = {
  key: "main",
  amapKey: DEFAULT_AMAP_KEY,
  // 是否允许后台开一个高德标签页去取小区外接矩形（默认不打扰）
  amapTabForBoxes: true,
  // 默认空：目的地由你右键复制地址后粘贴添加
  destinations: [],
  destinationCount: 0,
  radiusKm: 3,
  budget: { totalMin: 150, totalMax: 320, areaMin: 80, areaMax: 140, priceMax: 24000 },
  tenure: ["商品房"],
  sources: ["official", "manual", "poi", "seed"],
  departAt: "08:00",
  sortBy: "commute",
  showOut: true,
  // 侧栏上下留白（px）：避免盖住高德自带的工具条
  layout: { top: 72, bottom: 24 },
  // 阶段 3d 起才用到；先留字段，避免以后迁移
  commuteQuota: 10,
  lastSavedAt: null,
};

function normalizeSettings(s) {
  const src = s || {};
  const budget = Object.assign({}, DEFAULT_SETTINGS.budget, src.budget || {});
  const layout = Object.assign({}, DEFAULT_LAYOUT, src.layout || {});
  return Object.assign({}, DEFAULT_SETTINGS, src, {
    key: "main",
    destinations: Array.isArray(src.destinations) ? src.destinations : [],
    destinationCount: Array.isArray(src.destinations) ? src.destinations.length : 0,
    budget,
    layout,
    tenure: Array.isArray(src.tenure) ? src.tenure : DEFAULT_SETTINGS.tenure.slice(),
    sources: Array.isArray(src.sources) ? src.sources : DEFAULT_SETTINGS.sources.slice(),
  });
}

/* ---------------- 小区数据的规范化 ---------------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function uid(prefix) {
  return (prefix || "u") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const R_EARTH = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function haversineM(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 名称归一：去掉"小区/花园/苑/城"等尾缀与空格，只用于去重比较 */
function normalizeName(name) {
  return String(name || "")
    .replace(/[\s（）()·\-—_]/g, "")
    .replace(/(小区|花园|苑|家园|公寓|新城|城)$/g, "");
}

/** 多边形质心（面积加权；退化时退回顶点平均），用于把后端 GeoJSON 折成一个小区的点 */
function ringCentroid(ring) {
  const pts = (ring || []).filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
  if (!pts.length) return null;
  if (pts.length > 3) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop();
  }
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    area2 += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  const area = area2 / 2;
  if (Math.abs(area) > 1e-12) return [cx / (6 * area), cy / (6 * area)];
  const n = pts.length;
  return [pts.reduce((s, p) => s + Number(p[0]), 0) / n, pts.reduce((s, p) => s + Number(p[1]), 0) / n];
}

function centroidOfGeometry(geom) {
  if (!geom || !geom.coordinates) return null;
  if (geom.type === "Point") return [Number(geom.coordinates[0]), Number(geom.coordinates[1])];
  let ring = null;
  if (geom.type === "Polygon") ring = geom.coordinates[0];
  else if (geom.type === "MultiPolygon") ring = geom.coordinates[0] && geom.coordinates[0][0];
  if (!Array.isArray(ring) || !ring.length) return null;
  return ringCentroid(ring);
}

/** 把各种来源的记录统一成本插件的 community 结构 */
/** 把 "lng,lat;lng,lat;…" 解析成 [[lng,lat],…]；不是坐标串就返回 null */
function parsePolygonString(v) {
  if (typeof v !== "string" || v.length < 20) return null;
  if (!/^-?\d{2,3}\.\d{3,},\d{1,2}\.\d{3,}(;-?\d{2,3}\.\d{3,},\d{1,2}\.\d{3,})+/.test(v.trim())) return null;
  const pts = v
    .trim()
    .split(";")
    .map((seg) => seg.split(",").map(Number))
    .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return pts.length >= 3 ? pts : null;
}


/** 在真实高德标签页的 MAIN world 发请求（站点 JS 会补 bx-ua/x-dc 指纹头） */
/** 关掉我们开的后台标签页（delay 毫秒后） */
function closeTabSoon(delay) {
  clearTimeout(polyTabTimer);
  polyTabTimer = setTimeout(() => {
    if (polyTabId != null) chrome.tabs.remove(polyTabId).catch(() => {});
    polyTabId = null;
  }, delay);
}

async function amapInternalFetch(url, opts) {
  const allowCreateTab = !!(opts && opts.allowCreateTab);
  if (polyBlocked >= 2) return { ok: false, reason: "blocked-session" };
  if (Date.now() < polyCooldownUntil) return { ok: false, reason: "cooldown" };

  let tab = null;
  const tabs = await chrome.tabs.query({ url: "https://www.amap.com/*" });
  tab = tabs.find((t) => t.id != null) || null;
  if (!tab && polyTabId != null) {
    try {
      tab = await chrome.tabs.get(polyTabId);
    } catch {
      tab = null;
    }
  }
  if (!tab) {
    // 默认不开新标签页（会在标签栏里弹出来）。
    // 需要「外接矩形」时，请自己开着一个 amap.com 页面，或打开设置里的开关。
    if (!allowCreateTab) return { ok: false, reason: "no-tab" };
    tab = await chrome.tabs.create({ url: "https://www.amap.com/", active: false });
    polyTabId = tab.id;
  }

  // 等页面自己加载完再注入：高德的指纹 SDK 是异步装的，注入太早会没有反爬头
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t && t.status === "complete") break;
    } catch {
      return { ok: false, reason: "tab-gone" };
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const inject = async () => {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (u) =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.open("GET", u, true);
          x.timeout = 12000;
          x.onload = () => resolve({ status: x.status, text: String(x.responseText || "") });
          x.onerror = () => resolve({ status: 0, text: "" });
          x.ontimeout = () => resolve({ status: -1, text: "" });
          x.send();
        }),
      args: [url],
    });
    return (out && out.result) || {};
  };

  try {
    let r = await inject();
    let text = String(r.text || "");
    let blocked = !text || /rgv587|punish|FAIL_SYS_USER_VALIDATE/i.test(text);
    if (blocked) {
      // 站点刚起来时偶尔会判一次，等一下再试一次
      await new Promise((res) => setTimeout(res, 1600));
      r = await inject();
      text = String(r.text || "");
      blocked = !text || /rgv587|punish|FAIL_SYS_USER_VALIDATE/i.test(text);
    }
    if (blocked) {
      polyBlocked += 1;
      polyCooldownUntil = Date.now() + 10 * 60 * 1000;
      await bgLog("warn", "高德站内接口被拦", { status: r.status, head: text.slice(0, 100) });
      closeTabSoon(3000);
      return { ok: false, reason: "blocked", status: r.status, head: text.slice(0, 160) };
    }
    closeTabSoon(15000);
    return { ok: true, text };
  } catch (e) {
    await bgLog("warn", "高德站内接口失败", { error: String(e) });
    return { ok: false, reason: "error", error: String(e) };
  }
}

/** 站内 poi_list 的一条 → 统一结构（GCJ-02） */
function normalizeSitePoi(p) {
  if (!p || !p.name) return null;
  const lng = Number(p.longitude);
  const lat = Number(p.latitude);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  let bbox = null;
  if (typeof p.shape_region === "string") {
    const n = p.shape_region.split(",").map(Number);
    if (n.length === 4 && n.every(Number.isFinite)) bbox = n; // minLng,minLat,maxLng,maxLat
  }
  return {
    id: p.id || null,
    name: p.name,
    address: p.address || "",
    district: p.adname || null,
    lng,
    lat,
    distance: Number(p.distance) || null,
    typecode: p.typecode || null,
    bbox,
  };
}

function normalizeCommunity(raw, defaults) {
  if (!raw || typeof raw !== "object") return null;
  const d = defaults || {};
  const loc = raw.location && typeof raw.location === "object" ? raw.location : {};
  const center = raw.geometry ? centroidOfGeometry(raw.geometry) : null;
  const lng = num(raw.lng ?? raw.lon ?? loc.lng ?? loc.lon ?? (center && center[0]));
  const lat = num(raw.lat ?? loc.lat ?? (center && center[1]));
  const name = String(raw.name || "").trim();
  if (!name || lng == null || lat == null) return null;

  const official = raw.official || null;
  const avgPrice =
    num(raw.avgPrice) ??
    num(raw.display_price) ??
    num(raw.filing_price) ??
    num(official && official.filingPrice) ??
    num(raw.price_min) ??
    0;

  return {
    id: String(raw.id || uid("u")),
    name,
    district: raw.district || null,
    sub: raw.sub || raw.sub_area || null,
    lng,
    lat,
    avgPrice: avgPrice || 0,
    areaMin: num(raw.areaMin) ?? num(raw.area_min) ?? 0,
    areaMax: num(raw.areaMax) ?? num(raw.area_max) ?? 0,
    buildYear: num(raw.buildYear) ?? num(raw.build_year),
    tenureYears: raw.tenureYears || raw.tenure || null,
    propertyType: raw.propertyType || "待确认",
    sources: Array.isArray(raw.sources) && raw.sources.length ? raw.sources.slice() : d.sources || ["manual"],
    tags: Array.isArray(raw.tags) ? raw.tags.slice() : [],
    // 小区轮廓（GCJ-02 [[lng,lat],…]），来自阴影聚类，用来在地图上覆盖阴影
    footprint: Array.isArray(raw.footprint)
      ? raw.footprint
          .slice(0, 300)
          .map((q) => [num(q && q[0]), num(q && q[1])])
          .filter((q) => q[0] != null && q[1] != null)
      : null,
    footprintSource: raw.footprintSource || null,
    poiId: raw.poiId || null,
    // 高德站内 shape_region：[minLng,minLat,maxLng,maxLat]（GCJ-02）
    bbox:
      Array.isArray(raw.bbox) && raw.bbox.length === 4 && raw.bbox.every((v) => Number.isFinite(Number(v)))
        ? raw.bbox.map(Number)
        : null,
    poiDistance: num(raw.poiDistance) ?? null,
    official,
    createdAt: raw.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

/** 支持三种导入形态：本插件导出 / 后端 GeoJSON / 裸数组 */
function parseImportPayload(payload) {
  if (!payload) return [];
  if (payload.type === "FeatureCollection" || Array.isArray(payload.features)) {
    return (payload.features || [])
      .map((f) => normalizeCommunity(Object.assign({}, f.properties || {}, { geometry: f.geometry }), { sources: ["official"] }))
      .filter(Boolean);
  }
  if (Array.isArray(payload.communities)) return payload.communities.map((c) => normalizeCommunity(c)).filter(Boolean);
  if (Array.isArray(payload)) return payload.map((c) => normalizeCommunity(c)).filter(Boolean);
  return [];
}

/* ---------------- 首次启动 ---------------- */

let seeding = null;
async function ensureSeeded() {
  if (seeding) return seeding;
  seeding = (async () => {
    const s = await idb.get("settings", "main");
    if (!s) {
      await idb.put("settings", normalizeSettings({}));
      await addLogs([{ level: "info", source: "bg", msg: "已写入默认设置（空数据）" }]);
    } else if (!s.layout) {
      await idb.put("settings", normalizeSettings(s));
    }
  })();
  try {
    return await seeding;
  } finally {
    seeding = null;
  }
}

/* ---------------- 日志 ---------------- */

const memLog = [];   // 后台自身日志（DB 不可用时的兜底）

async function addLogs(entries) {
  const rows = (entries || []).map((e) => ({
    ts: e.ts || Date.now(),
    level: e.level || "info",
    source: e.source || "bg",
    msg: String(e.msg || ""),
    data: e.data,
    url: e.url,
  }));

  for (const r of rows) {
    const line = `[XAT][${r.source}][${r.level}] ${r.msg}`;
    if (r.level === "error") console.error(line, r.data || "");
    else if (r.level === "warn") console.warn(line, r.data || "");
    else console.log(line, r.data || "");
  }

  try {
    for (const r of rows) await idb.put("logs", r);
    const total = await idb.count("logs");
    if (total > LOG_LIMIT) {
      // 简单裁剪：删掉最早的一批
      const all = await idb.getAll("logs");
      const sorted = all.sort((a, b) => a.id - b.id).slice(0, total - LOG_LIMIT);
      for (const r of sorted) await idb.del("logs", r.id);
    }
  } catch (e) {
    memLog.push(...rows);
    console.error("[XAT][bg] 日志落库失败", e);
  }
  return true;
}

const bgLog = (level, msg, data) => addLogs([{ level, source: "bg", msg, data }]);

/* ---------------- 卫星影像（高德瓦片，GCJ-02 对齐） ---------------- */

const TILE_HOSTS = ["webst01", "webst02", "webst03", "webst04"];
const TILE_PX = 256;
// 阴影分析算法版本：改动 lib/shadow.js 的阈值/流程时递增，旧缓存自动失效
const SHADOW_CACHE_V = 2;

// 站内 poiInfo 的反爬状态：被拦两次就本次会话不再尝试，避免拖慢扫描
let polyBlocked = 0;
// 被拦之后冷却 10 分钟，避免每次保存都白等一轮
let polyCooldownUntil = 0;
let polyTabId = null;
let polyTabTimer = null;

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(s);
  });
}

/** 该 zoom 下、该纬度处 1 像素代表多少米（Web 墨卡托） */
function metersPerPixel(zoom, lat) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

async function analyzeBlob(blob, mPerPx) {
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(TILE_PX, TILE_PX);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, TILE_PX, TILE_PX);
  if (typeof bmp.close === "function") bmp.close();
  const img = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
  return XAT_IMAGERY.analyzeRgba(img.data, TILE_PX, TILE_PX, { mPerPx });
}

/** 取一张卫星瓦片（带本地缓存），返回 {key, blob, feats, bandMask, cached} */
async function getSatTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const centerLat = XAT_IMAGERY.tileToLonLatFloat(x + 0.5, y + 0.5, z)[1];
  const mPerPx = metersPerPixel(z, centerLat);
  const cached = await idb.get("tiles", key).catch(() => null);
  if (cached && cached.blob) {
    const analysis = await analyzeBlob(cached.blob, mPerPx);
    return { key, z, x, y, blob: cached.blob, feats: analysis.features, bandMask: analysis.bandMask, cached: true };
  }
  const host = TILE_HOSTS[Math.abs(x + y) % TILE_HOSTS.length];
  const url = `https://${host}.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`瓦片 ${z}/${x}/${y} HTTP ${res.status}`);
  const blob = await res.blob();
  const analysis = await analyzeBlob(blob, mPerPx);
  await idb.put("tiles", { key, z, x, y, blob, feats: analysis.features, at: Date.now() });
  return { key, z, x, y, blob, feats: analysis.features, bandMask: analysis.bandMask, cached: false };
}

/** 把瓦片拼成一张图；长暗带用半透明红色叠上去，方便人眼核对 */
async function composeMosaic(entries, cols, rows) {
  const W = cols * TILE_PX;
  const H = rows * TILE_PX;
  const base = new OffscreenCanvas(W, H);
  const ctx = base.getContext("2d", { willReadFrequently: true });
  for (const e of entries) {
    const bmp = await createImageBitmap(e.blob);
    ctx.drawImage(bmp, e.col * TILE_PX, e.row * TILE_PX, TILE_PX, TILE_PX);
    if (typeof bmp.close === "function") bmp.close();
  }
  for (const e of entries) {
    if (!e.bandMask) continue;
    const dx = e.col * TILE_PX;
    const dy = e.row * TILE_PX;
    const img = ctx.getImageData(dx, dy, TILE_PX, TILE_PX);
    const d = img.data;
    const m = e.bandMask;
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const i = y * TILE_PX + x;
        if (!m[i]) continue;
        const o = i * 4;
        // 1 像素描边：暗部里也能看出"这里标了"
        const edge =
          x === 0 || y === 0 || x === TILE_PX - 1 || y === TILE_PX - 1 ||
          !m[i - 1] || !m[i + 1] || !m[i - TILE_PX] || !m[i + TILE_PX];
        if (edge) {
          d[o] = 255;
          d[o + 1] = 46;
          d[o + 2] = 32;
        } else {
          d[o] = Math.round(0.6 * 226 + 0.4 * d[o]);
          d[o + 1] = Math.round(0.6 * 56 + 0.4 * d[o + 1]);
          d[o + 2] = Math.round(0.6 * 40 + 0.4 * d[o + 2]);
        }
      }
    }
    ctx.putImageData(img, dx, dy);
  }
  const maxW = 720;
  const scale = Math.min(1, maxW / W);
  const outW = Math.max(64, Math.round(W * scale));
  const outH = Math.max(64, Math.round(H * scale));
  const out = new OffscreenCanvas(outW, outH);
  const octx = out.getContext("2d");
  octx.drawImage(base, 0, 0, outW, outH);
  const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  return { dataUrl: await blobToDataUrl(blob), width: outW, height: outH };
}

function aggregateTiles(tiles) {
  if (!tiles.length) return null;
  const feats = tiles.map((t) => t.feats || {});
  const avg = (fn) => feats.reduce((s, f) => s + (fn(f) || 0), 0) / feats.length;
  return {
    scoreMean: avg((f) => f.score),
    scoreMax: Math.max.apply(null, feats.map((f) => f.score || 0)),
    darkRatioMean: avg((f) => f.darkRatio),
    greenRatioMean: avg((f) => f.greenRatio),
    patchesTotal: feats.reduce((s, f) => s + (f.patches || 0), 0),
    patchAreaM2Sum: feats.reduce((s, f) => s + (f.patchAreaM2 || 0), 0),
    maxPatchM2: feats.reduce((s, f) => Math.max(s, f.maxPatchM2 || 0), 0),
    meanFill: feats.length ? feats.reduce((s, f) => s + (f.meanFill || 0), 0) / feats.length : 0,
    tiles: tiles.length,
  };
}

/* ---------------- RPC ---------------- */

const handlers = {
  async boot() {
    const settings = normalizeSettings(await idb.get("settings", "main"));
    const communities = await idb.getAll("communities");
    const diag = await idb.getAll("diag").catch(() => []);
    return {
      settings,
      communities,
      diag,
      version: chrome.runtime.getManifest().version,
      logCount: await idb.count("logs"),
    };
  },

  async "settings.set"({ patch }) {
    const cur = normalizeSettings(await idb.get("settings", "main"));
    const merged = normalizeSettings(Object.assign({}, cur, patch || {}));
    const next = Object.assign({}, merged, { lastSavedAt: Date.now() });
    await idb.put("settings", next);
    await bgLog("info", "设置已保存", { keys: Object.keys(patch || {}) });
    return next;
  },

  /** 局部更新一条小区（补 bbox / poiId 等），不动其它字段 */
  async "community.patch"({ id, patch } = {}) {
    if (!id) throw new Error("缺少小区 id");
    const row = await idb.get("communities", String(id));
    if (!row) throw new Error("小区不存在");
    const merged = normalizeCommunity(Object.assign({}, row, patch || {}, { id: row.id }));
    await idb.put("communities", merged);
    return merged;
  },

  async "community.put"({ community }) {
    const row = normalizeCommunity(community, { sources: ["manual"] });
    if (!row) throw new Error("小区缺名称或坐标");
    const existing = await idb.get("communities", row.id);
    if (existing) {
      row.createdAt = existing.createdAt || row.createdAt;
      row.sources = Array.from(new Set([...(existing.sources || []), ...row.sources]));
    }
    await idb.put("communities", row);
    await bgLog("info", existing ? "小区已更新" : "小区已录入", { id: row.id, name: row.name });
    return row;
  },

  async "community.del"({ id }) {
    if (!id) throw new Error("缺少 id");
    await idb.del("communities", id);
    await bgLog("info", "小区已删除", { id });
    return true;
  },

  async "data.import"({ payload }) {
    const incoming = parseImportPayload(payload);
    if (!incoming.length) throw new Error("没有可识别的数据：支持 JSON 导出文件或后端 GeoJSON");
    const existing = await idb.getAll("communities");
    const byName = new Map();
    existing.forEach((c) => {
      const key = normalizeName(c.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(c);
    });

    let added = 0;
    let skipped = 0;
    for (const c of incoming) {
      const key = normalizeName(c.name);
      const same = byName.get(key) || [];
      const dup = same.find((e) => haversineM([e.lng, e.lat], [c.lng, c.lat]) < 200);
      if (dup) {
        skipped += 1;
        continue;
      }
      // 同名的别覆盖已有 id
      if (existing.some((e) => e.id === c.id)) c.id = uid("u");
      await idb.put("communities", c);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(c);
      added += 1;
    }
    await bgLog("info", "数据导入完成", { added, skipped, total: incoming.length });
    return { added, skipped, total: incoming.length };
  },

  async "data.reset"() {
    await idb.clear("communities");
    await bgLog("warn", "小区库已清空");
    return { ok: true, communities: [] };
  },

  /**
   * 抓一片区域的卫星图并算特征。
   * 高德影像瓦片是 GCJ-02 对齐的，所以取瓦片前把 WGS84 换成 GCJ-02。
   */
  async "imagery.area"({ lng, lat, radiusM = 1200, maxTiles = 25 } = {}) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("缺少坐标");
    const I = XAT_IMAGERY;
    const requested = Math.max(60, Math.min(6000, Number(radiusM) || 1200));
    const cap = Math.max(1, Math.min(49, Number(maxTiles) || 25));
    // 不低于 z16：z15 及更粗时楼影已经看不出来了，宁可缩小覆盖范围
    const zoom = I.pickZoom(requested, cap, 16);
    const r = Math.min(requested, I.radiusForTiles(zoom, cap));
    const list = I.tilesForCircle(lng, lat, r, zoom);
    const x1 = Math.min.apply(null, list.map((t) => t.x));
    const x2 = Math.max.apply(null, list.map((t) => t.x));
    const y1 = Math.min.apply(null, list.map((t) => t.y));
    const y2 = Math.max.apply(null, list.map((t) => t.y));

    const verdictRows = await idb.getAll("verdicts").catch(() => []);
    const vmap = {};
    verdictRows.forEach((v) => { vmap[v.key] = v.verdict; });

    const fetched = [];
    let failures = 0;
    for (const t of list) {
      try {
        const tile = await getSatTile(t.z, t.x, t.y);
        const center = I.tileToLonLatFloat(t.x + 0.5, t.y + 0.5, t.z);
        const wgs = I.gcj02ToWgs84(center[0], center[1]);
        fetched.push({ ...tile, col: t.x - x1, row: t.y - y1, center: wgs });
      } catch (e) {
        failures += 1;
        await bgLog("warn", "瓦片获取失败", { tile: `${t.z}/${t.x}/${t.y}`, error: String(e) });
      }
      await new Promise((res) => setTimeout(res, 40));
    }
    if (!fetched.length) throw new Error("一张瓦片都没取到（检查网络，或高德域名是否可访问）");

    const mosaic = await composeMosaic(fetched, x2 - x1 + 1, y2 - y1 + 1);
    const tiles = fetched.map((f) => ({
      key: f.key,
      z: f.z,
      x: f.x,
      y: f.y,
      center: f.center,
      score: f.feats.score,
      feats: f.feats,
      verdict: vmap[f.key] || null,
      cached: !!f.cached,
    }));
    const aggregate = aggregateTiles(tiles);
    await bgLog("info", "卫星影像分析完成", { zoom, tiles: tiles.length, failures, scoreMean: aggregate.scoreMean });
    return {
      zoom,
      radiusM: r,
      requestedRadiusM: requested,
      clipped: r < requested - 1,
      tiles,
      aggregate,
      mosaic: mosaic.dataUrl,
      mosaicSize: [mosaic.width, mosaic.height],
      bounds: { x1, x2, y1, y2 },
      failures,
      verdicts: vmap,
    };
  },

  /** 一个小区点位的小范围影像（z18，3×3 瓦片 ≈ 380 m 见方） */
  async "imagery.community"({ lng, lat } = {}) {
    return handlers["imagery.area"]({ lng, lat, radiusM: 170, maxTiles: 9 });
  },

  /* ---------------- 阴影扫描（保存时才触发，逐瓦片返回） ---------------- */

  /**
   * 规划一次扫描：只算瓦片清单，不取图、不计算。
   * 已缓存过阴影结果的瓦片标记 cached，前端可以直接画、不用等。
   */
  async "scan.plan"({ lng, lat, radiusM = 600, maxTiles = 400, zoom: fixedZoom } = {}) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("缺少坐标");
    const I = XAT_IMAGERY;
    const requested = Math.max(150, Math.min(20000, Number(radiusM) || 600));
    const cap = Math.max(1, Math.min(1200, Number(maxTiles) || 400));
    // 不再裁剪半径：按圆算全部瓦片，瓦片太多时降低 zoom（而不是缩小范围）
    const zoom = Number.isFinite(fixedZoom)
      ? Math.max(12, Math.min(18, fixedZoom))
      : I.pickZoom(requested, cap, 12);
    const r = requested;
    let list = I.tilesForCircle(lng, lat, r, zoom);
    const truncated = list.length > cap;
    if (truncated) list = list.slice(0, cap);
    const rows = await idb.getAll("tiles").catch(() => []);
    const done = new Set(rows.filter((t) => t && t.shadow).map((t) => t.key));
    const tiles = list.map((t) => {
      const key = `${t.z}/${t.x}/${t.y}`;
      return { z: t.z, x: t.x, y: t.y, key, cached: done.has(key) };
    });
    return {
      zoom,
      radiusM: r,
      requestedRadiusM: requested,
      clipped: truncated,
      truncated,
      maxTiles: cap,
      tiles,
      cachedCount: tiles.filter((t) => t.cached).length,
    };
  },

  /** 单瓦片：命中缓存直接返回；否则取图 → 阴影分析 → 落库 */
  async "scan.tile"({ z, x, y, ratio } = {}) {
    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("缺少瓦片坐标");
    const key = `${z}/${x}/${y}`;
    const row = await idb.get("tiles", key).catch(() => null);
    const sameRatio = !Number.isFinite(ratio) || !row?.shadow?.ratio || row.shadow.ratio === ratio;
    if (row && row.shadow && row.shadow.v === SHADOW_CACHE_V && sameRatio) {
      return Object.assign({ key, cached: true }, row.shadow);
    }

    const centerLat = XAT_IMAGERY.tileToLonLatFloat(x + 0.5, y + 0.5, z)[1];
    const mPerPx = metersPerPixel(z, centerLat);

    let blob = row && row.blob;
    if (!blob) {
      const host = TILE_HOSTS[Math.abs(x + y) % TILE_HOSTS.length];
      const url = `https://${host}.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`瓦片 ${key} HTTP ${res.status}`);
      blob = await res.blob();
    }

    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(TILE_PX, TILE_PX);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, TILE_PX, TILE_PX);
    if (typeof bmp.close === "function") bmp.close();
    const img = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
    const opts = { mPerPx, z, tx: x, ty: y };
    if (Number.isFinite(ratio)) opts.ratio = Math.max(0.1, Math.min(0.6, ratio));
    const out = XAT_SHADOW.analyzeTile(img.data, TILE_PX, opts);

    // 掩膜存成 PNG，前端按瓦片贴图直接画（凸包会拼出方格网，看着歪）
    let maskPng = null;
    if (out.maskRgba) {
      try {
        const cv = new OffscreenCanvas(TILE_PX, TILE_PX);
        cv.getContext("2d").putImageData(new ImageData(out.maskRgba, TILE_PX, TILE_PX), 0, 0);
        const blob = await cv.convertToBlob({ type: "image/png" });
        maskPng = await blobToDataUrl(blob);
      } catch (e) {
        await bgLog("warn", "掩膜编码失败", { tile: key, error: String(e) });
      }
    }

    const shadow = { v: SHADOW_CACHE_V, coverage: out.coverage, blobs: out.blobs, ref: out.ref, ms: out.ms, maskPng, ratio: Number.isFinite(ratio) ? ratio : null, at: Date.now() };
    await idb.put("tiles", Object.assign({}, row || {}, { key, z, x, y, blob, shadow, at: Date.now() }));
    return Object.assign({ key, cached: false }, shadow);
  },

  /** 路网：Overpass 取干道，转 GCJ 供地图绘制。失败不阻塞扫描。 */
  async "scan.roads"({ bbox } = {}) {
    if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("缺少 bbox");
    const [s, w, n, e] = bbox; // WGS84: south, west, north, east
    const q = `[out:json][timeout:25];way["highway"~"primary|secondary|tertiary|residential|trunk"](${s},${w},${n},${e});out geom;`;
    // Overpass 经常 502（过载），换镜像 + 重试一次
    const mirrors = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass-api.de/api/interpreter",
      "https://overpass.osm.ch/api/interpreter",
    ];
    let data = null;
    let lastErr = "";
    for (const url of mirrors) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q),
        });
        if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
        const json = await res.json();
        if (json && Array.isArray(json.elements) && json.elements.length) { data = json; break; }
        data = json;
      } catch (e) {
        lastErr = String(e);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!data) throw new Error(`Overpass 失败：${lastErr}`);
    const roads = [];
    for (const el of data.elements || []) {
      if (el.type !== "way" || !el.geometry) continue;
      const line = el.geometry.map((p) => XAT_IMAGERY.wgs84ToGcj02(p.lon, p.lat));
      if (line.length > 1) roads.push({ class: (el.tags && el.tags.highway) || "road", line });
    }
    return { count: roads.length, roads };
  },

  /**
   * 高德 POI 周边搜索（小区）。入参经纬度是 GCJ-02。
   * key 走设置页填的 amapKey（Web 服务 key），没配就报错让用户去填。
   */
  async "poi.nearby"({ lng, lat, radius = 250, limit = 6, types = "120302" } = {}) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("缺少坐标");
    const s = normalizeSettings(await idb.get("settings", "main"));
    const key = String(s.amapKey || "").trim() || DEFAULT_AMAP_KEY;
    if (!key) throw new Error("还没配高德 key（设置与诊断 → 高德 Web 服务 key）");
    const url =
      "https://restapi.amap.com/v3/place/around?key=" + encodeURIComponent(key) +
      "&location=" + lng.toFixed(6) + "," + lat.toFixed(6) +
      "&radius=" + Math.max(50, Math.min(1000, Number(radius) || 250)) +
      "&types=" + encodeURIComponent(types) +
      "&offset=" + Math.max(1, Math.min(25, Number(limit) || 6)) +
      "&page=1&extensions=base&sortrule=distance";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`高德 POI HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "1") throw new Error(`高德 POI 失败：${json.info || json.infocode}`);
    const pois = (json.pois || []).map((p) => {
      const [plng, plat] = String(p.location || "").split(",").map(Number);
      return {
        id: p.id,
        name: p.name,
        address: p.address,
        district: p.adname,
        type: p.type,
        lng: plng,
        lat: plat,
        distance: Number(p.distance) || null,
      };
    }).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat));
    return { count: pois.length, pois };
  },

  /**
   * 小区边界：高德 PC 站内接口 /ssr/api/getPoiDetail?id=<poiId>
   * 返回 data.spec.mining_shape.shape = "lng,lat;lng,lat;…"（GCJ-02）。
   * 这个接口有反爬（bx-ua / x-dc 指纹头由站点 JS 生成），所以必须在**真实高德标签页**的
   * MAIN world 里发 XHR。拿不到（验证码/超时）返回 ok:false，调用方回退到阴影轮廓。
   */
  async "poi.polygon"({ id, name } = {}) {
    if (!id) throw new Error("缺少 POI id");
    const url = "https://amap-pc-ssr.amap.com/ssr/api/getPoiDetail?id=" + encodeURIComponent(id);
    const r = await amapInternalFetch(url);
    if (!r.ok) return { ok: false, reason: r.reason, id };
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      return { ok: false, reason: "not-json", id };
    }
    const spec = json && json.data && json.data.spec;
    const pts = parsePolygonString(spec && spec.mining_shape && spec.mining_shape.shape);
    if (!pts) return { ok: false, reason: "no-shape", id };
    const base = (json.data && json.data.base) || {};
    return { ok: true, id, name: base.name || name || null, address: base.address || null, pts, source: "amap-getPoiDetail" };
  },

  /**
   * 周边小区。优先级：
   *   1) 站内 RQBXY —— 带 shape_region（外接矩形），但需要真实高德标签页 + 反爬头；
   *   2) Web 服务 place/around —— 稳定但只有点位。
   * 有高德标签页（或设置允许后台开）时才走 1；站内这条最多等 12 秒，超时/被拦立刻回退。
   */
  async "poi.around"({ lng, lat, range = 1000, keywords = "小区", city = "610100", pagesize = 25 } = {}) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("缺少圆心坐标");
    const requested = Math.round(Number(range) || 0);
    const r = Math.max(100, Math.min(5000, requested));
    const settings = normalizeSettings(await idb.get("settings", "main"));

    const tabs = await chrome.tabs.query({ url: "https://www.amap.com/*" }).catch(() => []);
    const allowTab = !!settings.amapTabForBoxes;
    // 主查询只复用「已经打开的」高德页；开新标签页留给后台补矩形，避免又一次卡住
    const siteTried = tabs.length > 0 && Date.now() >= polyCooldownUntil;
    let siteReason = null;

    if (siteTried) {
      const url =
        "https://www.amap.com/service/poiInfo?query_type=RQBXY&pagesize=" + pagesize + "&pagenum=1" +
        "&qii=true&cluster_state=5&need_utd=true&utd_sceneid=1000&div=PC1000" +
        "&addr_poi_merge=true&is_classify=true&zoom=17.5" +
        "&keywords=" + encodeURIComponent(keywords) +
        "&longitude=" + lng.toFixed(6) + "&latitude=" + lat.toFixed(6) +
        "&range=" + r + "&city=" + encodeURIComponent(city);
      const internal = await amapInternalFetch(url, { allowCreateTab: false });
      if (internal.ok) {
        try {
          const json = JSON.parse(internal.text);
          const list = (json.data && json.data.poi_list) || [];
          const pois = list.map(normalizeSitePoi).filter(Boolean);
          if (pois.length) {
            const withBox = pois.filter((p) => p.bbox).length;
            await bgLog("info", "周边小区（站内）", { count: pois.length, boxes: withBox, range: r });
            return {
              ok: true, source: "amap-site", range: r, requested, clamped: requested > r,
              count: pois.length, boxes: withBox, pois,
            };
          }
          siteReason = "empty";
        } catch (e) {
          siteReason = "parse";
          await bgLog("warn", "站内周边解析失败", { error: String(e) });
        }
      } else {
        siteReason = internal.reason;
      }
    } else {
      siteReason = "no-tab";
    }

    // 回退：Web 服务（只有点位）
    const key = String(settings.amapKey || "").trim() || DEFAULT_AMAP_KEY;
    const url =
      "https://restapi.amap.com/v3/place/around?key=" + encodeURIComponent(key) +
      "&location=" + lng.toFixed(6) + "," + lat.toFixed(6) +
      "&radius=" + r + "&types=120302&offset=" + Math.max(1, Math.min(25, pagesize)) +
      "&page=1&extensions=base&sortrule=distance";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`周边搜索 HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "1") throw new Error(`周边搜索失败：${json.info || json.infocode}`);
    const pois = (json.pois || [])
      .map((p) => {
        const [plng, plat] = String(p.location || "").split(",").map(Number);
        if (!Number.isFinite(plng) || !Number.isFinite(plat)) return null;
        return {
          id: p.id, name: p.name, address: p.address || "", district: p.adname || null,
          lng: plng, lat: plat, distance: Number(p.distance) || null,
          typecode: p.typecode || null, bbox: null,
        };
      })
      .filter(Boolean);
    await bgLog("info", "周边小区（Web 服务）", { count: pois.length, range: r, why: siteReason });
    return {
      ok: true, source: "amap-rest", range: r, requested, clamped: requested > r,
      count: pois.length, boxes: 0, siteReason, pois,
    };
  },

  /** 诊断：强制走一次站内接口，把结果/原因/响应头返回给面板 */
  async "poi.diag"({ lng, lat, range = 1000, city = "610100" } = {}) {
    const r = Math.max(100, Math.min(5000, Math.round(Number(range) || 1000)));
    const url =
      "https://www.amap.com/service/poiInfo?query_type=RQBXY&pagesize=25&pagenum=1" +
      "&qii=true&cluster_state=5&need_utd=true&utd_sceneid=1000&div=PC1000" +
      "&addr_poi_merge=true&is_classify=true&zoom=17.5&keywords=%E5%B0%8F%E5%8C%BA" +
      "&longitude=" + lng.toFixed(6) + "&latitude=" + lat.toFixed(6) +
      "&range=" + r + "&city=" + encodeURIComponent(city);
    const before = polyCooldownUntil;
    polyCooldownUntil = 0;
    polyBlocked = 0;
    const r2 = await amapInternalFetch(url, { allowCreateTab: true });
    polyCooldownUntil = before;
    if (!r2.ok) return { ok: false, reason: r2.reason, status: r2.status, head: r2.head || "" };
    let n = 0;
    let withBox = 0;
    try {
      const json = JSON.parse(r2.text);
      const list = (json.data && json.data.poi_list) || [];
      n = list.length;
      withBox = list.filter((p) => normalizeSitePoi(p) && normalizeSitePoi(p).bbox).length;
    } catch { /* ignore */ }
    return { ok: true, pois: n, withBox, head: r2.text.slice(0, 160) };
  },

  /**
   * 外接矩形：站内 RQBXY 一次能带回整页的 shape_region，按 id 对齐。
   * 需要真实高德标签页（反爬头）；失败就返回 ok:false，调用方不画矩形。
   */
  async "poi.aroundBoxes"({ lng, lat, range = 1000, keywords = "小区", city = "610100", allowTab = false } = {}) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("缺少圆心坐标");
    const r = Math.max(100, Math.min(5000, Math.round(Number(range) || 0)));
    const url =
      "https://www.amap.com/service/poiInfo?query_type=RQBXY&pagesize=25&pagenum=1" +
      "&qii=true&cluster_state=5&need_utd=true&utd_sceneid=1000&div=PC1000" +
      "&addr_poi_merge=true&is_classify=true&zoom=17.5" +
      "&keywords=" + encodeURIComponent(keywords) +
      "&longitude=" + lng.toFixed(6) + "&latitude=" + lat.toFixed(6) +
      "&range=" + r + "&city=" + encodeURIComponent(city);
    const internal = await amapInternalFetch(url, { allowCreateTab: !!allowTab });
    if (!internal.ok) return { ok: false, reason: internal.reason, head: internal.head };
    try {
      const json = JSON.parse(internal.text);
      const list = (json.data && json.data.poi_list) || [];
      const boxes = list
        .map((p) => {
          const poi = normalizeSitePoi(p);
          return poi && poi.bbox ? { id: poi.id, name: poi.name, bbox: poi.bbox } : null;
        })
        .filter(Boolean);
      await bgLog("info", "周边小区外接矩形", { boxes: boxes.length });
      return { ok: true, source: "amap-site", boxes };
    } catch (e) {
      await bgLog("warn", "外接矩形解析失败", { error: String(e) });
      return { ok: false, reason: "parse" };
    }
  },

  /** 人工判定：like / dislike / ignore / none（清除） */
  async "imagery.verdict"({ key, verdict }) {
    if (!key) throw new Error("缺少瓦片 key");
    const v = String(verdict || "none");
    if (v === "none") await idb.del("verdicts", key);
    else await idb.put("verdicts", { key, verdict: v, at: Date.now() });
    await bgLog("info", "影像判定已记录", { key, verdict: v });
    return { key, verdict: v === "none" ? null : v };
  },

  async "imagery.cache"() {
    const all = await idb.getAll("tiles").catch(() => []);
    const withShadow = all.filter((t) => t && t.shadow);
    const stale = withShadow.filter((t) => t.shadow.v !== SHADOW_CACHE_V).length;
    return {
      count: all.length,
      shadowCount: withShadow.length,
      staleShadow: stale,
      bytes: all.reduce((s, t) => s + (t.blob ? t.blob.size : 0), 0),
      shadowBytes: withShadow.reduce((s, t) => s + (t.shadow.maskPng ? t.shadow.maskPng.length : 0), 0),
    };
  },

  /** 只清阴影分析结果，保留瓦片图（下次扫描不用重新下载） */
  async "imagery.clearShadow"() {
    const all = await idb.getAll("tiles").catch(() => []);
    let n = 0;
    for (const t of all) {
      if (!t || !t.shadow) continue;
      delete t.shadow;
      await idb.put("tiles", t);
      n += 1;
    }
    await bgLog("warn", "阴影缓存已清空（瓦片保留）", { tiles: n });
    return { ok: true, cleared: n, kept: all.length };
  },

  async "imagery.clear"() {
    await idb.clear("tiles");
    await bgLog("warn", "卫星瓦片缓存已清空");
    return { ok: true };
  },

  async "log.add"({ entries }) {
    await addLogs(entries);
    return { count: (entries || []).length };
  },

  async "log.list"({ limit, level } = {}) {
    const all = await idb.getAll("logs").catch(() => memLog);
    const order = { debug: 10, info: 20, warn: 30, error: 40 };
    const filtered = level ? all.filter((r) => (order[r.level] || 20) >= (order[level] || 0)) : all;
    return filtered.sort((a, b) => b.id - a.id).slice(0, limit || 300);
  },

  async "log.clear"() {
    await idb.clear("logs");
    memLog.length = 0;
    return true;
  },

  async "diag.report"({ tabId, patch }) {
    if (!tabId) return false;
    const cur = (await idb.get("diag", tabId)) || { tabId };
    const next = { ...cur, ...patch, tabId, updatedAt: Date.now() };
    await idb.put("diag", next);
    return true;
  },

  async "diag.list"() {
    return await idb.getAll("diag").catch(() => []);
  },

  async openTab({ url, active }) {
    if (!/^https:\/\/([\w-]+\.)*amap\.com\//.test(url)) {
      await bgLog("warn", "拒绝打开非高德域名", { url });
      throw new Error("只允许打开 amap.com 的链接");
    }
    const tab = await chrome.tabs.create({ url, active: active !== false });
    await bgLog("info", "已打开高德算路标签", { url, tabId: tab.id });
    return { tabId: tab.id };
  },

  async "self.check"() {
    return {
      manifest: chrome.runtime.getManifest(),
      logCount: await idb.count("logs"),
      communityCount: await idb.count("communities"),
      diag: await idb.getAll("diag").catch(() => []),
      now: new Date().toISOString(),
    };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "xat.openOptions") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (!msg || msg.type !== "xat.rpc") return false;
  const fn = handlers[msg.method];
  if (!fn) {
    sendResponse({ ok: false, error: `未知方法 ${msg.method}` });
    return false;
  }
  Promise.resolve()
    .then(() => fn(msg.params || {}, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => {
      bgLog("error", `RPC ${msg.method} 失败`, { error: String(e && e.stack ? e.stack : e) });
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    });
  return true;   // 异步响应
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await bgLog("info", "扩展已安装/更新", { reason: details.reason, version: chrome.runtime.getManifest().version });
  await ensureSeeded();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSeeded().catch((e) => console.error("[XAT][bg] 启动初始化失败", e));
});

// service worker 每次唤醒都确保有默认设置（幂等）
ensureSeeded()
  .then(() => migrateBoxTab())
  .then(() => bgLog("debug", "service worker 就绪"))
  .catch((e) => console.error("[XAT][bg] 初始化失败", e));
