# 阶段 4 开发日志 · 交接与待办（v0.3.0 之后）

> 状态：**2026-10-26 收工**。这份文件是给"明天换一台机器继续开发的你/另一个 agent"看的：
> 上半部分记录「已经做成什么样、为什么这么定」，下半部分是「还没做、怎么验收、坑在哪」。
> 配套：`docs/extension/01-plan.md`（方案）、`02-ui.md`（界面）、`03-mvp.md`（分版本交付记录）、`data-dictionary.md`（字段）。

---

## 1. 现在能用的能力（v0.3.0）

装法：`chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/app`（或 `dist/xian-commute-ext-v0.3.0.zip` 解压到 `D:\xian-commute-ext`）。**目录路径不要变**，未打包扩展的 ID 由路径决定，换路径会丢已存数据。

| 能力 | 入口 | 说明 |
|---|---|---|
| 侧栏 | 高德页右边缘的「找房」抽屉 | 默认折叠；上下留白可在「筛选条件 → 侧栏位置」调，默认 72/24 px |
| 目的地 | 筛选条件 → ＋ 添加目的地 | 粘贴「右键复制」得到的内容即自动定位；纯文字走页面自带 `AMap.Geocoder` |
| 右键复制地址 | 地图右键菜单里新增的「复制地址」 | 克隆高德自己的 `li.menu_item` 注入；菜单没出现时自绘兜底。输出 `地址 (lng,lat)`，WGS84 |
| 小区 | ＋ 添加小区 / 详情页「编辑小区」 | 手录、编辑、删除；JSON / GeoJSON 导入（设置页），同名 200 m 内去重 |
| 卫星影像 | 小区详情 / 「发现」页扫描 | 拉高德卫星瓦片 → Otsu 二值化 → 开运算 5 m → 片状阴影筛选 → 打分；红色叠加（含 1 px 描边） |
| 人工校对 | 影像下方的「像小区 / 不像 / 忽略」 | 判定存 `verdicts` 表，重开仍在 |
| 采纳候选 | 发现页每张瓦片的「加为小区」 | 表单预填该瓦片中心坐标（**尚未做聚合与去重，见 P0-1**） |

数据表（`background.js`，DB 版本 3）：`settings` / `communities` / `logs` / `diag` / `commute`（预留）/ `tiles`（瓦片缓存）/ `verdicts`（影像判定）。

---

## 2. 关键设计决定（改之前先读，避免推翻重来）

### 2.1 坐标系
- 库内、比较、持久化一律 **WGS84**。
- 高德卫星瓦片是 **GCJ-02 对齐**：`lib/imagery.js::tilesForCircle` 里先 WGS84→GCJ-02 再算瓦片号；瓦片中心回推时再 GCJ→WGS。
- 深链、投影、右键复制同理（复制出去之前转 WGS84）。

### 2.2 默认空库
- v0.2.0 起不预置任何小区/目的地；DB 升级 `onupgradeneeded` 里只删旧样例 id（`c1..c12` / `d1..d3`），不动用户数据。

### 2.3 侧栏留白
- `.side` 用 `--xat-inset-top/bottom`（默认 72/24 px）让开高德自带工具条；抽屉标签跟着顶部留白走。
- `.pane` / `.tabpane` 必须是 flex 列布局 + `min-height:0`，否则详情页脚会被顶出可视区（踩过）。

### 2.4 影像检测（这块最容易被"想当然"改坏）
管线：`分绿化 → Otsu 二值化 → 开运算(5 m) → 连通域 → 片状筛选 → 打分`

- **不做水面处理**（用户决定：西安水面少，规则越少越可控，错的人工纠）。
- **只设下限，不设面积上限**：踩过的坑——最早加了「面积 ≤9000 ㎡ + 填充率 ≥0.45」，结果最明显的一大片方形阴影是一整块 **5.8 万 ㎡、填充率 0.27** 的连通域，被直接丢掉，反而标出一堆碎影。面积只在打分时封顶（`scoreAreaCapM2`）。
- 开运算是"让平房细影消失、楼栋宽影留下"的核心机制：半径 5 m ≈ 抹掉窄于 10 m 的影子。
- 打分（0~1，仅排序用）：`0.32×加权片状面积 + 0.2×最大块 + 0.14×块数 + 0.12×填充 + 0.12×相对暗度 + 0.1×受光屋顶占比`，纯绿化打折。
- 参数都在 `extension/app/lib/imagery.js` 的 `DEFAULTS`：`openRadiusM`、`minPatchAreaM2`、`minFill`、`maxAspect`、`scoreAreaCapM2`。
- **已知会错**：道路/广场/深色厂房屋顶会被当片状阴影；整幅欠曝的截图（手机翻拍）Otsu 会吃进大片暗地；公园树冠堆叠可能高分。当前定位是「粗排 + 人工看图」，不是自动判决。

### 2.5 扫描的 zoom 与覆盖
- 小区详情：z18（约 0.49 m/px），3×3 瓦片 ≈ 380 m 见方。
- 大圆扫描：**不低于 z16**（再粗就看不出楼影），瓦片数超上限时**截断覆盖半径**并在界面写明"实际覆盖半径 x.xx km"。默认 3 km 半径 → 实际只覆盖中心 1.2 km（`maxTiles: 25`）。
- 瓦片缓存进 `tiles` 表；`imagery.cache` / `imagery.clear` 两个 RPC 已存在，但**还没接到设置页 UI**（见 P1-2）。

### 2.6 右键菜单注入
- 高德 v2 是 `div.amap-menu > ul.context_menu > li.menu_item`（文案：这是哪儿 / 搜周边 / 设为地图中心点 / 清除路线）。
- 克隆它的 `li` 追加，样式天然一致；`cloneNode` 不会复制事件监听，所以不会触发高德原动作。
- 菜单懒渲染：先等 320 ms 自绘兜底，再盯 2 s，原生菜单出现就换回原生位置。
- 取坐标两条路：`map.on('rightclick')` + DOM `contextmenu` + `containerToLngLat` 兜底（右键落在覆盖物上也有效）。
- 逆地理编码借页面自带 `AMap.Geocoder`：**未登录高德时 regeo 返回 403**，此时只复制坐标（坐标足够定位）。

