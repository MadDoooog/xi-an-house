import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "app", "background.js");
const results = [];
const check = (name, pass, extra) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

/* ---------- 造一个 v1 旧库：12 条样例 + 1 条用户自录 + 3 个假目的地 ---------- */
const v1 = await new Promise((resolve, reject) => {
  const req = indexedDB.open("xat", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("settings", { keyPath: "key" });
    db.createObjectStore("communities", { keyPath: "id" });
    const s = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
    s.createIndex("ts", "ts");
    db.createObjectStore("diag", { keyPath: "tabId" });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

await new Promise((resolve, reject) => {
  const t = v1.transaction(["communities", "settings"], "readwrite");
  const cs = t.objectStore("communities");
  for (let i = 1; i <= 12; i += 1) {
    cs.put({
      id: "c" + i,
      name: "样例小区" + i,
      lng: 108.9 + i / 100,
      lat: 34.2,
      avgPrice: 20000,
      areaMin: 80,
      areaMax: 120,
      buildYear: 2015,
      tenureYears: "70年",
      propertyType: "商品房",
      sources: ["seed"],
      tags: [],
      official: null,
    });
  }
  cs.put({ id: "u-mine", name: "我录的小区", lng: 108.95, lat: 34.25, avgPrice: 15000, areaMin: 60, areaMax: 90, sources: ["manual"], tags: [] });
  t.objectStore("settings").put({
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
    commuteQuota: 10,
  });
  t.oncomplete = resolve;
  t.onerror = () => reject(t.error);
});
v1.close();
console.log("已造好 v1 旧库：12 条样例 + 1 条自录 + 3 个假目的地");

/* ---------- 用真实的 background.js 打开（应触发 v1→v2 迁移） ---------- */
const src = fs.readFileSync(SRC, "utf8");
let onMessage = null;
const EXT_DIR = path.join(HERE, "..", "app");
const chromeStub = {
  runtime: {
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getManifest: () => ({ version: "0.2.0" }),
    openOptionsPage: () => {},
  },
  tabs: { create: async () => ({ id: 1 }) },
};
const ctx = vm.createContext({
  indexedDB,
  importScripts: (rel) => {
    const code = fs.readFileSync(path.join(EXT_DIR, rel), "utf8");
    vm.runInContext(code, ctx);
  },
  IDBKeyRange,
  chrome: chromeStub,
  console: { log() {}, warn() {}, error() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});
vm.runInContext("var self = globalThis;", ctx);
vm.runInContext(src, ctx);
await new Promise((r) => setTimeout(r, 600));

const call = (method, params) =>
  new Promise((resolve, reject) => {
    onMessage({ type: "xat.rpc", method, params }, {}, (r) => (r && r.ok ? resolve(r.data) : reject(new Error((r && r.error) || "no response"))));
    if (!onMessage) reject(new Error("onMessage 未注册"));
  });

/* ---------- 断言 ---------- */
const boot = await call("boot");
const names = boot.communities.map((c) => c.name);
check("迁移：12 条样例被清掉", !names.some((n) => n.startsWith("样例小区")), names.join(","));
check("迁移：用户自录的小区保留", names.includes("我录的小区"), names.join(","));
check("迁移：3 个假目的地被清空", (boot.settings.destinations || []).length === 0, JSON.stringify(boot.settings.destinations));
check("迁移：补上侧栏留白默认值", boot.settings.layout && boot.settings.layout.top === 72 && boot.settings.layout.bottom === 24, JSON.stringify(boot.settings.layout));

const imp = await call("data.import", {
  payload: {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { id: 7, name: "导入小区甲", display_price: 21000 }, geometry: { type: "Polygon", coordinates: [[[108.96, 34.24], [108.97, 34.24], [108.97, 34.25], [108.96, 34.24]]] } },
      { type: "Feature", properties: { id: 8, name: "导入小区甲", display_price: 21000 }, geometry: { type: "Polygon", coordinates: [[[108.9601, 34.2401], [108.9701, 34.2401], [108.9701, 34.2501], [108.9601, 34.2401]]] } },
      { type: "Feature", properties: { id: 9, name: "我录的小区" }, geometry: { type: "Polygon", coordinates: [[[108.95, 34.25], [108.951, 34.25], [108.951, 34.251], [108.95, 34.25]]] } },
    ],
  },
});
check("导入：同名 200m 内去重", imp.added === 1 && imp.skipped === 2, JSON.stringify(imp));

const after = await call("boot");
const impRow = after.communities.find((c) => c.name === "导入小区甲");
check("导入：GeoJSON 取多边形中心", impRow && Math.abs(impRow.lng - 108.96667) < 0.002 && Math.abs(impRow.lat - 34.24333) < 0.002, impRow && `${impRow.lng},${impRow.lat}`);
check("导入：来源标为 official", impRow && impRow.sources.includes("official"), impRow && impRow.sources.join(","));

const saved = await call("community.put", {
  community: { id: "u-test", name: "手录小区丙", lng: 108.955, lat: 34.256, avgPrice: 18000, areaMin: 70, areaMax: 100, propertyType: "商品房", tags: ["临铁"] },
});
check("手录：normalize 后带 id/坐标/来源", saved.id === "u-test" && saved.lng === 108.955 && saved.sources.includes("manual"), JSON.stringify({ id: saved.id, src: saved.sources }));

const updated = await call("community.put", { community: { ...saved, avgPrice: 19500, sources: ["official"] } });
check("编辑：来源合并而不是覆盖", updated.sources.includes("manual") && updated.sources.includes("official"), updated.sources.join(","));

await call("community.del", { id: "u-test" });
const afterDel = await call("boot");
check("删除：小区没了", !afterDel.communities.some((c) => c.id === "u-test"));

await call("data.reset");
const afterReset = await call("boot");
check("清空：小区库为空", afterReset.communities.length === 0, "n=" + afterReset.communities.length);

let err = null;
try {
  await call("data.import", { payload: { nope: true } });
} catch (e) {
  err = String(e.message || e);
}
check("导入：不认识的数据给明确报错", /没有可识别/.test(err || ""), err);

const set = await call("settings.set", { patch: { layout: { top: 120, bottom: 40 } } });
check("设置：patch 合并后落库", set.layout.top === 120 && set.layout.bottom === 40, JSON.stringify(set.layout));

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  failed.forEach((f) => console.log(" - " + f.name));
  process.exitCode = 1;
}
