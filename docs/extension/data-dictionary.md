# 字段字典（数据字典）

> 状态：draft-1，随阶段 2 定稿 | 对应 `docs/extension/01-plan.md` §5 与 `extension/prototype/`
> 约定：库内字段名英文（`snake_case`），UI 文案中文；**坐标一律 WGS84**；金额单位见各字段；时间为 ISO 8601。

---

## 0. 通用约定

| 项 | 约定 |
|---|---|
| 主键 | 全部 `uuid v4`，不用自增（导出/导入不冲突） |
| 坐标 | `{lat, lng}`，WGS84。调用高德前转 GCJ-02，展示高德瓦片时按需转换 |
| 时间 | ISO 8601 带时区，如 `2026-03-02T21:14:00+08:00` |
| 金额 | 均价用 **元/㎡**（整数）；总价用 **万元**（整数）；费用用 元 |
| 面积 | **㎡**，保留 1 位小数 |
| 距离 | **米**（整数） |
| 时长 | **分钟**（整数，向上取整） |
| 空值 | 统一 `null`，不用 `""` 或 `0` 表示缺失。**缺失必须显式存 null，UI 显示"未录入"** |
| 来源 | 每个字段可挂一个 `SourceRef`，存储在 `field_provenance` 里，键为字段路径（如 `property.type`） |

---

## 1. 枚举值

### 1.1 `tenure`（产权年限）

| 值 | 含义 | 常见对象 |
|---|---|---|
| `"70"` | 住宅 70 年 | 普通商品房、经适房、安置房 |
| `"50"` | 50 年 | 部分商住、厂房改住 |
| `"40"` | 40 年 | 公寓、写字楼改住 |
| `null` | 未知 | — |

### 1.2 `property_type`（产权性质）

| 值 | 中文 | 默认策略 |
|---|---|---|
| `commercial` | 商品房 | 默认不过滤 |
| `affordable` | 经济适用房 | 默认不过滤，但详情标注"上市交易受限" |
| `resettlement` | 安置房 | 默认不过滤 |
| `small_property` | 小产权 | **默认排除** |
| `apartment` | 公寓 | **默认排除** |
| `reform_housing` | 房改房 | 默认不过滤 |
| `other` | 其他 | 默认排除，需备注说明 |

### 1.3 其余枚举

| 枚举 | 值 |
|---|---|
| `mode`（模式） | `drive` 驾车 / `transit` 公交 / `walk` 步行 |
| `calc_method` | `api` API 计算 / `manual_measured` 用户实测 / `estimated` 经验估算 |
| `provider` | `amap` / `osrm` / `mock` / `human` |
| `source_kind`（记录级） | `auto` 自动 / `manual` 人工 |
| `SourceRef.kind` | `official` 官方 / `manual` 人工 / `poi` POI 发现 / `seed` 样例 / `page_extract` 页面提取（本期不产出） |
| `Community.status` | `draft` 草稿 / `confirmed` 已确认 / `archived` 归档 |
| `CandidateSite.origin` | `poi` / `imagery` / `manual` |
| `CandidateSite.decision` | `pending` / `adopted` / `ignored` |
| `GapItem.status` | `open` / `resolved` / `dismissed` |
| `commute.exactness`（派生，不存库） | `exact` 自动计算 / `estimated` 直线估算 |

---

## 2. `Destination`（目的地）

> 变更：不再区分"公司/家"，统一为目的地列表；**不再有通勤上限**；每个目的地自带一种通勤方式。

| 字段 | 中文 | 类型 | 必填 | 来源 | 校验 | 展示位置 |
|---|---|---|---|---|---|---|
| `id` | 主键 | uuid | ✔ | 系统 | — | — |
| `order` | 序号 | int 1~5 | ✔ | 系统 | 1 起，连续 | 地图 pin ①②③、泳道、pill |
| `address_text` | 地址原文 | string(120) | ✔ | 人工 | 非空 | 条件编辑行 |
| `location.lat` | 纬度 | float | ✔ | 解算/点选 | −90~90 | 地图 pin |
| `location.lng` | 经度 | float | ✔ | 解算/点选 | −180~180 | 地图 pin |
| `location.crs` | 坐标系 | `'wgs84'` | ✔ | 系统 | 固定值 | 不展示 |
| `location.precision` | 精度 | `exact`\|`road`\|`district` | ✔ | 解算 | — | 详情"位置"行 |
| `geocode_source` | 解算方式 | `amap`\|`map_click`\|`manual` | ✔ | 系统 | — | 详情 |
| `mode` | 通勤方式 | `drive`\|`transit`\|`walk` | ✔ | 人工 | 必须是枚举值 | 条件编辑行的 seg、图例 |

