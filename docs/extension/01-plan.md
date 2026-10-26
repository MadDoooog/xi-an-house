# 西安通勤找房插件 — 阶段 1 方案（Plan）

> 状态：**draft-5（宿主改为注入高德官网），待你最终确认** | 不含代码
> 本文件是阶段 1 的交付物；阶段 2（UI）、阶段 3（最小闭环）、阶段 4（完善）依次展开。


## 0.0.1 draft-4 变更摘要（阶段 2 UI 改版后回填）

阶段 2 的 UI 讨论推翻了三处 v1 假设，方案以本节为准，与后文冲突时以本节优先：

| 原假设（draft-3） | 现方案（draft-4） | 影响 |
|---|---|---|
| 双工作地点 A 公司 / B 家，各自设通勤上限 | **目的地列表**（1~5 个，①②③），每个目的地自带一种通勤方式；**取消通勤上限** | 通勤从"硬约束"降为**排序主指标**（按最长通勤升序），不再有达标/临界/超限判定 |
| 可行区域 = A、B 连线为直径的圆 | **1 个点画圆；N 个点取最小外接圆（MEC）+ 扩展半径 R km**（R 由滑杆给，0~15 km） | 空间筛选改由半径承担；`core/region.ts` 增加 `minEnclosingCircle()` |
| 顶栏 + 左侧档案栏 + 右侧详情抽屉 | **无顶栏**；地图全屏；**右侧边栏三态**（列表 344px / 编辑 528px / 详情 620px 两列） | 组件结构见 `02-ui.md`；数据结构见 `data-dictionary.md` §2、§2.5 |

**这条改动最需要你留意的后果**：去掉上限后，"通勤不合格"这个筛选动作消失了，结果集可能从几十个涨到几百个（接入 POI 发现之后），而每个小区要对 N 个目的地各算一次路。所以草案里加了两道闸：**半径先剪枝** + **只对通勤最短的前 10 个调真 API、其余用直线估算**（详情里可单独重算）。

---


## 0.0.2 draft-5 变更摘要：宿主改为注入高德官网（推翻 D3/F3）

你提出"只在高德官方地图界面加载，选中小区后把起终点交给高德"，实测后确认可行，代价与收益如下。**与后文任何冲突，以本节为准。**

### 实测结论（2026-03，全部在真实 Chromium 里跑过）

| 项 | 结论 |
|---|---|
| 深链是否需要 API key | **不需要** |
| 是否消耗配额 | **不消耗** |
| **能否 hook 到 `AMap.Map` 实例** | **✅ 能**。`Object.defineProperty(window,'AMap',{set})` 拦截到库加载，再包一层 `AMap.Map` 构造函数，抓到实例：`zoom=13.97`、`center=[108.909,34.242]`、`lngLatToContainer([108.965,34.245]) = {x:1338,y:416}` |
| `fid/did`（POI id）是否必需 | **不必需**。编造名称 + 经纬度即可算路；但带 `fid=` 空串会**失败**（所以干脆不要带这个键） |
| 什么是必需的 | **经纬度**（`flat/flon/dlat/dlon`）。只有名称没有坐标 → 不算路 |
| `policy` | 可省，带不带都算 |
| 未登录能否算路 | **能**（页面上有登录按钮，但不拦截算路） |
| SSR HTML 里有没有时长 | **没有**（`分钟` 0 次）→ 必须等前端渲染后读 DOM |

### 已验证的算路 URL 规格

```
https://www.amap.com/ssr/dir
  ?fname=<出发地名称>&flat=<纬度>&flon=<经度>
  &dname=<目的地名称>&dlat=<纬度>&dlon=<经度>
  &type=<0驾车|1公交|2步行|3骑行>
  [&policy=1]
```

实测四种模式的返回（都在结果面板文本里，可直接读）：

| type | 模式 | 实际读到的内容 |
|---|---|---|
| `0` | 驾车 | `33分钟` `10.5公里` `途经：环城南路东段辅路 丰庆路…` |
| `1` | 公交 | `1小时1分钟` `步行 2.3公里` `11 4号线 3号线 23` `8站 • 3元 • 12.7公里` → **含换乘与票价** |
| `2` | 步行 | `2小时5分钟` `9.4公里` |
| `3` | 骑行 | `52分钟` `9.5公里`（有"自行车/电动车"子选项） |

**两个必须注意的坑**

1. **坐标系**：高德的 `flat/flon` 是 **GCJ-02**。我们库内是 WGS84，拼 URL 前**必须转 GCJ-02**，否则端点偏 300–500m。复用 `frontend/src/geo.ts` 的转换函数。
2. **时长格式不统一**：可能是 `33分钟`，也可能是 `1小时33分钟`。读回的正则必须同时匹配两种。

### 架构变化

| | draft-4（独立地图页） | draft-5（注入高德） |
|---|---|---|
| 主界面宿主 | 扩展自己的全屏地图页 | **高德官网页面** + 注入的右侧栏 |
| 地图与瓦片 | 自建 Leaflet + OSM/天地图 | **不需要**（高德自带） |
| API key / 配额 / CORS 代理 | 需要 | **全部不需要** |
| 坐标 | WGS84 ⇄ GCJ-02 双向 | 仅单向（画点时 WGS84 → GCJ-02） |
| 通勤时长来源 | 路径规划 API 批量算 | **深链新标签 + 读回 DOM**（来源标 `page_read`） |
| 排序依据 | 真实 API 时长 | 有读回值的按真实值，没有的按直线估算（`~`） |
| content script | 无 | **`*.amap.com`，两个 world** |
| 数据存储 | 扩展页 IndexedDB | **background 的 IndexedDB**（避免绑在 amap.com origin 上） |

### 三个进程/上下文

