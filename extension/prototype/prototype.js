/* ============================================================
   西接通勤 · 阶段 2 原型 v2（纯前端 mock，无任何网络请求）
   结构：全屏地图 + 右侧边栏（列表 / 编辑 / 详情）
   ============================================================ */
(() => {
  "use strict";

  /* ---------------- 目的地与配色 ---------------- */

  const DEST_COLORS = ["#9c2a22", "#2e5f8a", "#126e5b", "#b9852b", "#6e5a8a"];

  const ALL_DESTS = [
    { address: "高新一路 18 号", lon: 108.940, lat: 34.260, mode: "drive" },
    { address: "曲江池东路 1 号", lon: 109.020, lat: 34.220, mode: "transit" },
    { address: "未央路 12 号", lon: 108.995, lat: 34.285, mode: "drive" },
  ];

  const state = {
    destCount: 3,
    radiusKm: 3,
    panel: "list",       // list | edit | detail
    tab: "result",
    sort: "commute",
    selected: null,
    showOut: true,
    calc: false,
    exactN: 10,
    view: { cx: 0, cy: 0, ppk: 80 },
  };

  const MODE_LABEL = { drive: "驾车", transit: "公交", walk: "步行" };
  const SPEED = { drive: 22, transit: 18, walk: 4.6 };      // 城市平均 km/h
  const FIXED = { drive: 5, transit: 8, walk: 0 };          // 停车/候车固定耗时

  /* ---------------- mock 小区 ---------------- */

  const RAW = [
    { id:"c1",  name:"天瑞瑞璟小区", sub:"雁塔 · 曲江", lon:108.965, lat:34.245, avg:21000, area:[89,143], year:2016, tenure:"70年", type:"商品房", src:["official","manual"], tags:["临铁"] },
    { id:"c2",  name:"紫薇田园都市", sub:"雁塔 · 电子城", lon:109.005, lat:34.232, avg:16400, area:[78,132], year:2011, tenure:"70年", type:"商品房", src:["manual","poi"], tags:["学区"] },
    { id:"c3",  name:"枫林绿洲",     sub:"高新 · 软件园", lon:108.978, lat:34.251, avg:23800, area:[95,168], year:2018, tenure:"70年", type:"商品房", src:["official","manual"], tags:["临铁","学区"] },
    { id:"c4",  name:"曲江华著中城", sub:"雁塔 · 曲江", lon:109.012, lat:34.238, avg:19600, area:[88,126], year:2015, tenure:"70年", type:"商品房", src:["manual"], tags:["学区"] },
    { id:"c5",  name:"金地湖城大境", sub:"雁塔 · 曲江", lon:109.020, lat:34.228, avg:25400, area:[102,180], year:2019, tenure:"70年", type:"商品房", src:["poi","manual"], tags:["临湖"] },
    { id:"c6",  name:"万科金域华府", sub:"高新 · 唐延路", lon:108.952, lat:34.238, avg:22600, area:[86,135], year:2017, tenure:"70年", type:"商品房", src:["official","manual"], tags:["临铁"] },
    { id:"c7",  name:"雅荷四季城",   sub:"未央 · 凤城", lon:108.990, lat:34.258, avg:13900, area:[74,118], year:2009, tenure:"70年", type:"经济适用房", src:["manual"], tags:[] },
    { id:"c8",  name:"高新云顶",     sub:"高新 · 科技路", lon:108.945, lat:34.250, avg:18200, area:[92,150], year:2021, tenure:"50年", type:"公寓", src:["poi"], tags:[] },
    { id:"c9",  name:"香格里拉尚城", sub:"雁塔 · 小寨", lon:109.000, lat:34.248, avg:17500, area:[70,110], year:2007, tenure:"70年", type:"商品房", src:["manual","poi"], tags:["学区"] },
    { id:"c10", name:"龙湖香醍",     sub:"雁塔 · 曲江", lon:109.015, lat:34.252, avg:26800, area:[110,190], year:2020, tenure:"70年", type:"商品房", src:["official","manual"], tags:["临湖","临铁"] },
    { id:"c11", name:"融创曲江印",   sub:"雁塔 · 曲江", lon:109.008, lat:34.222, avg:31200, area:[120,210], year:2022, tenure:"70年", type:"商品房", src:["poi"], tags:["临湖"] },
    { id:"c12", name:"国宾中央区",   sub:"雁塔 · 电视塔", lon:108.988, lat:34.228, avg:15800, area:[80,124], year:2013, tenure:"70年", type:"安置房", src:["seed"], tags:[] },
  ];

  const CANDIDATES = [
    { name:"中海曲江大观", dist:420, dup:false },
    { name:"保利天悦",     dist:680, dup:false },
    { name:"华润二十四城", dist:940, dup:false },
    { name:"绿城桂语江南", dist:1310, dup:false },
    { name:"天地源枫林意树", dist:1650, dup:false },
    { name:"金辉世界城",   dist:2080, dup:true },
  ];

  const GAPS = [
    { lon:108.971, lat:34.236, built:0.38, green:0.22, mix:0.61, poi:340 },
    { lon:109.004, lat:34.244, built:0.33, green:0.19, mix:0.57, poi:520 },
    { lon:108.996, lat:34.219, built:0.41, green:0.16, mix:0.55, poi:760 },
  ];

  const SRC_LABEL = { official:"官方数据", manual:"人工录入", poi:"POI 发现", seed:"样例数据" };
  const SRC_ORDER = { official:4, manual:3, poi:2, seed:1 };
  const SRC_CLASS = { official:"badge--official", manual:"badge--manual", poi:"badge--poi", seed:"badge--seed" };

  /* ---------------- 几何 ---------------- */

  const ORIGIN = { lon: 108.98, lat: 34.24 };
  const KX = Math.cos(34.24 * Math.PI / 180) * 111.32;
  const KY = 111.32;
  const kmOf = (lon, lat) => ({ x: (lon - ORIGIN.lon) * KX, y: -(lat - ORIGIN.lat) * KY });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const digits = ["①", "②", "③", "④", "⑤"];
  const activeDests = () => ALL_DESTS.slice(0, state.destCount);

  // 最小外接圆（点数 ≤5，暴力枚举；2 点退化为「以连线为直径」）
  function minEnclosingCircle(pts) {
    if (pts.length === 0) return { c: { x: 0, y: 0 }, r: 0 };
    if (pts.length === 1) return { c: pts[0], r: 0 };
    const contains = (c, r) => pts.every((p) => Math.hypot(p.x - c.x, p.y - c.y) <= r + 1e-9);
    const fromPair = (p, q) => ({
      c: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
      r: Math.hypot(p.x - q.x, p.y - q.y) / 2,
    });
    const fromTriple = (p, q, s) => {
      const d = 2 * (p.x * (q.y - s.y) + q.x * (s.y - p.y) + s.x * (p.y - q.y));
      if (Math.abs(d) < 1e-12) return null;
      const p2 = p.x * p.x + p.y * p.y, q2 = q.x * q.x + q.y * q.y, s2 = s.x * s.x + s.y * s.y;
      const c = {
        x: (p2 * (q.y - s.y) + q2 * (s.y - p.y) + s2 * (p.y - q.y)) / d,
        y: (p2 * (s.x - q.x) + q2 * (p.x - s.x) + s2 * (q.x - p.x)) / d,
      };
      return { c, r: Math.hypot(p.x - c.x, p.y - c.y) };
    };

    let best = null;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const cand = fromPair(pts[i], pts[j]);
        if (contains(cand.c, cand.r) && (!best || cand.r < best.r)) best = cand;
      }
    }
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        for (let k = j + 1; k < pts.length; k += 1) {
          const cand = fromTriple(pts[i], pts[j], pts[k]);
          if (cand && contains(cand.c, cand.r) && (!best || cand.r < best.r)) best = cand;
        }
      }
    }
    return best || fromPair(pts[0], pts[1]);
  }

  function roiNow() {
    const pts = activeDests().map((d) => kmOf(d.lon, d.lat));
    const mec = minEnclosingCircle(pts);
    return { mec, center: mec.c, radius: mec.r + state.radiusKm };
  }

  /* ---------------- 通勤 mock 计算 ---------------- */

  function hash01(a, b) {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  function minutesFor(c, di) {
    const d = activeDests()[di];
    const km = dist(kmOf(c.lon, c.lat), kmOf(d.lon, d.lat));
    const idx = RAW.findIndex((x) => x.id === c.id) + 1;
    const jitter = 0.86 + hash01(idx, di + 1) * 0.36;
    return Math.max(3, Math.round((km / SPEED[d.mode]) * 60 * jitter + FIXED[d.mode]));
  }

  /* ---------------- 派生 ---------------- */

  const totalOf = (c) => Math.round(c.avg * ((c.area[0] + c.area[1]) / 2) / 10000);
  const weakestSrc = (c) => c.src.slice().sort((x, y) => SRC_ORDER[x] - SRC_ORDER[y])[0];
  const badge = (kind) => `<span class="badge ${SRC_CLASS[kind]}">${SRC_LABEL[kind]}</span>`;

  const FILTER = { totalMin: 150, totalMax: 320, areaMin: 80, areaMax: 140, priceMax: 24000, tenure: ["商品房"] };
  const inTenure = (c) => FILTER.tenure.includes(c.type);

  function meetsFilter(c) {
    const t = totalOf(c);
    if (t < FILTER.totalMin || t > FILTER.totalMax) return false;
    if (c.area[1] < FILTER.areaMin || c.area[0] > FILTER.areaMax) return false;
    if (c.avg > FILTER.priceMax) return false;
    if (!inTenure(c)) return false;
    return true;
  }

  const VIEW = { list: [], roi: null, outside: [] };

  function build() {
    const roi = roiNow();
    VIEW.roi = roi;

    const inside = [];
    const outside = [];
    RAW.forEach((c) => {
      const p = kmOf(c.lon, c.lat);
      const dCenter = dist(p, roi.center);
      const row = {
        ...c,
        p,
        dCenter,
        mins: activeDests().map((_, di) => minutesFor(c, di)),
        nearest: Math.min(...activeDests().map((d) => dist(p, kmOf(d.lon, d.lat)))),
        ok: meetsFilter(c),
      };
      row.worst = Math.max(...row.mins);
      if (dCenter <= roi.radius) inside.push(row);
      else outside.push(c);
    });

    // 精确 / 估算：按「最长通勤」由短到长取前 N 个精确，其余估算
    // （真实实现里就是先按通勤排序，只对排前面的调路径规划 API，省配额）
    inside.slice().sort((a, b) => a.worst - b.worst)
      .forEach((r, i) => { r.exact = i < state.exactN; });

    VIEW.list = inside;
    VIEW.outside = outside;
    return inside;
  }

  function sortedRows() {
    const rows = VIEW.list.slice();
    // 符合过滤的永远排在前面，不受排序方式影响
    const cmp = {
      commute: (a, b) => a.worst - b.worst,
      total: (a, b) => totalOf(a) - totalOf(b),
      price: (a, b) => a.avg - b.avg,
    }[state.sort];
    rows.sort((a, b) => (a.ok === b.ok ? cmp(a, b) : (a.ok ? -1 : 1)));
    return rows;
  }

  const shownRows = () => sortedRows().filter((c) => state.showOut || c.ok);

  /* ---------------- 渲染：条件摘要行 ---------------- */

  function renderCondLine() {
    const modes = [...new Set(activeDests().map((d) => MODE_LABEL[d.mode]))].join("/");
    $("#condTxt").innerHTML =
      `<em>${state.destCount}</em> 个目的地 · <em>${modes}</em> · <em>${state.radiusKm.toFixed(1)}</em> km · ` +
      `<em>${FILTER.totalMin}–${FILTER.totalMax}</em> 万`;
  }

  /* ---------------- 渲染：多泳道刻度尺 ---------------- */

  const LANE_MAX = 60;

  function renderLanes() {
    const pct = (m) => Math.min(m / LANE_MAX, 1) * 100;
    $("#lanes").innerHTML = activeDests().map((d, di) => {
      const ticks = VIEW.list.map((c) => {
        const sel = c.id === state.selected ? " is-sel" : "";
        return `<button class="lane__tick${sel}" style="left:${pct(c.mins[di])}%" data-id="${c.id}" ` +
          `title="${c.name} → ${digits[di]} ${c.mins[di]} 分" ` +
          `aria-label="${c.name} 到 ${digits[di]} ${c.mins[di]} 分钟"></button>`;
      }).join("");
      return `<div class="lane dc${di + 1}">
        <span class="lane__k">${digits[di]}</span>
        <div class="lane__track"><i class="lane__base"></i>${ticks}</div>
      </div>`;
    }).join("");
    $("#lanesAxis").innerHTML = [0, 10, 20, 30, 40, 50, 60]
      .map((n) => `<span style="left:${pct(n)}%">${n}</span>`).join("");

    $$(".lane__tick").forEach((el) => el.addEventListener("click", () => select(el.dataset.id)));
  }

  /* ---------------- 渲染：结果列表 ---------------- */

  function renderList() {
    const ul = $("#entryList");
    if (state.calc) {
      ul.innerHTML = `<li class="sk"><div class="sk__row"></div><div class="sk__row"></div><div class="sk__row"></div></li>`.repeat(3);
      return;
    }

    const rows = shownRows();
    if (!rows.length) {
      ul.innerHTML = `<li class="empty">
        <div class="empty__t">范围内没有符合条件的小区</div>
        <div class="empty__d">本地收录的小区没有落在这个范围内。<br />
          把<b>扩展半径</b>调大，或去「发现」里检索新的小区。</div>
      </li>`;
      return;
    }

    ul.innerHTML = rows.map((c, i) => {
      const pills = c.mins.map((m, di) =>
        `<span class="pill dc${di + 1}${c.exact ? "" : " pill--est"}"><i>${digits[di]}</i><b>${m}</b></span>`
      ).join("");
      return `<li class="entry${c.id === state.selected ? " is-sel" : ""}${c.ok ? "" : " is-out"}"
                  data-id="${c.id}" tabindex="0" role="button">
        <div class="entry__idx">${String(i + 1).padStart(2, "0")}</div>
        <div>
          <div class="entry__name">${c.name}</div>
          <div class="entry__tags">${badge(weakestSrc(c))}
            ${c.src.length > 1 ? `<span class="badge badge--none" title="还有 ${c.src.length - 1} 个来源">+${c.src.length - 1}</span>` : ""}
            ${c.tags.map((t) => `<span class="badge badge--tag">${t}</span>`).join("")}
            ${c.ok ? "" : `<span class="badge badge--none">不符合过滤</span>`}
          </div>
          <div class="pills">${pills}</div>
          <div class="entry__meta"><span class="num">${c.avg.toLocaleString()}</span> 元/㎡ ·
            <span class="num">${totalOf(c)}</span> 万 · <span class="num">${c.area[0]}–${c.area[1]}</span> ㎡ · ${c.tenure}</div>
        </div>
        <div class="entry__worst${c.exact ? "" : " entry__worst--est"}">
          <b>${c.worst}</b><span>最长</span>
        </div>
      </li>`;
    }).join("");

    $$(".entry", ul).forEach((el) => {
      el.addEventListener("click", () => select(el.dataset.id));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(el.dataset.id); }
      });
    });
  }

  function renderCounts() {
    const ok = VIEW.list.filter((c) => c.ok).length;
    $("#cIn").textContent = VIEW.list.length;
    $("#cOK").textContent = ok;
    $("#nResult").textContent = ok;
    const exact = VIEW.list.filter((c) => c.exact).length;
    const total = VIEW.list.length;
    $("#estNote").textContent = exact >= total
      ? `通勤：${total} 个全部精确计算（消耗 ${total * state.destCount} 次调用）`
      : `通勤：排在前 ${exact} 个的精确计算，其余 ${total - exact} 个为估算（数字前带 ~）`;
  }

  /* ---------------- 渲染：详情态左列的压缩列表 ---------------- */

  function renderMiniList() {
    const ul = $("#entryListMini");
    if (!ul) return;
    const rows = shownRows();
    $("#miniCount").textContent = VIEW.list.length;

    let outStarted = false;
    ul.innerHTML = rows.map((c, i) => {
      const divider = !c.ok && !outStarted
        ? (outStarted = true, `<li class="mini__divider">不符合过滤 · 仍列出但排在后面</li>`)
        : "";
      return divider + `
      <li class="mini__row${c.id === state.selected ? " is-sel" : ""}${c.ok ? "" : " is-out"}"
          data-id="${c.id}" tabindex="0" role="button" title="${c.name}">
        <i class="mini__bar" style="--tier:${c.ok ? rampColor(c.worst) : "#c9c3b6"}"></i>
        <span class="mini__idx">${String(i + 1).padStart(2, "0")}</span>
        <span class="mini__name">${c.name}</span>
        <b class="mini__min${c.exact ? "" : " is-est"}">${c.worst}</b>
        <span class="mini__price">${totalOf(c)} 万 · ${c.avg.toLocaleString()} 元/㎡</span>
      </li>`;
    }).join("");

    $$(".mini__row", ul).forEach((el) => {
      el.addEventListener("click", () => select(el.dataset.id));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(el.dataset.id); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const all = $$(".mini__row", ul);
          const i = all.indexOf(el);
          const next = all[i + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) { next.focus(); select(next.dataset.id); }
        }
      });
    });

    const sel = ul.querySelector(".is-sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- 渲染：详情 ---------------- */

  function row(k, v, kind) {
    const val = v === null || v === undefined || v === "" ? `<em class="blank">未录入</em>` : v;
    const b = kind ? badge(kind) : `<span class="badge badge--none">待补</span>`;
    return `<div class="crow"><div class="crow__k">${k}</div><div class="crow__v">${val}</div>${b}</div>`;
  }

  function renderDetail() {
    const c = VIEW.list.find((x) => x.id === state.selected);
    if (!c) return;
    $("#dName").textContent = c.name;
    $("#dMeta").innerHTML = `${c.sub} · ${badge(weakestSrc(c))}` +
      (c.ok ? "" : `<span class="badge badge--none">不符合过滤</span>`);

    const commuteRows = activeDests().map((d, di) => `
      <div class="crow crow--commute dc${di + 1}">
        <span class="crow__pin">${digits[di]}</span>
        <div>
          <div class="crow__big">${c.exact ? "" : "~"}${c.mins[di]}<small>分</small></div>
          <div class="crow__sub">${MODE_LABEL[d.mode]} · ${dist(kmOf(c.lon, c.lat), kmOf(d.lon, d.lat)).toFixed(1)} km · ${d.address}</div>
        </div>
        <span class="badge ${c.exact ? "badge--auto" : "badge--est"}">${c.exact ? "自动计算" : "直线估算"}</span>
      </div>`).join("");

    const reasons = [];
    reasons.push(`落在搜索范围内：距圆心 <span class="num">${c.dCenter.toFixed(1)}</span> km，范围半径 <span class="num">${VIEW.roi.radius.toFixed(1)}</span> km。`);
    if (!c.ok) {
      const why = [];
      const t = totalOf(c);
      if (t < FILTER.totalMin || t > FILTER.totalMax) why.push(`总价 ${t} 万超出 ${FILTER.totalMin}–${FILTER.totalMax} 万`);
      if (c.area[1] < FILTER.areaMin || c.area[0] > FILTER.areaMax) why.push(`面积 ${c.area[0]}–${c.area[1]} ㎡ 与 ${FILTER.areaMin}–${FILTER.areaMax} ㎡ 不重叠`);
      if (c.avg > FILTER.priceMax) why.push(`均价 ${c.avg.toLocaleString()} 超过 ${FILTER.priceMax.toLocaleString()}`);
      if (!inTenure(c)) why.push(`产权性质「${c.type}」不在筛选内`);
      reasons.length = 0;
      reasons.push(`<b>不符合过滤</b>：${why.join("；")}。仍列出来，是因为你打开了「显示不符合过滤的小区」。`);
    }

    $("#dBody").innerHTML = `
      <div class="detail__thumb">
        <div><b>卫星影像</b>待接入天地图 tk<br />用来核对"这真的是住宅小区吗"</div>
      </div>

      <div class="cblock">
        <div class="cblock__title">通勤（${state.destCount} 个目的地）</div>
        ${commuteRows}
        <p class="hint">精确值来自路径规划 API；估算值是直线距离 ÷ 城市平均速度，只用来占位。</p>
      </div>

      <div class="cblock">
        <div class="cblock__title">为什么在列表里</div>
        <p class="hint" style="margin-top:0">${reasons.join("<br />")}</p>
      </div>

      <div class="cblock">
        <div class="cblock__title">基本信息</div>
        ${row("位置", `<span class="num">${c.lon.toFixed(4)}, ${c.lat.toFixed(4)}</span>`, "manual")}
        ${row("行政区 / 板块", c.sub, "manual")}
        ${row("建成年份", `<span class="num">${c.year}</span> 年 · 房龄 <span class="num">${2026 - c.year}</span> 年`, "manual")}
        ${row("边界多边形", null, null)}
      </div>

      <div class="cblock">
        <div class="cblock__title">价格与产权</div>
        ${row("均价", `<span class="num">${c.avg.toLocaleString()}</span> 元/㎡`, c.src.includes("poi") ? "poi" : "manual")}
        ${row("面积区间", `<span class="num">${c.area[0]}–${c.area[1]}</span> ㎡`, "manual")}
        ${row("总价约", `<span class="num">${totalOf(c)}</span> 万`, "manual")}
        ${row("产权性质", `${c.type} · ${c.tenure}`, "manual")}
        ${row("备案价", c.src.includes("official") ? `<span class="num">${Math.round(c.avg * 0.96).toLocaleString()}</span> 元/㎡` : null,
              c.src.includes("official") ? "official" : null)}
        ${row("预售证 / 去化", c.src.includes("official") ? `已售 <span class="num">${60 + (c.mins[0] % 30)}</span>%` : null,
              c.src.includes("official") ? "official" : null)}
      </div>

      <div class="cblock">
        <div class="cblock__title">补充画像</div>
        ${row("物业费", c.src.includes("manual") ? `<span class="num">${(1.2 + (c.mins[0] % 20) / 6).toFixed(1)}</span> 元/㎡·月` : null,
              c.src.includes("manual") ? "manual" : null)}
        ${row("物业口碑", c.src.includes("manual") ? `<span class="num">${2 + (c.mins[0] % 4)}</span> / 5` : null,
              c.src.includes("manual") ? "manual" : null)}
        ${row("车位比", null, null)}
        ${row("标签", c.tags.length ? c.tags.join("、") : null, c.tags.length ? "manual" : null)}
      </div>

      <div class="cblock">
        <div class="cblock__title">来源</div>
        <div class="tr">${c.src.map(badge).join("")}</div>
        <p class="hint">本小区有 ${c.src.length} 个来源；${c.src.includes("official") ? "官方字段可直接用于筛选。" : "尚无官方数据，价格与产权均为人工填报，建议核实。"}</p>
      </div>
    `;
  }

  /* ---------------- 渲染：条件编辑 ---------------- */

  function renderEdit() {
    $("#destList").innerHTML = activeDests().map((d, di) => `
      <li class="dest dc${di + 1}">
        <span class="dest__k">${digits[di]}</span>
        <div class="dest__main">
          <input class="input" value="${d.address}" aria-label="目的地 ${di + 1} 地址" />
          <div class="seg seg--sm" role="group" aria-label="目的地 ${di + 1} 通勤方式">
            ${Object.entries(MODE_LABEL).map(([k, v]) =>
              `<button class="seg__btn${d.mode === k ? " is-on" : ""}" data-di="${di}" data-mode="${k}">${v}</button>`).join("")}
          </div>
        </div>
        <button class="dest__del" data-di="${di}" aria-label="删除目的地 ${di + 1}"
          ${state.destCount <= 1 ? "disabled" : ""}>✕</button>
      </li>`).join("");

    $("#btnAddDest").disabled = state.destCount >= 5;

    $$("#destList .seg__btn").forEach((b) => {
      b.addEventListener("click", () => {
        ALL_DESTS[+b.dataset.di].mode = b.dataset.mode;
        renderEdit();
        refresh();
      });
    });
    $$(".dest__del").forEach((b) => {
      b.addEventListener("click", () => {
        if (state.destCount <= 1) return;
        ALL_DESTS.splice(+b.dataset.di, 1);
        state.destCount -= 1;
        renderEdit();
        refresh();
      });
    });

    $("#radOut").textContent = state.radiusKm.toFixed(1);
    $("#radHint").innerHTML = state.destCount === 1
      ? `只有 1 个目的地 → 就是该点方圆 <b>${state.radiusKm.toFixed(1)}</b> km。`
      : `${state.destCount} 个目的地 → 取它们的外接圆，再向外扩 <b>${state.radiusKm.toFixed(1)}</b> km。`;
  }

  /* ---------------- 渲染：发现 / 待补 / 图例 ---------------- */

  function renderCandidates() {
    $("#candList").innerHTML = CANDIDATES.map((p, i) => `
      <li class="cand">
        <input type="checkbox" data-i="${i}" aria-label="选择 ${p.name}" />
        <div>
          <div class="cand__name">${p.name}</div>
          <div class="cand__meta">住宅区 · 距圆心 <span class="num">${p.dist}</span> m</div>
        </div>
        <span class="cand__state ${p.dup ? "" : "cand__state--new"}">${p.dup ? "已存在" : "新"}</span>
      </li>`).join("");
    const sync = () => {
      const n = $$("#candList input:checked").length;
      const btn = $("#btnAdopt");
      btn.textContent = `入库 ${n} 个`;
      btn.disabled = n === 0;
    };
    $$("#candList input").forEach((el) => el.addEventListener("change", sync));
    sync();
  }

  function renderGaps() {
    $("#gapList").innerHTML = GAPS.map((g, i) => `
      <li class="gap">
        <div class="gap__head">
          <span class="gap__name">影像区块 ${String(i + 1).padStart(2, "0")}</span>
          <span class="gap__coord">${g.lon.toFixed(3)}, ${g.lat.toFixed(3)}</span>
        </div>
        <div class="gap__thumb">卫星缩略图（阶段 4 接入后显示）</div>
        <div class="gap__sig">
          <span>建筑 <b>${Math.round(g.built * 100)}%</b></span>
          <span>绿化 <b>${Math.round(g.green * 100)}%</b></span>
          <span>交错 <b>${g.mix.toFixed(2)}</b></span>
          <span>最近 POI <b>${g.poi}</b> m</span>
        </div>
        <div class="gap__acts">
          <button class="btn btn--ghost btn--xs">新建小区</button>
          <button class="btn btn--ghost btn--xs">在地图上看</button>
          <button class="btn btn--ghost btn--xs">忽略</button>
        </div>
      </li>`).join("");
  }

  function renderLegendDests() {
    $("#legendDests").innerHTML = activeDests().map((d, di) =>
      `<span class="legend__dest dc${di + 1}"><i>${digits[di]}</i>${MODE_LABEL[d.mode]}</span>`).join("");
  }

  /* ---------------- 地图 ---------------- */

  const cvs = $("#map");
  const ctx = cvs.getContext("2d");
  let W = 0, H = 0, DPR = 1, hoverId = null;

  const P = (km) => ({
    x: W / 2 + (km.x - state.view.cx) * state.view.ppk,
    y: H / 2 + (km.y - state.view.cy) * state.view.ppk,
  });
  const PLL = (lon, lat) => P(kmOf(lon, lat));

  function resize() {
    const r = cvs.parentElement.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    cvs.width = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    cvs.style.width = W + "px";
    cvs.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw();
  }

  function fitView() {
    const roi = VIEW.roi || roiNow();
    let minX = roi.center.x - roi.radius, maxX = roi.center.x + roi.radius;
    let minY = roi.center.y - roi.radius, maxY = roi.center.y + roi.radius;
    VIEW.list.forEach((c) => {
      minX = Math.min(minX, c.p.x); maxX = Math.max(maxX, c.p.x);
      minY = Math.min(minY, c.p.y); maxY = Math.max(maxY, c.p.y);
    });
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    state.view.cx = (minX + maxX) / 2;
    state.view.cy = (minY + maxY) / 2;
    state.view.ppk = Math.min(W / (bw * 1.16), H / (bh * 1.16)) || 60;
    draw();
  }

  function updateScalebar() {
    const raw = 84 / state.view.ppk;
    const nice = [0.1, 0.2, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 50].find((v) => v >= raw) || 50;
    const bar = $(".scalebar__bar");
    if (bar) bar.style.width = Math.round(nice * state.view.ppk) + "px";
    const txt = $("#scaleText");
    if (txt) txt.textContent = nice < 1 ? `${Math.round(nice * 1000)} m` : `${nice} km`;
  }

  function drawBase() {
    ctx.fillStyle = "#efeae0";
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.strokeStyle = "#e4dccb";
    ctx.lineWidth = 1;
    const step = 1.1 * state.view.ppk;
    if (step > 6) {
      const ox = (W / 2 - state.view.cx * state.view.ppk) % step;
      const oy = (H / 2 - state.view.cy * state.view.ppk) % step;
      for (let x = ox; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = oy; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }
    ctx.restore();

    [
      { lon: 108.972, lat: 34.252, r: 0.55 },
      { lon: 109.014, lat: 34.236, r: 0.7 },
      { lon: 108.996, lat: 34.226, r: 0.45 },
    ].forEach((p) => {
      const q = PLL(p.lon, p.lat);
      const rr = p.r * state.view.ppk;
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, rr * 1.25, rr, 0.4, 0, Math.PI * 2);
      ctx.fillStyle = "#dfe6d3";
      ctx.fill();
    });

    const r1 = PLL(109.035, 34.28), r2 = PLL(109.0, 34.24), r3 = PLL(108.95, 34.205);
    ctx.beginPath();
    ctx.moveTo(r1.x, r1.y);
    ctx.quadraticCurveTo(r2.x + 40, r2.y - 30, r3.x, r3.y);
    ctx.lineWidth = Math.max(4, 0.115 * state.view.ppk);
    ctx.strokeStyle = "rgba(196,216,221,.62)";
    ctx.stroke();

    [[[108.93, 34.235], [109.03, 34.245]], [[108.985, 34.27], [108.99, 34.21]]].forEach((line) => {
      const p1 = PLL(line[0][0], line[0][1]);
      const p2 = PLL(line[1][0], line[1][1]);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
      ctx.lineWidth = 7; ctx.strokeStyle = "#f7f4ec"; ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = "#e0d8c5"; ctx.stroke();
    });
  }

  function hull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((p, q) => p.x - q.x || p.y - q.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    pts.forEach((p) => {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    });
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function rampColor(worst) {
    if (worst <= 15) return "#126e5b";
    if (worst <= 25) return "#6f9a5e";
    if (worst <= 35) return "#b9852b";
    return "#9c2a22";
  }

  function draw() {
    if (!W) return;
    drawBase();
    updateScalebar();

    const roi = VIEW.roi || roiNow();
    const roiP = P(roi.center);
    const roiRpx = roi.radius * state.view.ppk;
    const mecP = P(roi.mec.c);
    const mecRpx = roi.mec.r * state.view.ppk;

    // 已收录小区分布（范围内、符合过滤的点云）
    const okPts = VIEW.list.filter((c) => c.ok).map((c) => PLL(c.lon, c.lat));
    if (okPts.length >= 3) {
      okPts.forEach((p) => {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 0.5 * state.view.ppk);
        g.addColorStop(0, "rgba(18,110,91,.11)");
        g.addColorStop(1, "rgba(18,110,91,0)");
        ctx.beginPath(); ctx.arc(p.x, p.y, 0.5 * state.view.ppk, 0, Math.PI * 2);
        ctx.fillStyle = g; ctx.fill();
      });
      const hp = hull(okPts);
      if (hp.length >= 3) {
        ctx.beginPath();
        hp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = "rgba(18,110,91,.05)";
        ctx.fill();
        ctx.setLineDash([4, 5]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(18,110,91,.34)";
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 目的地外接圆（内圈）
    if (roi.mec.r > 0.2) {
      ctx.beginPath();
      ctx.arc(mecP.x, mecP.y, mecRpx, 0, Math.PI * 2);
      ctx.setLineDash([1, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(26,24,21,.42)";
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 搜索范围 = 外接圆 + 扩展半径
    ctx.beginPath();
    ctx.arc(roiP.x, roiP.y, roiRpx, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(46,95,138,.04)";
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(46,95,138,.75)";
    ctx.stroke();
    ctx.setLineDash([]);

    // 范围外小区：淡淡一点，说明"有数据但没落进来"
    VIEW.outside.forEach((c) => {
      const p = PLL(c.lon, c.lat);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(154,147,133,.4)";
      ctx.fill();
    });

    // 选中 → 到各目的地的连线
    const sel = VIEW.list.find((c) => c.id === state.selected);
    if (sel) {
      const s = PLL(sel.lon, sel.lat);
      activeDests().forEach((d, di) => {
        const from = PLL(d.lon, d.lat);
        const col = DEST_COLORS[di];
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(s.x, s.y);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        const mx = (from.x + s.x) / 2, my = (from.y + s.y) / 2;
        const label = `${sel.exact ? "" : "~"}${sel.mins[di]} 分`;
        ctx.font = "10px ui-monospace, Menlo, monospace";
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = "#f4f1e9";
        ctx.fillRect(mx - w / 2, my - 8, w, 13);
        ctx.fillStyle = col;
        ctx.textAlign = "center";
        ctx.fillText(label, mx, my + 2);
      });
    }

    // 范围内小区点（按最长通勤着色）
    VIEW.list.forEach((c) => {
      if (!c.ok && !state.showOut) return;
      const p = PLL(c.lon, c.lat);
      const r = c.ok ? 4.8 : 3.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.ok ? rampColor(c.worst) : "#b9b2a5";
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "#f4f1e9";
      ctx.stroke();

      if (c.id === state.selected || c.id === hoverId) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = c.id === state.selected ? "#1a1815" : "rgba(26,24,21,.45)";
        ctx.stroke();
      }
    });

    // 目的地 pin
    activeDests().forEach((d, di) => {
      drawPin(PLL(d.lon, d.lat), digits[di], DEST_COLORS[di], di % 2 ? 0.05 : -0.05, d.address);
    });
  }

  function drawPin(p, letter, color, tilt, label) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(tilt);
    const s = 22;
    ctx.fillStyle = color;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.fillStyle = "#f4f1e9";
    ctx.font = "700 12px 'PingFang SC', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, 0, 1);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(p.x, p.y + 14, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y + 11); ctx.lineTo(p.x, p.y + 17);
    ctx.lineWidth = 1; ctx.strokeStyle = color; ctx.stroke();

    ctx.font = "600 11px 'PingFang SC', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(244,241,233,.9)";
    ctx.fillRect(p.x - w / 2 - 4, p.y + 20, w + 8, 15);
    ctx.fillStyle = "#1a1815";
    ctx.fillText(label, p.x, p.y + 31);
  }

  /* ---------------- 交互 ---------------- */

  function setPanel(p) {
    state.panel = p;
    $$(".pane").forEach((el) => { el.hidden = el.dataset.pane !== p; });
    document.body.classList.toggle("is-edit", p === "edit");
    document.body.classList.toggle("is-detail", p === "detail");
  }

  function refresh() {
    build();
    renderCondLine();
    renderLanes();
    renderList();
    renderCounts();
    renderLegendDests();
    renderMiniList();
    if (state.panel === "detail") {
      if (!VIEW.list.some((c) => c.id === state.selected)) {
        state.selected = null;
        setPanel("list");
      } else {
        renderDetail();
      }
    }
    draw();
  }

  function select(id) {
    state.selected = id;
    renderDetail();
    renderMiniList();
    renderLanes();
    renderList();
    setPanel("detail");
    draw();
  }

  // 标签页
  $$(".tabs__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      $$(".tabs__btn").forEach((b) => b.classList.toggle("is-on", b === btn));
      $$(".tabpane").forEach((p) => { p.hidden = p.dataset.tabpane !== state.tab; });
    });
  });

  // 排序
  $$(".seg__btn[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".seg__btn[data-sort]").forEach((b) => b.classList.toggle("is-on", b === btn));
      state.sort = btn.dataset.sort;
      renderList();
    });
  });

  // 显示不符合
  $("#toggleOut").addEventListener("change", (e) => {
    state.showOut = e.target.checked;
    renderList();
    renderCounts();
    draw();
  });

  // 条件行 → 编辑
  $("#condLine").addEventListener("click", () => {
    renderEdit();
    setPanel("edit");
  });
  $("#cancelEdit").addEventListener("click", () => { setPanel("list"); refresh(); });
  $("#cancelEdit2").addEventListener("click", () => { setPanel("list"); refresh(); });

  $("#btnSaveCond").addEventListener("click", () => {
    setPanel("list");
    state.calc = true;
    renderList();
    setTimeout(() => {
      state.calc = false;
      refresh();
      fitView();
      draw();
    }, 700);
  });

  $("#btnAddDest").addEventListener("click", () => {
    if (state.destCount >= 5) return;
    if (!ALL_DESTS[state.destCount]) {
      ALL_DESTS[state.destCount] = { address: "新增地点", lon: 108.98, lat: 34.24, mode: "drive" };
    }
    state.destCount += 1;
    renderEdit();
    refresh();
  });

  $("#radRange").addEventListener("input", (e) => {
    state.radiusKm = +e.target.value / 10;
    renderEdit();
    refresh();
  });

  $("#demo1").addEventListener("click", () => { state.destCount = 1; renderEdit(); refresh(); fitView(); });
  $("#demo3").addEventListener("click", () => { state.destCount = 3; renderEdit(); refresh(); fitView(); });

  function closeDetail() {
    state.selected = null;
    setPanel("list");
    renderList();
    renderLanes();
    renderMiniList();
    draw();
  }

  $("#closeDetail").addEventListener("click", closeDetail);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#settingsSheet").hidden) { $("#settingsSheet").hidden = true; return; }
    if (state.panel === "detail") closeDetail();
    else if (state.panel === "edit") { setPanel("list"); refresh(); }
  });

  // 设置
  const openSettings = () => { $("#settingsSheet").hidden = false; };
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnSettings2").addEventListener("click", openSettings);
  $$("[data-close]").forEach((el) => {
    el.addEventListener("click", () => { $("#settingsSheet").hidden = true; });
  });
  $("#settingsSheet").addEventListener("click", (e) => {
    if (e.target.id === "settingsSheet") e.target.hidden = true;
  });

  // chips 三态
  $$(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const on = !chip.classList.contains("is-on");
      chip.classList.toggle("is-on", on);
      chip.classList.toggle("is-off", !on);
    });
  });

  // 地图缩放 / 平移 / 悬停
  $("#zoomIn").addEventListener("click", () => { state.view.ppk *= 1.3; draw(); });
  $("#zoomOut").addEventListener("click", () => { state.view.ppk /= 1.3; draw(); });
  $("#zoomFit").addEventListener("click", fitView);

  cvs.addEventListener("wheel", (e) => {
    e.preventDefault();
    state.view.ppk *= e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.view.ppk = Math.min(Math.max(state.view.ppk, 8), 900);
    draw();
  }, { passive: false });

  let dragging = false, last = null;
  cvs.addEventListener("mousedown", (e) => {
    dragging = true; last = { x: e.clientX, y: e.clientY };
    cvs.classList.add("is-drag");
  });
  window.addEventListener("mouseup", () => { dragging = false; cvs.classList.remove("is-drag"); });
  window.addEventListener("mousemove", (e) => {
    if (!dragging || !last) return;
    state.view.cx -= (e.clientX - last.x) / state.view.ppk;
    state.view.cy -= (e.clientY - last.y) / state.view.ppk;
    last = { x: e.clientX, y: e.clientY };
    draw();
  });

  const tip = $("#tooltip");
  cvs.addEventListener("mousemove", (e) => {
    if (dragging) return;
    const rect = cvs.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let hit = null;
    VIEW.list.forEach((c) => {
      if (!c.ok && !state.showOut) return;
      const p = PLL(c.lon, c.lat);
      if (Math.hypot(p.x - mx, p.y - my) < 11) hit = c;
    });
    if (hit) {
      hoverId = hit.id;
      tip.hidden = false;
      tip.style.left = mx + "px";
      tip.style.top = my + "px";
      tip.innerHTML = `<b>${hit.name}</b>` +
        hit.mins.map((m, di) =>
          `<div class="tooltip__row dc${di + 1}"><span class="tooltip__k">${digits[di]}</span>` +
          `<span class="num">${hit.exact ? "" : "~"}${m}</span> 分</div>`).join("") +
        `<div style="margin-top:4px"><span class="num">${hit.avg.toLocaleString()}</span> 元/㎡ · ` +
        `<span class="num">${totalOf(hit)}</span> 万</div>` +
        `<span class="tooltip__hint">点击查看详情</span>`;
      draw();
    } else {
      tip.hidden = true;
      if (hoverId) { hoverId = null; draw(); }
    }
  });

  cvs.addEventListener("click", () => { if (hoverId) select(hoverId); });

  /* ---------------- 启动 ---------------- */

  build();
  renderCondLine();
  renderLanes();
  renderList();
  renderCounts();
  renderEdit();
  renderCandidates();
  renderGaps();
  renderLegendDests();
  setPanel("list");
  resize();
  fitView();
  window.addEventListener("resize", resize);
})();