**约束**

- 数量 1~5。**最少 1 个**（删除按钮在只剩 1 个时禁用），最多 5 个（再多刻度尺与 pill 不可读）。
- `order` 决定配色（①朱砂 ②蓝图 ③青绿 ④芥黄 ⑤紫），地图 pin / 泳道 / pill 三处共用同一套色。
- 目的地没有名称/标签字段——编号就是标识。将来要加"备注"再说。

## 2.5 `Conditions`（筛选条件，单例）

> 这一组字段就是侧边栏第 1 行摘要的全部内容，保存后收起为一行。

| 字段 | 中文 | 类型 | 必填 | 默认 | 校验 | 展示位置 |
|---|---|---|---|---|---|---|
| `destinations` | 目的地列表 | `Destination[]` | ✔ | 1 个 | 1~5 个 | 条件编辑行、第 1 行摘要 |
| `expand_radius_km` | 扩展半径 | float km | ✔ | `3.0` | `0 ≤ x ≤ 15`，步进 0.1 | 滑杆、地图搜索范围圆 |
| `budget.total_min` / `.total_max` | 总价区间 | int 万元 | — | 150 / 320 | `0 < min ≤ max` | 滑杆、列表过滤 |
| `budget.area_min` / `.area_max` | 面积区间 | int ㎡ | — | 80 / 140 | 同上 | 滑杆 |
| `budget.price_max` | 均价上限 | int 元/㎡ | — | 24000 | 3000~80000 | 滑杆 |
| `tenure_filter` | 产权筛选 | `{include[], exclude[]}` | — | 只看商品房 | 每个值必须在枚举内 | 三态 chip |
| `source_filter` | 来源筛选 | `string[]` | — | 全部 | — | 三态 chip |
| `depart_at` | 出发时刻 | `HH:mm` | ✔ | `08:00` | — | 详情通勤块标题 |
| `sort_by` | 默认排序 | `commute`\|`total`\|`price` | ✔ | `commute` | — | 列表头 seg |

### 搜索范围的计算（`expand_radius_km` 的语义）

| 目的地点数 | 范围 |
|---|---|
| 1 | 以该点为圆心、`expand_radius_km` 为半径的圆 |
| 2 | 以两点连线为直径的圆（= 两点的最小外接圆）再外扩 `expand_radius_km` |
| ≥3 | 点集的**最小外接圆（MEC）**再外扩 `expand_radius_km` |

> 实现见 `core/region.ts` 的 `minEnclosingCircle()`：点数 ≤5，暴力枚举所有"两点为直径"与"三点外接圆"，取包含全部点且半径最小的那个。地图上同时画内圈（MEC，点线）与外圈（MEC + 半径，虚线），让"外扩"这件事看得见。

## 3. `Community`（小区，主表）

### 3.1 标识与位置