---

## 3. 待办（明天从这里挑）

### P0-1 把「发现」做成真正的“待定小区清单”

现状：只能看到「瓦片级」候选（z16 一张约 500 m），坐标取瓦片中心，没有聚合、没有去重、没有持久清单。目标：候选是**点**，带阴影证据与分数，可采纳/忽略，重开还在。

分三步：
1. **两段式扫描**：z16 粗扫找「有片状阴影的瓦片」→ 对这些瓦片再抓 z18 三瓦片精扫 → 用**最大那块阴影的质心**作为候选坐标（不是瓦片中心）。质心可从 `analyzeRgba` 返回的 `bandMask` 里按连通域算，或让 `analyzeRgba` 直接返回 `patches[{areaM2, cx, cy}]`。
2. **聚合去重**：相邻（≤250 m）高分瓦片合并为一个候选（加权质心 + 面积合计 + 最高分）；与 `communities` 200 m 内的候选标「已存在」，默认不进待定列表。
3. **落库 + 状态**：新建 `candidates` 表（`id, lng, lat, patchCount, areaM2, score, verdict: pending|adopted|ignored|existing, tileKeys[], updatedAt`）；发现页按状态分组；「继续扫外圈」按块续扫（利用 `tiles` 缓存，已扫的跳过）。

验收：大圆扫描后能看到候选点列表（不是瓦片缩略图列表）；相邻瓦片合并成 1 条；已收录小区附近标「已存在」；采纳后 `communities` 里多一条且坐标落在楼群上；重开浏览器清单仍在。
涉及：`background.js`（新 RPC + 表 + 聚合）、`content/ui.js`（发现页）、`manifest.json`（DB 版本升 4）、`lib/imagery.js`（返回质心）。

### P0-2 通勤时长读回（阶段 3d，让列表里的 `~` 消失）

现状：通勤是直线估算（`geo.estimateMinutes`），详情里的「去高德算」只打开深链。
要做：
1. 新增 `content/dir-readback.js`：`matches: https://*.amap.com/dir*` 与 `/ssr/dir*`，`MutationObserver` 等结果面板，正则同时匹配 `33分钟` 与 `1小时33分钟`，抓 `X公里`、换乘数；15 s 超时降级为「未读到」。
2. `background.js`：`openTab` 复用（已有），加队列（每次间隔 ≥3 s、单次上限 12、开跑前提示"将连续打开 N 个后台标签"），读回结果写 `commute` 表（`source_kind: 'page_read'`，置信度 0.8），并把 `source_url` 落库供「在高德看这条路线」。
3. `ui.js`：`pill--est` 的 `~` 前缀按「是否有 page_read 值」切换；详情里保留「在高德看这条路线」。

验收：点一次「去高德算」→ 新标签读到分钟数 → 该小区该目的地显示精确值（无 `~`）→ 重开仍在；失败时明确显示「未读到」而不是静默。
涉及：`manifest.json`（新增 content script）、`background.js`、`content/ui.js`、新增 `content/dir-readback.js`。

### P1-1 影像参数滑杆
把 `openRadiusM` / `minPatchAreaM2` / `minFill` 搬到「设置与诊断」页（存 `settings.imagery`，`imagery.area` 读取后透传 `opts`）。验收：改滑杆后重扫，叠加块明显变多/变少。

### P1-2 扫描覆盖与缓存
- 「继续扫外圈」按钮（按块推进，已扫瓦片直接命中 `tiles` 缓存）。
- 设置页显示影像缓存条数/体积（`imagery.cache` RPC 已有），并提供「清空瓦片缓存」（`imagery.clear` 已有）。

### P1-3 详情页重扫
影像加载失败时给「重试」；参数改动后允许手动「重扫这个小区」。

### P2-1 采纳候选时补行政区/板块
采纳时用页面 `AMap.Geocoder` 反查 `district`，失败留空（别阻塞保存）。

### P2-2 瓦片缓存上限
`tiles` 表按 `at` 做 LRU 上限（例如 800 张），设置页可清。

### 暂缓（原方案里已明确不做或分期）
- 自动发现（POI 周边搜索）：要 key，合规风险，暂不做。
- 影像底图人工画边界（4d）：等候选清单稳定后再评估。
- 前后端打通：后端 GeoJSON 已能导入，但备案价/去化率等字段在扩展里只显示 official 徽标，未做字段映射展示。

### 后端那条线（`backend/` + `frontend/`，本次没动）
- 备案价丰富 / 售罄分类仍是 partial（`classifier.py` 的 `unknown` 分支）。
- `东起…西至…` 地标式四至不支持，退化到 geocode buffer。
- list 页 `location_text` 解析脆弱（`西安银行` 那类）。
- 前端看板无筛选/搜索/图例；同名不同预售证分行存。

---

## 4. 验证方法（换机器后先跑这个）

### 4.1 离线单测（不需要浏览器，几秒）
```bash
cd extension/tests
npm install            # fake-indexeddb
node unit-background.mjs
```
覆盖：v1→v2→v3 迁移（只删样例、保留自录）、GeoJSON 导入与 200 m 去重、多边形质心、community.put/del、settings 合并、导入错误提示。

### 4.2 端到端（真实 Chromium + 真高德页面，约 6–8 分钟）
```bash
cd extension/tests
npm install            # playwright
# 需要一个 Chrome for Testing（Playwright 的 chromium 也行）
export XAT_CHROME=/path/to/chrome      # 不设就用 Playwright 自带 chromium
node e2e-amap.mjs
```
注意：
- 只加载 `extension/app`，不依赖打包。
- 未登录时高德会弹登录框 / baxia 验证，脚本里统一「清浮层再点」；**这些是测试环境的处理，不是产品逻辑**。
- 网络要求：`www.amap.com` 与 `webst0X.is.autonavi.com` 可达（本机测过可达；`google.com` 不可达）。

### 4.3 只验影像算法（不联网，用缓存瓦片）
`e2e-amap.mjs` 依赖网络；如果想离线调 `lib/imagery.js` 的参数，用任意 3×3 瓦片目录拼 768×768 后调 `XAT_IMAGERY.analyzeRgba(rgba, 768, 768, { mPerPx: 0.49 })`，看 `features.patches / patchAreaM2 / score`。我本地调试时用的就是这种方式（脚本未入库，可用 `jpeg-js` 十行拼图）。

