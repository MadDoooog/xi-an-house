/* ============================================================
   西接通勤 · background service worker
   职责：
   1) 唯一的本地数据库（IndexedDB），避免数据绑在 amap.com 的 origin 上
   2) 日志落库 + 诊断信息汇聚（远程排错靠它）
   3) 打开"去高德算路"的标签页
   所有调用都走 {type:'xat.rpc', method, params}，返回 {ok,data}|{ok:false,error}
   ============================================================ */
"use strict";

const DB_NAME = "xat";
const DB_VERSION = 1;
const LOG_LIMIT = 2000;

/* ---------------- IndexedDB ---------------- */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("communities")) db.createObjectStore("communities", { keyPath: "id" });
      if (!db.objectStoreNames.contains("logs")) {
        const s = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        s.createIndex("ts", "ts");
      }
      if (!db.objectStoreNames.contains("diag")) db.createObjectStore("diag", { keyPath: "tabId" });
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

/* ---------------- 初始数据 ---------------- */

const DEFAULT_SETTINGS = {
  key: "main",
  destinations: [
    { id: "d1", name: "高新一路 18 号", lng: 108.94, lat: 34.26, mode: "drive" },
    { id: "d2", name: "曲江池东路 1 号", lng: 109.02, lat: 34.22, mode: "transit" },
    { id: "d3", name: "未央路 12 号", lng: 108.995, lat: 34.285, mode: "drive" },
  ],
  destinationCount: 3,
  radiusKm: 3,
  budget: { totalMin: 150, totalMax: 320, areaMin: 80, areaMax: 140, priceMax: 24000 },
  tenure: ["商品房"],
  sources: ["official", "manual", "poi", "seed"],
  departAt: "08:00",
  sortBy: "commute",
  showOut: true,
  // 阶段 3d 起才用到；先留字段，避免以后迁移
  commuteQuota: 10,
  lastSavedAt: null,
};

