// 端到端：真实 Chromium 加载 extension/app，访问高德页面跑一遍主流程
// 依赖：npm i playwright；浏览器可用 Playwright 自带，或用 XAT_CHROME 指向 Chrome for Testing
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const EXT = path.join(HERE, "..", "app");
const CHROME = process.env.XAT_CHROME || "";
const OUT = path.join(HERE, "out");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, pass, extra) {
  results.push({ name, pass: !!pass, extra });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
}

const userDir = path.join(os.tmpdir(), "xat-e2e-profile-" + Date.now());
const context = await chromium.launchPersistentContext(userDir, {
  executablePath: CHROME && fs.existsSync(CHROME) ? CHROME : undefined,
  headless: true,
  locale: "zh-CN",
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

const pageErrors = [];
context.on("page", (p) => {
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  p.on("console", (m) => {
    if (m.type() === "error") pageErrors.push("console:" + m.text());
  });
});

await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://www.amap.com" });

let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log("extension id:", extId);

const rpc = (p, method, params) =>
  p.evaluate(
    ([m, prm]) =>
      new Promise((res, rej) => {
        chrome.runtime.sendMessage({ type: "xat.rpc", method: m, params: prm }, (r) =>
          r && r.ok ? res(r.data) : rej(new Error((r && r.error) || "no response"))
        );
      }),
    [method, params]
  );

/* ---------- 1. 后台默认状态 ---------- */
const opts = await context.newPage();
await opts.goto(`chrome-extension://${extId}/options/options.html`);
const boot = await rpc(opts, "boot");
check("后台：默认无小区", (boot.communities || []).length === 0, "n=" + (boot.communities || []).length);
check("后台：默认无目的地", (boot.settings.destinations || []).length === 0, "n=" + (boot.settings.destinations || []).length);
check("后台：默认留白 72/24", boot.settings.layout && boot.settings.layout.top === 72 && boot.settings.layout.bottom === 24, JSON.stringify(boot.settings.layout));

/* ---------- 2. 导入（GeoJSON 形态） ---------- */
const importRes = await rpc(opts, "data.import", {
  payload: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: 1, name: "测试小区甲", district: "雁塔", display_price: 21000 },
        geometry: { type: "Polygon", coordinates: [[[108.944, 34.252], [108.946, 34.252], [108.946, 34.254], [108.944, 34.252]]] },
      },
      {
        type: "Feature",
        properties: { id: 2, name: "测试小区甲", district: "雁塔", display_price: 21000 },
        geometry: { type: "Polygon", coordinates: [[[108.9441, 34.2521], [108.9461, 34.2521], [108.9461, 34.2541], [108.9441, 34.2521]]] },
      },
    ],
  },
});
check("导入：新增 1 / 去重 1", importRes.added === 1 && importRes.skipped === 1, JSON.stringify(importRes));
const afterImport = await rpc(opts, "boot");
const imported = (afterImport.communities || [])[0];
check("导入：坐标来自多边形中心", imported && Math.abs(imported.lng - 108.9453) < 0.001, imported && `${imported.lng},${imported.lat}`);
check("导入：来源标 official", imported && imported.sources.includes("official"), imported && imported.sources.join(","));

/* ---------- 3. 重置回干净状态 ---------- */
await rpc(opts, "data.reset");
const afterReset = await rpc(opts, "boot");
check("清空：小区库为空", (afterReset.communities || []).length === 0);

/* ---------- 4. 高德页面：注入 / 折叠 / 留白 ---------- */
const page = await context.newPage();