```
① MAIN world content script（必须，拿地图投影）
   hook AMap.Map 构造函数 → 拿到 map 实例
   → map.lngLatToContainer(gcj02) 算出像素坐标
   → window.postMessage 给 ②

② ISOLATED world content script（我们的 UI）
   右侧栏：条件摘要 / 列表 / 刻度尺 / 详情 / 发现 / 待补
   canvas 覆盖层（按 ① 给的投影画点）
   点「算通勤」→ postMessage 给 ③

③ background service worker
   持有 IndexedDB（小区/通勤/队列/配额无关）
   创建与关闭算路标签、等待加载完成、接收读回结果
```

### 通勤获取流程（单点 & 队列）

1. 侧栏点某目的地旁的「算通勤」。
2. ③ `chrome.tabs.create({ url: 深链 })`；单点模式 `active: true`（你能看见路线），队列模式 `active: false`（后台，读完自动关）。
3. 新标签上的 ②（同样注入 `*.amap.com`，识别 `/dir` 与 `/ssr/dir`）用 `MutationObserver` 等结果节点，读「XX 分钟 / XX 公里 / N 次换乘」，15s 超时降级。
4. ③ 写入 `CommuteRecord{ source_kind:'page_read', exactness:'exact', confidence:0.8 }`，通知主标签把该 pill 的 `~` 去掉。

### 明确不再做的事

- 不再申请或存储高德 key（设置页删掉 key 与配额条）。
- 不再调 `restapi.amap.com`（去掉该 host_permissions）。
- 不再有 OSM / 天地图瓦片、底图切换、影像 provider（影像补漏若要保留，需另议，见下方风险）。
- 不再有"独立地图页"这个界面。

### 新增风险（必须接受）

| 风险 | 影响 | 对策 |
|---|---|---|
| **寄生依赖** | 高德改版 / 反注入 / 要求登录才能算路 → 直接影响可用 | 侧栏与画点是核心，算法层与页面解耦；读回失败降级为"人工看+手填" |
| **hook `AMap.Map` 拿不到实例** | 画不了点，整个界面失效 | 阶段 3 第一件事就是 30 分钟 spike；拿不到则退回"用高德自带标记 + 只做列表"或恢复独立页 |
| **登录/滑块验证** | 自动化读不到时长 | 检测到验证码就提示"请在新标签完成验证后重试"，不尝试绕过 |
| **结果 DOM 改版** | 读回失效 | 选择器集中在一个文件 + 多重兜底（正则扫"分钟"）；失败标"未读到" |
| **队列连续跳转触发风控** | 被限流或要求验证 | 队列限速（每次间隔 ≥3s、单次队列上限 12 个）、显式告知"将连续打开 N 个标签" |
| **影像补漏无法复用高德底图** | 阶段 4c 失去卫星瓦片来源 | 需要另找影像源（天地图 tk 仍可只用于影像），或该模块降级/砍掉 |

### 队列与"看路线"（已定）

- 队列**后台静默**跑：`chrome.tabs.create({ active:false })` → 等 complete → 读回 → `tabs.remove`。
- **每条算路的 URL 要落库**（`CommuteRecord.source_url`），详情里给一个「在高德看这条路线」按钮 → 想看时随时用保存的 URL 打开（前台）。
- 队列限速 ≥3s/个，单次上限 12 个，开跑前明确提示"将连续打开 N 个后台标签"。

### 由此产生的连锁后果：让 API key 那条线彻底断掉

draft-3/4 里"小区发现"依赖 `/v3/place/around`（高德 Web 服务 API，**要 key**）。不用 key 之后，**发现功能失去数据源**。三个处置选项（阶段 4 再定，本期先不做）：

| 选项 | 做法 | 合规性 |
|---|---|---|
| N1 | 用户在高德页面搜索框里搜"小区"，插件读**当前可见结果** DOM，逐页人工确认 | ✅ 符合"只读用户可见页面" |
| N2 | 注入页里调 `AMap.PlaceSearch`（用高德自己的 key） | ⚠️ 同 C 方案，协议风险 |
| N3 | 不做自动发现，只靠人工录入 + 后端离线导出导入 | ✅ 最保守 |

本期采用 **N3**：先把"叠加 + 通勤读回"这条主线做扎实。影像补漏（原 4c）**已砍**（I1）。

### 阶段 3 拆解（按 draft-5 重写，hook 风险已消除）



| 子步 | 内容 | 关键验证 |
|---|---|---|
| 3a | 注入骨架：content script 双 world、右侧栏空壳、background + IndexedDB、样例数据 | 在高德页面上能出现侧栏，刷新后数据还在 |
| 3b | **hook spike（最高优先级）** | 能否拿到 `AMap.Map` 实例；`lngLatToContainer` 是否正确；拖动缩放时 canvas 是否跟手 |
| 3c | 画点 + 列表 + 刻度尺 + 详情（通勤值先用直线估算） | 地图点与列表联动 |
| 3d | 深链 + 单点读回 | 打开一个标签、读到分钟数、去掉 `~` |
| 3e | 队列（点一下算一个） | 连续 3 个不出错、限速生效、失败可跳过 |
| 3f | 发现 / 待补 / 手录（侧栏内标签页） | 手录一条并在地图上看到 |

---

## 0.0 已确认的决策

| # | 决策点 | 你的选择 | 对方案的影响 |
|---|-------|---------|-------------|
| D1 | 通勤路由数据源 | **A：高德 Web 服务 API** | 主适配器 `amap`；`mock` 用于离线开发；`osrm` 只留接口 |
| D2 | 等时圈策略 | **S1：只算小区点** + 点云派生近似区域 | 不为铺网格算路；区域面由已算出的小区点派生，零额外调用 |
| D3 | 主界面形态 | **F3：独立地图页，不注入高德官网** | 扩展自带全屏地图页（Leaflet + canvas + 侧边栏 + tooltip）；无 content script |
| D4 | 后端依赖 | **B1：纯插件 + IndexedDB** | 零服务依赖；官方数据只在阶段 4 走"离线导出 → 导入" |
| X1 | "从当前页面提取" | **暂不实现** | 本期无 `activeTab` / `content_scripts`；契约位保留 |
| G2 | 可行区域形状 | ~~以 A、B 连线为直径的圆~~ → **draft-4：目的地 MEC + 扩展半径** | 形状见 §7.2；半径由滑杆给 |
| P1+P2 | 小区发现 | **高德 POI 发现 + 影像规则补漏** | 新增发现管线与"待补清单"（见 §7.5） |
| V1+V2+V3 | 影像用途 | **底图展示 + 规则补漏 + 阶段 4 人工画边界** | 影像模块分三期落地，先用截图确认，再上规则扫描 |

