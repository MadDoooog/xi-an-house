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
  const HOOK_VERSION = "0.1.0";

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
  });

  /* ---- 方便你在 DevTools 控制台手动排查 ---- */
  window.__XAT_HOOK__ = {
    info: () => ({ ...state, hookVersion: HOOK_VERSION }),
    map: () => state.map,
    project: (lng, lat) => projectPoints([[lng, lat]]),
  };
})();