// 未登录/自动化环境下高德会弹登录框或 baxia 验证层，测试里统一清掉再点
const killOverlays = async () => {
  const n = await page.evaluate(() => {
    let c = 0;
    const sels = [".lbs-passport-modal", "[class*=passport-modal]", "[class*=mask]", ".baxia-dialog", "[class*=baxia]", "[class*=captcha]", "[class*=verify]"];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.position === "absolute") { el.remove(); c += 1; }
      });
    }
    return c;
  });
  if (n) console.log("已移除遮挡层", n);
  await page.waitForTimeout(120);
};
const safeClick = async (sel, opts) => { await killOverlays(); await safeClick(sel, opts); };
const safeFill = async (sel, val) => { await killOverlays(); await safeFill(sel, val); };

await page.goto("https://www.amap.com/", { waitUntil: "domcontentloaded", timeout: 90000 });

await page.waitForFunction(() => {
  const h = document.querySelector("#xat-root");
  return !!(h && h.shadowRoot && h.shadowRoot.querySelector(".drawer"));
}, null, { timeout: 40000 });
check("页面：侧栏已注入（#xat-root + shadow）", true);

// 去掉未登录时高德盖住地图的登录浮层（真实使用中已登录不会有）
const overlayKilled = await page.evaluate(() => {
  let n = 0;
  for (const sel of [".lbs-passport-modal", "[class*=passport-modal]", "[class*=mask]"]) {
    document.querySelectorAll(sel).forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "absolute") { el.remove(); n += 1; }
    });
  }
  return n;
});
console.log("已移除登录浮层节点：", overlayKilled);

// 等 ui.css 真正加载完成（<link> 是异步的）
await page.waitForFunction(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  const side = sr.querySelector(".side");
  return getComputedStyle(side).position === "fixed" && getComputedStyle(side).top !== "auto";
}, null, { timeout: 15000 });

const ui1 = await page.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  const drawer = sr.querySelector(".drawer");
  const side = sr.querySelector(".side");
  const cs = getComputedStyle(side);
  return {
    drawerVisible: !!drawer && !drawer.hidden,
    sideHidden: side.classList.contains("is-hidden"),
    sideTop: cs.top,
    sideBottom: cs.bottom,
    cond: (sr.querySelector("#xat-cond") || {}).textContent || "",
    list: (sr.querySelector("#xat-list") || {}).textContent || "",
    hook: window.__XAT_HOOK__ ? window.__XAT_HOOK__.info() : null,
  };
});
check("页面：默认折叠（只显示抽屉）", ui1.drawerVisible && ui1.sideHidden, JSON.stringify({ drawerVisible: ui1.drawerVisible, sideHidden: ui1.sideHidden }));
check("页面：侧栏顶部留白 72px", ui1.sideTop === "72px", ui1.sideTop);
check("页面：侧栏底部留白 24px", ui1.sideBottom === "24px", ui1.sideBottom);
check("页面：条件摘要提示还没设目的地", /还没设目的地/.test(ui1.cond), ui1.cond);
check("页面：列表是干净空态", /先设一个目的地/.test(ui1.list), ui1.list.slice(0, 60));
check("页面：AMap.Map 已挂钩", !!(ui1.hook && ui1.hook.patched), JSON.stringify(ui1.hook && { patched: ui1.hook.patched, instances: ui1.hook.instances, ready: ui1.hook.ready }));

await page.screenshot({ path: OUT + "/01-collapsed.png" });

// 等地图实例
let hookReady = false;
try {
  await page.waitForFunction(() => window.__XAT_HOOK__ && window.__XAT_HOOK__.info().ready, null, { timeout: 45000 });
  hookReady = true;
} catch (e) {
  hookReady = false;
}
check("页面：拿到地图实例（投影可用）", hookReady);