---

## 5. 环境坑（换机器最容易踩的）

1. **扩展目录路径决定扩展 ID**：把 `D:\xian-commute-ext` 改名/换盘，Chrome 会当成新扩展，IndexedDB 数据就"没了"。要迁移就整体搬目录，别新建。
2. **改了文件必须「重新加载」+ 刷新高德页**：content script 不会热更。
3. **Playwright 的 Chromium 下载走 CDN 常失败**：本机用 npmmirror 镜像下的 Chrome for Testing（`https://cdn.npmmirror.com/binaries/playwright/builds/cft/...`），没有 `unzip` 时用 Python `zipfile` 解。WSL 下 `D:` 挂在 `/mnt/d`。
4. **高德反爬**：自动化访问可能弹 `baxia-dialog`；真人使用一般不会。若出现，手动过一次验证即可，不要写绕过。
5. **未登录时逆地理编码 403**：右键只能复制坐标；登录后才有地址文字。
6. **MV3 service worker 30 s 空闲会休眠**：大范围扫描要分块（当前 25–36 张/次是安全的），别一次抓几百张。
7. 提交规范：代码/注释/`AGENTS.md`/提交信息用英文，`docs/extension/*.md` 沿用中文。

---

## 6. 本次（2026-10-26）做了什么的清单

- v0.2.0：侧栏默认折叠成抽屉 + 上下留白可调；默认空库 + v2 迁移清样例；右键「复制地址」（原生菜单注入 + 兜底）；目的地粘贴定位；小区 CRUD；JSON/GeoJSON 导入；修 `.pane` flex 布局 bug；打包脚本去掉对 `zip` 命令的依赖。
- v0.3.0：卫星影像管线（瓦片抓取/缓存/拼接/GCJ 对齐）、片状阴影检测（Otsu + 开运算 + 片状筛选 + 打分）、详情与大圆扫描 UI、人工判定与「加为小区」；修「大面积阴影被上限丢掉」和「航拍阴影被当水面」两个坑；按用户判断**移除水面处理**。
- 测试：本地 `unit-background.mjs` 13/13；`e2e-amap.mjs` 在 v0.2.0 阶段 31/31、加入影像后 39/39（那两次跑的是旧影像算法；v0.3.0 只做了 smoke + 离线样例复核，**明天第一件事建议先跑一遍 e2e**）。

---

## 4. v0.4.0 阴影扫描（保存时才计算，逐瓦片绘制）

**触发时机**：进页面不计算。只有在「目的地已设 + 点保存」之后才启动
（`ui.js` 的 `settings.set` 回调里 `startScan()`）。调试入口：
页面控制台 `window.postMessage({__xat:'ui',type:'debug-scan',dest:{name,lng,lat}},'*')`，
状态回读用 `type:'debug-state'`。

**流程**（`background.js` 三个新 RPC + `lib/shadow.js`）：

| RPC | 作用 |
|---|---|
| `scan.plan` | 只算瓦片清单（z17、≤36 张、半径 ≤600 m），标记哪些已有缓存；不取图 |
| `scan.tile` | 单张瓦片：命中 `tiles.shadow` 直接返回；否则取图→分析→落库 |
| `scan.roads` | Overpass 取干道（镜像 + 重试），WGS84→GCJ 供绘制；失败不阻塞 |

**分析**（`lib/shadow.js`，纯函数）：瓦片自身 p95 当参考亮度 → 暗像素 →
开运算 5 m（剪断 10 m 以下细颈）→ 连通块丢最长边 <20 m 的碎块 →
20 m 多数投票平滑 → 保留 ≥1500 m² → 凸包（≤16 点）→ GCJ 经纬度。

**绘制**：沿用 `ui.js` 既有 canvas 叠加层。阴影多边形与路网各自做一次
`project` 批投影；**视野变化时在 `onProjectResult` 里重新投影**（否则会停在旧屏幕坐标）。
样式：填充 0.16 + 描边 1.2，只画 ≥3000 m² 的块。

**性能约束**：瓦片上限 36 张、半径上限 600 m、z 不低于 17；每张瓦片间
`await setTimeout(0)` 让出主线程；扫描期间 `freeze` 消息 → `map.setStatus()`
锁住拖动/缩放，结束后解锁。实测单张冷启动 535 ms（含下载），分析本身 33–41 ms；
36 张全缓存时整轮 2–4 s。

**缓存**：结果写在既有的 IndexedDB `tiles` 记录里（`shadow: {coverage, blobs, at}`），
与瓦片 blob 同生命周期；设置页的「清空瓦片缓存」会一并清掉。

**已知问题**：Overpass 频繁 502，路网偶尔画不出来（已加重试与镜像，仍属尽力而为）；
高德未登录时页面中间的登录弹窗会挡住地图中心。

---

## 5. v0.5.0 转成自绘地图页（不再注入高德）

**为什么改**：把阴影/路网当成图层塞进 amap.com 的页面，缩放、拖动、重投影都得
跟着别人的地图实例走——实测拖动地图时阴影轮廓会固定在窗口上（`view-change`
在拖拽过程中不触发，重投影跟不上）。既然数据是我们自己算的，界面也自己做。

**入口**：`extension/app/map.html`（popup 里「打开阴影地图」直接开整页）。

| 文件 | 作用 |
|---|---|
| `app/map.html` | 面板 + canvas 地图容器 |
| `app/map.js` | 面板交互、调 `scan.*` RPC、把多边形/线喂给地图 |
| `app/lib/slippymap.js` | 极简 slippy map：canvas 瓦片渲染、拖动/滚轮缩放、多边形与线图层 |

**为什么不用 MapLibre**：MV3 的 CSP 不允许 `blob:` worker，MapLibre v4 要走
CSP 构建 + `setWorkerUrl`；而我们只需要「瓦片 + 多边形 + 线」，自绘 ~300 行、
零依赖、零 CSP 风险。

**坐标系**：全程 GCJ-02。高德卫星瓦片按 GCJ 对齐，`lib/shadow.js` 输出的多边形
也是 GCJ，所以地图不需要任何纠偏（旧注入方案里 `geo.ts` 那套转换在这里用不上）。

