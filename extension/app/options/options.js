/* 西接通勤 · 设置与诊断页 */
"use strict";

const $ = (s) => document.querySelector(s);

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "xat.rpc", method, params }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("后台无响应"));
      if (!res.ok) return reject(new Error(res.error));
      resolve(res.data);
    });
  });
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

const fmtTime = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/* ---------------- 状态卡片 ---------------- */

let cache = { diag: [], logs: [], manifest: null, counts: {} };

async function refreshStatus() {
  try {
    const [check, diag, logs] = await Promise.all([
      rpc("self.check"),
      rpc("diag.list"),
      rpc("log.list", { limit: 1, level: "debug" }),
    ]);
    cache.manifest = check.manifest;
    cache.diag = diag || [];
    cache.counts = { logs: check.logCount, comms: check.communityCount };

    $("#ver").textContent = "v" + check.manifest.version;
    $("#d-ver").textContent = check.manifest.version;
    $("#d-comms").textContent = check.communityCount + " 条";
    $("#d-logs").textContent = check.logCount + " 条";

    const last = (diag || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const hookEl = $("#d-hook");
    if (!last) {
      hookEl.textContent = "还没收到内容脚本上报";
      hookEl.className = "warn";
      $("#d-url").textContent = "—";
      $("#d-upd").textContent = "—";
    } else {
      hookEl.textContent = last.hookReady ? "已连接地图" : "未连接（" + (last.reason || "未知") + "）";
      hookEl.className = last.hookReady ? "ok" : "bad";
      $("#d-url").textContent = last.href || last.tabId || "—";
      $("#d-upd").textContent = fmtTime(last.updatedAt);
    }
    $("#diagbox").value = buildDiagText();
  } catch (e) {
    $("#d-hook").textContent = "读取失败：" + e.message;
    $("#d-hook").className = "bad";
  }
}

function buildDiagText() {
  const m = cache.manifest || {};
  const lines = [];
  lines.push("=== 西接通勤 诊断 ===");
  lines.push("time: " + new Date().toISOString());
  lines.push("ua: " + navigator.userAgent);
  lines.push("version: " + (m.version || "?"));
  lines.push("manifest permissions: " + JSON.stringify(m.permissions || []));
  lines.push("host_permissions: " + JSON.stringify(m.host_permissions || []));
  lines.push("content_scripts: " + JSON.stringify((m.content_scripts || []).map((c) => ({ matches: c.matches, world: c.world || "ISOLATED", js: c.js }))));
  lines.push("counts: " + JSON.stringify(cache.counts));
  lines.push("");
  lines.push("--- diag（内容脚本上报）---");
  (cache.diag || []).forEach((d) => lines.push(JSON.stringify(d)));
  lines.push("");
  lines.push("--- logs（最近 80 条）---");
  (cache.logs || []).slice(0, 80).forEach((l) => {
    lines.push(`${fmtTime(l.ts)} [${l.source}][${l.level}] ${l.msg}${l.data ? " " + safe(l.data) : ""}`);
  });
  return lines.join("\n");
}

function safe(v) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch (e) {
    return String(v);
  }
}

/* ---------------- 日志 ---------------- */