| 字段 | 中文 | 类型 | 必填 | 来源 | 校验 | 展示位置 |
|---|---|---|---|---|---|---|
| `id` | 主键 | uuid | ✔ | 系统 | — | — |
| `name` | 小区名 | string(60) | ✔ | 官方/人工/POI | 非空；与已有小区做名称归一后不得完全重复（提示但不阻止） | 列表卡片、详情标题、地图 tooltip |
| `alias` | 别名 | string[] | — | 人工 | 每条 ≤20 字 | 详情（有才显示） |
| `district` | 行政区 | string(20) | — | 官方/人工/POI | 建议从固定列表选（未央/雁塔/高新/碑林/莲湖/新城/灞桥/长安/高陵/鄠邑/临潼/阎良/周至/蓝田） | 列表副标题、详情 |
| `sub_area` | 板块 | string(20) | — | 人工 | — | 详情 |
| `address_text` | 地址 / 四至 | string(200) | ✔ | 官方/人工 | 非空 | 详情 |
| `location.lat` / `.lng` | 坐标 | float | ✔ | 解算/点选/POI | 落在西安 bbox(`107.4~109.8, 33.4~34.8`) 否则警告 | 地图点、详情 |
| `location.precision` | 坐标精度 | `exact`\|`road`\|`district` | ✔ | 解算 | — | 详情（"门牌 / 路口 / 行政区中心"） |
| `boundary` | 边界多边形 | GeoJSON Polygon | — | 官方/手绘 | 顶点 ≥3；面积 1 万~200 万 ㎡ 否则警告 | 详情状态 + 地图（阶段 4） |

### 3.2 价格与面积

| 字段 | 中文 | 类型 | 必填 | 来源 | 校验 | 展示位置 |
|---|---|---|---|---|---|---|
| `avg_price` | 均价 | int 元/㎡ | — | 人工/POI/官方 | 3000~80000 | 列表、详情 |
| `price_updated_at` | 均价更新时间 | date | — | 系统 | 超过 180 天在详情标"数据较旧" | 详情 |
| `area_range` | 面积区间 | `[min,max]` ㎡ | — | 人工 | `0<min≤max<1000` | 列表、详情 |
| `price_median_area` | 计价面积 | ㎡ | — | 派生 | = 面积区间中值 | 不展示（内部算总价） |
| `total_price_range` | 总价区间 | `[min,max]` 万元 | — | **派生** | = `avg_price × area_range / 10000` | 列表"总价约 X 万"、筛选 |
| `total_price_median` | 总价中值 | 万元 | — | **派生** | 同上取中值 | 列表排序 |
| `filing_price` | 备案价 | int 元/㎡ | — | 官方 | 3000~80000 | 详情，标"官方数据" |

> 派生字段不落库，读取时计算（`core/schema.ts` 提供 `derive(c)`），避免均价改动后不同步。

### 3.3 产权与楼况

| 字段 | 中文 | 类型 | 必填 | 来源 | 校验 | 展示位置 |
|---|---|---|---|---|---|---|
| `property.type` | 产权性质 | 枚举 1.2 | **✔** | **人工/官方** | 必须是枚举值 | 列表（"70年"）、详情、筛选 |
| `property.tenure` | 产权年限 | `"70"`\|`"50"`\|`"40"` | — | 人工 | 与 `type` 交叉校验：`apartment` 通常 40，`commercial` 通常 70 | 列表、详情 |
| `property.restricted` | 交易受限 | bool | — | 人工 | 经适房/安置房默认 true | 详情警示条 |
| `building.build_year` | 建成年代 | int | — | 人工 | 1950~当前年 | 详情（自动算房龄） |
| `building.age_years` | 房龄 | int | — | **派生** | = 当前年 − `build_year` | 列表可选列、详情 |
| `building.floors` | 总层数 | int | — | 人工 | 1~60 | 详情 |
| `building.total_units` | 总户数 | int | — | 人工 | 1~20000 | 详情 |
| `building.decoration` | 装修 | `rough`\|`fine`\|`other` | — | 人工 | — | 详情 |
| `building.elevator` | 有无电梯 | bool | — | 人工 | — | 详情 |
| `building.parking_ratio` | 车位比 | float | — | 人工 | 0~3 | 详情 |
| `management.company` | 物业公司 | string(40) | — | 人工 | — | 详情 |
| `management.fee` | 物业费 | float 元/㎡·月 | — | 人工 | 0~20 | 详情 |
| `management.reputation` | 物业口碑 | int 1~5 | — | **仅人工** | 1~5 | 详情（阶段 4 参与排序） |
| `surroundings.subway_dist_m` | 最近地铁距离 | int 米 | — | 人工/POI | 0~5000 | 详情、地图（阶段 4） |
| `surroundings.tags` | 标签 | string[] | — | 人工/POI | 预置词表：临铁/学区/临湖/临高架/临高速/老破小/次新 | 列表虚线 chip、详情 |
| `surroundings.noise` | 噪音评价 | int 1~5 | — | **仅人工** | 1~5（5=安静） | 详情 |