> 说明 1：X1 是原始需求 §三.2 的功能，你决定暂缓。方案保留 `DataSource` 契约与 `page-extract.ts` 空壳，将来恢复不用动架构。
> 说明 2：G2 的圆在几何上**不对应任何通勤时间约束**（它是「∠APB ≥ 90°」的点集），会包含"离两地都远"的位置。所以圆只做范围参考，**结论永远由逐小区算路给出**，配套措施见 §7.2。

---

## 0.1 一句话定位

一个**安装在自己浏览器里的通勤筛选器**：你有一到五个"要去的地方"，一个扩展半径，一个预算。插件把"通勤时间 + 预算 + 面积 + 产权性质"合起来算，在地图上给你**按通勤排序的小区清单 + 取数范围 + 小区画像**，缺信息的区块进"待补清单"由你补。

不是爬虫：无 content script、不在第三方页面常驻、不模拟登录、不批量翻页。对外请求只有三类：**通勤路径规划 API**、**POI 检索 API**、**地图瓦片**，且都在用户点击后发生。

---

## 1. 本期范围

### 做（In scope）

| # | 能力 |
|---|------|
| 1 | **目的地列表**（1~5 个，地址搜索 / 地图点选 / 粘贴坐标），每个目的地单独设通勤方式；**扩展半径**（km）滑杆 |
| 2 | 通勤计算：驾车 / 公交 / 步行三模式，可设出发时段 |
| 3 | 过滤：预算、面积区间、均价上限、产权性质（多选 + 排除） |
| 4 | 全屏地图页：**搜索范围 = 目的地最小外接圆 + 扩展半径**（内圈画 MEC、外圈画范围）、目的地 pin ①~⑤、小区点（按最长通勤分 4 档着色）、已收录分布晕染、悬浮 tooltip |
| 5 | 侧边栏：条件输入 + 结果列表（按通勤 / 总价排序）+ 筛选摘要 |
| 6 | 小区详情面板：全部字段 + **字段级来源标签** + **卫星影像缩略图** |
| 7 | 手动录入 / 编辑表单（地图点选定位、通勤实测时间） |
| 8 | **小区发现管线**：圆内高德 POI 检索 → 候选列表 → 批量并入本地库（去重） |
| 9 | **影像补漏 + 待补清单**：圆内瓦片规则扫描 → 有建筑群但无 POI 的区块 → 待补列表 |
| 10 | 本地存储（IndexedDB）+ 导出 / 导入 JSON 备份 |
| 11 | 来源标签：官方数据 / 人工录入 / 样例数据 / POI 发现（页面提取位保留不产出） |

### 不做（Out of scope）

求职反向匹配、避坑标签体系、办公楼识别、第三方房源页 DOM 提取（X1 暂缓）、自动爬取、账号体系、云端同步、多城市、真等时圈引擎。

---

## 2. 与现有仓库的关系

现有仓库（`backend/` PostGIS + ZJJ 爬虫、`frontend/` MapLibre 看板）**保持不动**；插件作为并列子项目放 `extension/`。理由：插件必须零服务依赖（双击加载即用），现有后端要 Docker + PostGIS。

可复用（纯函数，移植不改原代码）：

| 复用项 | 来源 | 用途 |
|-------|------|------|
| WGS84 ↔ GCJ-02 + Haversine + polyline 解码 | `frontend/src/geo.ts`、`backend/app/services/geo.py` | 坐标对齐、直线距离粗筛、圆/椭圆数学 |
| 官方字段语义（备案价 / 预售证 / 去化率 / 四至地址） | `backend/app/models.py`、`spike_results/spike_2b_price.json` | 阶段 4 官方数据段字段定义 |
| 官方数据导出格式（GeoJSON FeatureCollection） | `GET /api/communities/geojson` | 阶段 4 "官方数据导入"直接吃这个格式 |

**默认决定（可反对）**：插件放 `extension/`，同一 git 仓库，独立构建、独立打包。

---

## 3. 目录结构

无 content script；插件 = 全屏地图页 + 设置页 + 轻量 popup。