const SEED_COMMUNITIES = [
  { id: "c1", name: "天瑞瑞璟小区", district: "雁塔", sub: "曲江", lng: 108.965, lat: 34.245, avgPrice: 21000, areaMin: 89, areaMax: 143, buildYear: 2016, tenureYears: "70年", propertyType: "商品房", sources: ["official", "manual"], tags: ["临铁"], official: { permitNo: "2026289", filingPrice: 20160, soldRatio: 0.76 } },
  { id: "c2", name: "紫薇田园都市", district: "雁塔", sub: "电子城", lng: 109.005, lat: 34.232, avgPrice: 16400, areaMin: 78, areaMax: 132, buildYear: 2011, tenureYears: "70年", propertyType: "商品房", sources: ["manual", "poi"], tags: ["学区"], official: null },
  { id: "c3", name: "枫林绿洲", district: "高新", sub: "软件园", lng: 108.978, lat: 34.251, avgPrice: 23800, areaMin: 95, areaMax: 168, buildYear: 2018, tenureYears: "70年", propertyType: "商品房", sources: ["official", "manual"], tags: ["临铁", "学区"], official: { permitNo: "2026142", filingPrice: 22848, soldRatio: 0.81 } },
  { id: "c4", name: "曲江华著中城", district: "雁塔", sub: "曲江", lng: 109.012, lat: 34.238, avgPrice: 19600, areaMin: 88, areaMax: 126, buildYear: 2015, tenureYears: "70年", propertyType: "商品房", sources: ["manual"], tags: ["学区"], official: null },
  { id: "c5", name: "金地湖城大境", district: "雁塔", sub: "曲江", lng: 109.02, lat: 34.228, avgPrice: 25400, areaMin: 102, areaMax: 180, buildYear: 2019, tenureYears: "70年", propertyType: "商品房", sources: ["poi", "manual"], tags: ["临湖"], official: null },
  { id: "c6", name: "万科金域华府", district: "高新", sub: "唐延路", lng: 108.952, lat: 34.238, avgPrice: 22600, areaMin: 86, areaMax: 135, buildYear: 2017, tenureYears: "70年", propertyType: "商品房", sources: ["official", "manual"], tags: ["临铁"], official: { permitNo: "2025907", filingPrice: 21700, soldRatio: 0.63 } },
  { id: "c7", name: "雅荷四季城", district: "未央", sub: "凤城", lng: 108.99, lat: 34.258, avgPrice: 13900, areaMin: 74, areaMax: 118, buildYear: 2009, tenureYears: "70年", propertyType: "经济适用房", sources: ["manual"], tags: [], official: null },
  { id: "c8", name: "高新云顶", district: "高新", sub: "科技路", lng: 108.945, lat: 34.25, avgPrice: 18200, areaMin: 92, areaMax: 150, buildYear: 2021, tenureYears: "50年", propertyType: "公寓", sources: ["poi"], tags: [], official: null },
  { id: "c9", name: "香格里拉尚城", district: "雁塔", sub: "小寨", lng: 109.0, lat: 34.248, avgPrice: 17500, areaMin: 70, areaMax: 110, buildYear: 2007, tenureYears: "70年", propertyType: "商品房", sources: ["manual", "poi"], tags: ["学区"], official: null },
  { id: "c10", name: "龙湖香醍", district: "雁塔", sub: "曲江", lng: 109.015, lat: 34.252, avgPrice: 26800, areaMin: 110, areaMax: 190, buildYear: 2020, tenureYears: "70年", propertyType: "商品房", sources: ["official", "manual"], tags: ["临湖", "临铁"], official: { permitNo: "2026331", filingPrice: 25900, soldRatio: 0.55 } },
  { id: "c11", name: "融创曲江印", district: "雁塔", sub: "曲江", lng: 109.008, lat: 34.222, avgPrice: 31200, areaMin: 120, areaMax: 210, buildYear: 2022, tenureYears: "70年", propertyType: "商品房", sources: ["poi"], tags: ["临湖"], official: null },
  { id: "c12", name: "国宾中央区", district: "雁塔", sub: "电视塔", lng: 108.988, lat: 34.228, avgPrice: 15800, areaMin: 80, areaMax: 124, buildYear: 2013, tenureYears: "70年", propertyType: "安置房", sources: ["seed"], tags: [], official: null },
];

let seeding = null;
async function ensureSeeded() {
  if (seeding) return seeding;
  seeding = (async () => {
  const s = await idb.get("settings", "main");
  if (!s) {
    await idb.put("settings", { ...DEFAULT_SETTINGS });
    await addLogs([{ level: "info", source: "bg", msg: "已写入默认设置" }]);
  }
  const n = await idb.count("communities");
  if (!n) {
    for (const c of SEED_COMMUNITIES) await idb.put("communities", { ...c });
    await addLogs([{ level: "info", source: "bg", msg: `已写入样例小区 ${SEED_COMMUNITIES.length} 条` }]);
  }
  })();
  try { return await seeding; } finally { seeding = null; }
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
    const settings = (await idb.get("settings", "main")) || { ...DEFAULT_SETTINGS };
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
    const cur = (await idb.get("settings", "main")) || { ...DEFAULT_SETTINGS };
    const next = { ...cur, ...patch, lastSavedAt: Date.now() };
    await idb.put("settings", next);
    await bgLog("info", "设置已保存", { keys: Object.keys(patch || {}) });
    return next;
  },

  async "seed.reset"() {
    await idb.clear("communities");
    for (const c of SEED_COMMUNITIES) await idb.put("communities", { ...c });
    await bgLog("warn", "样例数据已重置");
    return await idb.getAll("communities");
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

// service worker 每次唤醒都确保有种子数据（幂等）
ensureSeeded()
  .then(() => bgLog("debug", "service worker 就绪"))
  .catch((e) => console.error("[XAT][bg] 初始化失败", e));