### 3.4 通勤、官方数据、来源

| 字段 | 中文 | 类型 | 必填 | 来源 | 说明 |
|---|---|---|---|---|---|
| `commute` | 通勤记录 | `CommuteRecord[]` | — | 自动 + 人工 | 见 §4；`manual_measured` 优先展示 |
| `official.permit_no` | 预售证号 | string(32) | — | 官方 | 阶段 4 导入 |
| `official.sale_type` | 销售类型 | `presale`\|`current_sale` | — | 官方 | 阶段 4 |
| `official.sold_ratio` | 去化率 | float 0~1 | — | 官方 | 阶段 4 |
| `official.published_at` | 公示日期 | date | — | 官方 | 阶段 4 |
| `poi.poi_id` | 高德 POI id | string(40) | — | POI 发现 | 回查用 |
| `poi.type` | POI 分类 | string(20) | — | POI 发现 | 如"住宅区" |
| `sources` | 记录级来源 | `SourceRef[]` | ✔ | 系统 | 至少 1 条 |
| `field_provenance` | 字段级来源 | `Record<path, SourceRef>` | — | 系统 | 键为 `property.type`、`avg_price` 这类路径 |
| `status` | 状态 | 枚举 | ✔ | 系统 | POI 批量导入默认 `draft` |
| `risk_flags` | 风险标记 | string[] | — | 人工 | 本期无 UI，字段预留 |
| `created_at` / `updated_at` | 创建/更新时间 | datetime | ✔ | 系统 | — |
| `last_verified_at` | 最后核实时间 | datetime | — | 系统 | 详情显示"3 天前核实" |

---

## 4. `CommuteRecord`（通勤记录）

一条 = 一个小区 × 一个目的地 × 该目的地的通勤方式。**没有上限字段**，只有时长。

| 字段 | 中文 | 类型 | 必填 | 校验 | 展示位置 |
|---|---|---|---|---|---|
| `id` | 主键 | uuid | ✔ | — | — |
| `community_id` | 小区 | uuid | ✔ | 外键存在 | — |
| `destination_id` | 目的地 | uuid | ✔ | 外键存在 | — |
| `mode` | 模式 | 枚举 | ✔ | 与目的地当前 mode 一致 | 详情通勤行 |
| `duration_min` | 时长 | int 分钟 | ✔ | 1~300 | 列表 pill、泳道刻度、详情大字 |
| `distance_m` | 距离 | int 米 | — | 0~100000 | 详情副行 |
| `transfers` | 换乘次数 | int | — | 仅 `transit`，0~5 | 详情副行 |
| `exactness` | 精确度 | `exact`\|`estimated` | ✔ | — | 详情 badge（自动计算 / 直线估算）；估算值前加 `~` |
| `calc_method` | 计算方式 | `api`\|`manual_measured`\|`estimated` | ✔ | — | 详情 |
| `provider` | 提供方 | `amap`\|`osrm`\|`mock`\|`human` | ✔ | — | 详情 tooltip |
| `source_kind` | 来源类型 | `auto`\|`manual` | ✔ | — | 详情 badge（用户实测优先展示） |
| `depart_at` | 出发时刻 | `HH:mm` | ✔ | 继承 `Conditions.depart_at` | 详情标题 |
| `measured_at` | 实测时间 | datetime | 条件必填 | `calc_method=manual_measured` 时必填 | 详情 |
| `note` | 实测说明 | string(120) | — | — | 详情 |

**唯一约束**：`(community_id, destination_id)` 唯一。同一组合下 `manual_measured` 覆盖 `api` 的展示，两条都保留。

**精确/估算的分层规则（省配额的关键）**：按「最长通勤」升序，前 `exact_quota`（默认 10）个调路径规划 API（`exact`），其余用 `直线距离 ÷ 城市平均速度` 生成 `estimated` 值。速度快查：驾 22 km/h + 5 min 停车、公交 18 km/h + 8 min 候车、步行 4.6 km/h。

