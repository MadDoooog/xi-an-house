/* 西接通勤 · 弹窗 */
"use strict";

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

async function refresh() {
  try {
    const check = await rpc("self.check");
    document.getElementById("ver").textContent = "v" + check.manifest.version;
    document.getElementById("comms").textContent = check.communityCount + " 条";
    document.getElementById("logs").textContent = check.logCount + " 条";

    const diag = (check.diag || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const hook = document.getElementById("hook");
    if (!diag) {
      hook.textContent = "未上报（先去高德页刷新一次）";
      hook.className = "warn";
    } else if (diag.hookReady) {
      hook.textContent = "已连接地图";
      hook.className = "ok";
    } else {
      hook.textContent = "未连接：" + (diag.reason || "未知");
      hook.className = "bad";
    }
  } catch (e) {
    document.getElementById("hook").textContent = "读取失败：" + e.message;
    document.getElementById("hook").className = "bad";
  }
}

document.getElementById("open").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.amap.com/" });
  window.close();
});

document.getElementById("diag").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();

// 阴影地图：扩展自己的整页界面（不再往高德页面里注图层）
const openMap = document.getElementById("open-map");
if (openMap) {
  openMap.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("map.html") });
  });
}