```
xi-an-house/
├── extension/
│   ├── manifest.json                   # MV3；permissions: storage；host: amap API + 瓦片域名
│   ├── vite.config.ts                  # 多入口：app / options / popup / background
│   ├── package.json
│   ├── src/
│   │   ├── background/
│   │   │   ├── index.ts                # service worker：消息路由（唯一出网口）
│   │   │   ├── api-proxy.ts            # 调高德：串行/限速/重试/缓存/错误归一
│   │   │   ├── tile-fetch.ts           # 瓦片 fetch → blob（绕 canvas 污染，影像分析前提）
│   │   │   └── quota.ts                # 每日调用记账；80% 提示、100% 熔断
│   │   ├── core/                       # 纯逻辑，无 DOM 无 chrome.*，可单测
│   │   │   ├── geo.ts                  # 坐标转换、Haversine、点在多边形、圆/椭圆求交、缓冲
│   │   │   ├── commute.ts              # 编排：粗筛 → 精确算路 → 归一 → 缓存
│   │   │   ├── region.ts               # 圆 ROI + 小区点 → 近似可达面（凸包/alpha shape）
│   │   │   ├── imagery.ts              # 像素特征 → 疑似住宅区评分（纯函数，输入 ImageData）
│   │   │   ├── gap.ts                  # 候选区块 vs POI 覆盖 → 待补清单
│   │   │   ├── filter.ts               # 预算/面积/均价/产权/通勤硬约束判定
│   │   │   ├── dedupe.ts               # 小区去重（名称归一 + 200m 内同点合并）
│   │   │   ├── score.ts                # 排序打分（阶段 4）
│   │   │   └── schema.ts               # 数据模型 + 迁移版本号
│   │   ├── adapters/
│   │   │   ├── routing/
│   │   │   │   ├── types.ts            # RoutingProvider 契约（§8）
│   │   │   │   ├── amap.ts             # 驾车/公交/步行
│   │   │   │   ├── osrm.ts             # 占位（阶段 4 可选）
│   │   │   │   └── mock.ts             # 离线假数据，不耗配额
│   │   │   ├── discovery/
│   │   │   │   ├── types.ts            # DiscoveryProvider 契约
│   │   │   │   ├── amap-poi.ts         # 圆内周边搜索住宅类 POI（主发现）
│   │   │   │   ├── imagery-scan.ts     # 瓦片网格扫描 + 评分 + 区块聚合（补漏）
│   │   │   │   └── manual-scan.ts      # 人工框选补漏（兜底）
│   │   │   └── sources/
│   │   │       ├── types.ts            # DataSource 契约
│   │   │       ├── manual.ts           # 表单录入
│   │   │       ├── official-import.ts  # 导入后端导出 GeoJSON（阶段 4）
│   │   │       └── page-extract.ts     # 【预留，本期不实现】
│   │   ├── storage/
│   │   │   ├── db.ts                   # IndexedDB 薄封装
│   │   │   ├── repos.ts                # communities / workPlaces / candidates / gaps
│   │   │   │                           # / commuteCache / tileCache / quota / settings
│   │   │   └── migrations.ts
│   │   ├── ui/
│   │   │   ├── App.tsx                 # 全屏地图 + 侧边栏
│   │   │   ├── components/
│   │   │   │   ├── Sidebar.tsx         # 条件输入 + 结果列表 + 摘要
│   │   │   │   ├── ConditionForm.tsx   # 目的地列表 + 扩展半径 + 预算/面积/产权
│   │   │   │   ├── ResultList.tsx      # 小区卡片：通勤分钟 + 均价 + 来源标签
│   │   │   │   ├── DetailSheet.tsx     # 详情：字段级 badge + 卫星缩略图
│   │   │   │   ├── DiscoveryPanel.tsx  # 发现：候选 POI 勾选批量入库
│   │   │   │   ├── GapList.tsx         # 待补清单：影像区块 → 新建/画边界
│   │   │   │   ├── ManualEntryForm.tsx # 手工录入/编辑
│   │   │   │   ├── SourceBadge.tsx     # 来源标签
│   │   │   │   └── Tooltip.tsx         # 悬浮提示
│   │   │   ├── map/
│   │   │   │   ├── MapCanvas.tsx       # Leaflet 容器 + canvas 渲染层
│   │   │   │   ├── tileProviders.ts    # 矢量底图：OSM（默认）/ 天地图（填 tk）
│   │   │   │   ├── imageryProvider.ts  # 卫星影像：天地图 img_w（详情/扫描用）
│   │   │   │   └── layers.ts           # 圆 ROI / 可达面 / 小区点 / 工作地点 / 缺口区块
│   │   │   └── styles/
│   │   ├── app/index.tsx               # 全屏地图页入口
│   │   ├── options/index.tsx           # key、tk、瓦片源、阈值调参、配额、导入导出
│   │   └── popup/index.tsx             # 轻入口：摘要 + "打开地图"
│   ├── public/leaflet/                 # Leaflet 静态资源（本地打包）
│   └── tests/                          # vitest：core/* + adapters（mock）
├── extension-sample/                   # 样例数据：5–8 个西安小区
├── docs/extension/
│   ├── 01-plan.md                      # 本文件
│   ├── 02-ui.md                        # 阶段 2
│   ├── 03-mvp.md                       # 阶段 3 验收记录
│   ├── data-dictionary.md              # 字段字典
│   └── 04-devlog.md                    # 阶段 4：自测记录 + 已知问题 + 待自动化项
└── backend/ (不动)
```

### manifest 权限（draft-5）

| 项 | 内容 | 说明 |
|---|---|---|
| `permissions` | `["storage"]` | 存设置与轻量偏好；**不需要 `tabs`**（`chrome.tabs.create` 本身不需权限，标签 id 从消息的 `sender.tab` 拿） |
| `host_permissions` | `https://*.amap.com/*` | 仅高德域名，用于注入与读回 |
| `content_scripts` | `matches: ["https://*.amap.com/*"]`，两个条目：`world: "MAIN"`（hook 地图）与默认 ISOLATED（UI），都 `run_at: "document_start"` | 见 §0.0.2 |
| 已移除 | `restapi.amap.com`、瓦片域名 | 不再由插件发算路请求 |
| 影像（可选） | 若阶段 4 保留影像补漏，再加天地图域名 | 与主流程解耦 |

## 4. 模块职责

| 模块 | 职责 | 明确不做 |
|------|------|---------|
| **通勤计算** `core/commute` + `adapters/routing` | 输入 {候选小区集合, 工作地点, 模式, 时段} → 每点分钟数；零调用剪枝、缓存、配额闸门、失败降级 | 不做导航、不存轨迹 |
| **区域派生** `core/region` | ① 圆 ROI（AB 为直径）；② 用**通过筛选的小区点**做凸包/alpha shape 得到"近似可达面" | 不做真等时圈、不为画区域铺网格算路 |
| **小区发现** `adapters/discovery` | ① POI 周边搜索（主）；② 影像瓦片扫描补漏；③ 人工框选兜底。产出 `CandidateSite` 与 `GapItem` | 不在后台自动跑、不翻页批量抓、不跨城 |
| **影像分析** `core/imagery` | 纯函数：`ImageData → {builtRatio, greenRatio, interleave, score}`；阈值可调 | 不做目标检测、不训练模型 |
| **数据录入** `adapters/sources` + `ManualEntryForm` | 手工填写小区与实测通勤；官方数据导入（阶段 4） | 不注入第三方页面 |
| **地图** `ui/map` | Leaflet + canvas：圆、可达面、小区点着色、缺口区块、影像底图、tooltip | 不引远程脚本、不做 3D |
| **存储** `storage/*` | IndexedDB：小区/候选/缺口/通勤缓存/瓦片特征缓存/配额/设置 | 不存原始瓦片大图（只存特征值） |
| **出网层** `background/*` | 所有外部请求集中：绕 CORS、集中限速与缓存、统一错误归一、瓦片转 blob | 不在 UI 线程散着发请求 |

