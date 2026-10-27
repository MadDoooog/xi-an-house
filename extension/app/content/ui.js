/* ============================================================
   西接通勤 · 注入 UI（ISOLATED world）
   运行环境：高德地图页面。Shadow DOM 隔离，不影响页面样式。
   本版（0.2.0）能力：
     - 默认干净状态：不预置任何小区/目的地，侧栏默认折叠成右边缘的抽屉标签
     - 侧栏上下留白可调（躲开高德自带工具条）
     - 目的地地址：粘贴「右键复制地址」得到的文本即可（含坐标则直接定位，
       只有文字则用页面自带的 AMap.Geocoder 解析）
     - 小区录入 / 编辑 / 删除（无外部数据依赖）
     - canvas 叠加：搜索范围、目的地 pin、小区点
     - 通勤值仍是「直线估算」，带 ~ 前缀；真值在阶段 3d 接入
   ============================================================ */
(function () {
  "use strict";

  const XAT = window.__XAT;
  if (!XAT || !XAT.log || !XAT.geo) {
    console.error("[XAT] 依赖未就绪，UI 放弃初始化");
    return;
  }
  const log = XAT.log.scope("ui");
  const geo = XAT.geo;
  const boot0 = Date.now();

  if (window.__XAT_UI_MOUNTED__) {
    log.warn("UI 已挂载，跳过重复注入");
    return;
  }

  // 高德的"路线规划"页不挂侧栏（阶段 3d 会在这里做读回）
  const isDirPage = /\/dir(\/|\?|$)/.test(location.pathname) || location.pathname.indexOf("/ssr/dir") >= 0;
  if (isDirPage) {
    log.info("当前是算路页，跳过侧栏注入（读回功能在阶段 3d）", { href: location.href });
    return;
  }

  window.__XAT_UI_MOUNTED__ = true;

  const DEST_COLORS = ["#9c2a22", "#2e5f8a", "#126e5b", "#b9852b", "#6e5a8a"];
  const DIGITS = ["①", "②", "③", "④", "⑤"];
  const MODE_LABEL = { drive: "驾车", transit: "公交", walk: "步行" };
  const MODE_TYPE = { drive: 0, transit: 1, walk: 2 };   // 高德 deep link 的 type
  const SRC_LABEL = { official: "官方数据", manual: "人工录入", poi: "POI 发现", seed: "样例数据" };
  const SRC_CLASS = { official: "badge--official", manual: "badge--manual", poi: "badge--poi", seed: "badge--seed" };
  const SRC_ORDER = { official: 4, manual: 3, poi: 2, seed: 1 };
  const LAYOUT_DEFAULTS = { top: 72, bottom: 24 };
  const MAX_DESTS = 5;

  const state = {
    settings: null,
    communities: [],
    panel: "list",
    tab: "result",
    sort: "commute",
    selected: null,
    showOut: true,
    rows: [],
    roi: null,
    dests: [],
    proj: null,
    hit: [],
    hoverId: null,
    hookReady: false,
    hidden: true,        // 默认折叠：只显示右边缘抽屉
    form: null,          // 正在编辑的小区
    formIsNew: false,
    geoSeq: 0,
    sat: {},             // 小区影像缓存：id -> imagery.community 结果
    scan: null,          // 阴影扫描结果（逐瓦片累加）
    scanScreen: null,    // 投影后的屏幕多边形
    scanReqId: 0,
    scanSnapshot: null,
    scanRunning: false,
  };

  /* ---------------- 工具 ---------------- */

  const $ = (sel, root) => (root || shadow).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || shadow).querySelectorAll(sel));

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "xat.rpc", method, params }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res) {
            reject(new Error("后台无响应（service worker 可能已休眠）"));
            return;
          }
          if (!res.ok) {
            reject(new Error(res.error || "未知错误"));
            return;
          }
          resolve(res.data);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /** 安全写 innerHTML：面板/标签切换的瞬间目标节点可能已经被替换掉 */
  function setHtml(sel, html) {
    const el = $(sel);
    if (el) el.innerHTML = html;
    return el;
  }

  function reportDiag(patch) {
    rpc("diag.report", { tabId: "tab:" + location.host + location.pathname, patch }).catch(() => {});
  }

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const totalOf = (c) => {
    const area = (Number(c.areaMin) + Number(c.areaMax)) / 2;
    if (!(Number(c.avgPrice) > 0) || !(area > 0)) return null;
    return Math.round((Number(c.avgPrice) * area) / 10000);
  };
  const weakestSrc = (c) => c.sources.slice().sort((a, b) => (SRC_ORDER[a] || 0) - (SRC_ORDER[b] || 0))[0];
  const badge = (kind) => `<span class="badge ${SRC_CLASS[kind] || "badge--none"}">${SRC_LABEL[kind] || "未知"}</span>`;
  const fmtPrice = (v) => (Number(v) > 0 ? Number(v).toLocaleString() : "未录入");
  const fmtArea = (c) => (Number(c.areaMin) > 0 || Number(c.areaMax) > 0 ? `${c.areaMin}–${c.areaMax}` : "未录入");
  const fmtTotal = (v) => (v == null ? "未录入" : v + " 万");

  /* ---------------- 界面布局 / 提示 / 坐标解析 ---------------- */

  function applyLayout() {
    const L = Object.assign({}, LAYOUT_DEFAULTS, (state.settings && state.settings.layout) || {});
    host.style.setProperty("--xat-inset-top", Math.max(0, Number(L.top) || 0) + "px");
    host.style.setProperty("--xat-inset-bottom", Math.max(0, Number(L.bottom) || 0) + "px");
  }

  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 2600);
  }

  function setDrawerVisible(open) {
    state.hidden = !open;
    drawer.hidden = !!open;
    side.classList.toggle("is-hidden", !open);
    const h = $(".side-handle");
    if (h) h.textContent = open ? "›" : "‹";
    if (!open) tooltip.hidden = true;
  }

  /* 从任意文本里找经纬度：兼容 108.965,34.245 / (108.965, 34.245) / 108.965 34.245 */
  const COORD_PAIR = /(-?\d{1,3}\.\d{2,8})\s*[,，\s]\s*(-?\d{1,2}\.\d{2,8})/;
  function parseCoords(text) {
    const m = String(text || "").match(COORD_PAIR);
    if (!m) return null;
    let lng = Number(m[1]);
    let lat = Number(m[2]);
    const okLng = (v) => v >= 73 && v <= 136;
    const okLat = (v) => v >= 3 && v <= 54;
    if (!okLng(lng) && okLat(lng) && okLng(lat)) {
      const t = lng;
      lng = lat;
      lat = t;
    }
    if (!okLng(lng) || !okLat(lat)) return null;
    // 粘贴来的坐标按 GCJ-02 理解（高德/腾讯的复制地址都是这个系），
    // 统一转成 WGS84 再存——库内、接口、导出全是 WGS84。
    const [wlng, wlat] = geo.gcj02ToWgs84(lng, lat);
    return { lng: wlng, lat: wlat };
  }

  function stripCoords(text) {
    return String(text || "")
      .replace(/[（(]?\s*-?\d{1,3}\.\d{2,8}\s*[,，]\s*-?\d{1,2}\.\d{2,8}\s*[)）]?/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function copyText(text) {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          ta.remove();
          resolve(!!ok);
        } catch (e) {
          resolve(false);
        }
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => resolve(true)).catch(fallback);
          return;
        }
      } catch (e) {
        /* 走兜底 */
      }
      fallback();
    });
  }

  /* ---------------- 地址解析（借用页面自带的 AMap.Geocoder） ---------------- */

  const geoWaiters = new Map();
  function requestGeocode(text, cb) {
    const reqId = ++state.geoSeq;
    geoWaiters.set(reqId, cb);
    window.postMessage({ __xat: "ui", type: "geocode", reqId, address: text, city: "西安" }, "*");
    setTimeout(() => {
      const f = geoWaiters.get(reqId);
      if (f) {
        geoWaiters.delete(reqId);
        f({ ok: false, error: "地址解析超时（6 秒）" });
      }
    }, 6000);
  }

  /** 右键菜单「复制地址」被点时，MAIN world 把坐标发过来；这里转 WGS84 后写剪贴板 */
  /** 外部（阴影聚类）写入小区后，重新拉一遍数据并重绘 */
  async function reloadData() {
    try {
      const data = await rpc("boot");
      state.settings = data.settings;
      state.communities = data.communities || [];
      state.dests = (data.settings && data.settings.destinations) || [];
      compute();
      render();
      requestProjection();
      log.info("数据已刷新", { communities: state.communities.length });
    } catch (e) {
      log.warn("刷新数据失败", { error: String(e) });
    }
  }

  function onCtxCopy(payload) {
    const p = payload || {};
    const g = p.gcj;
    if (!Array.isArray(g) || !Number.isFinite(g[0]) || !Number.isFinite(g[1])) {
      toast("右键没取到坐标");
      return;
    }
    // 复制 GCJ-02：粘回高德（或任何国内地图）才落在同一个点位。
    // 存库仍是 WGS84，由 parseCoords 在粘回来时换算。
    const coordText = `${g[0].toFixed(6)},${g[1].toFixed(6)}`;
    const where = p.address || p.poi || "";
    const text = where ? `${where} (${coordText})` : coordText;
    copyText(text).then((ok) => {
      if (!ok) {
        toast("复制失败，请手动选中后 Ctrl+C");
      } else if (where) {
        toast("已复制地址（GCJ-02），可直接粘到高德或本面板");
      } else {
        toast("已复制坐标（GCJ-02，高德可直接定位）");
      }
      log.info("右键复制结果", { ok, text });
    });
  }

  /* ---------------- Shadow DOM 挂载 ---------------- */

  const host = document.createElement("div");
  host.id = "xat-root";
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483000;";
  const shadow = host.attachShadow({ mode: "open" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("content/ui.css");
  shadow.appendChild(link);

  const canvas = document.createElement("canvas");
  canvas.className = "xat-canvas";
  shadow.appendChild(canvas);

  const pill = document.createElement("div");
  pill.className = "status-pill";
  pill.innerHTML = `<span class="status-dot"></span><b>西接通勤</b><small>等待地图…</small>`;
  shadow.appendChild(pill);

  // 折叠态的抽屉标签（贴右边缘，位置跟随「顶部留白」设置）
  const drawer = document.createElement("button");
  drawer.className = "drawer";
  drawer.title = "展开侧栏（西接通勤）";
  drawer.innerHTML =
    `<svg class="drawer__ico" viewBox="0 0 16 16" aria-hidden="true">` +
    `<path d="M2 3.4h12M2 8h12M2 12.6h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square"/>` +
    `</svg><span class="drawer__label">找房</span><span class="drawer__n" id="xat-drawer-n"></span>`;
  shadow.appendChild(drawer);

  const toastEl = document.createElement("div");
  toastEl.className = "toast-line";
  shadow.appendChild(toastEl);

  const side = document.createElement("aside");
  side.className = "side";
  side.innerHTML = `
    <button class="side-handle" title="收起/展开侧栏">‹</button>
    <button class="condline" data-act="edit">
      <span class="condline__txt" id="xat-cond">加载中…</span>
      <span class="condline__edit">编辑</span>
    </button>

    <section class="pane pane--list" data-pane="list">
      <nav class="tabs">
        <button class="tabs__btn is-on" data-tab="result">结果<span class="tabs__n" id="xat-n">0</span></button>
        <button class="tabs__btn" data-tab="discover">发现<span class="tabs__n">—</span></button>
        <button class="tabs__btn" data-tab="gap">待补<span class="tabs__n">—</span></button>
      </nav>

      <div class="tabpane" data-tabpane="result">
        <div class="lanes" id="xat-lanes"></div>
        <div class="lanes__axis" id="xat-axis"></div>
        <div class="listhead">
          <span class="listhead__count"><span class="num" id="xat-cin">0</span> 在范围内 · <span class="num" id="xat-cok">0</span> 符合</span>
          <div class="seg seg--sm">
            <button class="seg__btn is-on" data-sort="commute">通勤</button>
            <button class="seg__btn" data-sort="total">总价</button>
            <button class="seg__btn" data-sort="price">均价</button>
          </div>
        </div>
        <ul class="entries" id="xat-list"></ul>
        <div class="side__foot">
          <label class="check"><input type="checkbox" id="xat-showout" checked /> 显示不符合过滤的小区（灰点）</label>
          <button class="btn btn--ghost btn--xs" data-act="new-community">＋ 添加小区</button>
          <span class="side__note" id="xat-note"></span>
        </div>
      </div>

      <div class="tabpane" data-tabpane="discover" hidden>
        <div class="scan">
          <p class="hint" style="margin-top:10px">把搜索范围（大圆）里的卫星图抓下来，<b>先二值化，再挑出片状的阴影块</b>（够大、够成型），
            碎影和细线不算。机器结果只做参考，看图后点「像小区 / 不像」。</p>
          <button class="btn btn--primary btn--xs" data-act="scan-roi">扫描大圆影像</button>
          <div id="xat-scan-out"></div>
        </div>
      </div>

      <div class="tabpane" data-tabpane="gap" hidden>
        <div class="placeholder">
          <div class="placeholder__t">影像补漏已砍</div>
          <div class="placeholder__d">主流程不再自带底图，影像规则扫描失去瓦片来源，本期不做。</div>
        </div>
      </div>
    </section>

    <section class="pane pane--edit" data-pane="edit" hidden>
      <div class="pane__head">
        <div class="pane__headmain"><h2>筛选条件</h2></div>
        <button class="iconbtn" data-act="cancel-edit">×</button>
      </div>
      <div class="pane__body" id="xat-edit-body"></div>
      <div class="pane__foot">
        <button class="btn btn--ghost btn--xs" data-act="open-options">设置与日志</button>
        <button class="btn btn--ghost" data-act="cancel-edit">取消</button>
        <button class="btn btn--primary" data-act="save">保存</button>
      </div>
    </section>

    <section class="pane pane--detail" data-pane="detail" hidden>
      <div class="split">
        <div class="col-list">
          <div class="col-list__head">结果 · <span class="num" id="xat-mini-count">0</span></div>
          <ul class="mini" id="xat-mini"></ul>
        </div>
        <div class="col-detail">
          <div class="pane__head">
            <div class="pane__headmain">
              <h2 id="xat-dname">—</h2>
              <div class="pane__headmeta" id="xat-dmeta"></div>
            </div>
            <button class="iconbtn" data-act="close-detail" title="收起（Esc）">×</button>
          </div>
          <div class="pane__body" id="xat-dbody"></div>
          <div class="pane__foot">
            <button class="btn btn--ghost btn--xs" data-act="open-options">设置与日志</button>
            <button class="btn btn--primary btn--xs" data-act="edit-community">编辑小区</button>
          </div>
        </div>
      </div>
    </section>

    <section class="pane pane--form" data-pane="form" hidden>
      <div class="pane__head">
        <div class="pane__headmain">
          <h2 id="xat-form-title">添加小区</h2>
          <div class="pane__headmeta" id="xat-form-meta"></div>
        </div>
        <button class="iconbtn" data-act="cancel-form" title="取消">×</button>
      </div>
      <div class="pane__body" id="xat-form-body"></div>
      <div class="pane__foot">
        <button class="btn btn--ghost btn--xs" data-act="form-delete">删除</button>
        <button class="btn btn--ghost" data-act="cancel-form">取消</button>
        <button class="btn btn--primary" data-act="form-save">保存</button>
      </div>
    </section>
  `;
  shadow.appendChild(side);

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.hidden = true;
  shadow.appendChild(tooltip);

  // 挂到页面
  (document.body || document.documentElement).appendChild(host);
  log.info("侧栏已注入", { boot: Date.now() - boot0, href: location.href });

  /* ---------------- 派生计算 ---------------- */

  function validDests() {
    const all = (state.settings && state.settings.destinations) || [];
    return all.filter((d) => d && Number.isFinite(d.lng) && Number.isFinite(d.lat)).slice(0, MAX_DESTS);
  }

  function compute() {
    const s = state.settings;
    const dests = validDests();
    state.dests = dests;

    if (!dests.length) {
      state.rows = [];
      state.roi = null;
      return [];
    }

    const mec = geo.minEnclosingCircle(dests.map((d) => [d.lng, d.lat]));
    const radius = Math.max(mec.radius + (s.radiusKm || 0) * 1000, 150);
    const roi = { center: mec.center, radius, mec };

    const rows = [];
    for (const c of state.communities) {
      const p = [c.lng, c.lat];
      const dCenter = geo.haversine(p, roi.center);
      if (dCenter > roi.radius) continue;

      const mins = dests.map((d) => geo.estimateMinutes(geo.haversine(p, [d.lng, d.lat]), d.mode));
      const worst = Math.max.apply(null, mins);
      const total = totalOf(c);
      const ok =
        total != null &&
        total >= s.budget.totalMin && total <= s.budget.totalMax &&
        Number(c.areaMax) >= s.budget.areaMin && Number(c.areaMin) <= s.budget.areaMax &&
        Number(c.avgPrice) <= s.budget.priceMax &&
        (s.tenure.length === 0 || s.tenure.indexOf(c.propertyType) >= 0);

      rows.push({ ...c, mins, worst, total, ok, dCenter, exact: false });
    }

    rows.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (state.sort === "total") return (a.total == null ? Infinity : a.total) - (b.total == null ? Infinity : b.total);
      if (state.sort === "price") return Number(a.avgPrice) - Number(b.avgPrice);
      return a.worst - b.worst;
    });

    state.rows = rows;
    state.roi = roi;
    log.debug("已重算候选集", { inRoi: rows.length, ok: rows.filter((r) => r.ok).length, radiusKm: s.radiusKm, dests: dests.length });
    return rows;
  }

  /* ---------------- 侧边栏渲染 ---------------- */

  function renderCond() {
    const s = state.settings;
    const all = (s.destinations || []);
    const modes = Array.from(new Set(state.dests.map((d) => MODE_LABEL[d.mode] || "驾车"))).join("/");
    const txt = state.dests.length
      ? `<em>${state.dests.length}</em> 个目的地 · <em>${modes}</em> · <em>${Number(s.radiusKm).toFixed(1)}</em> km · <em>${s.budget.totalMin}–${s.budget.totalMax}</em> 万`
      : all.length
        ? `<em>${all.length}</em> 个目的地待定位 · 点这里解析地址`
        : `<em>还没设目的地</em> · 点这里粘贴地址`;
    $("#xat-cond").innerHTML = txt;
    side.classList.toggle("is-detail", state.panel === "detail");
    side.classList.toggle("is-edit", state.panel === "edit");
    side.classList.toggle("is-form", state.panel === "form");
  }

  const LANE_MAX = 60;
  function renderLanes() {
    if (!state.dests.length) {
      $("#xat-lanes").innerHTML = "";
      $("#xat-axis").innerHTML = "";
      return;
    }
    const pct = (m) => (Math.min(m / LANE_MAX, 1) * 100).toFixed(2) + "%";
    $("#xat-lanes").innerHTML = state.dests
      .map((d, di) => {
        const ticks = state.rows
          .map((r) => {
            const sel = r.id === state.selected ? " is-sel" : "";
            return `<button class="lane__tick${sel}" style="left:${pct(r.mins[di])};background:${DEST_COLORS[di]}" ` +
              `data-id="${r.id}" title="${esc(r.name)} → ${DIGITS[di]} ${r.mins[di]} 分"></button>`;
          })
          .join("");
        return `<div class="lane"><span class="lane__k" style="background:${DEST_COLORS[di]}">${DIGITS[di]}</span>` +
          `<div class="lane__track"><i class="lane__base"></i>${ticks}</div></div>`;
      })
      .join("");
    $("#xat-axis").innerHTML = [0, 10, 20, 30, 40, 50, 60]
      .map((n) => `<span style="left:${pct(n)}">${n}</span>`)
      .join("");
    $$(".lane__tick").forEach((el) => el.addEventListener("click", () => select(el.dataset.id)));
  }

  function shownRows() {
    return state.rows.filter((r) => state.showOut || r.ok);
  }

  function renderList() {
    const rows = shownRows();
    const ok = state.rows.filter((r) => r.ok).length;
    $("#xat-cin").textContent = state.rows.length;
    $("#xat-cok").textContent = ok;
    $("#xat-n").textContent = ok;
    const dn = $("#xat-drawer-n");
    if (dn) dn.textContent = ok ? String(ok) : "";
    $("#xat-note").textContent = state.communities.length
      ? `本机共 ${state.communities.length} 个小区；通勤为直线估算（带 ~）。`
      : "小区库还是空的：点下方「＋ 添加小区」，或在设置页导入数据。";

    if (!state.dests.length) {
      const n = state.communities.length;
      $("#xat-list").innerHTML = `<li class="empty">
        <div class="empty__t">先设一个目的地</div>
        <div class="empty__d">在高德地图上右键 →「复制地址」，粘贴到「筛选条件」里的目的地输入框；<br />
        有了目的地才会画出搜索范围${n ? `，库里已有 <b>${n}</b> 个小区会按范围筛出来` : "和小区"}。</div>
        <button class="btn btn--primary btn--xs" data-act="edit" style="margin-top:10px">去设置目的地</button>
      </li>`;
      $$("[data-act='edit']", $("#xat-list")).forEach((b) => b.addEventListener("click", () => setPanel("edit")));
      return;
    }

    if (!rows.length) {
      const noneInDb = state.communities.length === 0;
      $("#xat-list").innerHTML = `<li class="empty">
        <div class="empty__t">${noneInDb ? "小区库是空的" : "范围内没有小区"}</div>
        <div class="empty__d">${noneInDb
          ? "还没有任何小区数据：可以点下方「＋ 添加小区」手动录入（右键复制地址直接带坐标），也可以在设置页导入官方数据。"
          : "把扩展半径调大试试，或者检查目的地坐标是否落在你想看的片区。"}</div>
        ${noneInDb ? `<button class="btn btn--primary btn--xs" data-act="new-community" style="margin-top:10px">＋ 添加小区</button>` : ""}
      </li>`;
      $$("[data-act='new-community']", $("#xat-list")).forEach((b) => b.addEventListener("click", () => openCommunityForm(null)));
      return;
    }

    $("#xat-list").innerHTML = rows
      .map((r, i) => {
        const pills = r.mins
          .map((m, di) => `<span class="pill pill--est"><i style="background:${DEST_COLORS[di]}">${DIGITS[di]}</i><b>${m}</b></span>`)
          .join("");
        return `<li class="entry${r.id === state.selected ? " is-sel" : ""}${r.ok ? "" : " is-out"}" data-id="${esc(r.id)}" role="button" tabindex="0">
          <div class="entry__idx">${String(i + 1).padStart(2, "0")}</div>
          <div>
            <div class="entry__name">${esc(r.name)}</div>
            <div class="entry__tags">${badge(weakestSrc(r))}
              ${r.sources.length > 1 ? `<span class="badge badge--none">+${r.sources.length - 1}</span>` : ""}
              ${(r.tags || []).map((t) => `<span class="badge badge--tag">${esc(t)}</span>`).join("")}
              ${r.ok ? "" : `<span class="badge badge--none">不符合过滤</span>`}
            </div>
            <div class="pills">${pills}</div>
            <div class="entry__meta"><span class="num">${fmtPrice(r.avgPrice)}</span> 元/㎡ ·
              <span class="num">${fmtTotal(r.total)}</span> · <span class="num">${fmtArea(r)}</span> ㎡ · ${esc(r.tenureYears || "—")}</div>
          </div>
          <div class="entry__worst entry__worst--est"><b>${r.worst}</b><span>最长</span></div>
        </li>`;
      })
      .join("");

    $$(".entry").forEach((el) => {
      el.addEventListener("click", () => select(el.dataset.id));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(el.dataset.id);
        }
      });
    });
  }

  function renderMini() {
    const rows = shownRows();
    $("#xat-mini-count").textContent = state.rows.length;
    let outStarted = false;
    $("#xat-mini").innerHTML = rows
      .map((r, i) => {
        const div = !r.ok && !outStarted ? ((outStarted = true), `<li class="mini__divider">不符合过滤 · 排在后面</li>`) : "";
        return div + `<li class="mini__row${r.id === state.selected ? " is-sel" : ""}${r.ok ? "" : " is-out"}"
            data-id="${esc(r.id)}" tabindex="0" role="button" title="${esc(r.name)}">
          <i class="mini__bar" style="background:${r.ok ? geo.tierColor(r.worst) : "#c9c3b6"}"></i>
          <span class="mini__idx">${String(i + 1).padStart(2, "0")}</span>
          <span class="mini__name">${esc(r.name)}</span>
          <b class="mini__min is-est">${r.worst}</b>
          <span class="mini__price">${fmtTotal(r.total)} · ${fmtPrice(r.avgPrice)} 元/㎡</span>
        </li>`;
      })
      .join("");

    $$(".mini__row").forEach((el) => {
      el.addEventListener("click", () => select(el.dataset.id));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(el.dataset.id);
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const all = $$(".mini__row");
          const idx = all.indexOf(el);
          const next = all[idx + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) {
            next.focus();
            select(next.dataset.id);
          }
        }
      });
    });

    const sel = $(".mini__row.is-sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function crow(k, v, kind) {
    const val = v == null ? `<em class="blank">未录入</em>` : v;
    const b = kind ? badge(kind) : `<span class="badge badge--none">待补</span>`;
    return `<div class="crow"><div class="crow__k">${k}</div><div class="crow__v">${val}</div>${b}</div>`;
  }

  function renderDetail() {
    const r = state.rows.find((x) => x.id === state.selected);
    if (!r) return;
    $("#xat-dname").textContent = r.name;
    $("#xat-dmeta").innerHTML = `${esc(r.district || "未填行政区")} · ${esc(r.sub || "—")} ${badge(weakestSrc(r))}` +
      (r.ok ? "" : `<span class="badge badge--none">不符合过滤</span>`);

    const commute = state.dests
      .map((d, di) => {
        const dist = geo.haversine([r.lng, r.lat], [d.lng, d.lat]);
        return `<div class="crow crow--commute">
          <span class="crow__pin" style="background:${DEST_COLORS[di]}">${DIGITS[di]}</span>
          <div>
            <div class="crow__big">~${r.mins[di]}<small>分</small></div>
            <div class="crow__sub">${MODE_LABEL[d.mode]} · ${(dist / 1000).toFixed(1)} km · ${esc(d.name)}</div>
          </div>
          <button class="btn btn--ghost btn--xs" data-goto="${di}">去高德算</button>
        </div>`;
      })
      .join("");

    const why = [];
    if (state.roi) {
      why.push(`落在搜索范围内：距圆心 <span class="num">${(r.dCenter / 1000).toFixed(1)}</span> km，范围半径 <span class="num">${(state.roi.radius / 1000).toFixed(1)}</span> km。`);
    }
    if (!r.ok) {
      const w = [];
      if (r.total == null) w.push("没有价格/面积信息，无法判断是否在预算内");
      else if (r.total < state.settings.budget.totalMin || r.total > state.settings.budget.totalMax) w.push(`总价 ${r.total} 万不在区间内`);
      if (r.avgPrice > state.settings.budget.priceMax) w.push(`均价 ${Number(r.avgPrice).toLocaleString()} 超过上限`);
      if (state.settings.tenure.length && state.settings.tenure.indexOf(r.propertyType) < 0) w.push(`产权「${r.propertyType}」不在筛选内`);
      why.length = 0;
      why.push(`<b>不符合过滤</b>：${w.join("；") || "面积与筛选区间不重叠"}。仍显示是因为打开了「显示不符合过滤」。`);
    }

    const built = Number(r.buildYear) > 0 ? `${r.buildYear} 年 · 房龄 ${new Date().getFullYear() - r.buildYear} 年` : null;

    $("#xat-dbody").innerHTML = `
      <div class="sat" id="xat-dsat"><div class="sat__ph">卫星影像加载中…</div></div>

      <div class="cblock">
        <div class="cblock__title">影像粗判（机器参考，需人工核对）</div>
        <div id="xat-dsat-metrics"><p class="hint" style="margin-top:0">等影像…</p></div>
      </div>

      <div class="cblock">
        <div class="cblock__title">通勤（${state.dests.length} 个目的地 · 估算）</div>
        ${commute || `<p class="hint" style="margin-top:0">还没有目的地，先去「筛选条件」里加一个。</p>`}
        <p class="hint">点「去高德算」会在新标签打开高德的路线规划，真实时长由高德计算（读回在阶段 3d 接入）。</p>
      </div>

      <div class="cblock">
        <div class="cblock__title">为什么在列表里</div>
        <p class="hint" style="margin-top:0">${why.join("<br />")}</p>
      </div>

      <div class="cblock">
        <div class="cblock__title">基本信息</div>
        ${crow("位置", `<span class="num">${r.lng.toFixed(4)}, ${r.lat.toFixed(4)}</span>`, "manual")}
        ${crow("行政区 / 板块", `${esc(r.district || "—")} · ${esc(r.sub || "—")}`, "manual")}
        ${crow("建成年份", built, built ? "manual" : null)}
        ${crow("边界多边形", null, null)}
      </div>

      <div class="cblock">
        <div class="cblock__title">价格与产权</div>
        ${crow("均价", Number(r.avgPrice) > 0 ? `<span class="num">${Number(r.avgPrice).toLocaleString()}</span> 元/㎡` : null, Number(r.avgPrice) > 0 ? "manual" : null)}
        ${crow("面积区间", Number(r.areaMin) > 0 || Number(r.areaMax) > 0 ? `<span class="num">${fmtArea(r)}</span> ㎡` : null, Number(r.areaMin) > 0 ? "manual" : null)}
        ${crow("总价约", r.total == null ? null : `<span class="num">${r.total}</span> 万`, r.total == null ? null : "manual")}
        ${crow("产权性质", `${esc(r.propertyType || "待确认")} · ${esc(r.tenureYears || "—")}`, "manual")}
        ${crow("备案价", r.official ? `<span class="num">${Number(r.official.filingPrice).toLocaleString()}</span> 元/㎡` : null, r.official ? "official" : null)}
        ${crow("预售证 / 去化", r.official ? `${esc(r.official.permitNo)} · 已售 <span class="num">${Math.round(r.official.soldRatio * 100)}</span>%` : null, r.official ? "official" : null)}
      </div>

      <div class="cblock">
        <div class="cblock__title">来源</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${r.sources.map(badge).join("")}</div>
        <p class="hint">本小区有 ${r.sources.length} 个来源；列表显示的是其中"最弱"的那个。</p>
      </div>
    `;

    $$("[data-goto]").forEach((b) => b.addEventListener("click", () => gotoAmap(Number(b.dataset.goto))));
    loadCommunitySat(r);
  }

  /* ---------------- 卫星影像：详情图 + 大圆扫描 ---------------- */

  function verdictLabel(v) {
    if (v === "like") return "像小区";
    if (v === "dislike") return "不像";
    if (v === "ignore") return "忽略";
    return "未判定";
  }

  function verdictButtons(tile, verdicts) {
    if (!tile) return `<p class="hint">没有可判定的瓦片。</p>`;
    const cur = (verdicts && verdicts[tile.key]) || "";
    const one = (v, txt) =>
      `<button class="vbtn${cur === v ? " is-on" : ""}" data-act="sat-verdict" data-key="${esc(tile.key)}" data-v="${v}" data-cur="${cur}">${txt}</button>`;
    return `<div class="sat__acts">${one("like", "像小区")}${one("dislike", "不像")}${one("ignore", "忽略")}
      <span class="muted">当前：${verdictLabel(cur)}</span></div>`;
  }

  function centerTileOf(res, r) {
    let best = null;
    for (const t of res.tiles || []) {
      const d = geo.haversine([r.lng, r.lat], t.center);
      if (!best || d < best.d) best = { tile: t, d };
    }
    return best ? best.tile : null;
  }

  function renderSatInto(res, r) {
    const box = $("#xat-dsat");
    const metrics = $("#xat-dsat-metrics");
    if (!box) return;
    const agg = res.aggregate || {};
    const center = centerTileOf(res, r);
    setHtml("#xat-dsat", `
      <img class="sat__img" src="${res.mosaic}" alt="卫星影像" />
      <div class="sat__legend"><i></i>红 = 二值化后筛出的“片状阴影块”（够大、成型）；碎影/细线不算</div>
    `);
    if (metrics) {
      setHtml("#xat-dsat-metrics", `
        <div class="sat__metrics">
          <div><b>${Math.round((agg.scoreMax || 0) * 100)}</b><span>粗分 / 100</span></div>
          <div><b>${agg.patchesTotal || 0}</b><span>片状阴影块</span></div>
          <div><b>${Math.round((agg.patchAreaM2Sum || 0) / 1000)}</b><span>片状面积千㎡</span></div>
          <div><b>${Math.round(agg.maxPatchM2 || 0)}</b><span>最大块 ㎡</span></div>
        </div>
        <p class="hint">z${res.zoom} · ${res.tiles.length} 张瓦片 · 暗区 ${Math.round((agg.darkRatioMean || 0) * 100)}% · 绿化 ${Math.round((agg.greenRatioMean || 0) * 100)}%</p>
        ${verdictButtons(center, res.verdicts)}
        <p class="hint">机器只看“片状阴影块”，会漏也会误；最终以你看到的图为准。</p>
      `);
    }
  }

  async function loadCommunitySat(r) {
    const key = "c:" + r.id;
    const box = $("#xat-dsat");
    if (!box) return;
    if (state.sat[key]) {
      renderSatInto(state.sat[key], r);
      return;
    }
    box.innerHTML = `<div class="sat__ph">卫星影像加载中…（3×3 瓦片）</div>`;
    const metrics = $("#xat-dsat-metrics");
    if (metrics) metrics.innerHTML = `<p class="hint" style="margin-top:0">等影像…</p>`;
    try {
      const res = await rpc("imagery.community", { lng: r.lng, lat: r.lat });
      state.sat[key] = res;
      if (state.selected !== r.id) return;
      renderSatInto(res, r);
    } catch (e) {
      box.innerHTML = `<div class="sat__ph sat__ph--bad">影像取不到：${esc(e.message || e)}</div>`;
      log.warn("卫星影像失败", { error: String(e) });
    }
  }

  /* ---------------- 阴影扫描：保存时触发，逐瓦片算、逐瓦片画 ---------------- */

  const SCAN_MAX_TILES = 36;
  const SCAN_RADIUS_M = 600;

  function freezeMap(on) {
    window.postMessage({ __xat: "ui", type: "freeze", on: !!on }, "*");
  }

  async function startScan() {
    // 自绘地图页：扫描统一交给适配层（整圆覆盖 + 掩膜 + 聚类 + POI 反查）
    if (window.__xatShim && typeof window.__xatShim.scan === "function") {
      await window.__xatShim.scan();
      return;
    }
    const roi = state.roi;
    if (!roi) {
      toast("先设目的地，才有搜索范围");
      return;
    }
    if (state.scanRunning) {
      toast("正在扫描中…");
      return;
    }
    state.scanRunning = true;
    state.scan = {
      incremental: true,
      loading: true,
      polys: [],
      lens: [],
      roads: [],
      done: 0,
      total: 0,
      cached: 0,
      failed: 0,
      at: Date.now(),
    };
    state.scanScreen = null;
    state.tab = "discover";
    renderDiscover();
    freezeMap(true);
    draw();
    try {
      const plan = await rpc("scan.plan", {
        lng: roi.center[0],
        lat: roi.center[1],
        radiusM: Math.min(SCAN_RADIUS_M, Math.max(200, roi.radius)),
        maxTiles: SCAN_MAX_TILES,
      });
      state.scan.zoom = plan.zoom;
      state.scan.total = plan.tiles.length;
      state.scan.radiusM = plan.radiusM;
      // 缩放到扫描范围，否则瓦片多边形在地图上看不清
      const gcjCenter = geo.wgs84ToGcj02(roi.center[0], roi.center[1]);
      window.postMessage(
        { __xat: "ui", type: "fit", center: gcjCenter, zoom: Math.max(14, plan.zoom - 1) },
        "*",
      );
      renderDiscover();
      fetchRoads(plan.tiles);

      for (const t of plan.tiles) {
        if (!state.scanRunning) break;
        try {
          const res = await rpc("scan.tile", { z: t.z, x: t.x, y: t.y });
          for (const b of res.blobs || []) {
            if (b.areaM2 < 3000) continue;   // 太碎的块不画，避免糊成一片
            state.scan.polys.push(b.hull);
            state.scan.lens.push(b.hull.length);
          }
          if (res.cached) state.scan.cached += 1;
        } catch (e) {
          state.scan.failed += 1;
          log.warn("瓦片阴影失败", { key: t.key, error: String(e) });
        }
        state.scan.done += 1;
        requestShadowProjection();
        renderDiscover();
        // yield so the map can paint and the tab stays responsive
        await new Promise((res) => setTimeout(res, 0));
      }
      state.scan.loading = false;
      toast(
        `阴影完成：${state.scan.polys.length} 块 · 缓存命中 ${state.scan.cached}/${state.scan.total}`,
      );
      log.info("阴影扫描完成", {
        tiles: state.scan.total,
        cached: state.scan.cached,
        failed: state.scan.failed,
        blobs: state.scan.polys.length,
      });
    } catch (e) {
      state.scan = { incremental: true, error: String(e.message || e) };
      log.error("阴影扫描失败", { error: String(e) });
      toast("阴影扫描失败：" + (e.message || e));
    } finally {
      state.scanRunning = false;
      freezeMap(false);
      renderDiscover();
      draw();
    }
  }

  /** 路网：拿 tiles 的外接 bbox（WGS84），失败不影响阴影 */
  async function fetchRoads(tiles) {
    try {
      let s = 90;
      let w = 180;
      let n = -90;
      let e = -180;
      for (const t of tiles) {
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const ll = tileToWgs84(t.z, t.x + dx, t.y + dy);
          if (ll[1] < s) s = ll[1];
          if (ll[1] > n) n = ll[1];
          if (ll[0] < w) w = ll[0];
          if (ll[0] > e) e = ll[0];
        }
      }
      const res = await rpc("scan.roads", { bbox: [s, w, n, e] });
      if (!state.scan || !state.scan.incremental) return;
      state.scan.roads = res.roads || [];
      requestShadowProjection();
      log.info("路网已绘制", { ways: res.count });
    } catch (e) {
      log.warn("路网获取失败（不影响阴影）", { error: String(e) });
    }
  }

  function tileToWgs84(z, x, y) {
    const n2 = 2 ** z;
    const gLng = (x / n2) * 360 - 180;
    const gLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n2))) * 180) / Math.PI;
    return geo.gcj02ToWgs84(gLng, gLat);
  }

  let shadowProjPending = null;
  function requestShadowProjection() {
    if (shadowProjPending) return;
    shadowProjPending = requestAnimationFrame(() => {
      shadowProjPending = null;
      const sc = state.scan;
      const polys = (sc && sc.polys) || [];
      const roads = (sc && sc.roads) || [];
      if (!polys.length && !roads.length) {
        state.scanScreen = null;
        draw();
        return;
      }
      const pts = [];
      for (const p of polys) for (const q of p) pts.push(q);
      for (const r of roads) for (const q of r.line) pts.push(q);
      state.scanSnapshot = { lens: (sc && sc.lens ? sc.lens.slice() : []), roadLens: roads.map((r) => r.line.length) };
      state.scanReqId = ++projSeq;
      window.postMessage({ __xat: "ui", type: "project", reqId: state.scanReqId, points: pts }, "*");
    });
  }

  /** 把投影回来的屏幕坐标画上去：先路网、再阴影 */
  function drawScanLayer() {
    const sp = state.scanScreen;
    if (!sp) return;
    ctx.save();
    for (const r of sp.roads) {
      const major = r.class === "trunk" || r.class === "primary" || r.class === "secondary";
      ctx.beginPath();
      let started = false;
      for (const p of r.line) {
        if (!p) { started = false; continue; }
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
      }
      // 浅底图上白线看不见：先描白边再压深色
      ctx.lineWidth = (major ? 3.4 : 2.2) + 2;
      ctx.strokeStyle = "rgba(255,255,255,.75)";
      ctx.stroke();
      ctx.lineWidth = major ? 3.4 : 2.2;
      ctx.strokeStyle = major ? "rgba(24,52,96,.85)" : "rgba(24,52,96,.55)";
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(217,74,58,.16)";
    ctx.strokeStyle = "rgba(217,74,58,.9)";
    ctx.lineWidth = 1.2;
    for (const ring of sp.polys) {
      if (!ring.length) continue;
      ctx.beginPath();
      let started = false;
      for (const p of ring) {
        if (!p) continue;
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function renderDiscover() {
    const out = $("#xat-scan-out");
    if (!out) return;
    const s = state.scan;
    if (!s) {
      out.innerHTML = `<p class="hint">还没扫描。点上面的按钮会抓 20–25 张瓦片并分析；首次约 10–20 秒，之后走本机缓存。</p>`;
      return;
    }
    if (s.incremental) {
      if (s.error) {
        out.innerHTML = `<div class="sat__ph sat__ph--bad">扫描失败：${esc(s.error)}</div>`;
        return;
      }
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      out.innerHTML = `
        <div class="sat__ph">${s.loading ? "扫描中" : "扫描完成"} ${s.done}/${s.total}（${pct}%）· 阴影 ${s.polys.length} 块</div>
        <div class="scan-bar"><i style="width:${pct}%"></i></div>
        <p class="hint">z${s.zoom || "-"} · 缓存命中 ${s.cached}${s.failed ? ` · 失败 ${s.failed}` : ""} · 阴影实时叠加在地图上（红色），白色为路网</p>`;
      return;
    }
    if (s.loading) {
      out.innerHTML = `<div class="sat__ph">正在抓瓦片并分析…</div>`;
      return;
    }
    if (s.error) {
      out.innerHTML = `<div class="sat__ph sat__ph--bad">扫描失败：${esc(s.error)}</div>`;
      return;
    }
    const agg = s.aggregate || {};
    const tiles = (s.tiles || []).slice().sort((a, b) => b.score - a.score);
    const rows = tiles
      .slice(0, 8)
      .map((t) => {
        const cur = (s.verdicts || {})[t.key] || "";
        const btn = (v, txt) =>
          `<button class="vbtn${cur === v ? " is-on" : ""}" data-act="sat-verdict" data-key="${esc(t.key)}" data-v="${v}" data-cur="${cur}">${txt}</button>`;
        return `<li class="scan-tile">
          <div class="scan-tile__h">
            <b class="scan-tile__s">${Math.round(t.score * 100)}</b>
            <span class="num">${t.center[0].toFixed(4)}, ${t.center[1].toFixed(4)}</span>
            <span class="badge badge--none">${t.feats.patches || 0} 片状影 · ${Math.round(t.feats.maxPatchM2 || 0)}㎡</span>
          </div>
          <div class="scan-tile__acts">
            ${btn("like", "像小区")}${btn("dislike", "不像")}${btn("ignore", "忽略")}
            <button class="vbtn vbtn--add" data-act="adopt-tile" data-key="${esc(t.key)}">加为小区</button>
          </div>
        </li>`;
      })
      .join("");
    setHtml("#xat-scan-out", `
      <img class="sat__img" src="${s.mosaic}" alt="搜索范围卫星影像" />
      <div class="sat__legend"><i></i>红 = 片状阴影块 · 粗分均值 ${Math.round((agg.scoreMean || 0) * 100)} / 最高 ${Math.round((agg.scoreMax || 0) * 100)} · 片状块合计 ${agg.patchesTotal || 0}</div>
      <p class="hint">z${s.zoom} · 实际覆盖半径 ${(s.radiusM / 1000).toFixed(2)} km${s.clipped ? `（搜索半径 ${(s.requestedRadiusM / 1000).toFixed(1)} km 太大，只扫了中心）` : ""} · ${s.tiles.length} 张瓦片${s.failures ? ` · ${s.failures} 张失败` : ""}</p>
      <ul class="scan-list">${rows || `<li class="empty"><div class="empty__d">这一片没检出长影带。</div></li>`}</ul>
      <p class="hint">按粗分排序的前 ${Math.min(8, tiles.length)} 张。判定会存本机；觉得对就点「加为小区」把它录进来。</p>
    `);
  }

  async function setVerdict(key, v, cur) {
    const next = cur === v ? "none" : v;
    try {
      const res = await rpc("imagery.verdict", { key, verdict: next });
      const apply = (store) => {
        if (!store) return;
        if (!store.verdicts) store.verdicts = {};
        if (res.verdict) store.verdicts[key] = res.verdict;
        else delete store.verdicts[key];
      };
      apply(state.scan);
      Object.keys(state.sat).forEach((k) => apply(state.sat[k]));
      toast(next === "none" ? "已清除判定" : `已记下：${verdictLabel(next)}`);
      if (state.panel === "detail") renderDetail();
      if (state.tab === "discover") renderDiscover();
    } catch (e) {
      toast("记录失败：" + (e.message || e));
    }
  }

  function adoptTile(key) {
    const t = ((state.scan && state.scan.tiles) || []).find((x) => x.key === key);
    if (!t) return;
    openCommunityForm(null);
    if (!state.form) return;
    state.form.name = `影像候选 z${t.z}`;
    state.form.lng = t.center[0];
    state.form.lat = t.center[1];
    state.form.sources = ["manual"];
    renderForm();
    toast("坐标已填好，改成真实小区名再保存");
  }

  function destRowHtml(d, i, total) {
    const ok = Number.isFinite(d.lng) && Number.isFinite(d.lat);
    const coord = ok
      ? `${Number(d.lng).toFixed(6)}, ${Number(d.lat).toFixed(6)}`
      : "坐标未定位 · 粘贴地址后点「解析」";
    return `<li class="dest" data-di="${i}">
      <span class="dest__k" style="background:${DEST_COLORS[i % DEST_COLORS.length]}">${DIGITS[i] || i + 1}</span>
      <div class="dest__main">
        <div class="dest__row">
          <input class="input" data-dname="${i}" value="${esc(d.name || "")}" placeholder="粘贴右键复制来的地址" />
          <button class="dest__parse" data-dparse="${i}">解析</button>
        </div>
        <div class="dest__coord ${ok ? "is-ok" : "is-bad"}">${esc(coord)}</div>
        <div class="seg">
          ${Object.keys(MODE_LABEL)
            .map((m) => `<button class="seg__btn${d.mode === m ? " is-on" : ""}" data-dmode="${i}:${m}">${MODE_LABEL[m]}</button>`)
            .join("")}
        </div>
      </div>
      <button class="dest__del" data-ddel="${i}" ${total <= 1 ? "disabled" : ""}>✕</button>
    </li>`;
  }

  function renderEdit() {
    const s = state.settings;
    const all = s.destinations || [];
    const L = Object.assign({}, LAYOUT_DEFAULTS, s.layout || {});
    $("#xat-edit-body").innerHTML = `
      <fieldset class="field">
        <legend>目的地（最多 ${MAX_DESTS} 个）</legend>
        ${all.length
          ? `<ul class="dests">${all.map((d, i) => destRowHtml(d, i, all.length)).join("")}</ul>`
          : `<p class="hint" style="margin-top:0">还没有目的地。在高德地图上<b>右键 → 复制地址</b>，再点下面的「＋ 添加目的地」把地址粘进去。</p>`}
        <button class="btn btn--ghost btn--xs" data-act="add-dest" ${all.length >= MAX_DESTS ? "disabled" : ""}>＋ 添加目的地</button>
        <p class="hint">粘贴内容里带坐标（形如 <code>108.965123,34.245678</code>）会直接定位；只有文字时用高德页面自带的解析接口（需要高德页面联网正常）。</p>
      </fieldset>

      <fieldset class="field">
        <legend>扩展半径</legend>
        <label class="slider">
          <span>半径 <em class="num" id="xat-rad-out">${Number(s.radiusKm).toFixed(1)}</em> km</span>
          <input type="range" id="xat-rad" min="0" max="150" value="${Math.round(s.radiusKm * 10)}" />
        </label>
        <p class="hint">${all.length} 个目的地 → 取最小外接圆，再向外扩 ${Number(s.radiusKm).toFixed(1)} km。</p>
      </fieldset>

      <fieldset class="field">
        <legend>侧栏位置</legend>
        <label class="slider">
          <span>顶部留白 <em class="num" id="xat-top-out">${Math.round(Number(L.top))}</em> px</span>
          <input type="range" id="xat-lay-top" min="0" max="260" step="4" value="${Math.round(Number(L.top))}" />
        </label>
        <label class="slider">
          <span>底部留白 <em class="num" id="xat-bot-out">${Math.round(Number(L.bottom))}</em> px</span>
          <input type="range" id="xat-lay-bottom" min="0" max="260" step="4" value="${Math.round(Number(L.bottom))}" />
        </label>
        <p class="hint">让侧栏躲开高德右上角的工具条（卫星/图层/测距）和底部版权条；拖动立即生效，保存后下次也生效。</p>
      </fieldset>

      <fieldset class="field">
        <legend>预算与面积</legend>
        <p class="hint" style="margin-top:0">总价 ${s.budget.totalMin}–${s.budget.totalMax} 万 · 面积 ${s.budget.areaMin}–${s.budget.areaMax} ㎡ · 均价上限 ${Number(s.budget.priceMax).toLocaleString()} 元/㎡</p>
        <p class="hint">滑块在下一版接上，目前是固定值。</p>
      </fieldset>

      <fieldset class="field">
        <legend>产权性质</legend>
        <div class="chips">
          ${["商品房", "经济适用房", "安置房", "公寓"]
            .map((t) => `<button class="chip${s.tenure.indexOf(t) >= 0 ? " is-on" : " is-off"}" data-tenure="${t}">${t}</button>`)
            .join("")}
        </div>
      </fieldset>
    `;
    bindEditEvents();
  }

  function bindEditEvents() {
    const s = state.settings;

    $("#xat-rad").addEventListener("input", (e) => {
      s.radiusKm = Number(e.target.value) / 10;
      $("#xat-rad-out").textContent = Number(s.radiusKm).toFixed(1);
      recomputeAndRender();
    });

    const layTop = $("#xat-lay-top");
    const layBottom = $("#xat-lay-bottom");
    if (layTop) {
      layTop.addEventListener("input", (e) => {
        s.layout = Object.assign({}, LAYOUT_DEFAULTS, s.layout || {}, { top: Number(e.target.value) });
        $("#xat-top-out").textContent = Math.round(Number(s.layout.top));
        applyLayout();
      });
    }
    if (layBottom) {
      layBottom.addEventListener("input", (e) => {
        s.layout = Object.assign({}, LAYOUT_DEFAULTS, s.layout || {}, { bottom: Number(e.target.value) });
        $("#xat-bot-out").textContent = Math.round(Number(s.layout.bottom));
        applyLayout();
      });
    }

    $$("[data-dname]").forEach((el) => {
      const idx = Number(el.dataset.dname);
      el.addEventListener("input", () => {
        const d = s.destinations[idx];
        if (!d) return;
        d.name = el.value;
        // 打字/粘贴过程中一旦出现坐标就立刻定位（不重绘输入框，免得打断输入）
        const coords = parseCoords(el.value);
        if (coords && (d.lng !== coords.lng || d.lat !== coords.lat)) {
          d.lng = coords.lng;
          d.lat = coords.lat;
          const row = el.closest(".dest");
          const coordEl = row ? row.querySelector(".dest__coord") : null;
          if (coordEl) {
            coordEl.textContent = coords.lng.toFixed(6) + ", " + coords.lat.toFixed(6);
            coordEl.classList.remove("is-bad");
            coordEl.classList.add("is-ok");
          }
          compute();
          renderCond();
          renderLanes();
          renderList();
          requestProjection();
          maybeFitToDests();
        }
      });
      el.addEventListener("paste", () => {
        setTimeout(() => autoApplyIfCoords(idx), 0);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          parseDest(idx);
        }
      });
    });

    $$("[data-dparse]").forEach((b) => b.addEventListener("click", () => parseDest(Number(b.dataset.dparse))));

    $$("[data-dmode]").forEach((b) =>
      b.addEventListener("click", () => {
        const [di, mode] = b.dataset.dmode.split(":");
        const d = s.destinations[Number(di)];
        if (d) d.mode = mode;
        renderEdit();
        recomputeAndRender();
      })
    );

    $$("[data-ddel]").forEach((b) =>
      b.addEventListener("click", () => {
        s.destinations.splice(Number(b.dataset.ddel), 1);
        s.destinationCount = s.destinations.length;
        renderEdit();
        recomputeAndRender();
      })
    );

    $$("[data-tenure]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = b.dataset.tenure;
        const i = s.tenure.indexOf(t);
        if (i >= 0) s.tenure.splice(i, 1);
        else s.tenure.push(t);
        renderEdit();
        recomputeAndRender();
      })
    );
  }

  /** 目的地解析：文本里带坐标就直接用，否则走页面自带的 Geocoder */
  function parseDest(idx) {
    const s = state.settings;
    const d = (s.destinations || [])[idx];
    if (!d) return;
    const input = $(`[data-dname="${idx}"]`);
    const raw = (input ? input.value : d.name || "").trim();
    if (!raw) return toast("先粘贴一个地址");
    d.name = stripCoords(raw) || raw;

    const coords = parseCoords(raw);
    if (coords) {
      d.lng = coords.lng;
      d.lat = coords.lat;
      renderEdit();
      recomputeAndRender();
      toast("已按文本里的坐标定位");
      return;
    }

    const btn = $(`[data-dparse="${idx}"]`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "解析中…";
    }
    requestGeocode(raw, (res) => {
      if (res && res.ok) {
        const [lng, lat] = geo.gcj02ToWgs84(res.gcj[0], res.gcj[1]);
        d.lng = lng;
        d.lat = lat;
        d.name = raw;
        toast("已定位：" + (res.address || raw));
      } else {
        d.lng = null;
        d.lat = null;
        toast("地址没解析出来：" + ((res && res.error) || "未知原因"));
      }
      renderEdit();
      recomputeAndRender();
    });
  }

  /** 粘贴后如果发现坐标，直接定位，不用再点「解析」 */
  function autoApplyIfCoords(idx) {
    const s = state.settings;
    const d = (s.destinations || [])[idx];
    const input = $(`[data-dname="${idx}"]`);
    if (!d || !input) return;
    const coords = parseCoords(input.value);
    if (!coords) return;
    d.name = stripCoords(input.value) || input.value.trim();
    d.lng = coords.lng;
    d.lat = coords.lat;
    renderEdit();
    recomputeAndRender();
    toast("已识别到坐标");
  }

  /* ---------------- 小区录入 / 编辑 ---------------- */

  function openCommunityForm(id) {
    const row = id ? state.communities.find((c) => c.id === id) : null;
    state.formIsNew = !row;
    state.form = row
      ? Object.assign({}, row)
      : {
          id: null,
          name: "",
          district: null,
          sub: null,
          lng: null,
          lat: null,
          avgPrice: 0,
          areaMin: 0,
          areaMax: 0,
          buildYear: null,
          tenureYears: "70年",
          propertyType: "商品房",
          tags: [],
          sources: ["manual"],
          official: null,
        };
    setPanel("form");
  }

  function renderForm() {
    const f = state.form;
    if (!f) return;
    const ok = Number.isFinite(f.lng) && Number.isFinite(f.lat);
    $("#xat-form-title").textContent = state.formIsNew ? "添加小区" : "编辑小区";
    $("#xat-form-meta").innerHTML = state.formIsNew
      ? "名称 + 坐标就能存，其余可以后补"
      : `${badge((f.sources || ["manual"])[0])} <span class="muted">ID ${esc(f.id)}</span>`;
    const props = ["商品房", "经济适用房", "安置房", "公寓", "房改房", "待确认"];

    $("#xat-form-body").innerHTML = `
      <div class="formgrid">
        <div class="formrow">
          <label>名称 / 地址</label>
          <div class="dest__row">
            <input class="input" id="xat-fname" value="${esc(f.name || "")}" placeholder="粘贴右键复制来的地址，或手填小区名" />
            <button class="dest__parse" id="xat-fparse">解析</button>
          </div>
        </div>
        <div class="formrow">
          <label>坐标</label>
          <div class="dest__coord ${ok ? "is-ok" : "is-bad"}" id="xat-fcoord">${ok ? Number(f.lng).toFixed(6) + ", " + Number(f.lat).toFixed(6) : "未定位"}</div>
        </div>
        <div class="formrow">
          <label>均价 元/㎡</label>
          <input class="input" id="xat-fprice" type="number" min="0" step="100" value="${Number(f.avgPrice) || 0}" />
        </div>
        <div class="formrow formrow--pair">
          <label>面积 ㎡</label>
          <input class="input" id="xat-farea-min" type="number" min="0" step="1" value="${Number(f.areaMin) || 0}" placeholder="最小" />
          <span class="sep">–</span>
          <input class="input" id="xat-farea-max" type="number" min="0" step="1" value="${Number(f.areaMax) || 0}" placeholder="最大" />
        </div>
        <div class="formrow">
          <label>建成年份</label>
          <input class="input" id="xat-fyear" type="number" min="1950" max="2035" value="${Number(f.buildYear) || ""}" placeholder="例如 2016" />
        </div>
        <div class="formrow">
          <label>产权性质</label>
          <div class="chips">
            ${props.map((p) => `<button class="chip${f.propertyType === p ? " is-on" : ""}" data-fprop="${p}">${p}</button>`).join("")}
          </div>
        </div>
        <div class="formrow">
          <label>标签</label>
          <input class="input" id="xat-ftags" value="${esc((f.tags || []).join(" "))}" placeholder="空格分隔，例如：临铁 学区" />
        </div>
        <div class="formrow">
          <label>行政区</label>
          <input class="input" id="xat-fdistrict" value="${esc(f.district || "")}" placeholder="雁塔 / 高新 …（可留空）" />
        </div>
      </div>
      <div class="formnote">
        <b>怎么快速定位？</b> 在高德地图上对着小区位置<b>右键 →「复制地址（西接通勤）」</b>，
        再把剪贴板内容粘到上面的「名称 / 地址」框，会自动带出坐标（形如 <code>108.965123,34.245678</code>）；
        只有地名时点「解析」，用高德页面自带的接口换算。
      </div>
    `;

    const nameEl = $("#xat-fname");
    nameEl.addEventListener("input", () => {
      f.name = nameEl.value;
      const coords = parseCoords(nameEl.value);
      if (coords && (f.lng !== coords.lng || f.lat !== coords.lat)) {
        f.lng = coords.lng;
        f.lat = coords.lat;
        const c = $("#xat-fcoord");
        if (c) {
          c.textContent = coords.lng.toFixed(6) + ", " + coords.lat.toFixed(6);
          c.classList.remove("is-bad");
          c.classList.add("is-ok");
        }
      }
    });
    nameEl.addEventListener("paste", () => setTimeout(() => formParseCoords(true), 0));
    nameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        formParseCoords(false);
      }
    });
    $("#xat-fparse").addEventListener("click", () => formParseCoords(false));
    $$("[data-fprop]").forEach((b) =>
      b.addEventListener("click", () => {
        f.propertyType = b.dataset.fprop;
        $$("[data-fprop]").forEach((x) => x.classList.toggle("is-on", x === b));
      })
    );
  }

  function formParseCoords(onlyIfCoords) {
    const f = state.form;
    if (!f) return;
    const el = $("#xat-fname");
    const raw = (el ? el.value : f.name || "").trim();
    if (!raw) return toast("先填名称或地址");
    f.name = stripCoords(raw) || raw;

    const coords = parseCoords(raw);
    if (coords) {
      f.lng = coords.lng;
      f.lat = coords.lat;
      const c = $("#xat-fcoord");
      if (c) {
        c.textContent = Number(f.lng).toFixed(6) + ", " + Number(f.lat).toFixed(6);
        c.classList.remove("is-bad");
        c.classList.add("is-ok");
      }
      if (el) el.value = f.name;
      toast("已识别坐标");
      return;
    }
    if (onlyIfCoords) return;

    const btn = $("#xat-fparse");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "解析中…";
    }
    requestGeocode(raw, (res) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "解析";
      }
      if (res && res.ok) {
        const [lng, lat] = geo.gcj02ToWgs84(res.gcj[0], res.gcj[1]);
        f.lng = lng;
        f.lat = lat;
        const c = $("#xat-fcoord");
        if (c) {
          c.textContent = lng.toFixed(6) + ", " + lat.toFixed(6);
          c.classList.remove("is-bad");
          c.classList.add("is-ok");
        }
        toast("已定位：" + (res.address || raw));
      } else {
        toast("没解析出坐标：" + ((res && res.error) || "未知原因"));
      }
    });
  }

  function readFormInputs() {
    const f = state.form;
    if (!f) return null;
    const nameEl = $("#xat-fname");
    const priceEl = $("#xat-fprice");
    const amin = $("#xat-farea-min");
    const amax = $("#xat-farea-max");
    const year = $("#xat-fyear");
    const tags = $("#xat-ftags");
    const district = $("#xat-fdistrict");
    if (nameEl) f.name = nameEl.value.trim();
    if (priceEl) f.avgPrice = Number(priceEl.value) || 0;
    if (amin) f.areaMin = Number(amin.value) || 0;
    if (amax) f.areaMax = Number(amax.value) || 0;
    if (year) f.buildYear = Number(year.value) || null;
    if (tags) f.tags = (tags.value || "").split(/\s+/).filter(Boolean);
    if (district) f.district = district.value.trim() || null;

    if (!f.name) {
      toast("名称不能为空");
      return null;
    }
    if (!Number.isFinite(f.lng) || !Number.isFinite(f.lat)) {
      toast("还没有坐标：粘贴右键复制的地址，或点「解析」");
      return null;
    }
    if (f.areaMax > 0 && f.areaMin > f.areaMax) {
      const t = f.areaMin;
      f.areaMin = f.areaMax;
      f.areaMax = t;
    }
    if (!f.areaMax) f.areaMax = f.areaMin;
    return f;
  }

  async function saveForm() {
    const f = readFormInputs();
    if (!f) return;
    try {
      const saved = await rpc("community.put", { community: f });
      delete state.sat["c:" + saved.id];
      const i = state.communities.findIndex((c) => c.id === saved.id);
      if (i >= 0) state.communities[i] = saved;
      else state.communities.push(saved);
      state.form = null;
      setPanel("list");
      recomputeAndRender();
      toast("已保存：" + saved.name);
    } catch (e) {
      log.error("保存小区失败", { error: String(e) });
      toast("保存失败：" + e.message);
    }
  }

  async function deleteForm() {
    const f = state.form;
    if (!f) return;
    if (!f.id) {
      state.form = null;
      setPanel("list");
      return;
    }
    if (!window.confirm(`删除「${f.name || "这个小区"}」？`)) return;
    try {
      await rpc("community.del", { id: f.id });
    } catch (e) {
      toast("删除失败：" + e.message);
      return;
    }
    state.communities = state.communities.filter((c) => c.id !== f.id);
    delete state.sat["c:" + f.id];
    if (state.selected === f.id) state.selected = null;
    state.form = null;
    setPanel("list");
    recomputeAndRender();
    toast("已删除");
  }

  function render() {
    renderCond();
    renderLanes();
    renderList();
    renderMini();
    if (state.panel === "detail") renderDetail();
    if (state.panel === "edit") renderEdit();
    if (state.panel === "form") renderForm();
  }

  function recomputeAndRender() {
    state.scan = null;
    compute();
    render();
    requestProjection();
    maybeFitToDests();
  }

  function setPanel(p) {
    state.panel = p;
    $$(".pane").forEach((el) => (el.hidden = el.dataset.pane !== p));
    if (p === "edit") renderEdit();
    if (p === "detail") renderDetail();
    if (p === "form") renderForm();
    renderCond();
  }

  function select(id) {
    state.selected = id;
    setDrawerVisible(true);
    renderDetail();
    renderMini();
    renderLanes();
    setPanel("detail");
    requestProjection();
    log.debug("选中小区", { id });
  }

  function closeDetail() {
    state.selected = null;
    setPanel("list");
    renderLanes();
    renderMini();
    requestProjection();
  }

  /* ---------------- 去高德算（深链） ---------------- */

  async function gotoAmap(di) {
    const r = state.rows.find((x) => x.id === state.selected);
    const d = state.dests[di];
    if (!r || !d) return;
    // 高德的经纬度是 GCJ-02，必须先转，否则端点会偏 300-500m
    const [flng, flat] = geo.wgs84ToGcj02(d.lng, d.lat);
    const [dlng, dlat] = geo.wgs84ToGcj02(r.lng, r.lat);
    const url = "https://www.amap.com/ssr/dir"
      + `?fname=${encodeURIComponent(d.name)}&flat=${flat.toFixed(6)}&flon=${flng.toFixed(6)}`
      + `&dname=${encodeURIComponent(r.name)}&dlat=${dlat.toFixed(6)}&dlon=${dlng.toFixed(6)}`
      + `&type=${MODE_TYPE[d.mode]}`;
    log.info("打开高德算路", { url, mode: d.mode, community: r.name });
    try {
      await rpc("openTab", { url, active: true });
    } catch (e) {
      log.error("打开标签失败", { error: String(e) });
    }
  }

  /* ---------------- 投影与 canvas ---------------- */

  let projSeq = 0;
  let pendingProj = null;
  const cvs = canvas;
  const ctx = cvs.getContext("2d");
  let DPR = 1;

  function resizeCanvas() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    cvs.width = Math.round(window.innerWidth * DPR);
    cvs.height = Math.round(window.innerHeight * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function requestProjection() {
    if (pendingProj) return;
    pendingProj = requestAnimationFrame(() => {
      pendingProj = null;
      if (!state.roi) return;
      const items = [];
      const pts = [];
      const push = (kind, id, lnglat) => {
        items.push({ kind, id, i: pts.length });
        pts.push(lnglat);
      };

      state.dests.forEach((d, di) => push("dest", di, [d.lng, d.lat]));
      push("roi-center", null, state.roi.center);
      geo.circlePoints(state.roi.center, state.roi.radius, 72).forEach((p) => push("roi-ring", null, p));
      if (state.roi.mec.radius > 60) {
        geo.circlePoints(state.roi.mec.center, state.roi.mec.radius, 72).forEach((p) => push("mec-ring", null, p));
      }
      state.rows.forEach((r) => push("community", r.id, [r.lng, r.lat]));

      const gcj = pts.map((p) => geo.wgs84ToGcj02(p[0], p[1]));
      window.postMessage({ __xat: "ui", type: "project", reqId: ++projSeq, points: gcj }, "*");
    });
  }

  function onScanProjected(payload) {
    const { points, info, ready } = payload || {};
    if (!ready || !points || !info || !info.rect) return;
    const ox = info.rect.left || 0;
    const oy = info.rect.top || 0;
    const snap = state.scanSnapshot || { lens: [], roadLens: [] };
    let i = 0;
    const polys = [];
    for (const len of snap.lens) {
      const ring = [];
      for (let k = 0; k < len; k += 1) {
        const p = points[i++];
        ring.push(p ? [ox + p[0], oy + p[1]] : null);
      }
      polys.push(ring);
    }
    const roads = [];
    const src = (state.scan && state.scan.roads) || [];
    for (let ri = 0; ri < snap.roadLens.length; ri += 1) {
      const line = [];
      for (let k = 0; k < snap.roadLens[ri]; k += 1) {
        const p = points[i++];
        line.push(p ? [ox + p[0], oy + p[1]] : null);
      }
      roads.push({ class: (src[ri] && src[ri].class) || "road", line });
    }
    state.scanScreen = { polys, roads };
    draw();
  }

  function onProjectResult(payload) {
    const { reqId, points, info, ready } = payload || {};
    if (!reqId) return;
    if (!ready) {
      log.debug("投影未就绪（地图实例还没拿到）");
      return;
    }
    if (!state.hookReady) markHookReady(info, "project-result");
    if (!points || !info || !info.rect) return;

    const ox = info.rect.left || 0;
    const oy = info.rect.top || 0;
    const toScreen = (p) => (p ? [ox + p[0], oy + p[1]] : null);

    state.proj = { points, info, toScreen };
    // 视野变了：阴影/路网也要重新投影，否则会停留在旧的屏幕坐标上
    if (state.scan && (state.scan.polys.length || state.scan.roads.length)) requestShadowProjection();
    draw();
  }

  function draw() {
    if (!state.roi) {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      state.hit = [];
      return;
    }
    if (!state.proj) return;
    const { points, toScreen } = state.proj;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    // 索引重算（与 requestProjection 保持一致）
    let idx = 0;
    const destPts = state.dests.map(() => toScreen(points[idx++]));
    idx++; // roi-center
    const roiRing = [];
    for (let i = 0; i < 72; i += 1) roiRing.push(toScreen(points[idx++]));
    let mecRing = [];
    if (state.roi.mec.radius > 60) {
      for (let i = 0; i < 72; i += 1) mecRing.push(toScreen(points[idx++]));
    }
    const commPts = state.rows.map((r) => ({ id: r.id, p: toScreen(points[idx++]) }));

    const pathOf = (arr) => {
      const pts2 = arr.filter(Boolean);
      if (pts2.length < 3) return;
      ctx.beginPath();
      pts2.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
    };

    // 内圈：目的地外接圆
    if (mecRing.length) {
      pathOf(mecRing);
      ctx.setLineDash([1, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(26,24,21,.42)";
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 外圈：搜索范围
    pathOf(roiRing);
    ctx.fillStyle = "rgba(46,95,138,.045)";
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(46,95,138,.75)";
    ctx.stroke();
    ctx.setLineDash([]);

    // 选中：到各目的地的连线
    const sel = state.rows.find((r) => r.id === state.selected);
    if (sel) {
      const sPt = commPts.find((c) => c.id === sel.id);
      if (sPt && sPt.p) {
        state.dests.forEach((d, di) => {
          const dPt = destPts[di];
          if (!dPt) return;
          ctx.beginPath();
          ctx.moveTo(dPt[0], dPt[1]);
          ctx.lineTo(sPt.p[0], sPt.p[1]);
          ctx.lineWidth = 1.2;
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = DEST_COLORS[di];
          ctx.stroke();
          ctx.globalAlpha = 1;

          const mx = (dPt[0] + sPt.p[0]) / 2;
          const my = (dPt[1] + sPt.p[1]) / 2;
          const label = `~${sel.mins[di]} 分`;
          ctx.font = "10px ui-monospace, Menlo, monospace";
          const w = ctx.measureText(label).width + 8;
          ctx.fillStyle = "#f4f1e9";
          ctx.fillRect(mx - w / 2, my - 8, w, 13);
          ctx.fillStyle = DEST_COLORS[di];
          ctx.textAlign = "center";
          ctx.textBaseline = "alphabetic";
          ctx.fillText(label, mx, my + 2);
        });
      }
    }

    // 小区点
    state.hit = [];
    commPts.forEach(({ id, p }) => {
      const r = state.rows.find((x) => x.id === id);
      if (!r || !p) return;
      if (!r.ok && !state.showOut) return;
      const rad = r.ok ? 5 : 3.4;
      ctx.beginPath();
      ctx.arc(p[0], p[1], rad, 0, Math.PI * 2);
      ctx.fillStyle = r.ok ? geo.tierColor(r.worst) : "#b9b2a5";
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "#f4f1e9";
      ctx.stroke();

      if (id === state.selected || id === state.hoverId) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], rad + 4, 0, Math.PI * 2);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = id === state.selected ? "#1a1815" : "rgba(26,24,21,.45)";
        ctx.stroke();
      }
      state.hit.push({ id, x: p[0], y: p[1] });
    });

    // 目的地 pin
    destPts.forEach((p, di) => {
      if (!p) return;
      drawPin(p, DIGITS[di], DEST_COLORS[di], state.dests[di].name);
    });

    // 阴影 + 路网
    drawScanLayer();
  }

  function drawPin(p, letter, color, label) {
    const s = 22;
    ctx.save();
    ctx.translate(p[0], p[1]);
    ctx.rotate((letter === "②" ? 1 : -1) * 0.05);
    ctx.fillStyle = color;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.fillStyle = "#f4f1e9";
    ctx.font = "700 12px 'PingFang SC', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, 0, 1);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(p[0], p[1] + 14, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p[0], p[1] + 11);
    ctx.lineTo(p[0], p[1] + 17);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.font = "600 11px 'PingFang SC', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(244,241,233,.92)";
    ctx.fillRect(p[0] - w / 2 - 4, p[1] + 20, w + 8, 15);
    ctx.fillStyle = "#1a1815";
    ctx.fillText(label, p[0], p[1] + 31);
  }

  /* ---------------- MAIN world 消息 ---------------- */

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.__xat === "ui" && data.type === "debug-state") {
      window.postMessage(
        {
          __xat: "main",
          type: "debug-state",
          payload: {
            roi: state.roi ? { radius: Math.round(state.roi.radius), center: state.roi.center } : null,
            scan: state.scan
              ? { zoom: state.scan.zoom, done: state.scan.done, total: state.scan.total, polys: state.scan.polys.length, lens: state.scan.lens.length, roads: state.scan.roads.length, loading: state.scan.loading }
              : null,
            screen: state.scanScreen ? { polys: state.scanScreen.polys.length, roads: state.scanScreen.roads.length, first: state.scanScreen.polys[0] ? state.scanScreen.polys[0].slice(0, 2) : null } : null,
            proj: !!state.proj,
            scanReqId: state.scanReqId,
            hookReady: state.hookReady,
          },
        },
        "*",
      );
      return;
    }

    // 调试/自动化入口：在页面控制台里 post 一条消息即可触发一次扫描
    if (data && data.__xat === "ui" && data.type === "debug-scan" && data.dest) {
      const d = data.dest;
      state.settings.destinations = [{ name: d.name || "测试目的地", lng: d.lng, lat: d.lat, mode: d.mode || "walk" }];
      rpc("settings.set", { patch: { destinations: state.settings.destinations } }).catch(() => {});
      recomputeAndRender();
      setTimeout(() => startScan(), 150);
      return;
    }

    if (!data || data.__xat !== "main") return;

    if (data.type === "hook-log") {
      const p = data.payload || {};
      const fn = p.level === "error" ? log.error : p.level === "warn" ? log.warn : p.level === "debug" ? log.debug : log.info;
      fn.call(log, `[hook] ${p.msg}`, p.data);
      return;
    }

    if (data.type === "map-ready" || data.type === "view-change") {
      const info = data.payload || {};
      if (!state.hookReady) markHookReady(info, data.type);
      else if (state.hookReady && info.zoom != null) {
        const small = $(".status-pill small");
        if (small) small.textContent = `已连接地图 · zoom ${Number(info.zoom).toFixed(1)}`;
      }
      requestProjection();
      return;
    }

    if (data.type === "project-result") {
      const payload = data.payload || {};
      if (payload.reqId && payload.reqId === state.scanReqId) {
        onScanProjected(payload);
        return;
      }
      onProjectResult(payload);
      return;
    }

    if (data.type === "map-info") {
      const info = data.payload || {};
      log.info("地图信息", info);
      if (info.ready) markHookReady(info, "get-info");
      return;
    }

    if (data.type === "data-changed") {
      reloadData();
      return;
    }

    if (data.type === "ctx-copy") {
      onCtxCopy(data.payload);
      return;
    }

    if (data.type === "geocode-result") {
      const p = data.payload || {};
      const cb = geoWaiters.get(p.reqId);
      if (cb) {
        geoWaiters.delete(p.reqId);
        cb(p);
      }
      return;
    }

    if (data.type === "hook-failed") {
      setStatus("bad", "未挂钩：地图实例没拿到");
      reportDiag({ hookReady: false, reason: (data.payload || {}).reason });
      log.error("挂钩失败", data.payload);
    }
  });

  let lastFitKey = "";
  function fitToRoi() {
    if (!state.roi) return;
    const L = Object.assign({}, LAYOUT_DEFAULTS, (state.settings && state.settings.layout) || {});
    const padTop = Math.max(0, Number(L.top) || 0);
    const padBottom = Math.max(0, Number(L.bottom) || 0);
    // 预留右侧面板宽度，避免范围被侧栏挡住
    const panelW = state.hidden ? 44 : state.panel === "detail" ? 648 : state.panel === "list" ? 372 : 552;
    const usableW = Math.max(360, window.innerWidth - panelW);
    const usableH = Math.max(240, window.innerHeight - padTop - padBottom);
    const usable = Math.min(usableW, usableH);
    const metersPerPixel = (state.roi.radius * 2 * 1.25) / usable;
    const raw = Math.log2((156543.03392 * Math.cos((state.roi.center[1] * Math.PI) / 180)) / metersPerPixel);
    const zoom = Math.max(4, Math.min(18, Math.round(raw * 100) / 100));
    const [clng, clat] = geo.wgs84ToGcj02(state.roi.center[0], state.roi.center[1]);
    window.postMessage({ __xat: "ui", type: "fit", center: [clng, clat], zoom }, "*");
    log.info("请求缩放到搜索范围", { zoom, metersPerPixel: Math.round(metersPerPixel) });
  }

  /** 只有「目的地变了」才自动缩放，拖半径滑杆时不要跳地图 */
  function maybeFitToDests() {
    if (!state.hookReady || !state.roi || !state.dests.length) return;
    const key = state.dests.map((d) => Number(d.lng).toFixed(4) + "," + Number(d.lat).toFixed(4)).join("|");
    if (key === lastFitKey) return;
    lastFitKey = key;
    fitToRoi();
  }

  function markHookReady(info, via) {
    if (state.hookReady) return;
    state.hookReady = true;
    const z = info && info.zoom != null ? Number(info.zoom).toFixed(1) : "?";
    setStatus("ok", `已连接地图 · zoom ${z}`);
    reportDiag({ hookReady: true, zoom: info && info.zoom, center: info && info.center, via, href: location.href });
    log.info("地图挂钩就绪", { via, zoom: info && info.zoom, center: info && info.center, rect: info && info.rect });
    requestProjection();
    setTimeout(maybeFitToDests, 400);
  }

  function setStatus(kind, text) {
    const dot = $(".status-dot");
    dot.className = "status-dot" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : "");
    const small = $(".status-pill small");
    if (small) small.textContent = text;
  }

  /* ---------------- 交互 ---------------- */

  side.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "edit") setPanel("edit");
    if (a === "cancel-edit") {
      setPanel("list");
      recomputeAndRender();
    }
    if (a === "close-detail") closeDetail();
    if (a === "open-options") chrome.runtime.sendMessage({ type: "xat.openOptions" });
    if (a === "add-dest") {
      const s = state.settings;
      if (s.destinations.length >= MAX_DESTS) {
        toast(`最多 ${MAX_DESTS} 个目的地`);
        return;
      }
      s.destinations.push({ id: "d" + Date.now().toString(36), name: "", lng: null, lat: null, mode: "drive" });
      s.destinationCount = s.destinations.length;
      renderEdit();
      const inputs = $$("[data-dname]");
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    }
    if (a === "new-community") openCommunityForm(null);
    if (a === "scan-roi") startScan();
    if (a === "sat-verdict") setVerdict(act.dataset.key, act.dataset.v, act.dataset.cur || "");
    if (a === "adopt-tile") adoptTile(act.dataset.key);
    if (a === "edit-community") openCommunityForm(state.selected);
    if (a === "cancel-form") {
      state.form = null;
      setPanel("list");
      requestProjection();
    }
    if (a === "form-save") saveForm();
    if (a === "form-delete") deleteForm();
    if (a === "save") {
      rpc("settings.set", { patch: state.settings })
        .then((saved) => {
          state.settings = saved;
          applyLayout();
          log.info("设置已保存");
          setPanel("list");
          recomputeAndRender();
          toast("已保存");
          // 阴影扫描由地图适配层负责（整圆 + 掩膜 + 聚类），这里不再触发
        })
        .catch((err) => log.error("保存设置失败", { error: String(err) }));
    }
  });

  $$(".tabs__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      $$(".tabs__btn").forEach((b) => b.classList.toggle("is-on", b === btn));
      $$(".tabpane").forEach((p) => (p.hidden = p.dataset.tabpane !== state.tab));
      if (state.tab === "discover") renderDiscover();
    });
  });

  $$(".seg__btn[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".seg__btn[data-sort]").forEach((b) => b.classList.toggle("is-on", b === btn));
      state.sort = btn.dataset.sort;
      compute();
      renderList();
      renderMini();
    });
  });

  $("#xat-showout").addEventListener("change", (e) => {
    state.showOut = e.target.checked;
    renderList();
    renderMini();
    requestProjection();
  });

  $(".side-handle").addEventListener("click", () => {
    setDrawerVisible(false);
    requestProjection();
  });

  drawer.addEventListener("click", () => {
    setDrawerVisible(true);
    requestProjection();
  });

  pill.addEventListener("click", () => {
    if (!state.hookReady) {
      rpc("diag.report", { tabId: "manual", patch: { note: "用户点击状态胶囊", href: location.href } }).catch(() => {});
    }
    chrome.runtime.sendMessage({ type: "xat.openOptions" });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.panel === "detail") closeDetail();
    else if (state.panel === "form") {
      state.form = null;
      setPanel("list");
    } else if (state.panel === "edit") setPanel("list");
  });

  // 地图点悬停 / 点击（canvas 是 pointer-events:none，用坐标命中）
  let downAt = null;
  document.addEventListener("mousedown", (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  }, true);

  document.addEventListener("mousemove", (e) => {
    if (!state.hit.length) return;
    const near = state.hit.find((h) => Math.hypot(h.x - e.clientX, h.y - e.clientY) < 11);
    if (near) {
      if (state.hoverId !== near.id) {
        state.hoverId = near.id;
        const r = state.rows.find((x) => x.id === near.id);
        if (r) {
          tooltip.hidden = false;
          tooltip.style.left = e.clientX + "px";
          tooltip.style.top = e.clientY + "px";
          tooltip.innerHTML = `<b>${esc(r.name)}</b><br />` +
            r.mins.map((m, di) => `${DIGITS[di]} <span class="num">~${m}</span> 分`).join(" · ") +
            `<br /><span class="num">${fmtPrice(r.avgPrice)}</span> 元/㎡ · <span class="num">${fmtTotal(r.total)}</span>` +
            `<span class="tooltip__hint">点击查看详情</span>`;
        }
        draw();
      }
      tooltip.style.left = e.clientX + "px";
      tooltip.style.top = e.clientY + "px";
    } else if (state.hoverId) {
      state.hoverId = null;
      tooltip.hidden = true;
      draw();
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return;   // 拖动不算点击
    const near = state.hit.find((h) => Math.hypot(h.x - e.clientX, h.y - e.clientY) < 11);
    if (!near) return;
    e.stopPropagation();
    e.preventDefault();
    select(near.id);
  }, true);

  window.addEventListener("resize", () => {
    resizeCanvas();
    requestProjection();
    draw();
  });

  /* ---------------- 启动 ---------------- */

  async function boot() {
    resizeCanvas();
    try {
      const t0 = Date.now();
      const data = await rpc("boot");
      log.info("已读取本地数据", {
        ms: Date.now() - t0,
        communities: data.communities.length,
        destinations: (data.settings.destinations || []).length,
        version: data.version,
        radiusKm: data.settings.radiusKm,
      });
      state.settings = data.settings;
      state.communities = data.communities;
    } catch (e) {
      log.error("读取数据失败", { error: String(e) });
      setStatus("bad", "读取本地数据失败");
      return;
    }

    applyLayout();
    setDrawerVisible(!state.hidden);   // 默认折叠，只留右边缘抽屉

    compute();
    render();
    requestProjection();

    // 主动问一次挂钩状态（页面可能在 UI 之前就绪）
    window.postMessage({ __xat: "ui", type: "get-info" }, "*");
    setTimeout(() => {
      if (!state.hookReady) {
        setStatus("bad", "未挂钩 · 刷新页面试试（点这里看日志）");
        reportDiag({ hookReady: false, reason: "ui-timeout-20s", href: location.href });
        log.warn("20 秒内未收到 map-ready；挂钩会继续重试到 60 秒");
      }
    }, 20000);
  }

  boot().catch((e) => log.error("boot 失败", { error: String(e && e.stack ? e.stack : e) }));
})();
