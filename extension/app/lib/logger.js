/* ============================================================
   西接通勤 · 日志（content script 侧）
   - 同时打到 DevTools console（前缀 [XAT]）和后台的日志库
   - 级别用 chrome.storage 缓存，默认 info；options 页可切 debug
   - 任何未捕获异常都会被记录，避免"静默失效"
   ============================================================ */
(function () {
  "use strict";

  const XAT = (window.__XAT = window.__XAT || {});
  const PREFIX = "[XAT]";
  const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

  let minLevel = "info";
  let queue = [];
  let flushTimer = null;
  let sent = 0;
  let dropped = 0;

  function safeData(data) {
    if (data === undefined) return undefined;
    try {
      return JSON.parse(
        JSON.stringify(data, (k, v) => {
          if (typeof v === "function") return "[fn]";
          if (v instanceof Error) return { message: v.message, stack: String(v.stack).slice(0, 800) };
          return v;
        })
      );
    } catch (e) {
      return { _unserializable: String(e) };
    }
  }

  function write(level, source, msg, data) {
    if ((ORDER[level] || 20) < (ORDER[minLevel] || 20)) return;

    const entry = {
      ts: Date.now(),
      level,
      source: source || "content",
      msg: String(msg),
      data: safeData(data),
      url: location.href,
    };

    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn.call(console, PREFIX, `[${level}]`, msg, data === undefined ? "" : data);

    queue.push(entry);
    if (queue.length > 200) {
      dropped += queue.length - 200;
      queue = queue.slice(-200);
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 400);
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      chrome.runtime.sendMessage({ type: "xat.rpc", method: "log.add", params: { entries: batch } }, () => {
        // 后台休眠/未就绪时错误会被吞掉，这里只统计，不再递归记日志
        if (chrome.runtime.lastError) dropped += batch.length;
        else sent += batch.length;
      });
    } catch (e) {
      dropped += batch.length;
    }
  }

  chrome.storage.local.get({ logLevel: "info" }, (res) => {
    minLevel = res.logLevel || "info";
  });

  const log = {
    debug: (m, d) => write("debug", "content", m, d),
    info: (m, d) => write("info", "content", m, d),
    warn: (m, d) => write("warn", "content", m, d),
    error: (m, d) => write("error", "content", m, d),
    scope(name) {
      return {
        debug: (m, d) => write("debug", name, m, d),
        info: (m, d) => write("info", name, m, d),
        warn: (m, d) => write("warn", name, m, d),
        error: (m, d) => write("error", name, m, d),
      };
    },
    stats: () => ({ sent, dropped, queued: queue.length, minLevel }),
    /** 包一层 try/catch，异常不中断主流程但要留痕 */
    guard(label, fn, fallback) {
      try {
        return fn();
      } catch (e) {
        write("error", "guard", `${label} 抛异常`, { error: e });
        return fallback;
      }
    },
  };

  XAT.log = log;

  window.addEventListener("error", (e) => {
    write("error", "window", "未捕获的脚本错误", {
      message: e.message,
      file: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    write("error", "window", "未处理的 Promise 拒绝", { reason: e.reason });
  });

  write("info", "logger", "日志模块已就绪", { href: location.href, minLevel });
})();