### 通勤计算主流程

1. 填 A、B 与上限 Ta、Tb，选模式与时段 → 点"计算"。
2. `commute.ts` 取候选小区，先做**零调用剪枝**：Haversine 直线 ÷ 该模式上限速度 > 上限 → 判不可行（驾 40km/h、公交 25km/h、步行 4.5km/h 粗估）。
3. 剩余候选算路：驾车/步行优先批量接口（一次多终点），失败退回逐点；公交逐点（无批量），受配额闸门 + 进度条 + 可中断约束。
4. 结果写 `commuteCache`（key = 起终点 + 模式 + 时段 + provider，带 TTL），并回写小区 `commute`。
5. 硬约束过滤：`A ≤ Ta 且 B ≤ Tb`（只填一个地点则单约束）。
6. `region.ts` 用通过筛选的小区点派生可达面；`layers.ts` 把圆与可达面分两层渲染。
7. 侧栏列表 ↔ 地图双向联动。

---

## 5. 数据模型与字段字典

字段名英文，UI 中文。

### 5.1 `Destination`（目的地）+ `Conditions`（筛选条件）

draft-4 已把"双工作地点 + 通勤上限"改成"目的地列表 + 扩展半径"。

- 字段定义见 **`data-dictionary.md` §2（Destination）与 §2.5（Conditions）**，此处不再重复，避免两处漂移。
- 关键点：目的地 1~5 个、无上限、每个自带 `mode`；`Conditions` 含 `expand_radius_km`、预算、产权与来源筛选。

### 5.2 `Community`（小区，主表）

| 字段 | 类型 | 示例 | 可来自 | 说明 |
|------|------|------|--------|------|
| `id` | uuid | | — | |
| `name` / `alias` | string / string[] | 天瑞瑞璟小区 / ["天瑞瑞璟"] | 官方/人工/POI | 名称归一 |
| `district` / `sub_area` | string | 雁塔 / 曲江 | 官方/人工/POI | |
| `address_text` | string | 延兴门西路以东… | 官方/人工/POI | 四至或门牌 |
| `location` | `{lat,lng,crs,precision}` | | 解算/点选/POI | `precision: exact\|road\|district` |
| `boundary` | GeoJSON Polygon? | | 官方/手绘(V3) | 阶段 4 起用 |
| `avg_price` / `price_updated_at` | number / ISO | 21000 | 人工/官方 | 元/㎡ |
| `area_range` | `[min,max]` | [89,143] | 人工 | ㎡ |
| `total_price_range` | `[min,max]` | [187,300] 万 | 派生 | = avg_price × area_range |
| `property` | `{tenure, type, restricted}` | `{70, 商品房, false}` | **仅人工/官方** | 商品房/经适房/安置房/小产权/公寓/房改房 |
| `building` | `{build_year, floors, total_units, decoration, elevator, parking_ratio}` | | 人工 | 房龄 = 当前年 − build_year |
| `management` | `{company, fee, reputation 1-5}` | | **人工为主** | 物业口碑 |
| `surroundings` | `{subway_dist_m, tags[]}` | | 人工/POI | 学区/临铁/临高架 |
| `commute` | `CommuteRecord[]` | | 自动 + 人工 | 见 5.5 |
| `official` | `{permit_no, filing_price, sale_type, sold_ratio, published_at}` | | **官方数据** | 阶段 4 |
| `poi` | `{poiId, type, source}` | | POI 发现 | 高德 POI 回查用 |
| `sources` / `field_provenance` | `SourceRef[]` / `Record<path, SourceRef>` | | — | 记录级 + **字段级**来源 |
| `status` | `'draft'\|'confirmed'\|'archived'` | confirmed | — | POI 批量导入默认 draft |
| `created_at` / `updated_at` / `last_verified_at` | ISO | | — | |

### 5.3 `CandidateSite`（发现候选，未确认）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | |
| `name` | string | POI 名称或"影像区块 #n" |
| `location` | `{lat,lng}` | WGS84 |
| `origin` | `'poi'\|'imagery'\|'manual'` | 发现来源 |
| `poi_id` / `poi_type` | string? | 高德 POI id 与分类 |
| `imagery_score` | number? | 影像评分（`origin='imagery'` 时） |
| `matched_community_id` | uuid? | 去重后指回已有小区 |
| `decision` | `'pending'\|'adopted'\|'ignored'` | 你在发现面板里的处置 |

### 5.4 `GapItem`（待补条目）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | |
| `bbox` | `[w,s,e,n]` | 影像区块范围 |
| `center` | `{lat,lng}` | |
| `thumbnail_ref` | string | 瓦片特征缓存 key（不存原图） |
| `signal` | `{builtRatio, greenRatio, interleave}` | 触发它的特征值，供你判断可信度 |
| `nearest_poi_dist_m` | number | 离最近 POI 多远（越大越像"真缺口"） |
| `status` | `'open'\|'resolved'\|'dismissed'` | |

### 5.5 `CommuteRecord`（小区 × 工作地 × 模式 = 一条）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` / `community_id` / `work_place_id` | uuid | |
| `mode` | `'drive'\|'transit'\|'walk'` | |
| `duration_min` / `distance_m` / `transfers` | number | |
| `depart_at` | string | `08:00` |
| `calc_method` | `'api'\|'manual_measured'\|'estimated'` | |
| `provider` / `source_kind` | `'amap'\|'mock'\|'human'` / `'auto'\|'manual'` | UI 显示"自动计算 / 用户实测" |
| `measured_at` | ISO | 实测时间与高峰标注 |

### 5.6 `SourceRef`（来源标签）

