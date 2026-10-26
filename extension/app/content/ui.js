/* ============================================================
   西接通勤 · 注入 UI（ISOLATED world）
   运行环境：高德地图页面。Shadow DOM 隔离，不影响页面样式。
   本版（0.1.0 / 阶段 3a）能力：
     - 读取后台数据（IndexedDB）
     - 通过 MAIN world 的挂钩拿像素投影
     - canvas 叠加：搜索范围、目的地 pin、小区点
     - 侧边栏：条件摘要 / 泳道刻度尺 / 列表 / 两列详情 / 条件编辑
     - 通勤值目前是「直线估算」，带 ~ 前缀；真值在阶段 3d 接入
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
    proj: null,
    hit: [],
    hoverId: null,
    hookReady: false,
    hidden: false,
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

  function reportDiag(patch) {
    rpc("diag.report", { tabId: "tab:" + location.host + location.pathname, patch }).catch(() => {});
  }

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const totalOf = (c) => Math.round((c.avgPrice * (c.areaMin + c.areaMax)) / 2 / 10000);
  const weakestSrc = (c) => c.sources.slice().sort((a, b) => (SRC_ORDER[a] || 0) - (SRC_ORDER[b] || 0))[0];
  const badge = (kind) => `<span class="badge ${SRC_CLASS[kind] || "badge--none"}">${SRC_LABEL[kind] || "未知"}</span>`;

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
          <span class="side__note" id="xat-note"></span>
        </div>
      </div>

      <div class="tabpane" data-tabpane="discover" hidden>
        <div class="placeholder">
          <div class="placeholder__t">自动发现暂缓</div>
          <div class="placeholder__d">原来的"圈内找小区"依赖高德 Web 服务 API（要 key）。
            改用免 key 方案后，这一块暂缓，先靠人工录入与后端导入。<br /><br />
            想现在就试：去高德搜"小区"，人工挑几个录进来。</div>
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
            <button class="btn btn--primary btn--xs">编辑</button>
          </div>
        </div>
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

  function compute() {
    const s = state.settings;
    const dests = s.destinations.slice(0, s.destinationCount || 1);
    const mec = geo.minEnclosingCircle(dests.map((d) => [d.lng, d.lat]));
    const roi = { center: mec.center, radius: mec.radius + (s.radiusKm || 0) * 1000, mec };

    const rows = [];
    for (const c of state.communities) {
      const p = [c.lng, c.lat];
      const dCenter = geo.haversine(p, roi.center);
      if (dCenter > roi.radius) continue;

      const mins = dests.map((d) => geo.estimateMinutes(geo.haversine(p, [d.lng, d.lat]), d.mode));
      const worst = Math.max.apply(null, mins);
      const total = totalOf(c);
      const ok =
        total >= s.budget.totalMin && total <= s.budget.totalMax &&
        c.areaMax >= s.budget.areaMin && c.areaMin <= s.budget.areaMax &&
        c.avgPrice <= s.budget.priceMax &&
        (s.tenure.length === 0 || s.tenure.indexOf(c.propertyType) >= 0);

      rows.push({ ...c, mins, worst, total, ok, dCenter, exact: false });
    }

    rows.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (state.sort === "total") return a.total - b.total;
      if (state.sort === "price") return a.avgPrice - b.avgPrice;
      return a.worst - b.worst;
    });

    state.rows = rows;
    state.roi = roi;
    state.dests = dests;
    log.debug("已重算候选集", { inRoi: rows.length, ok: rows.filter((r) => r.ok).length, radiusKm: s.radiusKm, dests: dests.length });
    return rows;
  }

  /* ---------------- 侧边栏渲染 ---------------- */

  function renderCond() {
    const s = state.settings;
    const modes = Array.from(new Set(state.dests.map((d) => MODE_LABEL[d.mode]))).join("/");
    $("#xat-cond").innerHTML =
      `<em>${state.dests.length}</em> 个目的地 · <em>${modes}</em> · <em>${Number(s.radiusKm).toFixed(1)}</em> km · ` +
      `<em>${s.budget.totalMin}–${s.budget.totalMax}</em> 万`;
    side.classList.toggle("is-detail", state.panel === "detail");
    side.classList.toggle("is-edit", state.panel === "edit");
  }

  const LANE_MAX = 60;
  function renderLanes() {
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
    $("#xat-note").textContent = "通勤为直线估算（带 ~），真实值在阶段 3d 接入；地图数据来自本机样例库。";

    if (!rows.length) {
      $("#xat-list").innerHTML = `<li class="empty"><div class="empty__t">范围内没有小区</div>
        <div class="empty__d">把扩展半径调大试试，或检查目的地坐标。</div></li>`;
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
            <div class="entry__meta"><span class="num">${r.avgPrice.toLocaleString()}</span> 元/㎡ ·
              <span class="num">${r.total}</span> 万 · <span class="num">${r.areaMin}–${r.areaMax}</span> ㎡ · ${esc(r.tenureYears)}</div>
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
          <span class="mini__price">${r.total} 万 · ${r.avgPrice.toLocaleString()} 元/㎡</span>
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
    $("#xat-dmeta").innerHTML = `${esc(r.district)} · ${esc(r.sub)} ${badge(weakestSrc(r))}` +
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
    why.push(`落在搜索范围内：距圆心 <span class="num">${(r.dCenter / 1000).toFixed(1)}</span> km，范围半径 <span class="num">${(state.roi.radius / 1000).toFixed(1)}</span> km。`);
    if (!r.ok) {
      const w = [];
      if (r.total < state.settings.budget.totalMin || r.total > state.settings.budget.totalMax) w.push(`总价 ${r.total} 万不在区间内`);
      if (r.avgPrice > state.settings.budget.priceMax) w.push(`均价 ${r.avgPrice.toLocaleString()} 超过上限`);
      if (state.settings.tenure.length && state.settings.tenure.indexOf(r.propertyType) < 0) w.push(`产权「${r.propertyType}」不在筛选内`);
      why.length = 0;
      why.push(`<b>不符合过滤</b>：${w.join("；") || "面积与筛选区间不重叠"}。仍显示是因为打开了「显示不符合过滤」。`);
    }

    $("#xat-dbody").innerHTML = `
      <div class="detail__thumb"><div><b>卫星影像</b>待接入天地图 tk<br />用来核对"这真的是住宅小区吗"</div></div>

      <div class="cblock">
        <div class="cblock__title">通勤（${state.dests.length} 个目的地 · 估算）</div>
        ${commute}
        <p class="hint">点「去高德算」会在新标签打开高德的路线规划，真实时长由高德计算（读回在阶段 3d 接入）。</p>
      </div>

      <div class="cblock">
        <div class="cblock__title">为什么在列表里</div>
        <p class="hint" style="margin-top:0">${why.join("<br />")}</p>
      </div>

      <div class="cblock">
        <div class="cblock__title">基本信息</div>
        ${crow("位置", `<span class="num">${r.lng.toFixed(4)}, ${r.lat.toFixed(4)}</span>`, "manual")}
        ${crow("行政区 / 板块", `${esc(r.district)} · ${esc(r.sub)}`, "manual")}
        ${crow("建成年份", `<span class="num">${r.buildYear}</span> 年 · 房龄 <span class="num">${new Date().getFullYear() - r.buildYear}</span> 年`, "manual")}
        ${crow("边界多边形", null, null)}
      </div>

      <div class="cblock">
        <div class="cblock__title">价格与产权</div>
        ${crow("均价", `<span class="num">${r.avgPrice.toLocaleString()}</span> 元/㎡`, "manual")}
        ${crow("面积区间", `<span class="num">${r.areaMin}–${r.areaMax}</span> ㎡`, "manual")}
        ${crow("总价约", `<span class="num">${r.total}</span> 万`, "manual")}
        ${crow("产权性质", `${esc(r.propertyType)} · ${esc(r.tenureYears)}`, "manual")}
        ${crow("备案价", r.official ? `<span class="num">${r.official.filingPrice.toLocaleString()}</span> 元/㎡` : null, r.official ? "official" : null)}
        ${crow("预售证 / 去化", r.official ? `${esc(r.official.permitNo)} · 已售 <span class="num">${Math.round(r.official.soldRatio * 100)}</span>%` : null, r.official ? "official" : null)}
      </div>

      <div class="cblock">
        <div class="cblock__title">来源</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${r.sources.map(badge).join("")}</div>
        <p class="hint">本小区有 ${r.sources.length} 个来源；列表显示的是其中"最弱"的那个。</p>
      </div>
    `;

    $$("[data-goto]").forEach((b) => b.addEventListener("click", () => gotoAmap(Number(b.dataset.goto))));
  }

  function renderEdit() {
    const s = state.settings;
    $("#xat-edit-body").innerHTML = `
      <fieldset class="field">
        <legend>目的地</legend>
        <ul class="dests">
          ${state.dests
            .map(
              (d, di) => `<li class="dest">
              <span class="dest__k" style="background:${DEST_COLORS[di]}">${DIGITS[di]}</span>
              <div class="dest__main">
                <input class="input" value="${esc(d.name)}" data-dname="${di}" />
                <div class="seg">
                  ${Object.keys(MODE_LABEL)
                    .map((m) => `<button class="seg__btn${d.mode === m ? " is-on" : ""}" data-dmode="${di}:${m}">${MODE_LABEL[m]}</button>`)
                    .join("")}
                </div>
              </div>
              <button class="dest__del" data-ddel="${di}" ${state.dests.length <= 1 ? "disabled" : ""}>✕</button>
            </li>`
            )
            .join("")}
        </ul>
        <p class="hint">地址改了不会自动解析坐标（阶段 3b 接地址搜索）。目前坐标来自样例库。</p>
      </fieldset>

      <fieldset class="field">
        <legend>扩展半径</legend>
        <label class="slider">
          <span>半径 <em class="num" id="xat-rad-out">${Number(s.radiusKm).toFixed(1)}</em> km</span>
          <input type="range" id="xat-rad" min="0" max="150" value="${Math.round(s.radiusKm * 10)}" />
        </label>
        <p class="hint">${state.dests.length} 个目的地 → 取最小外接圆，再向外扩 ${Number(s.radiusKm).toFixed(1)} km。</p>
      </fieldset>

      <fieldset class="field">
        <legend>预算与面积</legend>
        <p class="hint" style="margin-top:0">总价 ${s.budget.totalMin}–${s.budget.totalMax} 万 · 面积 ${s.budget.areaMin}–${s.budget.areaMax} ㎡ · 均价上限 ${s.budget.priceMax.toLocaleString()} 元/㎡</p>
        <p class="hint">阶段 3a 先固定，滑块在下一版接上。</p>
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

    $("#xat-rad").addEventListener("input", (e) => {
      state.settings.radiusKm = Number(e.target.value) / 10;
      $("#xat-rad-out").textContent = Number(state.settings.radiusKm).toFixed(1);
      recomputeAndRender();
    });

    $$("[data-dmode]").forEach((b) =>
      b.addEventListener("click", () => {
        const [di, mode] = b.dataset.dmode.split(":");
        state.settings.destinations[Number(di)].mode = mode;
        renderEdit();
        recomputeAndRender();
      })
    );

    $$("[data-ddel]").forEach((b) =>
      b.addEventListener("click", () => {
        if (state.dests.length <= 1) return;
        state.settings.destinations.splice(Number(b.dataset.ddel), 1);
        state.settings.destinationCount = state.settings.destinations.length;
        renderEdit();
        recomputeAndRender();
      })
    );

    $$("[data-tenure]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = b.dataset.tenure;
        const i = state.settings.tenure.indexOf(t);
        if (i >= 0) state.settings.tenure.splice(i, 1);
        else state.settings.tenure.push(t);
        renderEdit();
        recomputeAndRender();
      })
    );
  }

  function render() {
    renderCond();
    renderLanes();
    renderList();
    renderMini();
    if (state.panel === "detail") renderDetail();
    if (state.panel === "edit") renderEdit();
  }

  function recomputeAndRender() {
    compute();
    render();
    requestProjection();
  }

  function setPanel(p) {
    state.panel = p;
    $$(".pane").forEach((el) => (el.hidden = el.dataset.pane !== p));
    renderCond();
    if (p === "edit") renderEdit();
    if (p === "detail") renderDetail();
  }

  function select(id) {
    state.selected = id;
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
    draw();
  }

  function draw() {
    if (!state.proj || !state.roi) return;
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
      onProjectResult(data.payload);
      return;
    }

    if (data.type === "map-info") {
      const info = data.payload || {};
      log.info("地图信息", info);
      if (info.ready) markHookReady(info, "get-info");
      return;
    }

    if (data.type === "hook-failed") {
      setStatus("bad", "未挂钩：地图实例没拿到");
      reportDiag({ hookReady: false, reason: (data.payload || {}).reason });
      log.error("挂钩失败", data.payload);
    }
  });

  let fitDone = false;
  function fitToRoi() {
    if (fitDone || !state.roi) return;
    fitDone = true;
    // 预留右侧面板宽度，避免范围被侧栏挡住
    const usableW = Math.max(360, window.innerWidth - 380);
    const usable = Math.min(usableW, window.innerHeight - 80);
    const metersPerPixel = (state.roi.radius * 2 * 1.25) / usable;
    const raw = Math.log2((156543.03392 * Math.cos((state.roi.center[1] * Math.PI) / 180)) / metersPerPixel);
    const zoom = Math.max(4, Math.min(18, Math.round(raw * 100) / 100));
    const [clng, clat] = geo.wgs84ToGcj02(state.roi.center[0], state.roi.center[1]);
    window.postMessage({ __xat: "ui", type: "fit", center: [clng, clat], zoom }, "*");
    log.info("请求缩放到搜索范围", { zoom, metersPerPixel: Math.round(metersPerPixel) });
  }

  function markHookReady(info, via) {
    if (state.hookReady) return;
    state.hookReady = true;
    const z = info && info.zoom != null ? Number(info.zoom).toFixed(1) : "?";
    setStatus("ok", `已连接地图 · zoom ${z}`);
    reportDiag({ hookReady: true, zoom: info && info.zoom, center: info && info.center, via, href: location.href });
    log.info("地图挂钩就绪", { via, zoom: info && info.zoom, center: info && info.center, rect: info && info.rect });
    requestProjection();
    setTimeout(fitToRoi, 400);
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
    if (a === "cancel-edit") { setPanel("list"); recomputeAndRender(); }
    if (a === "close-detail") closeDetail();
    if (a === "open-options") chrome.runtime.sendMessage({ type: "xat.openOptions" });
    if (a === "save") {
      rpc("settings.set", { patch: state.settings })
        .then(() => {
          log.info("设置已保存");
          setPanel("list");
          recomputeAndRender();
        })
        .catch((err) => log.error("保存设置失败", { error: String(err) }));
    }
  });

  $$(".tabs__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      $$(".tabs__btn").forEach((b) => b.classList.toggle("is-on", b === btn));
      $$(".tabpane").forEach((p) => (p.hidden = p.dataset.tabpane !== state.tab));
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
    state.hidden = !state.hidden;
    side.classList.toggle("is-hidden", state.hidden);
    $(".side-handle").textContent = state.hidden ? "‹" : "›";
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
    else if (state.panel === "edit") setPanel("list");
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
            `<br /><span class="num">${r.avgPrice.toLocaleString()}</span> 元/㎡ · <span class="num">${r.total}</span> 万` +
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
        version: data.version,
        radiusKm: data.settings.radiusKm,
      });
      state.settings = data.settings;
      state.communities = data.communities;
      if (!state.communities.length) {
        log.warn("小区库为空，尝试重置样例数据");
        state.communities = await rpc("seed.reset");
      }
    } catch (e) {
      log.error("读取数据失败", { error: String(e) });
      setStatus("bad", "读取本地数据失败");
      return;
    }

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