**集成方式**：`scan.plan` → 逐张 `scan.tile`（命中 `tiles.shadow` 直接返回）→
多边形逐块追加进图层。扫描期间地图仍可拖动缩放（自己的渲染循环，不存在被冻结
的问题）。

**路网不画**：卫星底图本身就有路网，再叠一层 OSM 干道是多余的（而且 Overpass
经常 502、要等 30–60 s）。`scan.roads` RPC 保留给旧的注入页，新页面不调用；
`slippymap.js` 的 `setLines` 也留着，以后真需要再开。

**实测**（锦业路 36 张 z17 瓦片）：2.3–4 s 出齐 67 块阴影，零报错。

**旧注入代码**：`content/ui.js`、`content/map-hook.js` 保留，但不再是主入口；
`shadow_clean`/`scan.*` 这些 RPC 两边共用。

---

## 6. v0.6.0 侧边栏搬到地图页

`map.html` 现在是完整界面，不再依赖注入到高德页面的那份 UI。

**面板**（左）：底图切换（卫星 / 经典）、目的地列表（添加/删除/点击定位）、
扫描（搜索半径 km + 进度 + 瓦片/缓存/阴影块/耗时）、小区列表（按到第一个目的地的
直线通勤分钟排序，点击定位）。

**地图**：卫星底图 `webst0x…style=6`，经典底图 `webrd0x…style=8`，两者都是 GCJ-02，
和阴影多边形同一坐标系，切换不需要纠偏（`slippymap.setBasemap()` 会清瓦片缓存重绘）。

**右键取点**：`slippymap` 抛 `contextmenu` 事件 → 页面弹自绘菜单，五项：
复制 WGS84 / 复制 GCJ-02 / 设为目的地 / 加为小区 / 在此扫描。坐标显示在菜单顶部，
复制走 `navigator.clipboard`，失败时退化为 toast 显示。

**图层**：`setMarkers` 画小区点（绿色）与目的地图标（按交通方式着色 + 名称），
`setCircle` 画搜索圆（虚线）。

**已知限制**：地址文本不能离线地理编码——输入框只认「经度,纬度」；要按地址定位请
在地图上右键选点。以后要支持地址，得接一个地理编码服务（高德 Web 服务 key 或
Nominatim，后者需要额外 host 权限）。

**调试入口**：`window.__xatMap`（地图实例）、`window.__xatState`（页面状态）。

---

## 7. v0.7.0 地图页换成右侧抽屉布局

上一版是自造的左侧简易面板，不是注入版那套界面。这一版直接复用 `content/ui.css`：

| 元素 | 类名 | 说明 |
|---|---|---|
| 折叠标签 | `.drawer` | 右边缘竖排「西接通勤」+ 小区数 |
| 抽屉 | `.side` / `.side.is-hidden` | 344 px，右上角 `›` 收起 |
| 条件行 | `.condline` | 「N 个目的地 · 步行 · X km」，点击跳目的地页 |
| 标签页 | `.tabs` / `.tabpane` | 结果 / 目的地 / 扫描 |
| 条目 | `.entry` + `.pill` + `.badge` | 序号、名称、来源标签、每个目的地的通勤药丸、最差时长 |
| 排序 | `.seg` | 通勤 / 价格 |

**踩到的坑**：`slippymap` 构造时无条件 `el.style.position = "relative"`，把页面里
`#map { position: fixed; inset: 0 }` 覆盖掉，结果容器高度为 0、canvas 不可见、
右键也接不到事件（`elementFromPoint` 返回 body）。已改成「仅在 static 时兜底」。

**验证**（headless Chrome + 真实 amap 瓦片）：折叠/展开、右键设为目的地、扫描
58 块阴影 2.2 s、零报错。

---

## 8. v0.8.0 地图页直接跑注入版 UI

v0.7 的抽屉虽然样式一样，但内容是我重写的简化版（没有详情页、录入表单、发现页、
泳道、过滤条件）。这一版改成**直接执行 `content/ui.js`**，只补一层适配器：

| 文件 | 作用 |
|---|---|
| `app/map.html` | 只剩 `<div id="map">` + 脚本加载顺序 |
| `app/lib/hook-shim.js` | 冒充 MAIN world 的地图钩子 |
| `app/lib/slippymap.js` | 自绘底图（ui.js 不画底图，只画叠加层） |

**适配的消息**（与 `content/map-hook.js` 同协议）：

| ui.js 发 | shim 回 |
|---|---|
| `project` | `project-result`（GCJ 经纬度 → 屏幕坐标，带容器 rect） |
| `get-info` / `ping` | `map-info` / `pong` |
| `fit` | 设 center/zoom 后回 `view-change` |
| `freeze` | `slippymap.setInteractive()` |
| `geocode` | `geocode-result{ok:false}`（离线无地理编码） |

shim 主动发 `map-ready` 和 `view-change`，于是状态胶囊、叠加画布、投影全部生效。
右键 → shim 发 `ctx-copy{gcj}` → ui.js 自己算 WGS84、复制、弹 toast（和注入版一模一样）。

**阴影扫描**：ui.js 不认识阴影，由 shim 负责。它包了一层 `chrome.runtime.sendMessage`，
侦测到 `settings.set` / `community.put` 成功就按当前目的地重算圆并逐瓦片扫描，
多边形画在 ui.js 叠加画布的**下面**（底图之上）。

**底图切换**：shim 往 `#xat-root` 的 Shadow DOM 里插一个 `.seg`（卫星/地图），
样式与侧栏同源。

**验证**：Shadow DOM 挂载、抽屉、三个标签页（结果/发现/待补）、状态胶囊「已连接地图」、
右键复制 toast、底图切换、阴影 53 块，全部通过，零异常。

---

## 9. v0.9.0 阴影改成像素掩膜（修「看着歪」）

**症状**：地图上的阴影像一块块方格，和斜向街区比着像贴歪了。