| 字段 | 类型 | 说明 |
|------|------|------|
| `kind` | `'official'\|'manual'\|'poi'\|'seed'\|'page_extract'` | 决定 badge 文案与配色 |
| `label` | string | 官方数据 / 人工录入 / POI 发现 / 样例数据 / 页面提取（本期不产出） |
| `site` / `url` / `captured_at` | string? / string? / ISO | 溯源 |
| `confidence` | 0–1 | 人工 1.0 / 官方 0.95 / POI 0.7 / 样例 0.2 |
| `raw_excerpt` | string? | 原文片段 |

### 5.7 附属表

| 表 | 键 | 内容 |
|----|----|------|
| `commuteCache` | hash(origin, dest, mode, depart, provider) | 结果 + TTL（驾车 7 天 / 公交 3 天 / 步行 90 天） |
| `tileCache` | hash(provider, z, x, y) | **只存像素特征**（特征值 + 缩略图 64×64 webp），不存原始瓦片 |
| `quotaLedger` | `date + provider` | `used` / `limit` / `reserved`；80% 提示，100% 熔断 |
| `settings` | chrome.storage.local 单例 | amap key、天地图 tk、瓦片源、**影像阈值**、默认模式、排序偏好 |

---

## 6. 人工接口 vs 自动接口的边界

原则：**能稳定自动化的只有通勤时长、坐标、小区名与位置；涉及主观评价、商业数据、产权的一律人工，且人工入口永久保留。**

| 字段组 | 自动可行性 | 本期实现 | 后续可自动化条件 |
|-------|-----------|---------|----------------|
| 通勤时长 | ✅ 高 | 自动（`amap`）+ 人工实测可覆盖 | 已自动化；实测值永远优先展示 |
| 坐标 | 🟡 中 | 自动解算 + 地图点选纠正 | — |
| **小区名 + 位置（发现）** | ✅ 中高 | **POI 周边搜索** + 影像补漏 + 人工框选 | 站点 adapter 稳定后扩展来源 |
| 边界多边形 | 🟡 中 | 阶段 4 在影像底图上手绘（V3） | 若有稳定 AOI 服务 |
| 备案价 / 预售证 / 去化率 | ✅ 有官方公示 | **阶段 4：后端离线导出 → 插件导入** | 插件内不爬 |
| 二手房挂牌均价 | 🟡 页面有、反爬强 | **人工录入** | X1 恢复后 |
| 产权性质 | ❌ 常缺/不实 | **人工录入（必填校验）** | 长期人工 |
| 房龄 / 物业口碑 / 噪音 / 车位 | ❌ 主观或无公开源 | **人工录入** | 长期人工 |
| 通勤实测（高峰真实感受） | ❌ | **人工录入**（`manual_measured`） | 长期人工，用来校验 API 偏差 |

**本期三个必须交付的人工接口**

1. **手动录入 / 编辑表单**：必填 `name + location + property.type`；三段折叠（基本信息 / 价格与产权 / 补充画像）；`location` 支持地图点选。
2. **发现面板 + 待补清单**：候选 POI 勾选批量入库；影像区块逐条"新建小区 / 忽略 / 稍后"。
3. **来源标签可见性**：详情页每字段一枚 badge；列表卡片显示"最弱来源"；筛选器可"隐藏仅样例或仅 POI 的小区"。

**"从当前页面提取"（X1）**：不实现，`DataSource` 契约与空壳文件保留。

---

## 7. 通勤、区域与发现方案

### 7.1 路由数据源：高德 Web 服务 API（D1）

| 能力 | 接口 | 备注 |
|------|------|------|
| 驾车 | `/v3/direction/driving` | `strategy` 避堵 + 出发时间 |
| 公交 | `/v3/direction/transit/integrated` | 含换乘次数；**无批量接口** |
| 步行 | `/v3/direction/walking` | 100km 内 |
| 批量距离 | `/v3/distance` | 支持多个起点/终点；公交不支持；**单请求上限需阶段 3 spike 实测** |
| 地理编码 | `/v3/geocode/geo`、`/v3/place/text` | 工作地点与小区地址；结果 GCJ-02 → WGS84 |
| **POI 周边搜索** | `/v3/place/around` | 圆内住宅类 POI（§7.5 主发现手段） |

**成本与风险**：免费额度按个人/企业认证不同，**实际数字以你控制台"配额管理"页为准**；超量按量付费。`quotaLedger` 记账 + 80% 提示 + 100% 熔断。key 存 `chrome.storage.local` 明文，只由你填；若开了 IP 白名单或数字签名必须关掉，否则 10005/10007。

### 7.2 地图上的区域层（draft-4）

**形状变更**：不再是"A、B 连线为直径的圆"，改为 **目的地最小外接圆（MEC）+ 扩展半径 R**。1 个目的地时 MEC 退化为点（半径 0），范围就是该点方圆 R km —— 正好对应"一个点就是在这个点附近租房"。

| 层 | 形状 | 依据 | 视觉 | 图例文案 |
|---|---|---|---|---|
| 内圈 | 目的地 MEC | 纯几何 | 细点线 | "目的地外接圆" |
| **搜索范围层** | MEC + R km | 纯几何，零数据 | 蓝图虚线 + 极淡填色 | "搜索范围（外接圆 + 扩展半径）" |
| 分布层 | 范围内、符合过滤的小区点 → 凸包 + 晕染 | 本地数据 | 淡青晕染 | "已收录小区分布（点云派生）" |

**配套的防误导设计**

1. 范围外的小区在地图上画成**极淡灰点**，表示"有数据但没落进来"，避免你以为半径外就没房子。
2. 圆内不符合预算/产权筛选的小区画成**小灰点**，可一键隐藏；列表里降透明度并标「不符合过滤」。
3. 列表**符合过滤的永远排在不符合的前面**，与排序方式无关。
4. 结论永远由小区点给出，圆只是取数边界。

> draft-3 的"以 AB 为直径的圆"是 MEC 在 2 个点时的特例，逻辑上已被覆盖。

### 7.3 时段与参数

