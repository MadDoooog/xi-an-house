# 阶段 3a 交付记录 · 可加载的注入骨架

> 版本 v0.1.0 | 产物：`dist/xian-commute-ext-v0.1.0.zip`（解压到 `D:\` 得到 `D:\xian-commute-ext\`）
> 源码：`extension/app/`（这就是可加载的扩展根目录，manifest.json 在最外层，无需构建）

---

## 1. 这一版做了什么

| # | 能力 | 状态 |
|---|------|------|
| 1 | 只在高德页面（`*.amap.com`）注入，其他网站不注入 | ✅ |
| 2 | MAIN world 挂钩 `AMap.Map`，拿到实例做像素投影 | ✅ |
| 3 | canvas 叠加：搜索范围圆（外接圆 + 扩展半径）、目的地 pin、小区点（按最长通勤分档） | ✅ |
| 4 | 侧边栏：条件摘要 / 多泳道刻度尺 / 列表 / **两列详情** / 条件编辑 | ✅ |
| 5 | 首次进入自动把地图缩放到搜索范围 | ✅ |
| 6 | 深链「去高德算」：按当前目的地 + 小区生成高德路线 URL 并在新标签打开 | ✅ |
| 7 | 日志（落 IndexedDB）+ 诊断自检页 + 一键复制诊断信息 | ✅ |
| 8 | 通勤时长读回 | ⬜ 阶段 3d |
| 9 | 地址搜索 / 新增目的地选点 | ⬜ 阶段 3b |
| 10 | 自动发现小区、影像补漏 | ⬜ 已砍/暂缓 |

**通勤数值当前是直线估算**（`~` 前缀），不是真实路线时长。

---

## 2. 文件结构

```
extension/app/                    ← 可加载根目录（也是 zip 的内容）
├── manifest.json                 权限：storage + *.amap.com；两个 content script（MAIN / ISOLATED）
├── background.js                 IndexedDB（settings/communities/logs/diag）+ RPC + 打开标签
├── lib/
│   ├── geo.js                    WGS84↔GCJ-02、haversine、最小外接圆、圆上取点、分档色
│   └── logger.js                 console + 落库；捕获 error / unhandledrejection
├── content/
│   ├── map-hook.js               MAIN world：拦截 window.AMap → 包 AMap.Map → 投影服务
│   ├── ui.js                     ISOLATED：Shadow DOM 侧栏 + canvas 绘制 + 交互
│   └── ui.css                    仅在 Shadow DOM 内生效（不会污染高德页面）
├── options/                      设置与诊断页（状态自检 / 日志 / 数据 / 版本说明）
├── popup/                        弹窗：状态 + 打开高德 + 进诊断页
└── README-安装说明.txt           给 Windows 用户的安装步骤
```

---

## 3. 关键设计决定

| 决定 | 原因 |
|---|---|
| **Shadow DOM 承载全部 UI** | 高德的 CSS 不会影响我们，我们的 CSS 也不会污染高德（第一版曾把 `ui.css` 声明进 `content_scripts.css`，那是注入到页面 DOM 的，会改到高德的按钮样式，已改掉） |
| **canvas 用 `pointer-events:none`，命中检测自己做** | 这样地图的拖动、缩放完全不受影响；只在离点 11px 内且位移 <6px 时才算"点击小区" |
| **投影请求走 postMessage，UI 只传 GCJ-02 坐标** | 坐标转换留在 UI 侧（有 `geo.js`），MAIN world 只做纯投影，避免两处各写一份转换 |
| **兜底三层：拦截赋值 → 轮询补挂（60s）→ 原型方法兜底网** | 第一次实测出现过"patched 但没实例"，加兜底避免偶发失败 |
| **数据全在 background 的 IndexedDB** | 内容脚本的 IndexedDB 属于 amap.com 的 origin，清缓存就没了 |

---

## 4. 自测记录（Linux + Playwright 加载真实扩展）

用 Playwright 以 `--load-extension` 加载 `extension/app`，访问 `https://www.amap.com/`：

| 检查项 | 结果 |
|---|---|
| service worker 启动 | ✅ |
| 首装写入 12 条样例 + 默认设置 | ✅ |
| 页面出现 `#xat-root`（Shadow DOM） | ✅ |
| `window.__XAT_HOOK__.info()` | `patched:true, instances:1, ready:true, zoom:9.87, center:[108.948,34.263]` |
| `lngLatToContainer([108.965,34.245])` | `[731.3, 464.7]` → 投影正确 |
| 自动缩放 | ✅ 从 zoom 9.87 → 12.49，中心落在搜索范围 |
| 侧栏渲染 | ✅ 12 条卡片、刻度尺 3 条泳道、计数「12 在范围内 · 6 符合」 |
| 详情两列 | ✅ 面板 620px，左列 216px 紧凑列表，右列详情 |
| 设置页 | ✅ 显示挂钩状态、日志 7–11 条、诊断 702 字符 |
| 后台日志 error 数 | **0** |

**稳定性**：连跑 3 次，2 次完全正常；1 次失败但日志明确指出原因——那次页面资源加载报 `net::ERR_CERT_VERIFIER_CHANGED`（测试环境网络问题），`patched:true` 但没有地图实例。这说明"日志 + 诊断"这条链路是有效的。

---

## 5. 已知问题

| # | 问题 | 影响 | 计划 |
|---|---|---|---|
| 1 | 通勤值是直线估算 | 结论只能当排序参考，不能当决策依据 | 阶段 3d 读回高德真实时长 |
| 2 | 目的地地址改了不会重新解算坐标 | 只能改名字，坐标仍来自样例库 | 阶段 3b 接地址搜索 / 地图选点 |
| 3 | 预算/面积的滑块未接 | 编辑态显示的是只读说明 | 下一版 |
| 4 | 侧栏会盖住高德右上角的工具条（卫星/图层/测距等） | 需要时可点侧栏左边的 `‹` 收起 | 可改成默认靠左下或可拖动 |
| 5 | 高德未登录时可能弹登录框 | 遮挡地图，但不影响注入与绘制 | 无需处理（用户环境已登录） |
| 6 | 示例数据是虚构的西安小区 | 仅用于验证链路 | 后续接人工录入 / 后端导入 |

---

## 6. 下一步（阶段 3d：读回真实通勤）

1. `/dir` 页注入一个轻量读回脚本：`MutationObserver` 等结果面板出现，抓「X小时Y分钟 / Z公里」。
2. 队列：点一下算一个，后台标签静默加载 → 读回 → 关闭 → 写库（`source_kind:'page_read'`，置信度 0.8）。
3. 每条算路的 URL 落库，详情里保留「在高德看这条路线」。
4. 读回值替换估算值，列表里的 `~` 去掉。