/* ---------- 5. 右键菜单「复制地址」 ---------- */
let ctxState = null;
if (hookReady) {
  // 右键前再清一次浮层（未登录时高德会在几秒后弹登录框挡住地图）
  const clearOverlays = () =>
    page.evaluate(() => {
      let n = 0;
      for (const sel of [".lbs-passport-modal", "[class*=passport-modal]", "[class*=mask]"]) {
        document.querySelectorAll(sel).forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.position === "absolute") { el.remove(); n += 1; }
        });
      }
      return { n, top: document.elementsFromPoint(640, 470).slice(0, 2).map((e) => e.tagName + "." + String(e.className).slice(0, 20)) };
    });

  // 未登录时高德会不定时弹登录框盖住地图，右键可能被吃掉；多试几次直到拿到坐标
  let ctxGot = false;
  for (let attempt = 1; attempt <= 4 && !ctxGot; attempt += 1) {
    const cleared = await clearOverlays();
    console.log(`右键前清浮层(第 ${attempt} 次):`, JSON.stringify(cleared));
    await page.waitForTimeout(350);
    await page.mouse.move(640, 470);
    await page.mouse.click(640, 470, { button: "right" });
    await page.waitForTimeout(1500);
    ctxGot = await page.evaluate(() => {
      const c = window.__XAT_HOOK__ && window.__XAT_HOOK__.lastCtx();
      return !!(c && c.gcj);
    });
  }
  await page.waitForTimeout(700);
  ctxState = await page.evaluate(() => {
    const injected = document.getElementById("xat-ctx-copy");
    const own = document.getElementById("xat-ctx-own");
    return {
      injected: !!injected,
      injectedText: injected ? injected.textContent : null,
      own: !!own,
      ownText: own ? own.textContent : null,
      lastCtx: window.__XAT_HOOK__ ? window.__XAT_HOOK__.lastCtx() : null,
      amapMenu: !!document.querySelector("ul.context_menu"),
      amapMenuItems: [...document.querySelectorAll("ul.context_menu > li")].map((li) => (li.textContent || "").trim()),
    };
  });
  await page.screenshot({ path: OUT + "/02-rightclick.png" });
  check("右键：取到 GCJ-02 坐标", !!(ctxState.lastCtx && ctxState.lastCtx.gcj), JSON.stringify(ctxState.lastCtx && ctxState.lastCtx.gcj));
  check("右键：菜单里有「复制地址」项", ctxState.injected || ctxState.own, JSON.stringify({ injected: ctxState.injected, own: ctxState.own }));

  if (ctxState.injected || ctxState.own) {
    // 未登录的高德会在右键后弹登录浮层盖住地图，先清掉再用真实鼠标点（保留用户手势，剪贴板才写得进去）
    const target = ctxState.injected ? "#xat-ctx-copy" : "#xat-ctx-own div";
    const box = await page.locator(target).boundingBox();
    await page.evaluate(() => {
      for (const sel of [".lbs-passport-modal", "[class*=passport-modal]", "[class*=mask]"]) {
        document.querySelectorAll(sel).forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.position === "absolute") el.remove();
        });
      }
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(700);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    check(
      "右键：剪贴板拿到「地址 (lng,lat)」或纯坐标",
      /^(-?\d{2,3}\.\d+\s*,\s*-?\d{1,2}\.\d+)$/.test(clip) || /\(\s*-?\d{2,3}\.\d+\s*,\s*-?\d{1,2}\.\d+\s*\)/.test(clip),
      clip
    );
    const m = clip.match(/(-?\d{2,3}\.\d+)\s*,\s*(-?\d{1,2}\.\d+)/);
    if (m) {
      const lng = Number(m[1]);
      const lat = Number(m[2]);
      const gcj = (ctxState.lastCtx && ctxState.lastCtx.gcj) || [0, 0];
      const dLng = Math.abs(lng - gcj[0]);
      const dLat = Math.abs(lat - gcj[1]);
      check(
        "右键：GCJ-02 已转成 WGS84（几百米级偏移）",
        dLng > 0.0005 && dLng < 0.02 && dLat > 0.0002 && dLat < 0.02 && lng > 73 && lng < 136 && lat > 3 && lat < 54,
        `gcj=${gcj.join(",")} wgs=${lng},${lat} d=${dLng.toFixed(5)},${dLat.toFixed(5)}`
      );
    }
  }
}