---

## 5. `SourceRef`（来源标签）

| 字段 | 中文 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `kind` | 来源类型 | 枚举 1.3 | ✔ | 决定 badge 颜色与文案 |
| `label` | 展示文案 | string | ✔ | 官方数据 / 人工录入 / POI 发现 / 样例数据 |
| `site` | 站点 | string(20) | — | `zjj` / `amap` / `manual` |
| `url` | 来源地址 | string(500) | — | 可点击溯源 |
| `captured_at` | 采集时间 | datetime | ✔ | — |
| `confidence` | 置信度 | float 0~1 | ✔ | official 0.95 / manual 1.0 / poi 0.7 / seed 0.2 |
| `raw_excerpt` | 原文片段 | string(300) | — | 便于事后核对 |

**"最弱来源"规则**（列表卡片显示用）：按 `seed(1) < poi(2) < manual(3) < official(4)` 取最小值。

---

## 6. `CandidateSite`（发现候选）

| 字段 | 中文 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `id` | 主键 | uuid | ✔ | — |
| `name` | 名称 | string(60) | ✔ | POI 名称或"影像区块 #3" |
| `location` | 坐标 | `{lat,lng}` | ✔ | WGS84 |
| `origin` | 发现来源 | 枚举 | ✔ | — |
| `poi_id` / `poi_type` | POI 信息 | string | — | `origin=poi` 时 |
| `dist_to_center_m` | 距圆心 | int 米 | ✔ | 列表展示、排序 |
| `imagery_score` | 影像评分 | float 0~1 | — | `origin=imagery` 时 |
| `matched_community_id` | 匹配到的小区 | uuid | — | 非空则显示"已存在"且不可勾选 |
| `decision` | 处置 | 枚举 | ✔ | `pending` 默认 |

**去重规则**（`core/dedupe.ts`）：名称归一（去空格、去"小区/花园/家园"后缀）后相同 **或** 两点距离 <200m → 判为已存在。

---

## 7. `GapItem`（待补条目）

| 字段 | 中文 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `id` | 主键 | uuid | ✔ | — |
| `bbox` | 区块范围 | `[w,s,e,n]` | ✔ | 一个瓦片或相邻瓦片合并后的范围 |
| `center` | 中心点 | `{lat,lng}` | ✔ | 地图飞行定位 |
| `thumbnail_ref` | 缩略图引用 | string | ✔ | `tileCache` 的键，**不存原图** |
| `signal.built_ratio` | 建筑占比 | float 0~1 | ✔ | 触发依据，必须展示 |
| `signal.green_ratio` | 绿化占比 | float 0~1 | ✔ | 同上 |
| `signal.interleave` | 建筑-绿化交错度 | float 0~1 | ✔ | **主判据**，同上 |
| `nearest_poi_dist_m` | 最近 POI 距离 | int 米 | ✔ | 越大越可能是真缺口，列表按此降序 |
| `status` | 状态 | 枚举 | ✔ | `open` 默认 |

---

## 8. 附属表

### 8.1 `commuteCache`

| 字段 | 说明 |
|---|---|
| `key` | `hash(origin, dest, mode, depart_at, provider)` |
| `duration_min` / `distance_m` / `transfers` | 缓存值 |
| `raw` | 原始响应（调试用，可关） |
| `created_at` / `ttl_sec` | 驾车 7 天 / 公交 3 天 / 步行 90 天 |

### 8.2 `tileCache`

| 字段 | 说明 |
|---|---|
| `key` | `hash(provider, z, x, y)` |
| `features` | `{built_ratio, green_ratio, interleave, road_ratio}` |
| `thumb` | 64×64 webp dataURL（供待补清单显示） |
| `created_at` | 影像时相变化后需失效 |

### 8.3 `quotaLedger`

| 字段 | 说明 |
|---|---|
| `date` + `provider` | 联合主键 |
| `used` / `limit` / `reserved` | 80% 提示、100% 熔断 |

### 8.4 `settings`（chrome.storage.local，单例）

