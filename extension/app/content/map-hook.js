/* ============================================================
   西接通勤 · 地图挂钩（MAIN world，document_start）
   目的：拿到高德页面自己的 AMap.Map 实例，用它的 lngLatToContainer
        把经纬度换算成像素，供上层 canvas 覆盖层绘制。
   注意：本文件跑在页面自己的 JS 环境里，不能访问扩展 API，
        所有日志通过 window.postMessage 交给隔离世界的 UI 转发。
   ============================================================ */
(function () {
  "use strict";
  if (window.__XAT_HOOK_INSTALLED__) return;
  window.__XAT_HOOK_INSTALLED__ = true;

  const TAG = "__xat";
  const HOOK_VERSION = "0.2.0";

  const state = {
    patched: false,
    instances: 0,
    map: null,
    ready: false,
    lastError: null,
    zoom: null,
    center: null,
    subscribeCount: 0,
  };

  function post(type, payload) {
    try {
      window.postMessage({ [TAG]: "main", type, payload, hookVersion: HOOK_VERSION }, "*");
    } catch (e) {
      console.warn("[XAT][hook] postMessage 失败", e);
    }
  }

  function log(level, msg, data) {
    const line = `[XAT][hook][${level}] ${msg}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn.call(console, line, data || "");
    post("hook-log", { level, msg, data });
  }

  function mapInfo(map) {
    const info = { zoom: null, center: null, rect: null, size: null };
    if (!map) {
      info.ready = false;
      return info;
    }
    try {
      info.zoom = typeof map.getZoom === "function" ? map.getZoom() : null;
      const c = typeof map.getCenter === "function" ? map.getCenter() : null;
      if (c) {
        info.center = [
          typeof c.getLng === "function" ? c.getLng() : c.lng,
          typeof c.getLat === "function" ? c.getLat() : c.lat,
        ];
      }
      const el = typeof map.getContainer === "function" ? map.getContainer() : null;
      if (el) {
        const r = el.getBoundingClientRect();
        info.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
        info.size = { width: r.width, height: r.height };
      }
    } catch (e) {
      info.error = String(e);
      state.lastError = String(e);
    }
    return info;
  }

  let rafPending = false;
  function emitViewChange() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const info = mapInfo(state.map);
      state.zoom = info.zoom;
      state.center = info.center;
      post("view-change", info);
    });
  }

  function bindMap(map) {
    state.map = map;
    state.instances += 1;
    const info = mapInfo(map);
    state.zoom = info.zoom;
    state.center = info.center;
    state.ready = true;

    log("info", "已拿到 AMap.Map 实例", {
      instances: state.instances,
      zoom: info.zoom,
      center: info.center,
      rect: info.rect,
    });
    post("map-ready", info);

    ["mapmove", "zoomchange", "moveend", "zoomend", "resize", "complete"].forEach((ev) => {
      try {
        map.on(ev, () => {
          state.subscribeCount += 1;
          emitViewChange();
        });
      } catch (e) {
        log("warn", `订阅事件 ${ev} 失败`, { error: String(e) });
      }
    });

    try {
      map.on("rightclick", onMapRightClick);
      log("info", "已订阅地图右键（复制地址用）");
    } catch (e) {
      log("warn", "订阅 rightclick 失败", { error: String(e) });
    }
  }

  let ourWrappedMap = null;
  let netsInstalled = false;

  /**
   * 兜底网：即使构造函数没拦住（例如实例在建图时页面自行 new 了保存的引用），
   * 只要页面调用 Map 的这些方法，就能把 this 抓回来。
   */
  function installProtoNets(OrigMap) {
    if (netsInstalled || !OrigMap || !OrigMap.prototype) return;
    netsInstalled = true;
    const NET_METHODS = ["setZoomAndCenter", "setZoom", "setCenter", "getZoom", "getCenter", "getContainer", "setFitView"];
    NET_METHODS.forEach((name) => {
      const orig = OrigMap.prototype[name];
      if (typeof orig !== "function" || orig.__xatNet) return;
      const wrapped = function (...args) {
        if (!state.map) {
          try {
            bindMap(this);
            log("warn", "构造函数没拦住，靠方法兜底抓到了实例", { via: name });
          } catch (e) {
            log("error", "兜底捕获失败", { error: String(e) });
          }
        }
        return orig.apply(this, args);
      };
      wrapped.__xatNet = true;
      OrigMap.prototype[name] = wrapped;
    });
    log("debug", "已在 Map.prototype 上安装兜底网", { methods: NET_METHODS.length });
  }

  function patchAmap(v) {
    if (!v || typeof v !== "object") return v;
    if (v.__xatPatched) return v;
    try {
      const Orig = v.Map;
      if (typeof Orig !== "function") return v;

      const Wrapped = function Map(...args) {
        const instance = new Orig(...args);
        try {
          bindMap(instance);
        } catch (e) {
          log("error", "捕获实例后处理失败", { error: String(e) });
        }
        return instance;
      };
      Wrapped.prototype = Orig.prototype;
      try {
        Object.setPrototypeOf(Wrapped, Orig);
      } catch (e) {
        /* 静态继承失败不影响主流程 */
      }
      Wrapped.__xatOriginal = Orig;
      Wrapped.__xatPatched = true;

      v.Map = Wrapped;
      ourWrappedMap = Wrapped;
      Object.defineProperty(v, "__xatPatched", { value: true, enumerable: false });
      state.patched = true;
      installProtoNets(Orig);
      log("info", "AMap.Map 已挂钩，等待实例创建");
    } catch (e) {
      state.lastError = String(e);
      log("error", "挂钩 AMap.Map 失败", { error: String(e) });
    }
    return v;
  }

  /* ---- 拦截 window.AMap 的赋值 ---- */
  let _amapValue;
  try {
    Object.defineProperty(window, "AMap", {
      configurable: true,
      get() {
        return _amapValue;
      },
      set(v) {
        _amapValue = patchAmap(v);
      },
    });
    log("info", "已在 document_start 安装 AMap 拦截器", { href: location.href });
  } catch (e) {
    state.lastError = String(e);
    log("error", "安装 AMap 拦截器失败（可能被抢先定义）", { error: String(e) });
  }

  /* ---- 兜底轮询：有些加载器不走 window.AMap 赋值 ---- */
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const live = window.AMap;

    if (live && typeof live.Map === "function") {
      if (!state.patched) {
        _amapValue = live;
        patchAmap(live);
        log("warn", "通过轮询补挂成功（拦截器没命中赋值）", { tries });
      } else if (ourWrappedMap && live.Map !== ourWrappedMap && !live.Map.__xatOriginal) {
        // 页面把我们的包装又覆盖掉了（少见但确实会发生）
        log("warn", "AMap.Map 被页面二次覆盖，重新挂钩", { tries });
        state.patched = false;
        patchAmap(live);
      }
    }

    if (state.map) {
      clearInterval(timer);
      return;
    }

    if (tries > 300) {   // 60 秒
      clearInterval(timer);
      log("error", "60 秒后仍未拿到地图实例", { patched: state.patched, hasAMap: !!live, href: location.href });
      post("hook-failed", { reason: state.patched ? "no-instance-after-60s" : "no-amap-after-60s", tries });
    }
  }, 200);

  /* ============================================================
     右键「复制地址」
     1) 地图 rightclick → 拿到 GCJ-02 坐标 → 顺手反查地址（用页面自带的 AMap.Geocoder）
     2) 在高德自己的右键菜单里追加一项；找不到菜单就自绘一个只剩这项的小菜单
     3) 点它 → postMessage 给 ISOLATED world 写剪贴板（那边有 geo.js 做坐标转换）
     ============================================================ */

  // 高德 v2 的右键菜单结构：div.amap-menu > ul.context_menu > li.menu_item
  // 这一版文案是「这是哪儿 / 搜周边 / 设为地图中心点 / 清除路线」；旧版本可能是「到这里去」等，
  // 所以检测同时认类名和文案，类名变了也不会瞎。
  const MENU_HINTS = [
    "这是哪儿", "搜周边", "设为地图中心点", "清除路线",
    "到这里去", "从这里出发", "添加标注", "添加收藏", "搜索附近", "设为起点", "设为终点",
  ];
  const CTX_ITEM_ID = "xat-ctx-copy";
  const CTX_OWN_ID = "xat-ctx-own";
  const lastCtx = { gcj: null, address: null, promise: null, poi: null, at: 0 };

  function rectOf(el) {
    try {
      return el.getBoundingClientRect();
    } catch (e) {
      return null;
    }
  }

  function menuScore(el) {
    const text = el.textContent || "";
    if (!text) return 0;
    let n = 0;
    for (const h of MENU_HINTS) if (text.indexOf(h) >= 0) n += 1;
    return n;
  }

  function isVisible(el) {
    const r = rectOf(el);
    if (!r || r.width < 24 || r.height < 16) return false;
    return r.width * r.height <= 150000;
  }

  /** 找高德自己的右键菜单列表；优先认类名，类名变了再退回「文案 + 多个子项」判断 */
  function findMenuList() {
    for (const sel of ["ul.context_menu", ".amap-menu ul", ".amap-context-menu"]) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    let best = null;
    for (const el of document.querySelectorAll("ul,ol,div,section")) {
      if (!isVisible(el)) continue;
      if (menuScore(el) < 2) continue;
      const kids = Array.from(el.children).filter((c) => /^(LI|DIV|A|BUTTON)$/.test(c.tagName));
      if (kids.length < 2) continue;
      const r = rectOf(el);
      const area = r.width * r.height;
      if (!best || area < best.area) best = { el, area };
    }
    return best ? best.el : null;
  }

  function scanForMenu() {
    return findMenuList();
  }

  function bindItemClick(item, onClick) {
    item.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    }, true);
  }

  /**
   * 在高德菜单里追加一项：
   * 直接克隆它自己的 li.menu_item —— 样式、hover、宽度全都天生一致；
   * setTimeout 不会被 cloneNode 复制，所以不用担心触发高德原来的动作。
   */
  function injectCtxItem(container, onClick) {
    if (!container) return null;
    const existing = container.querySelector("#" + CTX_ITEM_ID);
    if (existing) {
      bindItemClick(existing, onClick);
      return existing;
    }
    const stale = document.getElementById(CTX_ITEM_ID);
    if (stale) stale.remove();

    const kids = Array.from(container.children).filter((c) => /^(LI|DIV|A|BUTTON)$/.test(c.tagName));
    const sample = kids.length ? kids[kids.length - 1] : null;
    let item;
    if (sample) {
      item = sample.cloneNode(true);
      item.id = CTX_ITEM_ID;
      item.className = String(sample.className || "").replace(/\bunable\b/g, "").trim() || "menu_item";
      item.removeAttribute("data-xat-clone");
      const span = item.querySelector("span");
      if (span) {
        span.textContent = "复制地址";
        // 兄弟 span 若还有别的文案，清掉
        item.querySelectorAll("span").forEach((s) => {
          if (s !== span) s.textContent = "";
        });
      } else {
        item.textContent = "复制地址";
      }
      const icon = item.querySelector("i");
      if (icon) icon.className = "iconfont";
    } else {
      item = document.createElement("li");
      item.className = "menu_item";
      item.textContent = "复制地址";
    }
    bindItemClick(item, onClick);
    container.appendChild(item);
    log("info", "已在高德右键菜单里插入「复制地址」", { tag: container.tagName, cls: String(container.className).slice(0, 40) });
    return item;
  }

  function removeOwnMenu() {
    const el = document.getElementById(CTX_OWN_ID);
    if (el) el.remove();
  }

  function showOwnMenu(x, y, onClick) {
    removeOwnMenu();
    const box = document.createElement("div");
    box.id = CTX_OWN_ID;
    box.style.cssText =
      "position:fixed;z-index:2147483600;min-width:168px;padding:4px 0;background:#fff;" +
      "border:1px solid rgba(0,0,0,.14);border-radius:4px;box-shadow:0 6px 24px rgba(0,0,0,.16);" +
      "font:13px/1.6 'PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:#1a1815;";
    const item = document.createElement("div");
    item.textContent = "复制地址（西接通勤）";
    item.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;";
    item.addEventListener("mouseenter", () => {
      item.style.background = "#f2efe8";
    });
    item.addEventListener("mouseleave", () => {
      item.style.background = "transparent";
    });
    item.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
      removeOwnMenu();
    }, true);
    box.appendChild(item);
    box.style.left = Math.max(4, Math.min(x + 2, window.innerWidth - 190)) + "px";
    box.style.top = Math.max(4, Math.min(y + 2, window.innerHeight - 52)) + "px";
    document.body.appendChild(box);

    const onDown = (ev) => {
      if (box.contains(ev.target)) return;
      cleanup();
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") cleanup();
    };
    const cleanup = () => {
      removeOwnMenu();
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  }

  /* ---- 地理编码：借用页面自带的 AMap.Geocoder（无新 key） ---- */

  function withGeocoder(cb) {
    const A = window.AMap;
    if (!A) return cb(null);
    if (A.Geocoder) return cb(A);
    if (typeof A.plugin === "function") {
      try {
        A.plugin(["AMap.Geocoder"], () => cb(window.AMap));
        return;
      } catch (e) {
        return cb(null);
      }
    }
    return cb(null);
  }

  function reverseGeocode(lng, lat) {
    return new Promise((resolve) => {
      withGeocoder((A) => {
        if (!A || !A.Geocoder) return resolve(null);
        try {
          const g = new A.Geocoder({ radius: 250, extensions: "base" });
          g.getAddress([lng, lat], (status, result) => {
            if (status !== "complete" || !result || !result.regeocode) return resolve(null);
            const rc = result.regeocode;
            const ac = rc.addressComponent || {};
            const street = [ac.street, ac.streetNumber].filter(Boolean).join("");
            const addr = rc.formattedAddress || street || "";
            const poi = (rc.pois && rc.pois[0] && rc.pois[0].name) || null;
            resolve({ address: addr || "", poi });
          });
        } catch (e) {
          log("warn", "反查地址失败", { error: String(e) });
          resolve(null);
        }
      });
    });
  }

  function geocodeAddress(address, city) {
    return new Promise((resolve) => {
      withGeocoder((A) => {
        if (!A || !A.Geocoder) return resolve({ ok: false, error: "本页没有可用的 AMap.Geocoder" });
        try {
          const g = new A.Geocoder({ city: city || "西安", citylimit: false });
          g.getLocation(address, (status, result) => {
            const list = (result && result.geocodes) || [];
            if (status !== "complete" || !list.length) return resolve({ ok: false, error: "没有匹配的地址（" + String(status) + "）" });
            const gc = list[0];
            const loc = gc.location || {};
            const lng = typeof loc.getLng === "function" ? loc.getLng() : loc.lng;
            const lat = typeof loc.getLat === "function" ? loc.getLat() : loc.lat;
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return resolve({ ok: false, error: "解析结果没有坐标" });
            resolve({ ok: true, gcj: [lng, lat], address: gc.formattedAddress || address, level: gc.level || null });
          });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      });
    });
  }

  /** 两条路都会走到这里：地图的 rightclick 事件，或 DOM 的 contextmenu */
  function handleContext(x, y, gcj) {
    lastCtx.gcj = gcj;
    lastCtx.at = Date.now();
    lastCtx.address = null;
    lastCtx.poi = null;
    lastCtx.promise = reverseGeocode(gcj[0], gcj[1])
      .then((r) => {
        lastCtx.address = r && r.address ? r.address : null;
        lastCtx.poi = r && r.poi ? r.poi : null;
        return lastCtx.address;
      })
      .catch(() => null);

    const onClick = async () => {
      let address = lastCtx.address;
      if (!address && lastCtx.promise) {
        address = await Promise.race([lastCtx.promise, new Promise((r) => setTimeout(() => r(null), 2000))]);
      }
      post("ctx-copy", { gcj, address: address || null, poi: lastCtx.poi || null, at: lastCtx.at });
      log("info", "请求复制地址", { gcj, address: address || "(未取到地址，仅复制坐标)" });
    };

    // 高德菜单是异步渲染的，有时 1 秒后才出现：
    // 先等 320ms，没等到就自绘一项兜底；之后仍继续盯 2 秒，一旦原生菜单出现就换成原生位置。
    let done = false;
    let poll = null;
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };
    const injectNow = () => {
      if (done) return false;
      const menu = findMenuList();
      if (!menu) return false;
      done = true;
      stopPoll();
      removeOwnMenu();
      injectCtxItem(menu, onClick);
      return true;
    };
    if (injectNow()) return;

    setTimeout(() => {
      if (done) return;
      if (injectNow()) return;
      log("warn", "没等到高德的右键菜单，改为自绘一项");
      showOwnMenu(x, y, onClick);
    }, 320);
    poll = setInterval(injectNow, 140);
    setTimeout(stopPoll, 2000);
  }

  let ctxAt = 0;
  function onMapRightClick(e) {
    const now = Date.now();
    if (now - ctxAt < 300) return;
    ctxAt = now;

    let gcj = null;
    try {
      const ll = e && e.lnglat;
      if (ll) {
        gcj = [typeof ll.getLng === "function" ? ll.getLng() : ll.lng, typeof ll.getLat === "function" ? ll.getLat() : ll.lat];
      }
    } catch (err) {
      gcj = null;
    }
    if (!gcj || !Number.isFinite(gcj[0]) || !Number.isFinite(gcj[1])) {
      log("warn", "右键没有取到坐标，跳过", { hasEvent: !!e });
      return;
    }

    const oe = e && e.originEvent;
    const x = oe && Number.isFinite(oe.clientX) ? oe.clientX : window.innerWidth - 240;
    const y = oe && Number.isFinite(oe.clientY) ? oe.clientY : window.innerHeight / 2;
    handleContext(x, y, gcj);
  }

  /**
   * 兜底：有的页面/版本不给地图发 rightclick（或者右键落在覆盖物上），
   * 这时用 DOM 的 contextmenu + containerToLngLat 算坐标，一样能拿到点。
   */
  function onDomContextMenu(e) {
    const map = state.map;
    if (!map || typeof map.containerToLngLat !== "function") return;
    const el = typeof map.getContainer === "function" ? map.getContainer() : null;
    if (!el || !el.contains(e.target)) return;
    const now = Date.now();
    if (now - ctxAt < 300) return;

    let gcj = null;
    try {
      const r = el.getBoundingClientRect();
      const ll = map.containerToLngLat([e.clientX - r.left, e.clientY - r.top]);
      if (ll) {
        gcj = [typeof ll.getLng === "function" ? ll.getLng() : ll.lng, typeof ll.getLat === "function" ? ll.getLat() : ll.lat];
      }
    } catch (err) {
      gcj = null;
    }
    if (!gcj || !Number.isFinite(gcj[0]) || !Number.isFinite(gcj[1])) return;
    ctxAt = now;
    handleContext(e.clientX, e.clientY, gcj);
  }

  try {
    window.addEventListener("contextmenu", onDomContextMenu, true);
  } catch (e) {
    /* ignore */
  }

  /* ---- 投影服务：UI 发请求，这里同步算像素 ---- */
  function projectPoints(points) {
    const map = state.map;
    if (!map || typeof map.lngLatToContainer !== "function") return null;
    const out = [];
    for (const p of points) {
      let pt = null;
      try {
        pt = map.lngLatToContainer(p);
      } catch (e) {
        try {
          pt = map.lngLatToContainer(new window.AMap.LngLat(p[0], p[1]));
        } catch (e2) {
          out.push(null);
          continue;
        }
      }
      if (!pt) {
        out.push(null);
        continue;
      }
      out.push([typeof pt.getX === "function" ? pt.getX() : pt.x, typeof pt.getY === "function" ? pt.getY() : pt.y]);
    }
    return out;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[TAG] !== "ui") return;

    if (data.type === "project") {
      const pts = projectPoints(data.points || []);
      post("project-result", {
        reqId: data.reqId,
        points: pts,
        info: mapInfo(state.map),
        ready: !!state.map,
      });
      return;
    }

    if (data.type === "ping") {
      post("pong", { ready: state.ready, patched: state.patched, instances: state.instances });
      return;
    }

    if (data.type === "fit") {
      const { center, zoom } = data;
      try {
        if (state.map && Array.isArray(center)) {
          const ll = window.AMap && window.AMap.LngLat ? new window.AMap.LngLat(center[0], center[1]) : center;
          state.map.setZoomAndCenter(Number(zoom), ll, true, 300);
          log("info", "已缩放到搜索范围", { zoom, center });
          setTimeout(emitViewChange, 380);
        }
      } catch (e) {
        log("warn", "缩放失败", { error: String(e) });
      }
      return;
    }

    if (data.type === "get-info") {
      post("map-info", Object.assign({ ready: !!state.map, patched: state.patched }, mapInfo(state.map)));
    }

    if (data.type === "geocode") {
      const reqId = data.reqId;
      geocodeAddress(data.address, data.city)
        .then((r) => post("geocode-result", Object.assign({ reqId, address: data.address }, r)))
        .catch((e) => post("geocode-result", { reqId, ok: false, error: String(e) }));
    }
  });

  /* ---- 方便你在 DevTools 控制台手动排查 ---- */
  window.__XAT_HOOK__ = {
    info: () => ({ ...state, hookVersion: HOOK_VERSION }),
    map: () => state.map,
    project: (lng, lat) => projectPoints([[lng, lat]]),
    lastCtx: () => ({ ...lastCtx, promise: undefined }),
    scanMenu: () => scanForMenu(),
    geocode: (address, city) => geocodeAddress(address, city),
  };
})();