- 驾车：避堵策略 + 出发时间（预设 08:00 / 18:00）。
- 公交：`date/time` 出发时刻；夜间返回空则提示"该时段公交不可用"，允许回退驾车结果。
- 步行：直线 100km 内；超上限直接判不可行，零调用。

### 7.4 底图与影像（F3 + V1）

| 层 | 源 | 状态 | 说明 |
|---|---|---|---|
| 矢量底图 | OSM | **默认，零 key** | 立即可跑 |
| 矢量底图 | 天地图 `vec_w` + `cva_w`（WMTS，EPSG:3857） | **推荐，需免费 tk** | 国内速度好、CGCS2000≈WGS84 免转换 |
| 卫星影像（展示） | 天地图 `img_w` + `cia_w` | 同上 tk | 详情面板缩略图、缺口区块底图 |
| 卫星影像（分析） | 同上，**经 background fetch 成 blob** | 阶段 4 | 见 §7.5 |

> 想"视觉上就是高德地图"只能用高德栅格瓦片（非公开接口 + GCJ-02 转换 + 条款灰色）。本方案不默认启用；要的话我加一个 provider，约半天，风险你接受即可。

### 7.5 小区发现与补漏管线（P1+P2）

**阶段 A：POI 主发现（先做，准确率高）**

1. 在圆 ROI 内用 `/v3/place/around` 检索住宅类 POI（分类码 1203xx，具体码在阶段 3 spike 确认），分页拉全。
2. 结果 → `CandidateSite{origin:'poi'}`，与本地库做去重：名称归一 + 200m 内同点合并（`core/dedupe.ts`）。
3. 发现面板列出"新候选 N 个 / 已存在 M 个"，你勾选后批量入库（`status: draft`，来源标 POI）。

**阶段 B：影像规则补漏（阶段 4 做，补 POI 的空白）**

技术前提（**这三点决定成本，先说清**）：

| 前提 | 内容 |
|---|---|
| **canvas 跨域污染** | 天地图/高德瓦片不返回 CORS 头。用 `<img>` 叠着显示没问题，但 `getImageData()` 读像素会失败。必须由 background `fetch` 瓦片成 blob → `createImageBitmap` → 画到离屏 canvas 才读得到像素。**这是瓦片层不能直接用 Leaflet TileLayer 的原因** |
| **瓦片量** | 5km 半径圆：z17 一张约 253m → 约 **1200 张**；z16 约 500m → 约 **300 张**。所以扫描只用 z16（或 z15），且圆的边缘瓦片要裁掉 |
| **判据** | 阴影方向随影像时相变、植被看季节、楼顶颜色不一 → 三个独立阈值不稳 |

**所以判据不照搬"阴影 + 绿 + 路面"，改用更稳的一条：建筑与绿化的空间交错度。**

小区在影像上的标志性特征是"楼体与楼间绿地**交替出现**"，而不是"有楼或有树"——公园是成片绿、厂房是成片硬化、学校是大块操场上零星建筑。所以：

1. 每张 z16 瓦片下采样到 64×64；
2. 算三类像素占比：`built`（低饱和、中低亮度、含屋顶）、`green`（简化植被指数 ExG = 2G−R−B 超阈值）、`road`（高亮度低饱和细长带，作为辅助）；
3. 用 **`interleave` = 在 8×8 小格上统计"含建格 / 含绿格"相邻交替的比例** 作为主特征；
4. 评分 = `w1·interleave + w2·min(built, green) − w3·max(0, road − 0.5) − w4·(|built − green| 过大惩罚)`；
5. 相邻高分瓦片聚成区块 → 与 POI 点做空间匹配 → 区块内无 POI 且评分 > 阈值的进 `GapItem`；
6. 阈值在 options 页暴露 3 个滑杆，配"扫一遍给我看前 20 个区块"的预览，你在西安实地调。

**成本**：瓦片免费（天地图 tk 额度内），零 API 调用费；一次全圆扫描约 300 张瓦片，特征结果进 `tileCache`，之后增量。

**风险与兜底**：误报率无法先验量化（没有 ground truth），所以**补漏结果一律只进"待补清单"，绝不自动入库**；扫不出来就退回阶段 A 的 POI + 人工框选。

---

## 8. 模块契约（预留后续自动化的接口位）

| 契约 | 输入 | 输出 | 本期实现 | 后续可替换为 |
|------|------|------|---------|-------------|
| `RoutingProvider` | `{origins[], dest, mode, departAt}` | 每点 `{durationMin, distanceM, transfers?}` + 失败原因 | `amap`、`mock` | `osrm`、百度、自建矩阵 |
| `DiscoveryProvider` | `{roi, kinds}` | `CandidateSite[]` | `amap-poi`、`imagery-scan`、`manual-scan` | OSM landuse、其他 POI 源 |
| `DataSource` | `{file}` / `{formValues}`（将来 `{userGesture, visibleDom}`） | `FieldCandidate[]` | `manual`、`official-import` | 页面提取 adapter（X1） |
| `Geocoder` | `addressText` | `{lat,lng,precision}` | `amap` + 地图点选 | 本地地址库 |
| `RegionDeriver` | `{roiShape, points, threshold}` | `GeoJSON Polygon \| null` | `circle(AB)` + `convexHull`/`alphaShape` | 真等时圈引擎 |

**降级链**：`amap 失败 → 缓存过期值（标"上次结果"）→ 提示手动录入实测`；`POI 发现失败 → 人工框选`；`影像扫描不可用 → 只用 POI`。任何一环失败都不阻断主流程，只降精度。

---

## 9. 风险与合规清单