| 字段 | 中文 | 默认 |
|---|---|---|
| `amap_key` | 高德 Web 服务 key | `""` |
| `tianditu_tk` | 天地图 tk | `""` |
| `basemap` | 底图 | `"osm"`（填了 tk 后 `"tianditu"`） |
| `conditions` | 上次保存的筛选条件 | 见 §2.5（含目的地列表与扩展半径） |
| `exact_quota` | 每次精确计算的小区上限 | `10` |
| `city_bbox` | 城市范围 | 西安 `[107.4,33.4,109.8,34.8]` |
| `imagery.mix_min` | 交错度下限 | `0.58` |
| `imagery.built_min` | 建筑占比下限 | `0.28` |
| `imagery.poi_gap_min` | 离 POI 最小距离 | `200` m |
| `show_out_of_filter` | 是否显示不符合过滤的小区 | `true` |

---

## 9. 派生逻辑（不落库，读时算）

| 派生值 | 公式 | 用于 |
|---|---|---|
| `total_price_median` | `avg_price × (area_range[0]+area_range[1])/2 / 10000` | 列表"X 万"、总价筛选、排序 |
| `age_years` | `当前年 − building.build_year` | 详情、房龄筛选（阶段 4） |
| `worst_commute` | `max(commute[].duration_min)` | **列表排序主键、右侧大字、地图点配色分档** |
| `meets_filter` | 总价 ∈ `budget.total_*` ∧ 面积有交集 ∧ `avg_price ≤ budget.price_max` ∧ 产权 ∈ `tenure_filter.include` − `exclude` ∧ 来源 ∈ `source_filter` | 卡片透明度、`不符合过滤` badge、计数 |
| `mec` | 目的地点集的最小外接圆 | 地图内圈 |
| `search_radius` | `mec.r + expand_radius_km` | 地图外圈；`in_range = dist(community, mec.c) ≤ search_radius` |
| `weakest_source` | `min(confidence)` 的 `SourceRef` | 列表 badge |
| `data_cover_hull` | 范围内且 `meets_filter` 的小区点 → 凸包 + 晕染 | 地图"已收录小区分布"层 |
| `exactness` | 按 `worst_commute` 升序的前 `exact_quota` 个 = `exact`，其余 `estimated` | 通勤值是否带 `~` |

> 注意：**没有 `verdict`（达标/临界/超限）了**。去掉通勤上限后，"是否可行"不再由插件判定，改由半径（空间）+ 排序（时间）共同表达。

## 10. 数据校验与迁移

| 规则 | 处理 |
|---|---|
| 必填缺失 | 阻止保存，就地标红（不弹窗） |
| 坐标不在西安 bbox | 警告但允许保存（可能是远郊/错录），详情标"坐标可疑" |
| 均价 × 面积 与总价不符 | 总价是派生值，不会再冲突 |
| 同一小区重复录入 | 保存前做名称归一 + 200m 判定，提示"可能已存在：X"，给"仍然新建" |
| schema 升级 | `migrations.ts` 带版本号，逐版迁移；迁移前自动导出一份备份到 IndexedDB 的 `backup` 表 |
| 导出格式 | `{version, exported_at, work_places, communities, candidates, gaps, settings(不含 key)}` |

---

## 11. 字段与来源的对应关系（速查）

| 字段组 | 能来自 | 不可能是 |
|---|---|---|
| 名称 / 坐标 / 行政区 | 官方、人工、POI | — |
| 均价 / 面积 | 人工、POI（挂牌） | 官方（只有备案价） |
| 产权性质 / 产权年限 | **仅人工、官方** | POI |
| 房龄 / 物业 / 口碑 / 噪音 / 车位 | **仅人工** | 一切自动来源 |
| 备案价 / 预售证 / 去化率 | **仅官方** | 人工（人工填的应记为"人工录入"） |
| 通勤时长 | API 自动（`exact`）+ 直线估算（`estimated`）+ 人工实测（覆盖前两者） | — |
| 边界多边形 | 官方、手绘 | 自动解算（阶段 4 前不做） |
| 目的地 / 扩展半径 / 预算 / 产权筛选 | **仅人工** | 一切自动来源 |
