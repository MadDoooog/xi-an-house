/* ============================================================
   一块极简 slippy map（自绘 canvas）

   为什么不用 MapLibre：MV3 的 CSP 不允许 blob: worker，MapLibre 需要额外
   的 CSP 构建 + setWorkerUrl；而我们只要「卫星瓦片 + 多边形 + 线」，自绘
   反而更小、更快、完全可控。

   坐标系：全程 GCJ-02。高德卫星瓦片按 GCJ 对齐，我们算出来的阴影多边形
   也是 GCJ，所以不需要任何转换。

   用法：
     const m = new SlippyMap(el, { center: [lng, lat], zoom: 15, tileUrl });
     m.setPolygons([[ [lng,lat], ... ], ...]);
     m.setLines([{ cls: "primary", pts: [[lng,lat], ...] }]);
     m.fitBounds([w, s, e, n]);   // GCJ 经纬度
   ============================================================ */
(function () {
  "use strict";

  const TILE = 256;

  class SlippyMap {
    constructor(el, opts = {}) {
      this.el = el;
      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;cursor:grab";
      // 只在没有定位时兜底，别覆盖调用方的 fixed/absolute 布局
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      el.style.overflow = "hidden";
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.center = opts.center || [108.94, 34.26];
      this.zoom = opts.zoom || 15;
      this.minZoom = opts.minZoom == null ? 10 : opts.minZoom;
      this.maxZoom = opts.maxZoom == null ? 18 : opts.maxZoom;
      this.basemaps = opts.basemaps || {
        satellite: { label: "卫星", url: (z, x, y) => `https://webst0${1 + ((x + y) % 4)}.is.autonavi.com/appmaptile?style=6&z=${z}&x=${x}&y=${y}` },
        classic: { label: "地图", url: (z, x, y) => `https://webrd0${1 + ((x + y) % 4)}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&z=${z}&x=${x}&y=${y}` },
      };
      this.basemap = opts.basemap || "satellite";
      this.tileUrl = this.basemaps[this.basemap].url;
      this.polygons = [];
      this.lines = [];
      this.markers = [];
      this.circle = null;
      this.maskTiles = [];
      this.maskImgs = new Map();
      this.roadCuts = [];        // 只用于切分阴影，不绘制
      this.footprints = [];      // 已识别小区的多边形（覆盖阴影）
      this.maskHoles = [];       // 要被多边形覆盖掉的阴影区域
      this._maskCv = null;
      this.handlers = { move: [], click: [] };

      this.tiles = new Map(); // key -> {img, ready}
      this.pending = new Set();
      this.tileCount = 0;
      this.frozen = false;

      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this._bind();
      this._resize();
      this.draw();
    }

    /* ---------- 投影：GCJ 经纬度 ↔ 世界像素 ---------- */

    worldSize(z) {
      return TILE * 2 ** z;
    }

    lngToWorldX(lng, z) {
      return ((lng + 180) / 360) * this.worldSize(z);
    }

    latToWorldY(lat, z) {
      const rad = (lat * Math.PI) / 180;
      const y = Math.log(Math.tan(Math.PI / 4 + rad / 2));
      return ((1 - y / Math.PI) / 2) * this.worldSize(z);
    }

    worldXToLng(x, z) {
      return (x / this.worldSize(z)) * 360 - 180;
    }

    worldYToLat(y, z) {
      const n = Math.PI - (2 * Math.PI * y) / this.worldSize(z);
      return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }

    /** GCJ 经纬度 → 容器内 CSS 像素坐标 */
    project(lng, lat) {
      const cx = this.lngToWorldX(this.center[0], this.zoom);
      const cy = this.latToWorldY(this.center[1], this.zoom);
      const x = this.lngToWorldX(lng, this.zoom) - cx + this.w / 2;
      const y = this.latToWorldY(lat, this.zoom) - cy + this.h / 2;
      return [x, y];
    }

    unproject(x, y) {
      const cx = this.lngToWorldX(this.center[0], this.zoom);
      const cy = this.latToWorldY(this.center[1], this.zoom);
      return [
        this.worldXToLng(cx + x - this.w / 2, this.zoom),
        this.worldYToLat(cy + y - this.h / 2, this.zoom),
      ];
    }

    brand() {
      this.el.__xatMap = this;
      return this;
    }

    /* ---------- 交互 ---------- */

    _bind() {
      let drag = null;
      const canvas = this.canvas;

      canvas.addEventListener("pointerdown", (e) => {
        if (this.frozen) return;
        canvas.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY, center: this.center.slice(), moved: 0 };
        canvas.style.cursor = "grabbing";
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
        const cx = this.lngToWorldX(drag.center[0], this.zoom) - dx;
        const cy = this.latToWorldY(drag.center[1], this.zoom) - dy;
        this.center = [this.worldXToLng(cx, this.zoom), this.worldYToLat(cy, this.zoom)];
        this.draw();
      });
      const end = (e) => {
        if (!drag) return;
        const wasClick = drag.moved < 4;
        drag = null;
        canvas.style.cursor = "grab";
        if (wasClick) this._emit("click", this.unproject(e.offsetX, e.offsetY));
        else this._emit("move", this.center);
      };
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);

      canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          if (this.frozen) return;
          const before = this.unproject(e.offsetX, e.offsetY);
          const dz = e.deltaY < 0 ? 0.5 : -0.5;
          this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + dz));
          // 以光标为锚点缩放
          const after = this.unproject(e.offsetX, e.offsetY);
          this.center = [this.center[0] + (before[0] - after[0]), this.center[1] + (before[1] - after[1])];
          this.draw();
          this._emit("move", this.center);
        },
        { passive: false },
      );

      canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this._emit("contextmenu", {
          lngLat: this.unproject(e.offsetX, e.offsetY),
          clientX: e.clientX,
          clientY: e.clientY,
        });
      });

      canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (this.frozen) return;
        this.zoom = Math.min(this.maxZoom, this.zoom + 1);
        this.center = this.unproject(e.offsetX, e.offsetY);
        this.draw();
      });

      window.addEventListener("resize", () => {
        this._resize();
        this.draw();
      });
    }

    on(evt, cb) {
      (this.handlers[evt] || (this.handlers[evt] = [])).push(cb);
      return this;
    }

    _emit(evt, payload) {
      for (const cb of this.handlers[evt] || []) {
        try { cb(payload); } catch (e) { /* 观察者异常不影响绘制 */ }
      }
    }

    _resize() {
      const r = this.el.getBoundingClientRect();
      this.w = Math.max(1, Math.round(r.width));
      this.h = Math.max(1, Math.round(r.height));
      this.canvas.width = this.w * this.dpr;
      this.canvas.height = this.h * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    /* ---------- 数据层 ---------- */

    setInteractive(on) {
      this.frozen = !on;
      this.canvas.style.cursor = on ? "grab" : "progress";
    }

    setBasemap(kind) {
      if (!this.basemaps[kind] || kind === this.basemap) return;
      this.basemap = kind;
      this.tileUrl = this.basemaps[kind].url;
      this.tiles.clear();
      this.pending.clear();
      this.draw();
      this._emit("basemap", kind);
    }

    setMarkers(list) {
      this.markers = list || [];
      this.draw();
    }

    /** 掩膜瓦片：{z,x,y,key,url}，按瓦片贴图绘制，比多边形精确 */
    setMaskTiles(list) {
      this.maskTiles = list || [];
      this.draw();
    }

    /** 已识别小区的多边形：填充 + 描边 + 名称，用来覆盖原始阴影 */
    setFootprints(list) {
      this.footprints = list || [];
      this.draw();
    }

    /** 这些区域从阴影掩膜里挖掉（被小区多边形替代） */
    setMaskHoles(list) {
      this.maskHoles = list || [];
      this.draw();
    }

    /** 路网切割线（GCJ 折线）：画掩膜时用 destination-out 擦掉，路本身不显示 */
    setRoadCuts(lines) {
      this.roadCuts = lines || [];
      this.draw();
    }

    setCircle(c) {
      this.circle = c;
      this.draw();
    }

    setPolygons(rings) {
      this.polygons = rings || [];
      this.draw();
    }

    setLines(lines) {
      this.lines = lines || [];
      this.draw();
    }

    fitBounds(bounds, padding = 40) {
      const [w, s, e, n] = bounds;
      let z = this.maxZoom;
      for (; z > this.minZoom; z -= 0.25) {
        const x1 = this.lngToWorldX(w, z);
        const x2 = this.lngToWorldX(e, z);
        const y1 = this.latToWorldY(n, z);
        const y2 = this.latToWorldY(s, z);
        if (x2 - x1 <= this.w - padding * 2 && y2 - y1 <= this.h - padding * 2) break;
      }
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, z));
      this.center = [(w + e) / 2, (s + n) / 2];
      this.draw();
    }

    /* ---------- 绘制 ---------- */

    draw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        this._paint();
      });
    }

    _paint() {
      const ctx = this.ctx;
      const w = this.w;
      const h = this.h;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#e9e5dd";
      ctx.fillRect(0, 0, w, h);
      this._paintTiles();
      this._paintLines();
      this._paintPolygons();
      this._paintMaskTiles();
      this._paintCircle();
      this._paintMarkers();
    }

    _maskImg(key, url) {
      let info = this.maskImgs.get(key);
      if (info) return info;
      const img = new Image();
      info = { img, ready: false, edge: null };
      img.onload = () => {
        info.edge = this._buildEdge(img);   // 预生成 1 像素边界，绘制时直接用
        info.ready = true;
        this.draw();
      };
      img.onerror = () => { info.failed = true; };
      img.src = url;
      this.maskImgs.set(key, info);
      return info;
    }

    /** 形态学梯度：把掩膜在 8 个方向各偏移 1px 画一遍，再减去自身 → 只剩外圈 1px */
    _buildEdge(img) {
      const w = img.width;
      const h = img.height;
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const g = cv.getContext("2d");
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        g.drawImage(img, dx, dy);
      }
      g.globalCompositeOperation = "destination-out";
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = "source-over";
      return cv;
    }

    _paintMaskTiles() {
      if (!this.maskTiles.length) return;
      // 先画到离屏画布，再用路网擦除，最后整张贴上来——路网只当"剪刀"，不显示
      if (!this._maskCv) {
        this._maskCv = document.createElement("canvas");
        this._maskCtx = this._maskCv.getContext("2d");
      }
      const cv = this._maskCv;
      const mctx = this._maskCtx;
      if (cv.width !== this.w * this.dpr || cv.height !== this.h * this.dpr) {
        cv.width = this.w * this.dpr;
        cv.height = this.h * this.dpr;
      }
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.clearRect(0, 0, cv.width, cv.height);
      mctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      mctx.imageSmoothingEnabled = true;

      const cx = this.lngToWorldX(this.center[0], this.zoom);
      const cy = this.latToWorldY(this.center[1], this.zoom);
      for (const m of this.maskTiles) {
        const info = this._maskImg(m.key, m.url);
        if (!info || !info.ready) continue;
        const scale = 2 ** (this.zoom - m.z);
        const size = TILE * scale;
        const sx = m.x * TILE * scale - (cx - this.w / 2);
        const sy = m.y * TILE * scale - (cy - this.h / 2);
        if (sx > this.w || sy > this.h || sx + size < 0 || sy + size < 0) continue;
        // 半透明填充 + 实描边（和之前红框轮廓的观感一致，但形状是真实像素边界）
        mctx.globalAlpha = 0.26;
        mctx.drawImage(info.img, sx, sy, size, size);
        if (info.edge) {
          mctx.globalAlpha = 0.95;
          mctx.drawImage(info.edge, sx, sy, size, size);
        }
      }
      mctx.globalAlpha = 1;

      if (this.roadCuts.length) {
        const mpp = (156543.03392 * Math.cos((this.center[1] * Math.PI) / 180)) / 2 ** this.zoom;
        const wpx = Math.max(2, 26 / mpp); // 约 26 m 宽的走廊
        mctx.globalCompositeOperation = "destination-out";
        mctx.strokeStyle = "#000";
        mctx.lineWidth = wpx;
        mctx.lineCap = "round";
        mctx.lineJoin = "round";
        for (const ln of this.roadCuts) {
          const pts = ln.pts || ln;
          if (!pts || pts.length < 2) continue;
          mctx.beginPath();
          let started = false;
          for (const p of pts) {
            const sp = this.project(p[0], p[1]);
            if (!started) { mctx.moveTo(sp[0], sp[1]); started = true; } else mctx.lineTo(sp[0], sp[1]);
          }
          mctx.stroke();
        }
        mctx.globalCompositeOperation = "source-over";
      }

      // 已被小区多边形覆盖的区域，从阴影里挖掉
      if (this.maskHoles.length) {
        mctx.globalCompositeOperation = "destination-out";
        mctx.fillStyle = "#000";
        for (const hole of this.maskHoles) {
          const pts = hole.pts || hole;
          if (!pts || pts.length < 3) continue;
          mctx.beginPath();
          pts.forEach((p, i) => {
            const sp = this.project(p[0], p[1]);
            if (i === 0) mctx.moveTo(sp[0], sp[1]);
            else mctx.lineTo(sp[0], sp[1]);
          });
          mctx.closePath();
          mctx.fill();
        }
        mctx.globalCompositeOperation = "source-over";
      }

      this.ctx.drawImage(cv, 0, 0, this.w, this.h);
      this._paintFootprints();
    }

    /** 已识别小区：半透明填充 + 实线描边 + 名称 */
    _paintFootprints() {
      if (!this.footprints.length) return;
      const ctx = this.ctx;
      for (const f of this.footprints) {
        // 一个小区可能由多片阴影组成：rings 里每一片都画，标签只画一次（最大那片的质心）
        const rings = (f.rings && f.rings.length ? f.rings : [f.pts]).filter((r) => r && r.length >= 3);
        if (!rings.length) continue;
        ctx.save();
        ctx.beginPath();
        for (const pts of rings) {
          pts.forEach((p, i) => {
            const sp = this.project(p[0], p[1]);
            if (i === 0) ctx.moveTo(sp[0], sp[1]);
            else ctx.lineTo(sp[0], sp[1]);
          });
          ctx.closePath();
        }
        ctx.fillStyle = "rgba(46,95,138,.30)";
        ctx.fill("evenodd");
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#2e5f8a";
        ctx.stroke();
        if (f.name) {
          const biggest = rings.reduce((a, r) => (r.length > a.length ? r : a), rings[0]);
          const c = biggest.reduce((a, p) => [a[0] + p[0] / biggest.length, a[1] + p[1] / biggest.length], [0, 0]);
          const sp = this.project(c[0], c[1]);
          ctx.font = '600 12px "PingFang SC", system-ui, sans-serif';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(255,255,255,.92)";
          ctx.strokeText(f.name, sp[0], sp[1]);
          ctx.fillStyle = "#1a1815";
          ctx.fillText(f.name, sp[0], sp[1]);
        }
        ctx.restore();
      }
    }

    _paintCircle() {
      const c = this.circle;
      if (!c || !c.center) return;
      const ctx = this.ctx;
      const mid = this.project(c.center[0], c.center[1]);
      const edge = this.project(c.center[0] + c.radius / (111320 * Math.cos((c.center[1] * Math.PI) / 180)), c.center[1]);
      const r = Math.hypot(edge[0] - mid[0], edge[1] - mid[1]);
      ctx.save();
      ctx.beginPath();
      ctx.arc(mid[0], mid[1], Math.max(2, r), 0, Math.PI * 2);
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "rgba(26,24,21,.72)";
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    _paintMarkers() {
      const ctx = this.ctx;
      for (const m of this.markers) {
        const p = this.project(m.lng, m.lat);
        if (p[0] < -40 || p[1] < -40 || p[0] > this.w + 40 || p[1] > this.h + 40) continue;
        ctx.beginPath();
        ctx.arc(p[0], p[1], m.r || 5, 0, Math.PI * 2);
        ctx.fillStyle = m.color || "#126e5b";
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = "#f4f1e9";
        ctx.stroke();
        if (m.label) {
          ctx.font = "600 11px 'PingFang SC', system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          const w = ctx.measureText(m.label).width;
          ctx.fillStyle = "rgba(244,241,233,.9)";
          ctx.fillRect(p[0] - w / 2 - 4, p[1] + 8, w + 8, 15);
          ctx.fillStyle = "#1a1815";
          ctx.fillText(m.label, p[0], p[1] + 11);
        }
      }
    }

    _paintTiles() {
      const z = Math.floor(this.zoom);
      const scale = 2 ** (this.zoom - z);
      const size = TILE * scale;
      const cx = this.lngToWorldX(this.center[0], this.zoom);
      const cy = this.latToWorldY(this.center[1], this.zoom);
      const left = cx - this.w / 2;
      const top = cy - this.h / 2;

      const x0 = Math.floor(left / size);
      const y0 = Math.floor(top / size);
      const x1 = Math.ceil((left + this.w) / size);
      const y1 = Math.ceil((top + this.h) / size);
      const max = 2 ** z;

      for (let ty = y0; ty < y1; ty += 1) {
        if (ty < 0 || ty >= max) continue;
        for (let tx = x0; tx < x1; tx += 1) {
          const wx = ((tx % max) + max) % max;
          const key = `${z}/${wx}/${ty}`;
          const info = this._tile(key, z, wx, ty);
          const sx = tx * size - left;
          const sy = ty * size - top;
          if (info && info.ready) {
            this.ctx.drawImage(info.img, sx, sy, size + 0.6, size + 0.6);
          }
        }
      }
    }

    _tile(key, z, x, y) {
      let info = this.tiles.get(key);
      if (info) return info;
      if (this.pending.has(key)) return null;
      this.pending.add(key);
      const img = new Image();
      info = { img, ready: false };
      img.onload = () => {
        info.ready = true;
        this.pending.delete(key);
        this.tileCount += 1;
        // 简单 LRU：超过 400 张就清最早的
        if (this.tiles.size > 400) {
          const oldest = this.tiles.keys().next().value;
          if (oldest) this.tiles.delete(oldest);
        }
        this.draw();
      };
      img.onerror = () => {
        this.pending.delete(key);
        this.tiles.set(key, { img, ready: false, failed: true });
      };
      // 不需要读像素，别开 crossOrigin：瓦片服务没有 CORS 头会直接加载失败
      img.src = this.tileUrl(z, x, y);
      this.tiles.set(key, info);
      return info;
    }

    _paintLines() {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const ln of this.lines) {
        const major = /^(trunk|primary|secondary)/.test(String(ln.cls || ""));
        ctx.beginPath();
        let started = false;
        for (const p of ln.pts) {
          const s = this.project(p[0], p[1]);
          if (!started) { ctx.moveTo(s[0], s[1]); started = true; } else ctx.lineTo(s[0], s[1]);
        }
        ctx.lineWidth = (major ? 3.2 : 2) + 2;
        ctx.strokeStyle = "rgba(255,255,255,.8)";
        ctx.stroke();
        ctx.lineWidth = major ? 3.2 : 2;
        ctx.strokeStyle = major ? "rgba(24,52,96,.9)" : "rgba(24,52,96,.6)";
        ctx.stroke();
      }
      ctx.restore();
    }

    _paintPolygons() {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = "rgba(217,74,58,.22)";
      ctx.strokeStyle = "rgba(217,74,58,.95)";
      ctx.lineWidth = 1.2;
      for (const ring of this.polygons) {
        if (!ring || ring.length < 3) continue;
        ctx.beginPath();
        let started = false;
        for (const p of ring) {
          const s = this.project(p[0], p[1]);
          if (!started) { ctx.moveTo(s[0], s[1]); started = true; } else ctx.lineTo(s[0], s[1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  window.XAT_MAP = { SlippyMap };
})();
