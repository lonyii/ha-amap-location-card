# AMap Location Card

高德地图定位卡片 · Home Assistant 自定义 Lovelace 卡片 · 兼容 iPhone Safari

读取任意自带经纬度的 HA 实体（WGS-84），通过**高德 Web 服务**强制纠偏为 GCJ-02，
在高德底图上分层渲染「源实体 / 充电桩 / 公共厕所」，并支持周边检索、弹窗与一键唤起高德导航。

单文件 ES Module，**零构建依赖**，可直接放进 `config/www/` 或通过 HACS 安装。

---

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [高德 Key 申请](#高德-key-申请很重要)
- [快速开始](#快速开始)
- [完整配置项](#完整配置项)
- [坐标转换接口（强制走高德 Web 服务）](#坐标转换接口强制走高德-web-服务)
- [搜索范围：跟随地图当前缩放](#搜索范围跟随地图当前缩放)
- [需求对照表](#需求对照表)
- [重要限制与合规提醒](#重要限制与合规提醒)
- [iPhone Safari 兼容说明](#iphone-safari-兼容说明)
- [故障排查](#故障排查)
- [底图加载不出来？先看提示条说了什么](#底图加载不出来先看提示条说了什么)
- [本地验收（不装 HA）](#本地验收不装-ha)
- [开发](#开发)

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| Key | **一个高德 Key 通吃**：坐标转换 + 周边检索 + 地图底图，无需申请第二个 |
| 实体数据源 | 卡片配置页任选一个自带 `latitude` / `longitude` 的实体（手机、Teslamate、device_tracker 等），兼容 `lat` / `lon` / `lng` 写法与字符串数值 |
| 坐标校验 | 实体不存在、无经纬度属性、(0,0)、越界都会被拦截并在卡片内给出中文提示，不继续执行 |
| 强制高德纠偏 | 不使用本地 GCJ-02 算法，调用 `/v3/assistant/coordinate/convert`（`coordsys=gps` + `output=json`），经 `status` / `infocode` 判定，并对返回值做范围与偏移量二次校验 |
| 三层降级 | Web 服务失败 → 高德 JS API 内置转换 → 原始 WGS-84（并提示偏移风险），任何一层都不炸卡 |
| 周边检索 | `types=011100` 充电设施、`types=140306` 公共厕所，类型码与搜索范围均可配置 |
| 搜索范围跟随缩放 | 默认 `auto`：检索半径由地图当前可视范围推出，放大收窄、缩小扩大，防抖 600ms + 12% 死区，不烧配额 |
| 拖动后按新视野重新搜索 | `auto` 模式下检索基点跟随视野中心：拖走地图 600ms 后自动以新视野为中心重搜（中心移动超过半径 25% 或至少 120 米才触发） |
| 无感检索 | 重检索**全程不显示 loading 遮罩**；标记按 POI 增量复用（同一站点不重建、不闪烁）；**搜不到时不弹任何提示条**，保持安静 |
| 铺满窗口 | 默认 `fill_viewport: true`：高度 = 可视高度 − 上方顶栏/地址栏 − 下方底栏/工具栏（HA 底部导航、App tab bar 都算在内，见下文）；HA 配置编辑器的预览不铺满，关闭后回退固定 `height` |
| 全屏高度可自定义 | `map_height` 支持直接写 CSS：`100dvh`、`calc(100dvh - 120px)`、`100%` 或纯像素，规则与 [ha-map-card-recode](https://github.com/lonyii/ha-map-card-recode) 一致，写了就不再自动测量 |
| 缓存 + 节流 | 同坐标默认 5 分钟内不重复转换；所有高德请求串行节流 + 并发去重 + TTL 缓存 |
| 分层标记 | 源实体（红圈主图标）/ 充电桩（绿）/ 公厕（紫），icon 支持 `mdi:`、图片 URL、`/local/xx.png`、emoji |
| 弹窗信息 | 充电桩：名称 ｜ 距离 ｜ 电价 ｜ 可用桩数；公厕：名称 ｜ 距离 ｜ 地址 |
| 一键导航 | 弹窗内「高德导航」按钮，或直接点击标记即唤起 `uri.amap.com/navigation`（`callnative=1`，可拉起高德 App） |
| 视图模式 | 「自动跟随实体居中」/「手动锁定视图」；手动拖动后自动暂停跟随 15 秒，避免抢镜头 |
| 附近列表 | 底部可展开的点位列表，也作为地图渲染失败时的兜底视图 |
| 可视化编辑器 | 6 个分组、全部字段可在 HA 原生卡片编辑器中配置，无 YAML 也能用 |
| 降级渲染 | JS API 加载失败 / 真不支持 WebGL / 渲染超时 → 自动切换「瓦片底图」（高德栅格瓦片直接画 canvas，v1.0.5 起默认开启），功能不丢；提示条带「重试高清底图」与「复制诊断」 |

---

## 安装

### 方式一：HACS（自定义仓库）

1. HACS → 右上角 ⋮ → **自定义存储库**
2. 仓库地址填本仓库地址，类别选 **Lovelace / Dashboard**
3. 搜索 `AMap Location Card` → 下载
4. 刷新浏览器（清缓存）

> 仓库根目录需包含 `hacs.json`、`package.json` 与 `amap-location-card.js`，本仓库已经具备。

### 方式二：手动安装

1. 把 `amap-location-card.js` 复制到 HA 配置目录的 `config/www/` 下（若无 `www` 目录请新建）
2. 设置 → 仪表盘 → 右上角 ⋮ → **资源** → 添加资源
   - URL：`/local/amap-location-card.js`
   - 类型：**JavaScript 模块**
3. 刷新浏览器

### 方式三：快速试用（不写资源）

在仪表盘的「原始编辑器」中直接引入：

```yaml
resources:
  - url: /local/amap-location-card.js
    type: module
```

---

## 高德 Key 申请（很重要）

在 [高德开放平台控制台](https://console.amap.com/dev/key/app) 创建应用，申请 **一个** Key 即可：

| 用途 | 接口 | 填到 |
| --- | --- | --- |
| 坐标转换、周边检索、地图底图 | `restapi.amap.com` + `webapi.amap.com` | `amap_key` |

同一个 Key 同时用于三件事，**不需要**再单独申请第二个 Key。

### 如果底图加载不出来

高德控制台的 Key 是有**平台类型**的。若你申请的 Key 类型不是「Web 端（JS API）」，
底图会加载失败；此时卡片会**自动降级为简化视图**（点位、弹窗、列表、导航全部照常可用），
并在卡片上给出提示条，不影响坐标转换与周边检索。

真要两者都拿满分，可在控制台再申请一个「Web 端（JS API）」类型的 Key，填到 `amap_js_key`（高级项，一般留空即可）。

### 安全密钥 securityJsCode（一般不用填）

自 **2021-12-02** 起申请的 JS API Key，若在控制台开启了「安全密钥」，
则必须配套 `securityJsCode` 才能加载底图，否则会报 `INVALID_USER_SCODE`。
此时把它填到 `security_js_code` 即可（仅底图需要，坐标转换与周边检索不受影响）。

> 我们已在脚本加载 **之前** 设置 `window._AMapSecurityConfig = { securityJsCode }`，这是高德官方要求的顺序。
> 另外，若你的 Key 配置了「数字签名」，本卡片不支持签名（签名必须在服务端完成），请改用安全密钥方式。

### ⚠️ Key 会暴露在前端

Lovelace 卡片运行在浏览器里，Key 一定会随请求发出。请务必在高德控制台为该 Key 设置：

- **调用量上限**（防止被刷爆配额）
- **域名白名单**（只允许你的 HA 域名）

> 经实测，`restapi.amap.com` 返回 `Access-Control-Allow-Origin: *`，因此浏览器**可以直连**，无需自建代理。
> 如果你对 Key 暴露零容忍，可以在高德控制台限制域名，或自行加一层反向代理（本卡片不内置代理）。

---

## 快速开始

最小可用配置（YAML 模式）：

```yaml
type: custom:amap-location-card
entity: device_tracker.my_phone
amap_key: 你的高德Key
```

一个完整的例子：

```yaml
type: custom:amap-location-card
title: 我的车
entity: device_tracker.tesla_model_y
amap_key: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
height: 380
view_mode: follow
follow_zoom: 16
radius_mode: auto          # 搜索范围 = 屏幕上的可视矩形
auto_radius_basis: cover   # 外接半径覆盖整个矩形 + 裁掉矩形外的结果
auto_radius_max: 5000
show_charging: true
show_charging_price: true
show_charging_available: true
show_toilet: true
icon_entity: mdi:car-electric
icon_charging: mdi:ev-station
icon_toilet: mdi:human-male-female
```

---

## 界面布局：只有一张地图

卡片**没有顶部标题栏，也没有底部工具栏** —— 整张卡片就是地图，操作入口全部浮在地图上：

- **右下角控件列**（自上而下）：`◎ 回到定位` → `+ 放大` → `− 缩小` → `☰ 列表`（高德底图与简化视图共用同一列，`show_toolbar: false` 可只留列表按钮）；
- **左上角状态标签**：坐标 / 坐标系判定 / 搜索范围 / 刷新时间，半透明小字，不挡操作；
- **列表**：点 `☰` 后在**地图下方**展开，头部有「跟随中 / 已锁定」「刷新」「收起」；
  铺满窗口模式下地图自动让出高度，列表自己滚动，收起后地图立刻占回全屏。

### 铺满高度会避开上下的工具栏

`fill_viewport: true` 时卡片高度**不是**简单的 `100dvh`，而是实测出来的
「可视高度 − 上方占位 − 下方遮挡」：

- **上方**：卡片顶端到视口顶的距离（HA 顶栏、侧边栏头部、浏览器地址栏都在文档流里，自然被扣掉）；
- **下方**：从视口底部向上探测贴底的 `fixed` / `sticky` 层 —— HA 移动端底部导航、
  App 原生 tab bar 的占位、浏览器工具栏都会被让出来。没有就让 0；遇到怪异布局最多让出 40% 视口。

这样右下角的「列表」按钮和展开后的列表**永远不会躲在底栏下面**点不到。
探测在加载时、窗口缩放/旋转、底栏出现或消失（resize / visualViewport 变化）时自动重算。

### 全屏显示规则（对齐 ha-map-card-recode）

高度规则参照 [lonyii/ha-map-card-recode](https://github.com/lonyii/ha-map-card-recode) 的
`map_height` 写法：**高度是一段可以自己写的 CSS，而不是被固定在某个像素值上**。
优先级从高到低：

| 顺序 | 配置 | 行为 |
| --- | --- | --- |
| 1 | `map_height`（数字或 CSS 字符串） | 直接作为地图区高度，**不再做任何视口测量**。数字 = 像素；字符串原样使用 |
| 2 | `fill_viewport: true`（默认） | 自动铺满：可视高度 − 上方占位 − 下方贴底工具栏（见上一节） |
| 3 | `fill_viewport: false` | 固定 `height`（px） |

`map_height` 的合法写法（其余一律忽略、回落到自动铺满）：

```yaml
map_height: 480                        # 数字 = 480px
map_height: "100dvh"                   # 正好一屏（推荐，扣掉了浏览器地址栏）
map_height: "100vh"                    # 一屏，但老移动端 100vh 会把地址栏算进去
map_height: "calc(100dvh - 120px)"     # 一屏再自己扣掉顶栏 + 底栏的高度
map_height: "calc(100dvh - 56px - env(safe-area-inset-bottom))"
map_height: "100%"                     # 跟随父容器高度（panel 视图 / 全屏容器里用）
```

几条与参考项目一致、也踩过坑的细节：

- **`map_height` 一旦填了，就完全不参与视口测量** —— 减多少由你说了算，
  不会出现「我以为扣了 120px，卡片又自己扣了一次底栏」的双重扣减。
- **`100%` 会让卡片跟随父容器高度**：卡片根节点会带 `.alc-h100`（`height: 100%` + flex 纵向），
  地图区 flex 撑满剩余空间，列表照常在地图下方展开。注意百分比高度要求**祖先链上有确定高度**
  （HA 的 `panel: true` 全屏视图、或你自己给了高度的容器都行）；链条上哪一层都是
  `height: auto` 时，CSS 会把 `100%` 当成无效值，地图自动退回 `min-height: 120px` 保底。
- **地图区始终带 `min-height: 120px` 保底**，写错 `calc` 也不会把地图压成一条线。
- **配置编辑器的预览里不认 `map_height`**，否则填个 `100dvh` 会把配置面板整个撑爆；
  保存后回到仪表盘才是真实高度。

## 完整配置项

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `entity` | string | **必填** | 定位实体，需自带 `latitude` / `longitude` |
| `coord_sys` | `wgs84` / `gcj02` | `wgs84` | 实体坐标所属坐标系。`wgs84`（GPS / HA Companion 等）走高德纠偏；`gcj02`（坐标本就来自高德/腾讯等国内服务）**不纠偏直接用** —— 选错会让所有点在高德底图上整体偏移约 300~600 米 |
| `amap_key` | string | **必填** | 高德 Key，一个通吃：坐标转换 + 周边检索 + 地图底图 |
| `amap_js_key` | string | — | 高级：单独指定底图 Key，留空复用 `amap_key` |
| `security_js_code` | string | — | 高级：安全密钥，仅当底图报 `INVALID_USER_SCODE` 时填 |
| `title` | string | 实体名 | 卡片名称。**顶部标题栏已取消**，此值仅作读屏 / 悬浮提示的无障碍标签 |
| `height` | number | `320` | 地图高度（px），120–1200。仅在 `fill_viewport: false` 且未填 `map_height` 时生效 |
| `map_height` | number / string | — | **全屏高度（优先级最高）**：数字 = 像素；字符串原样当 CSS 高度（`100dvh`、`calc(100dvh - 120px)`、`100%`）。填了它就不再自动测量，`fill_viewport` / `height` 都不生效。规则见上文「全屏显示规则」 |
| `fill_viewport` | boolean | `true` | 铺满浏览器窗口：高度按「可视高度 − 上下工具栏」实测（HA 配置编辑器的预览不铺满）；关闭后使用固定 `height`。填了 `map_height` 时本项不生效 |
| `view_mode` | `follow` / `locked` | `follow` | 自动跟随实体 / 手动锁定视图 |
| `follow_zoom` | number | `16` | 跟随模式缩放级别 3–19 |
| `locked_center` | string | — | 锁定中心 `经度,纬度` |
| `locked_zoom` | number | `15` | 锁定模式缩放级别 3–19 |
| `map_style` | string | `amap://styles/normal` | 高德地图样式 URI |
| `gesture` | `map` / `scroll` | `map` | `map` 地图吃掉手势（iOS 推荐）；`scroll` 页面纵向滚动优先 |
| `show_source_marker` | boolean | `true` | 显示实体主图标 |
| `show_radius_circle` | boolean | `false` | 显示搜索半径圈。默认关闭：搜索范围就是整张地图的可视矩形，画圈只会多一层视觉噪音 |
| `show_toolbar` | boolean | `true` | 显示地图右下角的「缩放 / 回到定位」按钮。关闭后只留「列表」按钮 |
| `fallback_tiles` | boolean | `true` | **无底图时的瓦片兜底**（v1.0.5）：JS 底图 15 秒渲染不出瓦片（App 内嵌 WKWebView 常见）时，自动改用同一套高德栅格瓦片直接画到 canvas —— 地图照样能看，点位/列表/检索全不受影响。关闭后无底图时只显示网格 |
| `show_scale` | boolean | `true` | 显示比例尺 |
| `radius_mode` | `auto` / `fixed` | `auto` | `auto` = 搜索范围 = 屏幕上的可视矩形（随容器尺寸与缩放自适应）；`fixed` = 用下面固定值 |
| `radius` | number | `2000` | 固定搜索半径（米），50–50000，仅 `radius_mode: fixed` 时生效 |
| `auto_radius_basis` | `cover` / `visible` | `cover` | 自动范围取法。`cover` = 外接（中心→最远角）覆盖整个可视矩形，矩形外的结果自动裁掉，**等价于按屏幕矩形搜索**；`visible` = 内切（中心→最近边），只搜画面中间一块，宽屏时两侧会漏 |
| `auto_radius_pad` | number | `1` | 自动范围系数，0.2–4。`1` = 恰好贴到可视边缘 |
| `auto_radius_max` | number | `5000` | 自动范围上限（米），100–50000，防止缩得很远时范围撑得过大。屏幕矩形本身超过上限时以矩形为准，保证四角不漏 |
| `show_charging` | boolean | `true` | 启用充电桩检索 |
| `charging_type` | string | `011100` | 充电设施 POI 类型码（可改） |
| `show_charging_price` | boolean | `true` | 充电桩弹窗显示电价 |
| `show_charging_available` | boolean | `true` | 充电桩弹窗显示可用桩数 |
| `show_toilet` | boolean | `true` | 启用公共厕所检索 |
| `toilet_type` | string | `140306` | 公共厕所 POI 类型码（可改） |
| `max_poi` | number | `20` | 每类最多显示条数 1–25 |
| `icon_entity` | string | `mdi:crosshairs-gps` | 实体图标 |
| `icon_charging` | string | `mdi:ev-station` | 充电桩图标 |
| `icon_toilet` | string | `mdi:human-male-female` | 公厕图标 |
| `icon_size` | number | `34` | 图标尺寸（px）16–96 |
| `click_action` | `popup` / `navigate` | `popup` | 点击标记：弹信息窗 / 直接唤起导航 |
| `open_in_new_tab` | boolean | `true` | `true` = 新标签打开，保留 HA 面板；`false` = 当前页跳转（若 `window.open` 被 WebView 拦截会自动回退到当前页跳转） |
| `coord_cache_ttl` | number | `300` | 坐标转换缓存秒数，`0` = 关闭缓存 |
| `poi_cache_ttl` | number | `300` | 周边检索缓存秒数，`0` = 关闭缓存 |
| `api_min_interval` | number | `400` | 两次高德请求最小间隔（ms），节流防抖 |
| `refresh_interval` | number | `60` | 实体持续移动时的最小刷新间隔（秒） |
| `price_fields` | string | 内置候选 | 电价字段映射，逗号分隔，如 `biz_ext.charge_price,biz_ext.price` |
| `available_fields` | string | 内置候选 | 可用桩数字段映射 |
| `total_fields` | string | 内置候选 | 总桩数字段映射 |
| `show_debug` | boolean | `false` | 状态栏显示请求数 / 缓存命中 / 失败数 |

---

## 坐标转换接口（强制走高德 Web 服务）

卡片**不使用本地 GCJ-02 纠偏算法**，所有坐标转换都走高德官方 HTTP 接口：

```
GET https://restapi.amap.com/v3/assistant/coordinate/convert
      ?key=<你的 Web 服务 Key>
      &locations=<经度>,<纬度>      ← 经度在前，英文逗号分隔
      &coordsys=gps                ← 源坐标系是 WGS-84（HA / TeslaMate 输出的就是它）
      &output=json
```

返回：`{"status":"1","info":"ok","infocode":"10000","locations":"116.403792,39.911491"}`，
其中 `locations` 就是 GCJ-02。

> 注意区分：`AMap.convertFrom` 是前端 JS SDK 内置的转换方法，**不是**这个 HTTP 接口。
> 本卡片把它只用作**降级链的第二级**，第一级永远是上面这个 Web 服务接口。

### 缓存与节流

| 机制 | 实现 |
| --- | --- |
| 5 分钟缓存 | `coord_cache_ttl`（默认 `300` 秒），同一坐标（精确到小数点后 6 位）不重复请求 |
| 手动强制刷新 | 列表头部「刷新」按 `force` 穿透缓存 |
| 串行节流 | 所有高德请求经 `RateLimiter` 串行，默认最小间隔 `api_min_interval=400ms` |
| 并发去重 | 相同参数的并发请求合并成一次 |
| 独立缓存池 | 坐标转换与周边检索分开缓存；缩放导致半径变化时**只清检索缓存**，不动转换缓存 |

### 容错：三层降级

| 层级 | 触发条件 | 行为 |
| --- | --- | --- |
| 1 | 正常 | Web 服务接口转换 → `via: web` |
| 2 | Web 服务失败（网络 / 限流 / 参数 / 返回异常） | 改用 JS API `AMap.convertFrom` → `via: jsapi`，并提示降级原因 |
| 3 | JS API 也失败 | 直接使用原始 WGS-84 坐标渲染 → `via: raw`，提示「点位可能存在偏移」 |

任何一层失败都**不会阻塞卡片**：标记、列表、导航照常工作。

### 错误识别（status / infocode）

`status !== '1'` 即视为失败，并把高德返回的 `info` + `infocode` 一起映射成中文提示。
内置按官方错误码表收录了关键码，例如：

| infocode | info | 提示 |
| --- | --- | --- |
| 10001 | `INVALID_USER_KEY` | Key 不正确或已过期 |
| 10002 | `SERVICE_NOT_AVAILABLE` | 该 Key 没有权限使用此服务 |
| 10003 | `DAILY_QUERY_OVER_LIMIT` | 今日调用量超限，次日 0:00 自动解封 |
| 10004 | `ACCESS_TOO_FREQUENT` | 请求过于频繁（1 分钟），下一分钟自动解封 |
| 10009 | `USERKEY_PLAT_NOMATCH` | Key 与绑定平台不符 → 坐标转换必须用「Web 服务」Key |
| 20000 / 20001 | `INVALID_PARAMS` / `MISSING_REQUIRED_PARAMS` | 参数非法 / 缺少必填参数 |
| 20011 | `INSUFFICIENT_ABROAD_PRIVILEGES` | 查询点在海外但无海外地图权限 |

排查时错误对象上带 `err.info` 与 `err.infocode`，`show_debug: true` 时可直接在控制台看到。

### ⚠️ 实测踩坑：高德对越界坐标**不报错**

```
locations=999,999  →  {"status":"1","info":"ok","infocode":"10000","locations":"999,999"}
```

越界坐标会被**原样回显**，`status=1`、`infocode=10000`，看起来完全正常。
如果照单全收，地图就会被飞到一个荒谬的位置。因此卡片在**响应侧**做了三重校验：

1. **范围校验**：返回坐标必须落在合法经纬度范围内，否则判失败；
2. **偏移量护栏**：返回坐标与输入坐标的偏差 > `0.05°` 时判失败
   （实测境内 GCJ-02 偏移 < `0.01°`，境外坐标高德原样返回、偏移为 0，所以 0.05° 只拦错乱返回、不误伤境外实体）；
3. **只缓存成功结果**：校验不通过立刻剔除该缓存项，避免坏数据在缓存里锁死 5 分钟。

另外，输入坐标本身在发出请求前就会先本地校验（实体缺经纬度 / (0,0) / 越界直接不进请求），省配额。

### 反向踩坑：`status=1` 但**转换没生效**（偏移 0）

同一个接口还有另一副面孔：Key 没开通「Web 服务」或后端降级时，它会把输入坐标**原样返回**，
`status=1`、`infocode=10000`，一样看不出异常。而境内 WGS-84 → GCJ-02 必然产生 300~700 米偏移，
原样回显就意味着**实体和检索中心一起偏了约 500 米**，且没有任何报错。

所以卡片补了一条判定：**输入在境内包围盒内、返回偏移 < 1 米** → 判定「纠偏未生效」并出提示条，
而不是让用户对着偏移去猜坐标来源。境外坐标本来就不偏移（原样返回是正确行为），不在此判定内。

---

## 搜索范围：跟随地图当前缩放

默认 `radius_mode: auto` —— 检索半径不再是写死的 2000 米，而是**由地图当前可视范围推出来**：

| 底图分支 | 半径来源 |
| --- | --- |
| 高德底图 | `map.getBounds()` 的西南 / 东北角 |
| 简化视图 | 画布尺寸 × 当前缩放级别的米/像素 |

再乘以 `auto_radius_pad`，并按 `auto_radius_max` 收敛（下限 100 米）。所以：

- **地图放大** → 可视范围变小 → 检索半径收窄，只搜眼前这一片；
- **地图缩小** → 可视范围变大 → 检索半径自动扩大，把看到的地方都搜一遍。

### 检索基点：跟随视野中心

`auto` 模式下周边检索的**基点（location 参数）不是实体坐标，而是当前视野中心**：

- 初始视野对准实体，两者重合，行为与「围绕实体搜索」一致；
- **拖动地图到别处** → 松手 600 ms 后以新视野中心为基点、按新的可视矩形重新检索 —— 看哪儿搜哪儿；
- 检索基点 = 视野中心，检索范围 = 当前可视矩形，两者自洽 ⇒ **屏幕里的点一条不漏，屏幕外一条不显示**；
- **实体移动**（HA 推送新定位）→ 视野自动跟随回实体 → 检索基点自然回到实体周边；
- `fixed` 模式不受影响，始终围绕实体坐标检索。

### 搜索范围 = 浏览者屏幕上的矩形

高德周边检索（`/v3/place/around`）只接受圆形半径，但用户要的是「我这块屏幕上能看到的范围」——
那是个矩形。两者不等价，所以卡片用两步凑出精确的矩形检索：

1. **用外接半径去搜**：半径 = 视野中心 → 屏幕四个角里最远的那个，保证整个可视矩形都在圆内；
2. **按矩形裁剪**：结果回来后只保留落在地图 `getBounds()` 里的 POI，圆内矩形外的点直接丢掉。

这样得到的结果集，与一次真正的矩形范围检索完全一致：**屏幕上看得见的 POI 一条不漏，
屏幕外的一个不显示**，地图上永远不会出现「框外的点」，也就不需要「铺满显示」这类兜底提示。

范围大小自动适配浏览者屏幕：容器越宽越高（`fill_viewport: true` 时就是整窗），
或地图缩得越远，矩形越大、自动检索半径也越大；手机竖屏则自动收窄。
`auto_radius_max` 只会限制「外扩系数」带来的额外范围，屏幕矩形本身超过上限时仍以矩形为准。

| 取值 | 半径 | 效果 |
| --- | --- | --- |
| `cover`（默认） | 中心 → **最远角**（外接圆）+ 矩形裁剪 | 精确覆盖整屏矩形，等价于按屏幕搜索 |
| `visible` | 中心 → **最近边**（内切圆） | 只搜画面中间一块。手机竖屏勉强够用，**宽屏两侧与四角会漏** |

以 1024×360 px、zoom 16、南昌纬度为例：内切 ≈ 377 m，外接 ≈ 1137 m。
内切方案在 9 个铺满屏幕的候选点里只能搜到 3 个（四角方向全丢）。
所以默认 `cover`，`visible` 只作为「就想搜中间一小块」的可选项保留。

> 想让检索范围固定、不随屏幕与缩放变化，用 `radius_mode: fixed` + `radius`。
> 固定模式不做矩形裁剪（范围是用户显式指定的），结果出画时仍有「铺满显示」按钮兜底。

配套的工程处理：

- **防抖 600 ms**：缩放 / 拖动过程中不会每帧都发请求，`zoomend` 或拖动松手后才结算；
- **12% 半径死区 + 中心移动死区**：半径变化不足 12% 且视野中心移动不足半径的 25%（至少 120 米）时不重新请求，避免来回缩放拖动烧配额；
- **只清检索缓存**：半径变了只清 `poiCache`，坐标转换结果继续复用，不会重新纠偏；
- **搜索范围圈默认不画**：范围就是整屏矩形，不需要额外画圈。想看得见范围可打开 `show_radius_circle`（高德底图用 `AMap.Circle`、简化视图用 Canvas，实时跟着视野变）；
- **定位点不钉死在画面中心**：简化视图的十字准星与半径圈画在**实体投影位置**上，地图被拖走后跟着实体偏移，不会出现「准星在这里、标记在那里」；
- **标记不越界**：地图容器 `overflow: hidden`，标记与弹窗一律裁剪在地图框内，不会盖到控件列或页面上；
- 想回到写死半径，把 `radius_mode` 设为 `fixed` 并配 `radius` 即可（缩放不再触发任何额外请求）。

---

## 需求对照表

| 需求条目 | 实现位置 |
| --- | --- |
| 任选自带经纬度的实体，无坐标则提示不执行 | `readEntityLocation()` / `_stateFromHass()` |
| 强制调用 `/v3/assistant/coordinate/convert`，`coordsys=gps` | `AmapWebApi.convertFromGps()` |
| 同坐标 5 分钟内不重复调用 | `TtlCache` + `coord_cache_ttl`（默认 300s） |
| 接口异常优雅降级 | `convertToGcj02()` 三级降级链 + 卡片内提示条 |
| 统一使用用户填入的高德 Key | `getSharedApi(key)` 全局按 Key 复用客户端（一个 Key 通吃底图 + 检索） |
| 可配置搜索半径 | `radius_mode` / `radius` / `auto_radius_basis` / `auto_radius_pad` / `auto_radius_max` |
| 搜索范围 = 浏览者屏幕矩形（随容器尺寸 / 缩放自适应） | `_currentRadius()` ← `_viewportRadiusAMap()` / `CanvasFallbackMap.viewportRadius()` |
| 矩形范围检索（高德只支持圆形） | 外接半径检索 + `_fetchPois()` 里按 `_pinInView()` 裁剪 |
| 结果点位不超出底图范围 | 上述裁剪保证 0 出界；`fixed` 模式仍有 `_checkPinsVisible()` / `_fitAllPins()` 兜底 |
| 充电桩开关 + `types=011100` | `show_charging` / `charging_type` |
| 返回距离、位置、名称、电价、可用桩数 | `buildPoiView()` + `poiPopupHtml()` |
| 电价独立子开关 | `show_charging_price` |
| 公厕开关 + `types=140306` | `show_toilet` / `toilet_type` |
| API 节流防抖，失败静默提示不炸卡 | `RateLimiter` + `_pending` 去重 + `_showNotice()` |
| 高德 JS API 底图（不用 HA 默认地图） | `amapLoader.load()` + `_createAMap()` |
| 分层标记 + 自定义主图标 | `_renderPins()` |
| 充电桩 / 公厕图标与弹窗字段 | `_poiPopupHtml()` |
| 自动跟随 / 手动锁定 | `view_mode` + `_applyView()` |
| 点击标记唤起高德导航 | `buildNavigationUrl()` + `click_action` |
| HA 原生可视化配置面板 | `AmapLocationCardEditor`（6 个分组，覆盖全部配置项） |
| 全部高德请求带缓存、节流 | `AmapWebApi._cachedRequest()` |
| 各类异常友好提示、不阻塞 HA | `_notices` 提示条系统 + 全链路 try/catch |
| iPhone Safari 兼容 | 见下一节 |
| 不写死参数，全部可配置 | 编辑器 5 组共 35+ 可配置项 |

---

## 重要限制与合规提醒

### 1. 高德 POI **不保证**返回电价与可用桩数

这是必须说清楚的一点。实测与官方文档确认：

- `/v3/place/around` 的 `biz_ext`（深度信息）**官方文档未定义子字段**；
- 官方仅说明 `rating`（评分）与 `cost`（人均消费）出现在**餐饮 / 酒店 / 景点 / 影院**类 POI；
- **充电站（`011100`）没有官方电价与空闲桩数字段**。

因此本卡片的做法是：

1. 请求带 `extensions=all`；
2. 用一组候选字段名依次探测 `biz_ext`（内置 15 个候选，如 `charge_price`、`price`、`available`、`surplus` …）；
3. 取到就展示，取不到就显示「暂无数据」并在弹窗中给出提示，**不报错、不空白**；
4. 如果你的 Key 或账号确实能拿到自定义字段，用 `price_fields` / `available_fields` / `total_fields` 直接指定字段路径即可。

> 想要**稳定**的电价与空位数，需要接入充电运营商开放平台（特来电 / 快电 / 云快充等）或自建数据源，
> 高德本身不是这类数据的提供方。本卡片已把展示层解耦，接第三方只需替换 `buildPoiView()` 里的取值逻辑。

### 2. 配额

高德个人开发者配额有限（周边搜索、坐标转换各有一档免费额度，以控制台实时数据为准）。
卡片默认开启缓存与节流就是为了尽量少烧配额。若你有多张卡片用同一个 Key，它们会**共享**同一个节流器与缓存池。

### 3. 坐标系

三个坐标来源的转换规则**各不相同**，这是最容易出「点位整体偏移」的地方：

| 来源 | 原始坐标系 | 是否转换 |
| --- | --- | --- |
| HA 实体 `latitude` / `longitude`（GPS、Companion App、GPSLogger 等） | **WGS-84** | **必须转一次**（`coord_sys: wgs84`，默认） |
| 周边检索结果 `/v3/place/around` 的 `pois[].location`（充电桩、公厕） | **GCJ-02**（高德返回时已是火星坐标） | **一次都不能转**，代码里原样透传 |
| 底图 / JS API（`AMap.Marker`、`setCenter`、`lngLatToContainer`） | 期望 GCJ-02 | — |

所以：
- 实体按 WGS-84 处理（GPS 原生坐标系，也是 `device_tracker` 的常规约定），扫描全文件只有
  `_refresh` 里那一处调用 `convertToGcj02()` 是允许的转换入口。
- 若你的实体本身已经是 GCJ-02（例如某些国产车机、高德/微信上报的位置），
  把 `coord_sys` 设成 `gcj02`，卡片会跳过转换（否则二次纠偏会整体偏 300~700 米）。
- 卡片对外展示的坐标、检索中心、导航参数**统一是 GCJ-02**。
- **API 口径校核**：检索坐标若被误转换，`distance` 与地图几何会同时对不上。
  开发侧有量测脚本对比「卡片内部 pin 坐标」与「高德原始 `location`」是否逐位相同，
  以及「按 pin 坐标算的距离」与「高德返回的 `distance`」是否一致（实测误差 ≤1 米）。

### 4. 地图数据合规

高德地图服务的使用需遵守高德开放平台的服务条款；在中国大陆地区展示地图时请使用高德提供的合规底图，
不要叠加使用未经审图的地图瓦片。本卡片仅调用高德官方 JS API 与 Web 服务。

---

## iOS App 里没有底图？（WKWebView 差异）

HA 官方 iOS App 用的是 **WKWebView**，它和 Safari 同一个内核但不完全等价，最常见的三种表现与处理：

| 现象 / 成因 | 卡片现在的处理 |
| --- | --- |
| **WebGL 探测误报**：未挂载到文档的 canvas 在部分 iOS 版本上拿不到 WebGL 上下文（Safari 里同样写法却是好的）。旧逻辑据此直接降级成简化视图 —— 表现就是「App 里没底图、Safari 正常」 | 探测改为**挂载 + 1×1 + 依次试 webgl2/webgl/experimental-webgl + 用完释放上下文**（iOS 的 WebGL 上下文配额很少，泄漏一个就可能让地图建不出来）；探测结果**只用于诊断**，真不支持时由高德自己报错再降级 |
| **容器初始尺寸为 0**：App 恢复上次视图 / 卡片在隐藏 Tab 里创建，高德在 0×0 容器上建图不会请求瓦片，之后一直是空白 | `ResizeObserver` 检测到「0 → 有尺寸」时补一次 `map.resize()` **并重新应用视野**；12 秒超时也会先做一次同样的自愈再提示 |
| **从后台回来 WebGL 上下文丢失**（画布在、瓦片没了） | 监听 `webglcontextlost` → 提示「重试」；`visibilitychange` 回到前台时若仍有异常提示，自动重建一次地图 |
| **偶发脚本/网络失败**（App 内网络切换、DNS 缓存） | 提示条「重试」重建；联网（`online`）后也会自动重试 |
| **以上全都没救回来**（JS API 在 App 里彻底起不来） | **自动换成「瓦片底图」**（v1.0.5）：同一套高德栅格瓦片绕过 JS API 直接画到 canvas，永不见白板；提示条保留「重试高清底图」与「复制诊断」 |

### 还不显示？一键复制诊断

底图相关的提示条（加载失败 / 渲染超时 / 上下文丢失）现在都带一个 **「复制诊断」** 按钮，
点一下会把下面这些信息写进剪贴板（App 里也能用），直接粘贴反馈即可定位：

```
amap-location-card v1.0.5
UA：（完整 UA，可判断是否 App 内嵌 WebView）
环境：HA App / 内嵌 WebView | 浏览器
屏幕：390×844 @3x
卡片容器：390×700          ← 0×0 说明是布局问题
地图模式：amap | fallback · 地图就绪：是/否 · canvas 数
WebGL 探测：通过/未通过 · 渲染器：Apple GPU / unavailable
Key：xxxxxx…（长度，来源 amap_key / amap_js_key）
安全密钥：已配置/未配置
JS API：v2.0 · https://webapi.amap.com/maps
视野：center 115.98912,28.63808 zoom 16
提示条：（逐条列出当前提示）
```

> 想看实时日志：iPhone 用数据线连 Mac，Safari →「开发」→ 选中 App 的 WebView 即可打开 Web Inspector。

## iPhone Safari 兼容说明

卡片针对 iOS Safari 做了以下专门处理：

| 问题 | 处理 |
| --- | --- |
| 地图白屏 | WebGL 探测**只做诊断**，不再据此提前降级（见下节）；真不支持时由高德自己报错并提示 |
| 渲染超时 | 12 秒未触发 `complete` → 先补一次 `resize` + 重新应用视野自愈，再提示「重试」并提供「复制诊断」 |
| JS API 加载失败 | 自动切换简化视图，点位、列表、导航全部可用 |
| 手势冲突（拖动地图变成滚动页面） | 地图容器 `touch-action: none`（`gesture: map`），可用 `gesture: scroll` 换成页面滚动优先 |
| 点击不触发 | 弹窗按钮走 **shadow root 事件委托**；标记容器显式设置尺寸与 `pointer-events`；按钮统一 `touch-action: manipulation` 并清除 iOS 点击高亮 |
| 100vh 抖动 | 固定高度模式使用**固定像素**（`height` 配置），不使用 `vh`；`fill_viewport` 模式按实测的可视高度定高（`100dvh` 只作 JS 未生效时的兜底），地址栏收放、旋转、底栏出现/消失都会自动重算。想完全自己掌控高度就写 `map_height: "100dvh"`（或 `calc(100dvh - 120px)`），此时卡片不做任何测量 |
| 拖动/缩放 | 高德底图与简化视图均由卡片**自管手势层**接管：单指/鼠标拖动、双指捏合、滚轮缩放、双击放大、轻点点标记开弹窗（见下节） |
| 列表滚动 | `-webkit-overflow-scrolling: touch` |

---

## 已知问题：JSAPI 2.0 × Shadow DOM（本卡片的解决方案）

高德 JS API 2.0 的拖拽/缩放管线依赖一张**透明 iframe 盾**（`opacity:0` 铺满地图），
事件全部进入该 iframe 的内部文档处理。这个管线在 **Shadow DOM** 里会断：
`mousedown` 之后事件全部失踪，地图完全拖不动、滚轮缩放无效 —— 而 Lovelace 卡片
必须运行在 Shadow DOM 中，所以这是所有 HA 自定义卡片都会踩的坑。

本卡片的处理方式：

1. **手势接管**：地图上方铺一层 `.alc-gesture`（卡片自己的 Shadow DOM 元素），
   拖拽 / 捏合 / 滚轮 / 双击 / 轻点全部由卡片接管，再把结果以
   `setCenter` / `setZoom` 等**程序化 API** 驱动高德 —— 渲染、瓦片、标记仍由高德负责。
2. **弹窗自绘**：高德 `InfoWindow` 同样收不到点击（在 iframe 盾之下），改为卡片自绘
   弹窗（`.alc-amap-pop`），跟随锚点移动、出画自动收起、点空白关闭。
3. **缩放按钮自绘**：高德 `ToolBar` 在 Shadow DOM 下不可点，改为卡片自绘 ＋/− 按钮。
4. **不要关 `zoomEnable`**：实测 AMap 2.0 里 `zoomEnable:false` 会连带禁掉
   **程序化** `setZoom` / `setFitView` 的缩放（内部耦合），所以只关 `scrollWheel`
   与 `doubleClickZoom`（防事件穿透时双重触发），拖拽/缩放开关保持开启。
5. **手势路径上的 `setZoom` / `setCenter` 第二参必须传 `true`（立即生效）**。
   AMap 2.0 里这两个 API 的第二参是 `immediately`，**不传或传 `false` 都是带动画**：
   - 捏合时逐帧 `setZoom` 会排队一堆互相打断的缩放动画，iOS Safari 上被中断的动画
     会让标记层与瓦片层脱节 →「缩放后定位点位置全错」；
   - `setCenter` 不带第二参是**动画平移**（实测 450ms 才到位），连续锚定缩放时
     上一次的平移动画被打断、中心停在半路 → 锚点漂移几十像素。
6. **捏合/滚轮锚定在指点位置**（`_amapZoomAround`）：缩放前后「手指按住的那个地点」不动，
   而不是绕地图中心缩放。锚定用 `containerToLngLat` → `setZoom(z, true)` →
   `lngLatToContainer` 反算中心偏移 → `setCenter(c, true)`，对任意投影都精确。

验证方式：无头浏览器 + CDP 真实输入事件（鼠标拖拽/滚轮、单指拖拽/双指捏合）逐项回归，
见 `.dom-test.cjs` 的 **M7 高德底图手势接管** 与 **M8 缩放锚点与弹窗重绑** 两节；
标记像素对齐量测脚本为 `alc-zoom.cjs`（捏合/滚轮前后逐标记比对，实测 0px 偏差）。

---

## 故障排查

| 现象 | 可能原因与处理 |
| --- | --- |
| 提示「高德 Key 无效或未开通该服务」 | Key 填错或不支持 Web 服务，请在控制台确认该 Key 的可用服务 |
| 提示「缺少安全密钥」/ `INVALID_USER_SCODE` | 底图需要：填 `security_js_code`（控制台「Key 详情」里的安全密钥） |
| 底图不出但点位正常 | 说明该 Key 不是「Web 端（JS API）」类型，或底图脚本被拦截 → 卡片已降级为简化视图，**看提示条里的具体原因**，详见 [底图加载不出来](#底图加载不出来先看提示条说了什么) |
| 提示「高德接口调用量已达上限」/ 报 `infocode 10003` | 配额用尽，调大 `coord_cache_ttl` / `poi_cache_ttl`、提高 `refresh_interval`，或调小 `auto_radius_max` |
| 提示「请求过于频繁」/ 报 `infocode 10004` | 1 分钟内请求次数超限，下一分钟自动解封；可调大 `api_min_interval` |
| 提示「Key 与绑定平台不符」/ 报 `infocode 10009` | 坐标转换与周边检索必须使用「**Web 服务**」类型的 Key，不能拿 JS API Key 顶替 |
| 搜不到充电桩/公厕 | **正常且无提示**（空结果保持安静，不弹提示条）。`auto` 模式下把地图缩小一点即可自动扩大范围；`fixed` 模式下调大 `radius`，或检查 `charging_type` / `toilet_type` |
| 点位有几十~几百米偏移 | 提示条显示「未纠偏（WGS84）」，说明转换接口失败了，看提示条里的具体报错 |
| **所有点都在高德底图上整体偏移约 300~600 米（方向固定）** | 两种可能，按顺序排查：① 坐标来源本身已是 GCJ-02（高德/腾讯/微信等国内 App 上报），却又转了一次 → 设 `coord_sys: gcj02`，状态栏会显示「已是高德坐标（未转换）」；② 坐标是 GPS，但**转换接口原样回显了输入**（`status=1` 却 0 偏移）→ 卡片会提示「纠偏未生效」，去控制台确认这把 Key 开通了「Web 服务」权限 |
| **结果点位跑到地图框外面去了** | 不该再出现：`auto` 模式是「外接半径检索 + 矩形裁剪」，只会渲染屏幕内的点。若仍复现，请更新到最新版本；`fixed` 模式下范围是显式指定的，出画时点提示条上的「铺满显示」即可 |
| **宽屏时两边明明有充电桩却搜不到** | 说明 `auto_radius_basis` 被设成了 `visible`（内切圆只覆盖画面中间）。改回默认的 `cover` 即可按整屏矩形搜索 |
| **iOS App 里底图空白但点位还在** | v1.0.5 起会自动换成「瓦片底图」（同一套高德瓦片、不经 JS API），不会再有白板。若看到的是网格（而非地图），检查 `fallback_tiles` 是否被关掉，或网络是否拦了 `*.is.autonavi.com` |
| **只有 HA iOS App 里没有底图，Safari 和电脑正常** | 见「[iOS App 里没有底图](#ios-app-里没有底图wkwebview-差异)」：v1.0.3 起不再因 WebGL 探测失败提前降级，并修了「容器 0 尺寸 / 后台回来上下文丢失」两条路径。若仍有问题，点提示条上的「复制诊断」把信息发出来 |
| **底图一直空白但列表有点位** | 点提示条「重试」；仍空白则点「复制诊断」看 `卡片容器` 是否为 0×0、`WebGL 探测` 是否为未通过 |
| **地图拖不动 / 滚轮不缩放** | 本卡片用手势层接管了高德底图的全部交互（JSAPI 2.0 在 Shadow DOM 下的已知缺陷，见「已知问题」一节）。请更新到最新版本；若仍复现，确认浏览器未禁用 Pointer Events（iOS 13+/现代浏览器均支持） |
| **缩放（双指捏合/滚轮）后定位点整体错位、和地图对不上** | 已修复：手势路径的 `setZoom` / `setCenter` 现在全部立即生效（带动画的调用在 iOS 上被逐帧打断后，标记层会与瓦片层脱节），且捏合改为**锚定双指中点**缩放（指下的地点不再滑走）。请更新到最新版本 |
| **弹窗开着缩放地图后，弹窗内容和图上的点对不上** | 已修复：重检索重建标记后，弹窗自动换绑到同 id 的新数据；该 POI 被新半径挤出结果时弹窗自动收起 |
| **打开配置面板后每隔两三秒整页闪一下 / 输入框失焦、刚填的值被清掉** | 已修复（v1.0.1）：编辑器等 `ha-textfield` / `ha-entity-picker` 注册后升级原生控件，旧逻辑只要其中一个存在就重建表单，在 HA 里（`ha-entity-picker` 按需加载、常常一直不注册）会变成每 2.5 秒无限重建。现在按「已渲染的能力档位」升级，同一档只升一次，且正在输入时推迟到失焦 |
| **定位十字和实体标记对不上 / 拖动地图后准星还在原地** | 已修复：简化视图的十字准星与半径圈改为画在实体投影位置上，跟着实体走 |
| 标记溢出到地图外面，盖住了页面 | 已修复：地图容器加了 `overflow: hidden`，标记与弹窗一律裁剪在地图框内 |
| 自动跟随刚点完「刷新」就自己停了 | 已修复：程序化改视野（自动跟随 / 回到定位）不再被误判成「用户拖动」，不会自我暂停 15 秒 |
| 提示「坐标转换返回越界坐标 / 偏差过大」 | 高德返回了不可信结果，卡片已主动丢弃并降级。通常是配额或 Key 权限异常，看同一条提示里的 infocode |
| 充电桩电价一直显示「暂无数据」 | 高德不返回该字段，见 [重要限制](#1-高德-poi-不保证返回电价与可用桩数) |
| 卡片显示红框报错「请指定 entity」 | 配置里 `entity` 为空 |
| 拖动地图后不再自动跟随 | 有意设计：暂停跟随 15 秒，展开列表后点「恢复跟随」可立即恢复 |

---

## 底图加载不出来？先看提示条说了什么

卡片会把「底图失败」细分成几种情况分别提示，不要只看「已切换为简化视图」这半句：

| 提示内容 | 含义 | 怎么办 |
| --- | --- | --- |
| `高德 JS API 脚本加载失败…webapi.amap.com 当前无法访问` | **网络层到不了** | 查设备网络 / DNS / 代理 / 防火墙；或浏览器 CSP 的 `connect-src`、内容拦截扩展屏蔽了该域名 |
| `高德 JS API 脚本加载失败…本身可访问，脚本是被拦截的` | **域名通，但脚本被拦** | 常见于广告拦截扩展、站点 CSP 的 `script-src`，或**沙箱化的预览环境**；换到真实浏览器 / HA 页面打开通常即恢复 |
| `地图初始化失败：…INVALID_USER_SCODE` | 缺安全密钥 | 在「高级：多 Key 与安全密钥」里填入控制台的 `securityJsCode` |
| `地图初始化失败：…INVALID_USER_KEY` 或「地图渲染异常」带 Key 提示 | Key 不是 JS API 类型 | 去高德控制台确认 Key 类型；检索与坐标转换不受影响 |
| `未配置高德 Key…` | 真的没填 Key | 配置面板里填 |

### 卡片内置的诊断

- **失败时自动探测域名**：用 `fetch(mode: 'no-cors')` 探一次 `webapi.amap.com`。
  `script` 标签不受 CORS 约束、`fetch` 受约束，所以「opaque 响应能拿到」≈「网络层是通的」，
  据此才能把上面两种失败区分开。
- **详情一律打到控制台**（不依赖 `show_debug`）：错误码、脱敏后的完整请求地址、域名探测结果，
  可以直接复制去排查。
- **网络恢复自动重试**：处于简化视图且存在底图失败提示时，浏览器 `online` 事件会触发一次自动重建，
  不需要用户手动点「重试」。离开页面时会解绑该监听。
- **反复重试不残留**：每次加载前会清掉上一次失败留下的 `<script data-alc-amap>`，避免 `head` 里堆积。

> 提示条里的那句「已切换为简化视图，点位与列表功能不受影响」是**真的**：
> 标记、弹窗、附近列表、导航链接全部走的是高德 Web 服务（`restapi.amap.com`），
> 与底图脚本是两个独立通道，底图挂了不影响检索。

---

## 本地预览（可选）

> **演示页 `demo.html` 不随仓库发布**：它预填了开发用的高德 Key，发布等于公开 Key。
> 卡片是单文件、无构建，任意静态页面都能挂载；需要可视化调试时在本地保留一份 demo 即可。

本地这份 demo 的默认设置：

- 高德 Key 已预填（测试坐标：**南昌市青山湖区罗家镇观田一带**，实体位置 `115.984158, 28.641333` WGS-84）；
- 默认**加载真实高德底图**（取消勾选「加载真实高德底图」即切回简化视图）；
- 坐标转换**透传真实高德接口**，保证与真实底图对齐；
- 周边检索默认走**真实接口**；勾选「Mock 检索」切换为本地构造数据（点位围绕检索中心随机散布，名称地址均为虚构，地图左上角有「Mock 演示数据」角标）；
- 搜索范围默认「自动 · 跟随地图缩放」，侧栏实时显示当前生效半径，**缩放地图即可看到半径与结果同步变化**。

侧栏还可以模拟各种异常：接口限流报错（infocode 10003）、返回空结果、接口延迟、
坐标转换网络异常（HTTP 500）、坐标转换限流（infocode 10004）、坐标转换越界回显、
实体无经纬度。右下日志会打印每一次被拦截的高德请求。

---

## 开发

```bash
# 语法检查（CI 里跑的就是这一句）
node --check amap-location-card.js
```

完整测试脚本（`.smoke-test.cjs` / `.dom-test.cjs` / `.demo-check.cjs` / `.geo-audit.cjs`）
**仅本地保留，不随仓库发布**。本地运行方式：

```bash
node .smoke-test.cjs   # 143 项：坐标校验 / 距离 / 缓存 / 节流 / POI 解析 / 字段探测 / 链接构造 / 降级链 / 转换响应侧校验 / infocode 映射 / 底图失败诊断 / 投影 / 半径配置
node .dom-test.cjs     # 231 项：jsdom 真实渲染 —— 两种地图分支 / 标记 / 弹窗 / 列表 / 事件委托 / 编辑器（含控件升级不得定时重建）/ 自动半径与拖动重搜 / 转换异常降级 / 建图抛错 / 联网自动重试 / 生命周期（需 npm i jsdom）
node .demo-check.cjs   # 77 项：demo 页 DOM 引用完整性、预填 Key 与坐标、脚本语法、配置项拼写、失败可排查性
```

测试在 Node / jsdom 中桩掉浏览器全局后加载**同一份源码**，因此测的就是发布的那份文件，
不存在构建产物与实际代码不一致的问题。`.dom-test.cjs` 会注入一个假的 `AMap` 对象
（含可调的 `getBounds()`、快照语义的 `getCenter()`、`lngLatToContainer` /
`containerToLngLat` 投影），从而覆盖高德底图分支（Map 创建、Marker 位置与内容、
自绘弹窗、手势层拖拽/滚轮/捏合/轻点命中、`setFitView` 铺满显示、Circle 半径圈、
控件挂载）与简化视图分支（Canvas 绘制、视口裁剪、标记 DOM）。

### 发布

```bash
./push.sh                 # 一键提交并推送（只提交关键文件）
./push.sh -n              # 预演：只打印将要提交的变更，不提交
./push.sh -m "fix: xxx"   # 自定义提交信息
./push.sh --with-tests    # 连测试脚本一起发布
```

Windows 上直接 **双击 `push.cmd`** 也行（自动定位 Git Bash，跑完停住让你看结果）。
`.cmd` 必须用 CRLF 换行，`.gitattributes` 已固定该规则，`push.sh` 每次运行也会自动纠正。

发布白名单：`amap-location-card.js`、`README.md`、`hacs.json`、`package.json`、
`.gitignore`、`.github/`。`demo.html` 与测试脚本被 `.gitignore` 挡在仓库外
（demo 内含本地 Key，绝不外发）。

### 目录结构

```
ha-amap-location-card/        # GitHub 仓库（只含发布文件）
├── amap-location-card.js     # 卡片本体（唯一交付物，单文件免构建）
├── hacs.json                 # HACS 元数据
├── package.json
├── README.md
├── push.sh                   # 一键发布脚本
└── .github/workflows/validate.yaml

本地额外保留（不发布）：
├── demo.html                 # 可视化验收页（含预填 Key）
├── .smoke-test.cjs / .dom-test.cjs / .demo-check.cjs / .geo-audit.cjs
```

---

## License

MIT