| 风险 | 影响 | 对策 |
|------|------|------|
| MV3 禁远程代码（CSP） | 不能引 CDN 的 Leaflet / 高德 JS API | 全部本地打包；瓦片只做图片层（F3 决策已顺带解决） |
| **host_permissions 扩大** | 安装提示变"可读取多个网站数据"，说服力下降 | 只加瓦片与 amap 域名；README 写明"仅用于取瓦片和算路" |
| API key 泄露/超配额 | 费用、封 key | 只存本机 + 明示风险 + 记账 + 熔断 |
| CORS | 直连 restapi 受限 | 全部走 service worker + host_permissions |
| **canvas 跨域污染** | 影像像素读不到 | background fetch 成 blob 再解码（§7.5） |
| **影像扫描误报** | 待补清单被噪声塞满 | 结果只进清单不自动入库；阈值可调 + 预览前 20；可按"离最近 POI 距离"排序 |
| **影像时相/季节差异** | 阈值年年要重调 | 阈值放 options，不写死；文档记录调参时间与影像批次 |
| 瓦片量过大 | 首扫慢、tk 额度 | 只用 z16、圆外瓦片裁掉、特征缓存增量 |
| 圆 ROI 语义误导 | 以为圆内都可行 | §7.2 四道防误导设计（灰点、列表过滤、图例、不成面） |
| 高德算路偏差（堵车、内部路） | 通勤判断失真 | 展示"API 估算"标签；实测可覆盖；预留 ±15% 容差开关 |
| 坐标偏移 300–500m | 点画错 | 库内 WGS84；调高德前转 GCJ-02；天地图免转换 |
| 数据只在本地 | 换机丢数据 | 一键导出/导入 JSON；schema 版本化迁移 |

---

## 10. 阶段路线图与验收标准

| 阶段 | 交付物 | 验收标准 |
|------|-------|---------|
| **1. Plan**（本文件） | 目录、模块、字段、边界、口径 | 你确认本文件 |
| **2. UI** | `02-ui.md` + 可点击 HTML 线框原型（本地打开、不联网）+ 字段字典 | 8 个界面可视：全屏地图+侧栏、条件输入、结果列表、详情（字段级 badge + 卫星缩略图）、发现面板、待补清单、手录表单、设置（含阈值滑杆）。来源标签与"搜索范围 vs 可达区"两层图例清晰可辨 |
| **3. 最小闭环** | `extension/` 可加载（`chrome://extensions` → 加载已解压） | 填 A/B + 上限 → 计算 → 出现圆 + 两 pin + 小区点着色 + 灰点 + 可达面 → 点小区弹详情（含人工字段与来源标签）→ 重开浏览器数据还在。样例 5–8 小区；路由先 `mock` 后切真 API |
| **4. 完善与测试** | 每模块自测记录 + `04-devlog.md`（已知问题 + 待自动化项） | 三模式切换、POI 发现面板、影像补漏与待补清单、官方数据导入、影像底图人工画边界、过滤与渲染优化 |

### 阶段 3 内部拆解

| 子步 | 内容 | 关键验证 |
|------|------|---------|
| 3a | 骨架 + IndexedDB + 样例数据 | 加载插件、持久化 |
| 3b | mock 路由闭环（圆 + 点 + 可达面 + 过滤 + 详情） | 全链路可跑、不耗配额 |
| 3c | 高德真 API（含 30 分钟 spike） | 三模式各测 1 次；批量算路是否支持步行与单请求上限；公交逐点耗时与配额；错误码归一 |
| 3d | 手录表单 + 地图点选 | 录入真实小区并算出通勤 |
| 3e | POI 发现面板 | 圆内搜索 → 候选去重 → 勾选入库 |

### 阶段 4 内部拆解

| 子步 | 内容 |
|------|------|
| 4a | 官方数据导入（后端离线导出 GeoJSON → 插件） |
| 4b | 影像底图展示（详情缩略图、缺口底图） |
| 4c | 影像规则扫描 + 待补清单 + 阈值调参面板 |
| 4d | 影像底图上人工画边界（V3） |
| 4e | 通勤三模式切换完善 + 排序打分 + 性能优化 |

---

## 11. 下一步

本文件确认后 → **进入阶段 2（UI）**，给线框原型 + 字段字典，等你点头再动代码。

需要你做的（不阻塞，阶段 3c 前完成即可）：

1. 高德开放平台申请 **Web 服务** 类型 key（不是 Web 端 JS key），顺便看下路径规划日额度数字。
2. 天地图申请免费 tk（个人开发者），影像与国内底图都靠它。

---

## 附录：术语速查

| 术语 | 白话 |
|------|------|
| **MV3 / Manifest V3** | Chrome 扩展的当前规范，比旧版更严，尤其限制"远程代码"。 |
| **CSP** | 浏览器的"允许加载什么代码"白名单。MV3 下扩展页面只能跑包里自带的 JS，所以引不了 CDN 的 Leaflet 和高德 JS API。 |
| **service worker** | MV3 的后台脚本。本方案里所有出网请求集中在这里：绕 CORS、限速、缓存、算配额。 |
| **content script** | 注入别人网页里跑的脚本。本方案不使用（X1 暂缓）。 |
| **IndexedDB** | 浏览器内置本地数据库，能存的数据远多于 localStorage，适合存小区与通勤记录。 |
| **host_permissions** | 扩展被允许直接访问的域名清单。加上瓦片域名后，安装提示会显示"可读取这些网站的数据"。 |
| **canvas 跨域污染（taint）** | 把别人的图片画到 canvas 上后，浏览器会把这张 canvas 标记为"被污染"，从此禁止读像素（防偷图）。解法是自己 fetch 成 blob 再画，因为 blob URL 算同源。 |
| **WGS84 / GCJ-02 / BD-09** | 三套坐标系。WGS84 国际通用（GPS/OSM/天地图）；高德用 GCJ-02（火星坐标，加了偏移）；百度用 BD-09。混用会让点位错 300–500m。 |
| **POI** | 兴趣点，地图上的一个带名字的点（小区、学校、加油站都算）。高德的 POI 库有"住宅区"分类，这是本方案发现小区的主要手段。 |
| **ExG（超绿指数）** | 2G − R − B，遥感里最廉价的植被判据：值高说明这块像素偏绿。 |
| **等时圈 / alpha shape / 凸包** | 前者是"X 分钟内能到哪"的真区域；后两个是把散点围成面的算法，凸包最紧但会把凹处包进去，alpha shape 更贴形状。 |