/* ---------- 6. 抽屉展开 + 目的地粘贴坐标 ---------- */
await page.evaluate(() => document.querySelector("#xat-root").shadowRoot.querySelector(".drawer").click());
await page.waitForTimeout(500);
const ui2 = await page.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  return { sideHidden: sr.querySelector(".side").classList.contains("is-hidden"), drawerHidden: sr.querySelector(".drawer").hidden };
});
check("抽屉：点一下展开侧栏", !ui2.sideHidden && ui2.drawerHidden, JSON.stringify(ui2));
await page.screenshot({ path: OUT + "/03-expanded.png" });

await safeClick("#xat-root [data-act='edit']");
await page.waitForTimeout(300);

// 侧栏位置滑杆：拖动应立刻改变 .side 的 top，并写回设置
await page.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  const el = sr.querySelector("#xat-lay-top");
  el.value = "160";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(250);
const liveTop = await page.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  return getComputedStyle(sr.querySelector(".side")).top;
});
check("侧栏位置：拖滑杆立即生效", liveTop === "160px", liveTop);
await page.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  const el = sr.querySelector("#xat-lay-top");
  el.value = "72";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(200);

await safeClick("#xat-root [data-act='add-dest']");
await page.waitForTimeout(300);
await safeFill("#xat-root [data-dname='0']", "西安市雁塔区小寨东路 (108.945300,34.253100)");
await page.waitForTimeout(500);
await safeClick("#xat-root [data-dparse='0']");
await page.waitForTimeout(600);
const ui3 = await page.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  return {
    cond: (sr.querySelector("#xat-cond") || {}).textContent || "",
    coord: (sr.querySelector(".dest__coord") || {}).textContent || "",
    rowsInRoi: (sr.querySelector("#xat-cin") || {}).textContent,
  };
});
check("目的地：粘贴带坐标的地址即定位", /1 个目的地/.test(ui3.cond) && /108\.945300/.test(ui3.coord), JSON.stringify(ui3));
await page.screenshot({ path: OUT + "/04-destination.png" });

await safeClick("#xat-root [data-act='save']");
await page.waitForTimeout(700);
const saved = await rpc(opts, "boot");
check("目的地：保存后落库", (saved.settings.destinations || []).length === 1 && Math.abs(saved.settings.destinations[0].lng - 108.9453) < 1e-4, JSON.stringify(saved.settings.destinations));

/* ---------- 7. 手录小区 ---------- */
await safeClick("#xat-root [data-act='new-community']");
await page.waitForTimeout(400);
await safeFill("#xat-fname", "测试小区乙 (108.946000,34.253500)");
await safeFill("#xat-fprice", "18000");
await safeFill("#xat-farea-min", "80");
await safeFill("#xat-farea-max", "120");
await safeClick("#xat-root [data-act='form-save']");
await page.waitForTimeout(900);
const ui4 = await page.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  return {
    panel: [...sr.querySelectorAll(".pane")].filter((p) => !p.hidden).map((p) => p.dataset.pane).join(","),
    rows: sr.querySelectorAll(".entry").length,
    list: (sr.querySelector("#xat-list") || {}).textContent || "",
  };
});
check("手录：保存后出现在列表里", ui4.rows >= 1, JSON.stringify(ui4).slice(0, 160));
const afterCommunity = await rpc(opts, "boot");
const mine = (afterCommunity.communities || []).find((c) => c.name.includes("测试小区乙"));
check("手录：落库并带坐标", !!(mine && Math.abs(mine.lng - 108.946) < 1e-4), mine && `${mine.id} ${mine.lng},${mine.lat} src=${mine.sources}`);
await page.screenshot({ path: OUT + "/05-with-community.png" });

