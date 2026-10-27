/* ============================================================
   阴影聚类：把「路网切开的掩膜」连成片，输出每片的中心点

   输入是每张瓦片已渲染好的掩膜图（slippymap.maskImgs 里的 Image），
   为了省内存，统一按 1/4 分辨率累加到一张画布上：
     瓦片 256px -> 64px，z17 下大约 4 m / 网格像素
   然后：
     1. 用路网折线 destination-out 擦出走廊（路只切不画）
     2. 4 连通域标记，丢掉面积过小的碎块
     3. 每个连通域取质心 → GCJ 经纬度

   纯浏览器侧实现（需要 canvas），不依赖后台。
   ============================================================ */
(function () {
  "use strict";

  const SCALE = 4;      // 每张 256px 瓦片压到 64px
  const GRID_PX = 256 / SCALE;

  function pxToGcj(z, wx, wy) {
    const n = 2 ** z;
    const lng = (wx / n / 256) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / n / 256)));
    return [lng, (latRad * 180) / Math.PI];
  }

  function gcjToWorldPx(z, lng, lat) {
    const n = 2 ** z;
    const wx = ((lng + 180) / 360) * n * 256;
    const latRad = (lat * Math.PI) / 180;
    const wy = ((1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2) * n * 256;
    return [wx, wy];
  }

  /**
   * @param {Array<{z:number,x:number,y:number,img:HTMLImageElement}>} tiles
   * @param {Array<{pts:number[][]}>} roadCuts   GCJ 折线
   * @param {object} opts { minAreaM2, roadWidthM, mPerPx }
   * @returns {{clusters:Array<{areaM2:number,lng:number,lat:number,w:number,h:number}>, grid:object}}
   */
  function cluster(tiles, roadCuts, opts) {
    const P = opts || {};
    const minAreaM2 = P.minAreaM2 == null ? 1500 : P.minAreaM2;
    const roadWidthM = P.roadWidthM == null ? 26 : P.roadWidthM;
    if (!tiles.length) return { clusters: [] };

    const z = tiles[0].z;
    const mPerPx = P.mPerPx || (156543.03392 * Math.cos((34.25 * Math.PI) / 180)) / 2 ** z;
    const mPerGrid = mPerPx * SCALE;

    const xs = tiles.map((t) => t.x);
    const ys = tiles.map((t) => t.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const cols = Math.max(...xs) - x0 + 1;
    const rows = Math.max(...ys) - y0 + 1;

    const cv = document.createElement("canvas");
    cv.width = cols * GRID_PX;
    cv.height = rows * GRID_PX;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;

    for (const t of tiles) {
      if (!t.img || !t.img.complete) continue;
      ctx.drawImage(t.img, (t.x - x0) * GRID_PX, (t.y - y0) * GRID_PX, GRID_PX, GRID_PX);
    }

    // 路网擦除：和显示层同一套逻辑，保证「切开」的位置一致
    if (roadCuts && roadCuts.length) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = Math.max(1, roadWidthM / mPerGrid);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const ln of roadCuts) {
        const pts = ln.pts || ln;
        if (!pts || pts.length < 2) continue;
        ctx.beginPath();
        pts.forEach((p, i) => {
          const [wx, wy] = gcjToWorldPx(z, p[0], p[1]);
          const gx = wx / SCALE - x0 * GRID_PX;
          const gy = wy / SCALE - y0 * GRID_PX;
          if (i === 0) ctx.moveTo(gx, gy);
          else ctx.lineTo(gx, gy);
        });
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    const W = cv.width;
    const H = cv.height;
    const data = ctx.getImageData(0, 0, W, H).data;
    const seen = new Uint8Array(W * H);
    const labels = new Int32Array(W * H).fill(-1);
    let labelId = 0;
    const stack = [];
    const clusters = [];
    const minPx = Math.max(4, minAreaM2 / (mPerGrid * mPerGrid));

    for (let i = 0; i < W * H; i += 1) {
      if (seen[i] || data[i * 4 + 3] === 0) continue;
      stack.length = 0;
      stack.push(i);
      seen[i] = 1;
      labels[i] = labelId;
      const seedX = i % W;
      const seedY = (i / W) | 0;
      let n = 0;
      let sx = 0;
      let sy = 0;
      let minX = W;
      let maxX = 0;
      let minY = H;
      let maxY = 0;
      while (stack.length) {
        const cur = stack.pop();
        n += 1;
        const x = cur % W;
        const y = (cur / W) | 0;
        sx += x;
        sy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const push = (j) => {
          if (!seen[j] && data[j * 4 + 3] !== 0) {
            seen[j] = 1;
            labels[j] = labelId;
            stack.push(j);
          }
        };
        if (x > 0) push(cur - 1);
        if (x < W - 1) push(cur + 1);
        if (y > 0) push(cur - W);
        if (y < H - 1) push(cur + W);
      }
      if (n < minPx) continue;
      const gx = sx / n;
      const gy = sy / n;
      const [lng, lat] = pxToGcj(z, x0 * 256 + gx * SCALE, y0 * 256 + gy * SCALE);

      // 轮廓：取该连通域左上角像素做 Moore 跟踪，再 Douglas–Peucker 简化
      let ring = traceBorder((idx) => labels[idx] === labelId, W, H, seedX, seedY);
      ring = simplify(ring, 1.6);
      labelId += 1;
      const pts = ring.map(([px, py]) => pxToGcj(z, x0 * 256 + px * SCALE, y0 * 256 + py * SCALE));

      clusters.push({
        areaM2: Math.round(n * mPerGrid * mPerGrid),
        lng,
        lat,
        w: (maxX - minX + 1) * mPerGrid,
        h: (maxY - minY + 1) * mPerGrid,
        pts,
      });
    }
    clusters.sort((a, b) => b.areaM2 - a.areaM2);
    return { clusters, grid: { x0, y0, cols, rows, mPerGrid, zoom: z } };
  }

  /* ---------------- 轮廓提取 ---------------- */

  const NB = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  /** Moore 邻域跟踪：从一个连通域的起点顺时针描外轮廓，得到闭合环（网格坐标） */
  function traceBorder(inside, W, H, sx, sy) {
    const ring = [];
    let cx = sx;
    let cy = sy;
    let dir = 7; // 从右上开始扫
    const start = [sx, sy];
    let guard = 0;
    const limit = W * H * 4;
    do {
      ring.push([cx, cy]);
      let found = false;
      for (let k = 0; k < 8; k += 1) {
        const d = (dir + 6 + k) % 8; // 从回溯方向的下一个开始
        const nx = cx + NB[d][0];
        const ny = cy + NB[d][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (!inside(ny * W + nx)) continue;
        dir = d;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
      if (!found) break;
      guard += 1;
    } while ((cx !== start[0] || cy !== start[1]) && guard < limit);
    return ring;
  }

  /** Douglas–Peucker 简化（网格坐标） */
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = 1;
    keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const [ax, ay] = pts[a];
      const [bx, by] = pts[b];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      let best = -1;
      let bestD = 0;
      for (let i = a + 1; i < b; i += 1) {
        const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len;
        if (d > bestD) { bestD = d; best = i; }
      }
      if (bestD > eps) {
        keep[best] = 1;
        stack.push([a, best], [best, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }

  window.XAT_CLUSTERS = { cluster };
})();
