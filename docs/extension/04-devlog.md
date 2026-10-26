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
