/* ============================================================
   地图适配层：让 content/ui.js 以为自己还挂在高德地图上

   content/ui.js 是注入版那套完整侧栏（结果/发现/待补/详情/录入/设置），
   它只通过 window.postMessage 跟 MAIN world 的地图钩子对话：
     发：{__xat:'ui', type:'project'|'fit'|'get-info'|'ping'|'freeze'|'geocode'}
     收：{__xat:'main', type:'project-result'|'map-ready'|'view-change'|'map-info'|'pong'}

   这里用 lib/slippymap.js 的自绘地图把这些消息实现掉，于是侧栏完全不用改。

   阴影扫描：ui.js 不认识阴影，所以由本层负责——在「保存设置 / 新增小区」之后
   （包一层 chrome.runtime.sendMessage 侦测）按当前目的地算出圆，逐瓦片扫描，
   多边形画在 ui.js 的叠加画布下面。
   ============================================================ */
(function () {
  "use strict";

  const HOOK_VERSION = "shim-1";
  // 阴影阈值：相对瓦片 p95 的亮度比。0.40 在密集区几乎整片判暗，收紧要小一些
  const SHADOW_RATIO = 0.26;
  // 单次扫描的瓦片上限：超过就由 background 降到更低 zoom（而不是缩小半径）
  const SHADOW_MAX_TILES = 400;
  const post = (type, payload) => window.postMessage({ __xat: "main", type, payload }, "*");

  const el = document.getElementById("map");
  const map = new XAT_MAP.SlippyMap(el, { center: [108.880017, 34.194737], zoom: 15 });
  window.__xatMap = map;

  let readyPosted = false;

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
      // 离线页面没有地理编码服务；ui.js 会把提示显示在输入框旁
      post("geocode-result", {
        reqId: d.reqId,
        ok: false,
        error: "此页面不支持地址解析，请在地图上右键取点",
      });
      return;
    }
  });

  /* ---------------- 右键取点 → 交给 ui.js 复制 ---------------- */

  map.on("contextmenu", ({ lngLat }) => {
    post("ctx-copy", { gcj: [lngLat[0], lngLat[1]] });
  });

  /* ---------------- 阴影进度（插进 Shadow DOM） ---------------- */

  let progressEl = null;
  let cancelRequested = false;

  function progressShow(done, total, zoom) {
    const root = document.getElementById("xat-root");
    const shadow = root && root.shadowRoot;
    if (!shadow) return;
    if (!progressEl) {
      progressEl = document.createElement("button");
      progressEl.className = "status-pill";
      progressEl.style.cssText = "left:auto;right:12px;bottom:12px;pointer-events:auto;cursor:pointer";
      shadow.appendChild(progressEl);
      progressEl.addEventListener("click", () => {
        if (!scanning) return;
        cancelRequested = true;
        progressEl.innerHTML = '<span class="status-dot"></span><b>阴影</b><small>正在停止…</small>';
      });
    }
    progressEl.style.display = "flex";
    progressEl.innerHTML =
      `<span class="status-dot"></span><b>阴影 ${done}/${total}</b>` +
      `<small>z${zoom} · 点击取消</small>`;
  }

  function progressHide() {
    if (progressEl) progressEl.style.display = "none";
  }

  /* ---------------- 阴影扫描（ui.js 不感知） ---------------- */

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

  let scanTimer = null;
  let scanning = false;

  function scheduleShadowScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(runShadowScan, delay == null ? 500 : delay);
  }

  async function loadRoadCuts(tiles, cx, cy, radiusM) {
    try {
      const bounds = boundsOfTiles(tiles);
      if (!bounds) return;
      const [w, s, e, n] = bounds;
      const w2 = XAT_IMAGERY.gcj02ToWgs84(w, s);
      const e2 = XAT_IMAGERY.gcj02ToWgs84(e, n);
      const res = await rpc("scan.roads", { bbox: [w2[1], w2[0], e2[1], e2[0]] });
      map.setRoadCuts((res.roads || []).map((r) => ({ cls: r.class, pts: r.line })));
      post("hook-log", { level: "info", msg: "路网已取回（仅用于切分阴影）", data: { ways: res.count } });
    } catch (e) {
      post("hook-log", { level: "warn", msg: "路网取回失败（阴影仍可用）", data: { error: String(e) } });
    }
  }

  function boundsOfTiles(tiles) {
    if (!tiles || !tiles.length) return null;
    let w = 180, s = 90, e = -180, n = -90;
    for (const t of tiles) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const ll = XAT_IMAGERY.tileToLonLatFloat(t.x + dx, t.y + dy, t.z);
        if (ll[0] < w) w = ll[0];
        if (ll[0] > e) e = ll[0];
        if (ll[1] < s) s = ll[1];
        if (ll[1] > n) n = ll[1];
      }
    }
    return [w, s, e, n];
  }

  /** 打开页面时把库里已存的小区轮廓画回去（覆盖对应阴影） */
  async function restoreFootprints() {
    try {
      const data = await rpc("boot");
      const list = (data.communities || [])
        .filter((c) => Array.isArray(c.footprint) && c.footprint.length >= 3)
        .map((c) => {
          const g = XAT_IMAGERY.wgs84ToGcj02(c.lng, c.lat);
          return { name: c.name, pts: c.footprint, lng: g[0], lat: g[1] };
        });
      map.setFootprints(list);
    } catch { /* 忽略 */ }
  }

  async function runShadowScan() {
    if (scanning) return;
    let settings;
    try {
      const data = await rpc("boot");
      settings = data.settings;
    } catch {
      return;
    }
    const dests = (settings && settings.destinations) || [];
    if (!dests.length) {
      map.setMaskTiles([]);
      map.setRoadCuts([]);
      map.setFootprints([]);
      map.setMaskHoles([]);
      map.setPolygons([]);
      return;
    }
    const gcj = dests.map((d) => XAT_IMAGERY.wgs84ToGcj02(d.lng, d.lat));
    const cx = gcj.reduce((a, p) => a + p[0], 0) / gcj.length;
    const cy = gcj.reduce((a, p) => a + p[1], 0) / gcj.length;
    const R = 6371000;
    const far = Math.max(
      ...gcj.map((p) => {
        const dLat = ((p[1] - cy) * Math.PI) / 180;
        const dLng = ((p[0] - cx) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((cy * Math.PI) / 180) * Math.cos((p[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
      }),
    );
    const km = Number(settings.radiusKm) || 1;
    const radius = Math.max(200, far + km * 1000);

    scanning = true;
    map.setMaskTiles([]);
    map.setPolygons([]);
    try {
      const plan = await rpc("scan.plan", {
        lng: cx,
        lat: cy,
        radiusM: Math.round(radius),
        maxTiles: SHADOW_MAX_TILES,
      });
      progressShow(0, plan.tiles.length, plan.zoom);

      // 路网只用来切分阴影：取回来喂给地图做擦除，不画线
      loadRoadCuts(plan.tiles, cx, cy, radius);
      const masks = [];
      let blocks = 0;
      cancelRequested = false;
      let processed = 0;
      for (const t of plan.tiles) {
        if (cancelRequested) break;
        processed += 1;
        try {
          const res = await rpc("scan.tile", { z: t.z, x: t.x, y: t.y, ratio: SHADOW_RATIO });
          blocks += (res.blobs || []).length;
          if (res.maskPng) {
            masks.push({ z: t.z, x: t.x, y: t.y, key: t.key, url: res.maskPng });
            map.setMaskTiles(masks);
          }
        } catch {
          /* 单张失败不影响整体 */
        }
        if (processed % 4 === 0 || processed === plan.tiles.length) progressShow(processed, plan.tiles.length, plan.zoom);
        await new Promise((r) => setTimeout(r, 0));
      }
      progressShow(processed, plan.tiles.length, plan.zoom);
      post("hook-log", {
        level: "info",
        msg: cancelRequested ? "阴影扫描已取消" : "阴影扫描完成",
        data: { blocks, tiles: processed, total: plan.tiles.length, zoom: plan.zoom },
      });

      if (!cancelRequested) {
        await clusterAndLookup(plan, cx, cy);
      }
    } catch (e) {
      post("hook-log", { level: "warn", msg: "阴影扫描失败", data: { error: String(e) } });
    } finally {
      scanning = false;
      setTimeout(progressHide, 2500);
    }
  }

  // 保存设置 / 新增小区之后才重算（不保存不计算）
  chrome.runtime.sendMessage = function (msg, cb) {
    const isSave = msg && msg.type === "xat.rpc" && (msg.method === "settings.set" || msg.method === "community.put");
    return rawSend(msg, function (res) {
      if (isSave) scheduleShadowScan(400);
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
    box.style.cssText = "position:fixed;right:12px;top:10px;pointer-events:auto;z-index:6;box-shadow:0 2px 10px -6px rgba(0,0,0,.6)";
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

  /* ---------------- 聚类 + POI 反查 → 面板 ---------------- */

  // 小区名不像小区：驿站、快递、门、超市、物业…（高德把这些也标成"住宅小区"类型）
  const POI_BAD = /(驿站|快递|菜鸟|门市|门\b|大门|东门|西门|南门|北门|侧门|停车|车库|车场|物业|售楼|营销|超市|便利店|商店|幼儿园|学校|学院|医院|诊所|药店|银行|ATM|餐厅|饭店|食堂|咖啡|活动室|服务中心|居委会|社区|保安|岗亭|充电|快递柜|网点|分店|店$|站$|楼$|栋$|单元|号院)/;
  const POI_GOOD = /(小区|花园|家苑|苑|家园|新村|别墅|公馆|公寓|国际|广场|社区|里|湾|庭|府|城|园)/;

  /**
   * 先从候选里剔掉「XX小区驿站 / 西门 / 停车场」这类子设施，再取最近的。
   * 不能只用名字加分：同一次查询里 244 m 外的「XX小区」会压过 70 m 外的真小区。
   */
  function pickPoi(pois) {
    const named = pois.filter((p) => p && p.name);
    if (!named.length) return null;
    const clean = named.filter((p) => !POI_BAD.test(p.name));
    const pool = clean.length ? clean : named;
    const near = pool.filter((p) => !Number.isFinite(p.distance) || p.distance <= 150);
    const cands = (near.length ? near : pool).slice();
    cands.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
    // 距离接近（<40 m 差）时，优先名字更像小区的
    const first = cands[0];
    const tie = cands.find(
      (p) => Math.abs((p.distance ?? 1e9) - (first.distance ?? 1e9)) < 40 && POI_GOOD.test(p.name) && !POI_GOOD.test(first.name),
    );
    return tie || first;
  }

  async function clusterAndLookup(plan) {
    if (!window.XAT_CLUSTERS) return;
    // 掩膜是 dataURL 异步解码的：缓存命中时扫描几毫秒就结束，
    // 必须等图片 onload 完成再聚类，否则会拿到 0 张图静默返回。
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      const pend = plan.tiles.some((t) => {
        const i = map.maskImgs.get(t.key);
        return i && !i.ready && !i.failed;
      });
      if (!pend) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    const tiles = [];
    for (const t of plan.tiles) {
      const info = map.maskImgs.get(t.key);
      if (info && info.ready && info.img) tiles.push({ z: t.z, x: t.x, y: t.y, img: info.img });
    }
    if (!tiles.length) {
      post("hook-log", { level: "warn", msg: "聚类跳过：掩膜图未就绪", data: { tiles: plan.tiles.length } });
      return;
    }

    const { clusters } = window.XAT_CLUSTERS.cluster(tiles, map.roadCuts, {
      minAreaM2: 1500,
      roadWidthM: 26,
    });
    post("hook-log", { level: "info", msg: "阴影聚类完成", data: { clusters: clusters.length } });
    if (!clusters.length) return;

    // 只查前 N 片，避免把 key 额度打满
    const limit = 12;
    let added = 0;
    let skipped = 0;
    // 去重：本次已加 + 库里已有的同名小区
    const seenNames = new Set();
    const footprints = [];
    const holes = [];
    map.setFootprints([]);
    map.setMaskHoles([]);
    try {
      const boot = await rpc("boot");
      for (const c of boot.communities || []) seenNames.add(String(c.name || ""));
    } catch { /* 忽略 */ }
    for (const c of clusters.slice(0, limit)) {
      try {
        const res = await rpc("poi.nearby", { lng: c.lng, lat: c.lat, radius: 300, limit: 10 });
        const poi = pickPoi((res.pois || []).filter((p) => p.name && !seenNames.has(String(p.name))));
        if (!poi) { skipped += 1; continue; }
        // 先试高德站内接口拿真实小区边界（mining_shape），拿不到就用阴影轮廓兜底
        let poly = c.pts;
        let polySrc = "shadow-cluster";
        try {
          const r = await rpc("poi.polygon", { id: poi.id, name: poi.name, lng: poi.lng, lat: poi.lat });
          if (r && r.ok && Array.isArray(r.pts) && r.pts.length >= 3) {
            poly = r.pts;
            polySrc = "amap-getPoiDetail";
          }
        } catch { /* 回退到阴影轮廓 */ }

        // 同名小区可能对应多片阴影：合并到同一个多边形组里
        const key = String(poi.name);
        let fp = footprints.find((x) => x.name === key);
        if (!fp) {
          fp = { name: key, pts: poly, rings: [] };
          footprints.push(fp);
          seenNames.add(key);
        }
        fp.rings.push(poly);
        if (!fp.pts || poly.length > fp.pts.length) fp.pts = poly;
        holes.push({ pts: c.pts });
        map.setFootprints(footprints.slice());
        map.setMaskHoles(holes.slice());
        const wgs = XAT_IMAGERY.gcj02ToWgs84(poi.lng, poi.lat);
        await rpc("community.put", {
          community: {
            name: poi.name,
            lng: wgs[0],
            lat: wgs[1],
            district: poi.district || null,
            sources: ["poi"],
            footprint: poly || null,    // GCJ 多边形，用来覆盖阴影
            footprintSource: polySrc,
          },
        });
        added += 1;
      } catch (e) {
        post("hook-log", { level: "warn", msg: "POI 反查失败", data: { error: String(e) } });
        break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    post("hook-log", { level: "info", msg: "阴影聚类已写入面板", data: { added, skipped, clusters: clusters.length } });
    if (added) post("data-changed", { added });
  }

  /* ---------------- 启动 ---------------- */

  setTimeout(mountBasemapSwitch, 700);
  setTimeout(mountBasemapSwitch, 2000); // ui.js 可能晚一点才挂好
  setTimeout(() => emitReady("boot"), 100);
  setTimeout(restoreFootprints, 600);
  setTimeout(() => post("map-info", info()), 450);
  scheduleShadowScan(800);

  window.__xatShim = { map, scan: runShadowScan, info };
})();