**排查**：
1. 先验几何：`lib/shadow.js` 的 `pxToGcj` 与 `slippymap` 的投影做往返，误差 0.5 px（像素中心）。
2. 再验分析：在真实瓦片上涂一个已知位置的 64×64 黑方块，输出多边形的 GCJ 包围盒
   与 `pxToGcj` 期望值相差 **0.000005°（约 0.5 m）** —— 坐标是准的。
3. 真正原因两条：
   - **每张瓦片各自套凸包**，相邻瓦片的 hull 边缘拼成网格，看着就是方格；
   - ratio 0.40 在密集区把 40–70% 的像素判成暗（实测该片区中位 56.9%），
     一个 blob 直接等于整块瓦片。

**改法**：
- `analyzeTile` 额外返回 `maskRgba`（最终保留像素的 256×256 位图）。
- `scan.tile` 把它编码成 PNG dataURL（`maskPng`）随结果返回并按瓦片缓存。
- `slippymap.setMaskTiles()` 按瓦片屏幕矩形 `drawImage` 贴上去——和底图瓦片同一套
  几何，缩放平移自动对齐，不再有多边形拼缝。
- 阈值可调：`scan.tile({..., ratio})`，侧栏适配层 `SHADOW_RATIO = 0.26`
  （该片区实测：0.40→中位 56.9%，0.26→大部分瓦片 5–25%）。

**注意**：改了 ratio 后旧缓存不再命中（`shadow.ratio` 与请求不一致时重算）。

---

## 10. v0.10.0 整圆覆盖 + 路网只切不画

**问题 1：范围调大后还是只有 36 块瓦片**
- `scan.plan` 原来用 `radiusForTiles(zoom, cap)` 把半径裁到「cap 张瓦片能盖住的范围」，
  适配层还写死 `Math.min(600, radius)`。两处都去掉了。
- 现在：**按圆算全部瓦片**，瓦片数超上限时**降 zoom**（z18→z17→…→z12）而不是缩半径；
  `maxTiles` 上限放到 400，返回 `truncated` 标记。
- 实测（伟业公馆）：半径 0.5 km → z18 / 81 张；1 km → z18 / 324 张；2 km → z17 / 324 张。
- 配套：扫描时右下角出现进度胶囊「阴影 128/324 · z17 · 点击取消」（插在同一个 Shadow DOM）。

**问题 2：路网还在被画出来**
- 路网现在**只当剪刀**：`slippymap.setRoadCuts()` 把折线存下来，画掩膜时先画到离屏画布，
  再用 `globalCompositeOperation = "destination-out"` 沿路网擦出 ~26 m 宽的走廊，
  最后整张贴回主画布。路本身一个像素都不显示。
- 路网由适配层在扫描开始时并行取（`scan.roads`，Overpass，慢但失败不影响阴影）。

**验证**：0.6 km 半径 → 121 张掩膜瓦片、83 条道路剪切线，无异常；截图见
`docs/extension/screenshots/v0.10-road-cut-mask.png`。

---

## 11. v0.11.0 描边恢复 + 缓存版本号 + 手动清缓存

**描边为什么没了**：v0.9 为了修「方格/歪」把凸包多边形换成了像素掩膜贴图，贴图只有半透明
填充、没有边，所以看起来是实心色块。现在在掩膜位图上用**形态学梯度**（原图 8 个方向各偏移
1 px 画一遍，再 `destination-out` 减掉自身）预生成 1 px 边界，绘制时「填充 alpha 0.26 +
边界 alpha 0.95」，观感和以前的红框轮廓一致，但形状是真实像素边界。

**缓存版本号**：`background.js` 里 `SHADOW_CACHE_V = 2`。记录里存 `shadow.v`，
不匹配就重算——改阈值/改绘制方式后不会再出现新旧混显。`imagery.cache` 会报
`staleShadow`（过期条数）。

**手动清缓存**（设置与诊断页 → 「卫星 / 阴影缓存」）：

| 按钮 | 作用 |
|---|---|
| 刷新统计 | 瓦片数/体积、含阴影张数、过期张数 |
| 只清阴影（保留瓦片） | 逐条删 `shadow` 字段，瓦片图保留，重扫不用重新下载 |
| 清空瓦片+阴影 | `imagery.clear`，全删，下次重新下载 |

**排错提醒**：替换 `D:\xian-commute-ext` 后必须去 `chrome://extensions` 点刷新，
否则 Chrome 还在跑旧的 service worker，会出现「新旧两版同时存在」的错觉。

---

## 12. v0.11.1 修右键复制贴回高德偏移（坐标系）

**症状**：插件地图里右键复制坐标 → 粘到高德 → 位置往西北偏约两个街区。

**原因**：`ui.js` 的 `onCtxCopy` 把地图上的 GCJ-02 坐标**转成 WGS84 再复制**，
而高德搜索框按 GCJ-02 理解数字坐标。西安的 GCJ 相对 WGS 偏东偏南约 500 m，
把 WGS 当 GCJ 往后贴，就落在真实位置西北方向——方向、量级都对得上。

**修法**（`content/ui.js`，注入版和地图页共用这一份）：

| 方向 | 之前 | 现在 |
|---|---|---|
| 右键复制 | GCJ → WGS84 → 复制 WGS84 | 直接复制 **GCJ-02**（高德/腾讯都按这个系） |
| 粘贴解析 `parseCoords` | 原样当作 WGS84 入库 | 按 **GCJ-02** 理解，`gcj02ToWgs84` 后入库 |

库内、接口、导出仍然是 WGS84，不变。往返实测误差 **0.64 m**（来自反算的近似）；
浏览器里实点右键验证：点击处 GCJ (108.880017, 34.194719) == 复制的文本，误差 0 m。

**注意**：历史数据不用清洗——旧版复制和解析都在 WGS84 体系内，库里的坐标一直是对的，
错的只是「贴到高德」这一步。

---

## 13. v0.12.0 阴影聚类 + 高德 POI 反查

**流程**：整圆扫描 → 掩膜按瓦片贴图 → 路网擦除 → **聚类** → 每片质心 → 高德 POI 反查 → 写入小区库 → 面板刷新。

