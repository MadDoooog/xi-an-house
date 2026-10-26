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

const DB_NAME = "xat";
const DB_VERSION = 2;
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

const DEFAULT_SETTINGS = {
  key: "main",
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
  .then(() => bgLog("debug", "service worker 就绪"))
  .catch((e) => console.error("[XAT][bg] 初始化失败", e));