async function loadLogs() {
  const level = $("#log-level").value;
  try {
    const rows = await rpc("log.list", { limit: 400, level });
    cache.logs = rows;
    $("#log-count").textContent = rows.length + " 条（最多显示 400）";
    $("#logs").innerHTML = rows
      .map(
        (l) =>
          `<div class="logline ${l.level}"><span class="t">${fmtTime(l.ts)}</span>` +
          `<span class="s">${l.source}</span>` +
          `<span class="m">${escapeHtml(l.msg)}${l.data ? " " + escapeHtml(safe(l.data)) : ""}</span></div>`
      )
      .join("");
  } catch (e) {
    $("#logs").textContent = "读取日志失败：" + e.message;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function download(name, text, type) {
  const blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ---------------- 事件 ---------------- */

$("#btn-refresh").addEventListener("click", async () => {
  await refreshStatus();
  await loadLogs();
  toast("已刷新");
});

$("#btn-copy").addEventListener("click", async () => {
  await refreshStatus();
  await loadLogs();
  const text = buildDiagText();
  $("#diagbox").value = text;
  try {
    await navigator.clipboard.writeText(text);
    toast("诊断信息已复制");
  } catch (e) {
    $("#diagbox").select();
    toast("复制失败，已选中文本请手动 Ctrl+C");
  }
});

$("#btn-amap").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.amap.com/" });
});

$("#log-level").addEventListener("change", loadLogs);
$("#btn-logs-refresh").addEventListener("click", loadLogs);

$("#btn-logs-export").addEventListener("click", () => {
  const text = (cache.logs || [])
    .map((l) => `${new Date(l.ts).toISOString()} [${l.source}][${l.level}] ${l.msg}${l.data ? " " + safe(l.data) : ""}`)
    .join("\n");
  download(`xat-logs-${Date.now()}.txt`, text);
});

$("#btn-logs-export-json").addEventListener("click", () => {
  download(`xat-logs-${Date.now()}.json`, JSON.stringify(cache.logs || [], null, 2), "application/json");
});

$("#btn-logs-clear").addEventListener("click", async () => {
  if (!confirm("清空全部日志？")) return;
  await rpc("log.clear");
  await loadLogs();
  await refreshStatus();
  toast("日志已清空");
});

$("#btn-import").addEventListener("click", () => $("#file-import").click());

$("#file-import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const res = await rpc("data.import", { payload });
    toast(`导入完成：新增 ${res.added}，跳过重复 ${res.skipped}`);
    await refreshStatus();
  } catch (err) {
    toast("导入失败：" + (err && err.message ? err.message : err));
  } finally {
    e.target.value = "";
  }
});

$("#btn-clear").addEventListener("click", async () => {
  if (!confirm("清空本机小区库？此操作不可撤销，建议先导出备份。")) return;
  await rpc("data.reset");
  await refreshStatus();
  toast("小区库已清空");
});

$("#btn-export").addEventListener("click", async () => {
  const data = await rpc("boot");
  download(`xat-data-${Date.now()}.json`, JSON.stringify({ settings: data.settings, communities: data.communities }, null, 2), "application/json");
});

refreshStatus().then(loadLogs);
setInterval(() => {
  refreshStatus();
}, 5000);

/* ---- 缓存面板 ---- */
  /* ---- 缓存 ---- */
  async function refreshCache() {
    const el = document.getElementById("cache-stat");
    el.textContent = "读取中…";
    try {
      const c = await rpc("imagery.cache");
      const mb = (n) => (n / 1048576).toFixed(1);
      el.textContent =
        `瓦片 ${c.count} 张（${mb(c.bytes)} MB）· 含阴影 ${c.shadowCount} 张` +
        `（${mb(c.shadowBytes || 0)} MB）· 过期阴影 ${c.staleShadow} 张`;
    } catch (e) {
      el.textContent = "读取失败：" + e.message;
    }
  }
  document.getElementById("btn-cache-refresh")?.addEventListener("click", refreshCache);
  document.getElementById("btn-cache-shadow")?.addEventListener("click", async () => {
    if (!confirm("只清阴影分析结果（瓦片保留，重扫不用重新下载）？")) return;
    const r = await rpc("imagery.clearShadow");
    await refreshCache();
    alert(`已清 ${r.cleared} 张瓦片的阴影结果，保留 ${r.kept} 张瓦片。回地图页重新扫描即可。`);
  });
  document.getElementById("btn-cache-all")?.addEventListener("click", async () => {
    if (!confirm("清空所有瓦片和阴影？下次扫描需要重新下载全部瓦片。")) return;
    await rpc("imagery.clear");
    await refreshCache();
    alert("已清空瓦片与阴影缓存。");
  });
  refreshCache();
  setInterval(refreshCache, 5000);

/* ---- 高德 key ---- */
(async () => {
  const input = document.getElementById("amap-key");
  const stateEl = document.getElementById("amap-key-state");
  const btn = document.getElementById("btn-amap-key");
  if (!input || !btn) return;
  const show = async () => {
    try {
      const d = await rpc("boot");
      const key = (d.settings && d.settings.amapKey) || "";
      input.value = key;
      stateEl.textContent = key
        ? `已配置（${key.slice(0, 6)}…${key.slice(-4)}）`
        : "未配置。没有 key 时阴影仍会扫描，但不会反查小区名。";
    } catch (e) {
      stateEl.textContent = "读取失败：" + e.message;
    }
  };
  btn.addEventListener("click", async () => {
    const key = input.value.trim();
    try {
      await rpc("settings.set", { patch: { amapKey: key } });
      await show();
      toast("高德 key 已保存");
    } catch (e) {
      stateEl.textContent = "保存失败：" + e.message;
    }
  });
  show();
})();