| 新增 | 说明 |
|---|---|
| `lib/shadow-clusters.js` | 把每张掩膜按 1/4 分辨率累加到一张画布（z17 下约 4 m/格），用同一套路网折线 `destination-out` 擦出走廊，再做 4 连通域标记；丢掉 < 1500 m² 的碎块，输出每片质心（GCJ）与面积 |
| `background.js` → `poi.nearby` | 高德 Web 服务周边搜索（`types=120302` 小区），入参 GCJ，返回 name/address/district/location/distance |
| `settings.amapKey` | 设置页新增「高德 Web 服务 key」，只存本机 IndexedDB |
| `content/ui.js` → `data-changed` | 聚落写入后由适配层发消息，ui.js 重新 `boot` + `compute` + `render`，不用刷新页面 |

**配额控制**：一次最多查 12 片；同名去重（本次已加 + 库里已有）；每片查 5 个候选、取最近的。

**实测**（纬业公馆一带，0.5 km）：写入 12 个真实小区名（中建·国熙台、响塘德苑、唐兴花园、盛景园、恬静园、枫叶新都市A区 …），面板显示「POI 发现」徽标，通勤分钟照常计算。

**已知**：POI 不带价格/面积，所以列表里显示「未录入」，且默认落在「不符合过滤」里（勾选底部「显示不符合过滤的小区」可见）。

---

## 14. v0.12.1 修「保存后多画一层红框半透明阴影」

**症状**：打开页面加载实心阴影（掩膜），点保存又叠了一层红框半透明阴影。

**日志证据**（用户导出）：

```
09:39:39  阴影扫描完成 {tiles:36, cached:0, failed:0, blobs:58}      ← 旧路径
09:39:42  [hook] 阴影扫描完成 {blocks:142, tiles:306, zoom:18}        ← 新路径
```

**原因**：`content/ui.js` 里还留着 v0.4 时期的「保存设置后自动扫描」：
`setTimeout(() => startScan(), 60)`。那个 `startScan` 是注入版的老流程（`scan.plan` 固定 36 张），
它把结果画在 ui.js 自己的叠加画布上（`drawScanLayer`，半透明填充 + 描边）。
于是保存一次跑两条扫描、画两层。

**修法**：
1. 删掉保存后的旧触发（阴影扫描统一由 `lib/hook-shim.js` 负责：整圆 + 掩膜 + 聚类）。
2. `startScan()` 在有适配层（自绘地图页）时**直接委托**给 `window.__xatShim.scan()`；
   注入版没有 `__xatShim`，仍走老逻辑——两边的行为不会互相污染。

**顺带从日志看到的**：
- `POI 反查失败 {"error":"还没配高德 key"}` → 用户那台机器没填 key，聚类能跑但没有名字。
- `路网已取回 {"ways":0}` 出现过两次（Overpass 返回空），不影响阴影，只是这次没有切割。

---

## 15. v0.12.2 内置高德 key + 聚类等掩膜就绪

**key 分工**（三个别混用）：

| 变量 | 值来源 | 用途 |
|---|---|---|
| `AMAP_WEB_KEY` | 后端采集 key | 后端采集边界、**扩展 POI 反查**（`restapi.amap.com`） |
| `AMAP_JS_KEY` + `AMAP_JS_SECURITY` | web 底图 key + 密钥 | 只在浏览器端用 JS API 时需要；我们目前用栅格瓦片，用不到 |

- `background.js` 新增 `DEFAULT_AMAP_KEY`（= 采集 key），设置页留空时直接用；
  `poi.nearby` 现在是 `settings.amapKey || DEFAULT_AMAP_KEY`。
- `.env` 已填 `AMAP_JS_KEY` / `AMAP_JS_SECURITY`，`.env.example` 里补了三个 key 的说明。

**修聚类空转**：缓存全命中时扫描几毫秒结束，`clusterAndLookup` 在掩膜 dataURL
`onload` 之前就跑，拿到 0 张图直接 return（面板没结果）。现在先等最多 4 秒直到所有
掩膜就绪，超时才放弃并写一条 warn 日志。

**实测**：伟业公馆 0.25 km → 3 张掩膜 → 3 片聚类 → 写入 12 个真实小区
（中建·国熙台、枫叶新都市A区、中华世纪城B/C/D/E区、紫薇臻品…），面板「POI 发现」徽标正常。

**注意**：结果列表默认只显示**落在搜索圆内**的小区（`x 在范围内`），半径 0.25 km 时
只有 1 个在圈内是正常的；把半径调大能看到更多。

---

## 16. v0.13.0 选对小区名 + 多边形覆盖阴影

**问题 1：查回来的是「高新云璟小区驿站」而不是「金辉·高新云璟」**
- 高德把驿站也标成 `商务住宅;住宅区;住宅小区`，按 `types` 过滤不掉（实测同一点返回 6 条，
  其中就有驿站）。
- 只按名字打分也不行：244 m 外的「大寨子村小区」名字加分后压过 70 m 外的真小区。
- 改成：**先剔除子设施，再取最近**。`POI_BAD` 覆盖驿站/快递/门/停车/物业/超市/幼儿园/学院/
  药店/银行/餐厅/居委会/岗亭/充电/单元/栋…；剔除后在 ≤150 m 内取最近；
  距离相差 <40 m 时再偏向名字像小区的（`POI_GOOD`）。
- 实测你给的点 `108.866154,34.240929`：驿站 −48.3 分被剔除，`金辉·高新云璟`（70 m）选中。

**问题 2：想用小区多边形覆盖阴影**
- 高德 POI 接口**不返回小区边界**（只有点、地址、类型）。所以多边形来自**阴影聚类自身**：
  `shadow-clusters.js` 增加 Moore 邻域轮廓跟踪 + Douglas–Peucker 简化（ε=1.6 格 ≈ 6 m），
  每片输出 `pts`（GCJ）。
- 识别出名字的片区：
  1. `community.footprint` 存进库里（GCJ 环，最多 300 点），重开页面 `restoreFootprints()` 画回；
  2. 地图上画成蓝色半透明 + 描边 + 名称（标签画在最大环的质心）；
  3. 同一片区域从阴影掩膜里 `destination-out` 挖掉——即「多边形覆盖阴影」；
  4. 同名小区由多片阴影组成时合并成多环，一次标签。
- `normalizeCommunity` 新增 `footprint` / `footprintSource` 字段（原来会被丢弃）。

