/* ============================================================
   地图适配层：让 content/ui.js 以为自己还挂在高德地图上

   ui.js 只通过 window.postMessage 跟 MAIN world 的地图钩子对话：
     发：{__xat:'ui', type:'project'|'fit'|'get-info'|'ping'|'freeze'|'geocode'}
     收：{__xat:'main', type:'project-result'|'map-ready'|'view-change'|'map-info'|'pong'}
   这里用 lib/slippymap.js 的自绘地图把这套消息实现掉，侧栏完全不用改。

   「扫描」= 求搜索圆的圆心 → 调高德周边小区接口（query_type=RQBXY）→ 写入面板。
   不再做任何阴影识别。
   ============================================================ */
(function () {
  "use strict";

  const HOOK_VERSION = "shim-2";
  const post = (type, payload) => window.postMessage({ __xat: "main", type, payload }, "*");

  const el = document.getElementById("map");
  const map = new XAT_MAP.SlippyMap(el, { center: [108.880017, 34.194737], zoom: 15 });
  window.__xatMap = map;

  let readyPosted = false;
  let scanning = false;

  const rawSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      rawSend({ type: "xat.rpc", method, params }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!res) reject(new Error("后台无响应"));
        else if (res.ok) resolve(res.data);
        else reject(new Error(res.error || "调用失败"));
      });
    });

  function info() {
    const r = el.getBoundingClientRect();
    return {
      ready: true,
      patched: true,
      zoom: map.zoom,
      center: map.center.slice(),
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      size: { width: r.width, height: r.height },
      hookVersion: HOOK_VERSION,
    };
  }

  function emitReady(why) {
    if (readyPosted) return;
    readyPosted = true;
    post("map-ready", Object.assign(info(), { why }));
  }

  map.on("move", () => {
    emitReady("move");
    post("view-change", info());
  });

  /* ---------------- ui.js → 钩子 ---------------- */

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__xat !== "ui") return;

    if (d.type === "project") {
      const pts = (d.points || []).map((p) => {
        const s = map.project(p[0], p[1]);
        return [s[0], s[1]];
      });
      post("project-result", { reqId: d.reqId, points: pts, info: info(), ready: true });
      return;
    }
    if (d.type === "get-info") {
      post("map-info", info());
      return;
    }
    if (d.type === "ping") {
      post("pong", { ready: true, patched: true, instances: 1, hookVersion: HOOK_VERSION });
      return;
    }
    if (d.type === "fit") {
      const { center, zoom } = d || {};
      if (Array.isArray(center) && Number.isFinite(center[0])) map.center = center.slice();
      if (Number.isFinite(zoom)) map.zoom = Math.max(map.minZoom, Math.min(map.maxZoom, zoom));
      map.draw();
      setTimeout(() => post("view-change", info()), 80);
      return;
    }
    if (d.type === "freeze") {
      map.setInteractive(!d.on);
      return;
    }
    if (d.type === "geocode") {
      post("geocode-result", { reqId: d.reqId, ok: false, error: "此页面不支持地址解析，请在地图上右键取点" });
      return;
    }
  });

  map.on("contextmenu", ({ lngLat }) => {
    post("ctx-copy", { gcj: [lngLat[0], lngLat[1]] });
  });

  /* ---------------- 搜索圆 ---------------- */

  const R = 6371000;
  function haversineM(a, b) {
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLng = ((b[0] - a[0]) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** 圆心 = 所有目的地的中点；半径 = 最远目的地 + 设置里的搜索半径 */
  function circleOf(settings) {
    const dests = (settings && settings.destinations) || [];
    if (!dests.length) return null;
    const pts = dests.map((d) => XAT_IMAGERY.wgs84ToGcj02(d.lng, d.lat));
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const far = Math.max(...pts.map((p) => haversineM([cx, cy], p)));
    const km = Number(settings.radiusKm) || 1;
    return { center: [cx, cy], radius: Math.max(200, far + km * 1000) };
  }

  /* ---------------- 周边小区 ---------------- */

  async function scan() {
    if (scanning) return null;
    let settings;
    try {
      settings = (await rpc("boot")).settings;
    } catch (e) {
      post("hook-log", { level: "warn", msg: "读取设置失败", data: { error: String(e) } });
      return null;
    }
    const circle = circleOf(settings);
    if (!circle) {
      post("hook-log", { level: "info", msg: "还没有目的地" });
      return null;
    }
    scanning = true;
    map.setCircle({ center: circle.center, radius: circle.radius });
    // 视图对齐到圆（ui.js 的 fit 不一定触发）
    try {
      const [cx, cy] = circle.center;
      const latRad = (cy * Math.PI) / 180;
      const targetMpp = (2 * circle.radius) / (Math.min(map.w, map.h) * 0.8);
      const z = Math.log2((156543.03392 * Math.cos(latRad)) / Math.max(0.2, targetMpp));
      map.center = [cx, cy];
      map.zoom = Math.max(map.minZoom, Math.min(map.maxZoom, z));
      map.draw();
      setTimeout(() => post("view-change", info()), 60);
    } catch { /* 忽略 */ }
    try {
      const res = await rpc("poi.around", {
        lng: circle.center[0],
        lat: circle.center[1],
        range: Math.round(circle.radius),
        keywords: "小区",
      });
      const pois = res.pois || [];
      post("hook-log", {
        level: "info",
        msg: "周边小区查询完成",
        data: {
          source: res.source,
          count: pois.length,
          range: res.range || Math.round(circle.radius),
          requested: res.requested,
          clamped: res.clamped || false,
        },
      });

      // 去重：库里已有的同名小区不再重复写入
      const seen = new Set();
      try {
        const boot = await rpc("boot");
        for (const c of boot.communities || []) seen.add(String(c.name || ""));
      } catch { /* 忽略 */ }

      let added = 0;
      for (const p of pois) {
        const name = String(p.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const wgs = XAT_IMAGERY.gcj02ToWgs84(p.lng, p.lat);
        try {
          await rpc("community.put", {
            community: {
              name,
              lng: wgs[0],
              lat: wgs[1],
              district: p.district || null,
              sources: ["poi"],
              poiId: p.id || null,
              bbox: p.bbox || null,
              poiDistance: p.distance == null ? null : Math.round(p.distance),
            },
          });
          added += 1;
        } catch (e) {
          post("hook-log", { level: "warn", msg: "写入小区失败", data: { name, error: String(e) } });
        }
      }
      const rects = pois
        .filter((p) => Array.isArray(p.bbox) && p.bbox.length === 4)
        .map((p) => ({ name: p.name, bbox: p.bbox }));
      if (rects.length) map.setRects(rects);
      else map.setRects([]);
      post("hook-log", { level: "info", msg: "周边小区已写入面板", data: { added, total: pois.length, rects: rects.length } });
      if (added) post("data-changed", { added });
      return { added, total: pois.length, source: res.source };
    } catch (e) {
      post("hook-log", { level: "warn", msg: "周边小区查询失败", data: { error: String(e) } });
      return null;
    } finally {
      scanning = false;
    }
  }

  // 「保存设置 / 新增小区」之后才查（不保存不计算）
  chrome.runtime.sendMessage = function (msg, cb) {
    // 只认「保存设置」（目的地/半径）；写入小区不再触发，避免自己写自己、无限递归
    const isSave = msg && msg.type === "xat.rpc" && msg.method === "settings.set";
    return rawSend(msg, function (res) {
      if (isSave) setTimeout(() => scan(), 300);
      if (cb) cb(res);
    });
  };

  /* ---------------- 底图切换（注入 Shadow DOM，用同款 .seg 样式） ---------------- */

  function mountBasemapSwitch() {
    const root = document.getElementById("xat-root");
    const shadow = root && root.shadowRoot;
    if (!shadow || shadow.querySelector(".xat-basemap")) return;
    const box = document.createElement("div");
    box.className = "seg xat-basemap";
    box.style.cssText =
      "position:fixed;right:12px;top:10px;pointer-events:auto;z-index:6;box-shadow:0 2px 10px -6px rgba(0,0,0,.6)";
    box.innerHTML =
      '<button class="seg__btn is-on" data-bm="satellite">卫星</button>' +
      '<button class="seg__btn" data-bm="classic">地图</button>';
    box.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg__btn");
      if (!btn) return;
      [...box.children].forEach((b) => b.classList.toggle("is-on", b === btn));
      map.setBasemap(btn.dataset.bm);
    });
    shadow.appendChild(box);
  }

  /* ---------------- 启动 ---------------- */

  setTimeout(mountBasemapSwitch, 700);
  setTimeout(mountBasemapSwitch, 2000);
  setTimeout(async () => {
    try {
      const boot = await rpc("boot");
      const rects = (boot.communities || [])
        .filter((c) => Array.isArray(c.bbox) && c.bbox.length === 4)
        .map((c) => ({ name: c.name, bbox: c.bbox }));
      if (rects.length) map.setRects(rects);
    } catch { /* 忽略 */ }
  }, 700);

  setTimeout(() => emitReady("boot"), 100);
  setTimeout(() => post("map-info", info()), 450);
  setTimeout(() => scan(), 900);

  window.__xatShim = { map, scan, info, circleOf };
})();