/* ---------- 8. 编辑 / 删除 ---------- */
if (mine) {
  await safeClick(`#xat-root .entry[data-id='${mine.id}']`);
  await page.waitForTimeout(400);
  await safeClick("#xat-root [data-act='edit-community']");
  await page.waitForTimeout(400);
  const title = await page.evaluate(() => document.querySelector("#xat-root").shadowRoot.querySelector("#xat-form-title").textContent);
  check("编辑：详情页的「编辑小区」能打开表单", /编辑小区/.test(title), title);
  await safeClick("#xat-root [data-act='cancel-form']");
  await page.waitForTimeout(300);
}

/* ---------- 8.5 卫星影像：详情缩略图 + 大圆扫描 + 判定 ---------- */
await safeClick("#xat-root [data-act='cancel-form']").catch(() => {});
await page.waitForTimeout(400);
if (mine) {
  await safeClick(`#xat-root .entry[data-id='${mine.id}']`).catch(() => {});
  await page.waitForTimeout(500);
}

let satOk = false;
try {
  await page.waitForFunction(() => {
    const sr = document.querySelector("#xat-root").shadowRoot;
    const img = sr.querySelector("#xat-dsat .sat__img");
    return img && img.src.startsWith("data:image/jpeg");
  }, null, { timeout: 90000 });
  satOk = true;
} catch (e) {
  satOk = false;
}
check("影像：详情页出现真卫星缩略图", satOk);

if (satOk) {
  const satInfo = await page.evaluate(() => {
    const sr = document.querySelector("#xat-root").shadowRoot;
    const img = sr.querySelector("#xat-dsat .sat__img");
    const metrics = sr.querySelector("#xat-dsat-metrics").textContent.replace(/\s+/g, " ").trim();
    return { bytes: img.src.length, metrics };
  });
  check("影像：缩略图带数据（>20KB base64）", satInfo.bytes > 20000, String(satInfo.bytes));
  check("影像：给出粗分/长影带/方向一致等指标", /粗分/.test(satInfo.metrics) && /长影带/.test(satInfo.metrics) && /方向一致/.test(satInfo.metrics), satInfo.metrics.slice(0, 120));

  // 人工判定：点「像小区」应高亮并落库
  const vres = await page.evaluate(async () => {
    const sr = document.querySelector("#xat-root").shadowRoot;
    const btn = sr.querySelector("[data-act='sat-verdict'][data-v='like']");
    if (!btn) return { found: false };
    const key = btn.dataset.key;
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const on = sr.querySelector(`[data-act='sat-verdict'][data-v='like'][data-key='${key}']`);
    return { found: true, key, active: on && on.classList.contains("is-on") };
  });
  check("影像：判定按钮可按（像小区）", !!(vres.found && vres.active), JSON.stringify(vres));

  // 大圆扫描：先退出详情回到列表，才能看到「发现」页签
  await safeClick("#xat-root [data-act='close-detail']").catch(() => {});
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const sr = document.querySelector("#xat-root").shadowRoot;
    const tab = [...sr.querySelectorAll(".tabs__btn")].find((b) => b.dataset.tab === "discover");
    tab && tab.click();
  });
  await page.waitForTimeout(400);
  await safeClick("#xat-root [data-act='scan-roi']");
  let scanOk = false;
  try {
    await page.waitForFunction(() => {
      const sr = document.querySelector("#xat-root").shadowRoot;
      const img = sr.querySelector("#xat-scan-out .sat__img");
      return img && img.src.startsWith("data:image/jpeg");
    }, null, { timeout: 120000 });
    scanOk = true;
  } catch (e) {
    scanOk = false;
  }
  check("影像：大圆扫描出影像", scanOk);
  if (scanOk) {
    const scanInfo = await page.evaluate(() => {
      const sr = document.querySelector("#xat-root").shadowRoot;
      const out = sr.querySelector("#xat-scan-out");
      const tiles = [...out.querySelectorAll(".scan-tile")];
      return {
        tiles: tiles.length,
        firstScore: tiles.length ? tiles[0].querySelector(".scan-tile__s").textContent : null,
        hasAdd: !!out.querySelector("[data-act='adopt-tile']"),
        legend: (out.querySelector(".sat__legend") || {}).textContent || "",
      };
    });
    check("影像：扫出候选瓦片并按分排序", scanInfo.tiles >= 3 && Number(scanInfo.firstScore) >= 0, JSON.stringify(scanInfo).slice(0, 160));
    check("影像：每个候选可「加为小区」", scanInfo.hasAdd, "");
    // 点第一个「加为小区」，表单应带上坐标
    if (scanInfo.hasAdd) {
      await safeClick("#xat-scan-out [data-act='adopt-tile']");
      await page.waitForTimeout(600);
      const adopted = await page.evaluate(() => {
        const sr = document.querySelector("#xat-root").shadowRoot;
        const name = (sr.querySelector("#xat-fname") || {}).value || "";
        const coord = (sr.querySelector("#xat-fcoord") || {}).textContent || "";
        return { name, coord, panel: [...sr.querySelectorAll(".pane")].filter((p) => !p.hidden).map((p) => p.dataset.pane).join(",") };
      });
      check("影像：采纳候选 → 表单预填坐标", /影像候选/.test(adopted.name) && /\d+\.\d+/.test(adopted.coord), JSON.stringify(adopted));
      await safeClick("#xat-root [data-act='cancel-form']");
      await page.waitForTimeout(300);
    }
  }
}