**实测**：`108.866154,34.240929` 半径 0.4 km → 12 个小区全部带多边形（8–24 点），
「金辉·高新云璟」排在第一位，圆圈内阴影被多边形替换。

---

## 17. v0.14.0 用高德站内接口取小区边界（mining_shape）

**接口**：`https://amap-pc-ssr.amap.com/ssr/api/getPoiDetail?id=<poiId>`

```json
{"code":1,"data":{"base":{"name":"天朗·蓝湖树","x":"108.870085","y":"34.235333"},
 "spec":{"mining_shape":{"shape":"108.871977,34.237104;108.872135,34.235037;…"}}}}
```

`data.spec.mining_shape.shape` 就是小区边界（`;` 分隔的 `lng,lat`，GCJ-02）。POI id 与
Web 服务 REST 的 id 是同一套（金辉·高新云璟 = `B0FFIW5PO3`，两边一致）。

**反爬**：直接 curl 会返回 HTML 或 `FAIL_SYS_USER_VALIDATE`（需要站点 JS 生成的
`bx-ua`/`x-dc` 指纹头）。所以实现在 **真实高德标签页的 MAIN world** 里发 XHR：
`chrome.scripting.executeScript({world:"MAIN"})`，站点自己的 XHR 钩子会补头。

**实现**（`background.js` → `poi.polygon`）：
1. 找现有 `https://www.amap.com/*` 标签页；没有就后台开一个（`active:false`）；
2. MAIN world 发 XHR 取 `getPoiDetail`，解析 `mining_shape.shape`；
3. 标签页复用，2 分钟没用再关；两次被拦则本次会话不再尝试（`polyBlocked`）；
4. 失败返回 `{ok:false}`，调用方回退到阴影聚类轮廓。

**侧栏适配层**：`footprintSource` 会是 `amap-getPoiDetail`（成功）或 `shadow-cluster`（回退）。

**踩的坑**：`poly` 变量在声明之前被 `fp.rings.push(poly)` 用了，TDZ 报错被外层 catch 吞掉、
直接 `break`，导致一片都加不进去（表现为「扫描完成但面板为空」）。已把取多边形提到前面。

**验证**：无头环境被验证码挡（`{ok:false, reason:"blocked"}`），回退路径正常——
11 个小区全部拿到 `shadow-cluster` 轮廓。真实浏览器（有登录会话）应走到 `amap-getPoiDetail`。

---

## 18. 交接快照（v0.14.0）

### 18.1 现在跑通的链路

```
设目的地（面板/右键）
      ↓  保存时触发（hook-shim 包了 chrome.runtime.sendMessage 侦测 settings.set / community.put）
scan.plan   整圆瓦片（不裁半径，太多就降 zoom），z18→z12
      ↓
scan.tile   逐张瓦片 → lib/shadow.js 分析 → 返回 maskPng（256×256 红色掩膜）
      ↓       掩膜按瓦片贴图（slippymap.setMaskTiles），比凸包精确
路网         Overpass 折线 → destination-out 擦 26 m 走廊（只切不画）
      ↓
聚类         lib/shadow-clusters.js：1/4 分辨率累加 → 4 连通域 → Moore 轮廓 → DP 简化
      ↓
命名         poi.nearby（高德 Web 服务，types=120302）→ pickPoi 剔除子设施取最近
      ↓
边界         poi.polygon → 站内 getPoiDetail → data.spec.mining_shape.shape
      ↓        成功=amap-getPoiDetail；失败回退=shadow-cluster（阴影轮廓）
落库         community.put({name, footprint, footprintSource, sources:['poi']})
      ↓
面板         post('data-changed') → ui.js reloadData() → 列表刷新
```

### 18.2 文件地图（extension/app）

| 文件 | 职责 | 改动风险 |
|---|---|---|
| `map.html` | 只有 `#map` + 脚本加载顺序 | 低（顺序：geo → logger → imagery → slippymap → shadow-clusters → hook-shim → content/ui.js） |
| `lib/hook-shim.js` | 冒充 map-hook，让 `content/ui.js` 以为自己挂在高德上；负责阴影扫描/聚类/POI/边界 | **高**，改这里最容易连锁 |
| `lib/slippymap.js` | 自绘 GCJ 瓦片底图 + 掩膜 + 路网剪切 + 小区多边形 | 中 |
| `lib/shadow.js` | 单瓦片阴影分析（p95 参考 → ratio → 开运算 → 平滑 → maskRgba） | 中，改了要升 `SHADOW_CACHE_V` |
| `lib/shadow-clusters.js` | 掩膜累加 + 连通域 + 轮廓跟踪 + DP 简化 | 中 |
| `content/ui.js` | **注入版和地图页共用**的侧栏（列表/详情/录入/设置/canvas 叠加） | 高（两边都受影响） |
| `background.js` | RPC 总入口：scan.plan/scan.tile/scan.roads/poi.nearby/poi.polygon/imagery.* | 中 |

### 18.3 关键约束（新 agent 必读）

1. **坐标系**：库内一律 WGS84；瓦片/多边形/POI 一律 GCJ-02。
   - 右键复制输出 **GCJ-02**（粘回高德才对），`parseCoords` 按 GCJ 解析再转 WGS84 入库。
   - `slippymap` 的 `project/center` 全部按 GCJ 理解。
2. **高德站内接口有反爬**：`www.amap.com/service/poiInfo`、`amap-pc-ssr.amap.com/ssr/api/getPoiDetail`
   需要站点 JS 生成的 `bx-ua`/`x-dc` 指纹头，裸请求返回 HTML 或 `FAIL_SYS_USER_VALIDATE`。
   只能在**真实 amap 标签页的 MAIN world** 里发 XHR（`chrome.scripting.executeScript({world:'MAIN'})`）。
   无头/机房 IP 会被直接判定为验证码，**本地无法端到端验证这条路径**。
3. **阴影缓存带版本号**：`SHADOW_CACHE_V`（background.js）。改算法/改绘制就 +1，旧缓存自动失效。
   另有 `settings.ratio` 与请求不一致时重算的逻辑。
4. **扫描不能裁半径**：`scan.plan` 按圆算全部瓦片，瓦片数超 `maxTiles` 时**降 zoom**，不缩半径。
5. **路网只切不画**：`setRoadCuts()` 存折线，画掩膜时 `destination-out` 擦走廊；`setLines` 是死代码。
6. **侧栏是复用的**：地图页直接跑 `content/ui.js`，通过 `window.postMessage({__xat:'main'|'ui'})`
   与 `hook-shim` 通信。协议与 `content/map-hook.js` 一致，改一边要同步另一边。

### 18.4 已知缺陷

- 聚类质心落在阴影上，POI 匹配是「最近的小区」，**密集区可能张冠李戴**（可用 `footprint` 人工修正，未做）。
- `poi.polygon` 每查一次要发一次站内请求，12 片 ≈ 20 秒额外开销；被拦两次后本会话熔断。
- 阴影阈值 `SHADOW_RATIO = 0.26` 是**按西安这一批影像定的**，换季节/换城市要重调。
- 掩膜是逐像素的，小区边界来自高德；两者叠在一起时，阴影挖洞用的是**聚类轮廓**（不是高德边界），
  可能留一点边角。
- POI 不带价格/面积，列表里显示「未录入」，默认落在「不符合过滤」里。

### 18.5 TODO（按优先级）

**P0**
- [ ] 在真实浏览器验证 `poi.polygon` 是否真的拿到 `mining_shape`（看日志「拿到小区边界」），
      并确认 `footprintSource = amap-getPoiDetail`。
- [ ] 小区边界与阴影挖洞统一：拿到高德边界后，用**高德边界**而不是聚类轮廓去挖阴影。
- [ ] 人工修正入口：点小区 → 拖动/重画多边形 → 存回 `community.footprint`。

**P1**
- [ ] 聚类质心改为「阴影指向小区」的匹配（用 footprint 中心 + POI 中心双向校验）。
- [ ] 一次扫描只查面积最大的前 N 片（减少站内请求与 POI 配额消耗）。
- [ ] 结果列表区分「POI 发现」与「手工录入」，给个一键清空发现项。

**P2**
- [ ] 删除注入版遗留：`content/map-hook.js` 的右键菜单注入、`scan.roads` 的老渲染路径。
- [ ] 阴影阈值做成面板滑杆（`SHADOW_RATIO` 目前是常量）。
- [ ] 底图缓存清理按钮已做（设置页），可以考虑加「只清某区域」。

### 18.6 验证方法（本仓库惯例）

```bash
# 语法
node --check extension/app/lib/hook-shim.js
for f in extension/app/lib/*.js extension/app/content/*.js; do node --check "$f"; done

# 无头跑地图页（扩展 ID 由路径决定，换目录要改）
CHROME=~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
$CHROME --headless=new --no-sandbox --disable-gpu --window-size=1440,900 \
  --user-data-dir=/tmp/prof --remote-debugging-port=9333 \
  --disable-extensions-except=$PWD/extension/app --load-extension=$PWD/extension/app \
  "chrome-extension://boodepmkkopchbjeepbkifbhbjcachfb/map.html"

# 打包 + 部署到 Windows D 盘
bash scripts/pack_extension.sh
python3 -c "import zipfile;zipfile.ZipFile('dist/xian-commute-ext-v0.14.0.zip').extractall('/mnt/d')"
```

- 扩展 ID 由**加载目录的绝对路径**决定，换目录会变，IndexedDB 也会跟着变。
- 替换 `D:\xian-commute-ext` 后必须在 `chrome://extensions` 点刷新，否则旧的 service worker 继续跑，
  会出现「新旧两版同时生效」的假象。

---

## 19. v0.15.0 砍掉阴影识别，改成「圆 → 周边小区」

**决定**：找一个片区里有什么小区，不需要先算阴影——阴影只是「这片可能有高层/连片小区」
的代理，误差大且要标定阈值。直接用高德的「周边」搜索更准、更省事。

**新链路**（`lib/hook-shim.js` 全部重写，shim-2）：

```
目的地 → 圆心（所有目的地中点）+ 半径（最远目的地 + radiusKm）
      ↓
poi.around  →  https://www.amap.com/service/poiInfo?query_type=RQBXY
                &keywords=小区&longitude=&latitude=&range=&city=610100
      ↓         站内接口被反爬拦时，回退 restapi.amap.com/v3/place/around?types=120302
      ↓
去重写入 community.put({name, lng, lat, district, sources:['poi'], poiId, poiDistance})
      ↓
post('data-changed') → ui.js reloadData() → 面板列表（按到目的地的通勤排序）
```

**站内接口返回结构**（用用户 cookie 实测）：

```json
{"data":{"poi_list":[{"name":"中南·上悦城","id":"B0FFJGYPL4","address":"…",
  "longitude":"108.800100","latitude":"34.294052","distance":"160.01",
  "typecode":"120302","shape_region":"108.797953,34.297848,108.802027,34.290433"}]}}
```

`shape_region` 只是外接矩形（minLng,minLat,maxLng,maxLat），**不是小区边界**；
真边界仍要 `getPoiDetail` 的 `mining_shape`（`poi.polygon` 保留，但不再自动批量调）。

**实测**（安泰路 108.800142,34.292615，半径 1 km）：
站内被反爬拦 → 回退 Web 服务，返回 14 个小区并写入面板
（中南·上悦城四期 146 m、二期 150 m、三期 151 m、中南·上悦城 159 m、沣华熙郡 383 m …）。

**同时删掉的东西**：
- `map.html` 不再加载 `lib/shadow-clusters.js`；页面不再画掩膜/路网剪切/小区轮廓。
- 自动扫描不再由 `community.put` 触发（只认 `settings.set`），避免自己写自己递归。
- `lib/shadow.js`、`lib/shadow-clusters.js`、`background.scan.*` **保留但不再被地图页使用**，
  作为参考实现（注入版「发现」页仍在用 `scan.plan/scan.tile`）。

**新增/改动 RPC**：
| RPC | 说明 |
|---|---|
| `poi.around` | 周边小区（站内 RQBXY → Web 服务回退），返回 `{ok, source, range, count, pois[]}` |
| `amapInternalFetch(url)` | 复用「真实 amap 标签页 + MAIN world XHR + 熔断」，`poi.polygon` 也改用它 |