/* ---------- 9. 关掉浏览器，重开验证持久化 ---------- */
const settingsBefore = await rpc(opts, "settings.set", { patch: { layout: { top: 120, bottom: 40 } } });
check("设置：留白可改", settingsBefore.layout.top === 120 && settingsBefore.layout.bottom === 40, JSON.stringify(settingsBefore.layout));

await context.close();

const ctx2 = await chromium.launchPersistentContext(userDir, {
  executablePath: CHROME && fs.existsSync(CHROME) ? CHROME : undefined,
  headless: true,
  locale: "zh-CN",
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--disable-dev-shm-usage"],
});
const page2 = await ctx2.newPage();
await page2.goto("https://www.amap.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page2.waitForFunction(() => {
  const h = document.querySelector("#xat-root");
  return !!(h && h.shadowRoot && h.shadowRoot.querySelector(".drawer"));
}, null, { timeout: 40000 });
await page2.waitForFunction(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  const side = sr.querySelector(".side");
  return getComputedStyle(side).position === "fixed" && getComputedStyle(side).top !== "auto";
}, null, { timeout: 15000 });
const ui5 = await page2.evaluate(() => {
  const sr = document.querySelector("#xat-root").shadowRoot;
  const side = sr.querySelector(".side");
  return {
    top: getComputedStyle(side).top,
    bottom: getComputedStyle(side).bottom,
    cond: (sr.querySelector("#xat-cond") || {}).textContent || "",
    sideHidden: side.classList.contains("is-hidden"),
  };
});
check("持久化：重开后留白仍是 120/40", ui5.top === "120px" && ui5.bottom === "40px", `${ui5.top}/${ui5.bottom}`);
check("持久化：重开后目的地还在", /1 个目的地/.test(ui5.cond), ui5.cond);
check("持久化：重开后仍默认折叠", ui5.sideHidden);
await ctx2.close();

const ourErrors = pageErrors.filter((e) => e.includes("[XAT]") || e.includes("chrome-extension://"));
check("运行期没有插件自己的 JS 报错", ourErrors.length === 0, ourErrors.slice(0, 4).join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  console.log("失败项：");
  failed.forEach((f) => console.log(" - " + f.name + (f.extra ? " :: " + f.extra : "")));
  process.exitCode = 1;
}
fs.writeFileSync(OUT + "/results.json", JSON.stringify({ results, pageErrors }, null, 2));
