# 本地分支改造说明（fork tuning）

基于上游 `tashfeenahmed/freellmapi` **v0.16.27**（2026-11-12 的提交，比九月的快照领先 307 个提交）。
目标是「只用免费额度」这一件事做了六项改造，集中在 `server/src/services/` 下新增的三个服务
+ 一个只读迁移 + `routes/tuning.ts`，路由和目录同步只做挂载式的最小侵入。

选 v0.16.27 当基线而不是九月的旧快照，是因为上游这四个月修掉的问题正好砸在这几处：
#1628（`auto:` 别名被全局策略覆盖导致「排序不生效」）、按模型独立计费的新额度逻辑、
#1348（内置厂商 `/models` 发现）、`provider-quota` 与 `model-probe`。
在旧快照上重写这些等于白干。

## 先说三个被实测推翻的传闻

上游文档和社区里反复出现的说法，有一条经不起验证，改造方案因此改过一次：

1. **「免费版目录 30 天才更新一次」——不成立。**
   2026-11-13 匿名 `GET https://api.freellmapi.co/v1/latest` 返回
   `version: 2026.11.12`、`generatedAt: 2026-11-12T13:25Z`，也就是**昨天**的快照。
   `tier: "monthly"` 描述的是「这份数据给谁用」，不是「多久重建一次」。
2. **「带 license 就能强制走 live」——做不到。**
   带伪造 Bearer 请求，返回的仍是同一版本、同一个 `monthly` tier：tier 由服务端按 license
   是否有效决定，客户端没有开关。所以本分支不去改 tier 协商，而是把轮询间隔做成可配置并默认
   缩到 3 小时（一次条件 GET，没变化就是 304），再加一个「立即刷新」按钮。
3. **「目录里有价格字段可以判断免费/收费」——没有。**
   实测 v2026.11.12 的模型条目字段只有 platform / modelId / 排名 / 限流 / 上下文 / 能力标记，
   与价格无关。所以免费/收费只能靠两路证据：模型 id 约定（OpenRouter 的 `:free`）和真实价格探测。

## 六项改造

### 1. 数据层：`20261001_000001_model_cost_tier.ts`

文件名日期是 `20261001`（而不是写作时的 2026-11-13），因为它必须排在上游那条
`2026-10-02` 起的快照类迁移**之前**：后面的迁移会把 `SELECT * FROM models` 整表快照进
`settings`，如果本迁移排在它们之后，回放时快照里的列与最终 schema 不一致，
`roundtrip` 测试就会挂。改动只影响文件名顺序，不影响任何已部署实例的迁移记录。

- `models.price_tier` —— `'free' | 'paid' | 'unknown'`，默认 `'unknown'`。
  默认值的取舍：目录本身不含任何价格字段（实测 v2026.11.12），把 1300 个模型一律标成「免费」
  只是让面板说谎；标成「收费」又会让所有老装置在升级瞬间全部禁用。`unknown` 照常参与路由，
  真正的判定只在有正面证据时写入（`:free` 后缀、价格全零、或手动刷新）。
- `models.capability_tier` —— `1` 前沿 / `2` 强力 / `3` 补充 / `4` 垃圾 / `0` 未评级。
- `models.price_note`、`models.limit_scope` —— 展示用和「限额按模型还是按账户计量」的覆盖位。
- 新表 `provider_limits` —— 每平台一套 RPM/RPD/TPM/TPD/并发/计量范围。
- 新表 `model_denylist` —— 为后续「永久拉黑某模型」预留，目前无写入方。

### 2. 路由层：收费模型过滤（`services/cost-tier.ts` + `router.ts`）

过滤点放在 `orderChain()` 里，而不是九个建链 SQL 里。原因很直接：九个查询分属
profile / group / alias / global-sort 等不同路径，漏掉一个就等于留了一条收费模型的暗道；
而所有路径最终都会经过 `orderChain`，一处过滤等于全覆盖。

`unknown` **不**过滤。绝大多数上游根本不公布价格，把「未知」当「收费」会把 493 个模型砍到个位数。

### 3. 目录同步（`services/catalog-sync.ts`）

- 轮询间隔从硬编码 12h 改为可配置，默认 3h；`CATALOG_SYNC_INTERVAL_MS=0` 关闭定时（启动同步与手动刷新仍可用）。
- 每次 apply 之后重算一遍 `price_tier`（在事务外，避免拉长写锁窗口）。

### 4. 能力分级（`services/capability-tier.ts`）

按目录 `intelligence_rank` 分档：≤20 一档、≤60 二档、≤150 三档、其余四档；再叠加一串
明确的垃圾 id 特征（亚 1B 演示模型、embedding/rerank、审核端点、图文音模型）。
「小但强」的模型刻意不列（Gemma 4 26B、Qwen3-27B、Nemotron Nano 都是三档）。

`resortChainByCapability()` 是「按能力重排链路」，它只改 `fallback_config.priority`，
不动启用状态。手工排序的价值在于「这是我要的顺序」，所以能力档位只用来**生成**顺序，
不在每次路由时覆盖它——上游 #1628 修的就是这类「排序不生效」的问题。

### 5. 厂商限流（`services/provider-limits.ts` + `ratelimit.ts`）

上游把 `nvidia: 40` 写成了**账户级**每分钟闸门，但 NVIDIA NIM 的 40 RPM 是按**模型**计量的：
不同模型 id 各自 40，账户级闸门把本来不冲突的模型串行化了。这次改成 `scope='model'` 存表。
同理补上 OpenRouter `:free`（20 RPM / 50 RPD，RPD 全模型共享）、AMD（20 RPM + 8 并发）、
Agnes（10 RPM）等。

解析顺序：`PROVIDER_*_CAP_*` 环境变量 > `provider_limits` 表（仅当 scope='account'）> 硬编码默认。
scope='model' 的档位永远不会被当成账户闸门读——那正是上面那个 bug 的成因。

### 6. 一键刷新（`services/model-refresh.ts`）

逐个问已配置厂商的 `GET /models`，把新增模型并进来（收费和垃圾默认禁用），
重算能力档位。**从不删除**：上游列表分页或临时故障时，删行会直接清空链路。

这条基本是复用上游 #1348 已有的管道——`builtin-model-discovery.discoverBuiltinModels()`
已经处理了密钥解密、单键代理（#590）和错误映射，只是它只对一份白名单平台、按调度跑。
这里把入口开放给所有已配置平台并改成手动触发，另外补上两个上游没有的东西：回来的模型要有
价格判定，以及它落在哪个能力档、是否进 profile（不进 profile 的模型永远路由不到）。

## 接口

全部挂在 `/api/tuning`（需要登录）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/summary` | 免费开关 + 价格/能力档统计 + 已启用数 |
| PUT | `/free-only` | `{ enabled: boolean }` |
| POST | `/disable-paid` | `{ reclassify?: true }` 先重算再禁用 |
| POST | `/enable-free` | 反向操作，只动免费档 |
| POST | `/junk` | `{ action: 'recompute' \| 'disable' \| 'resort' \| 'all', confirm?: true }` |
| GET | `/limits` | 全部「已配置」的厂商限流行 |
| GET | `/limits/roster` | **每一个已注册厂商**：官方额度说明 + 可编辑配置，未配置也给一行 |
| PUT | `/limits/:platform` | 局部更新，未传字段保持原值 |
| POST | `/limits/seed` | 重新播种内置档位（不覆盖已存在行） |
| POST | `/refresh` | `{ platforms?, skipKeyless?, recomputeTiers? }` 刷新**全部**厂商模型 |
| GET | `/routing-tiers` | 梯队开关、轮数、各档模型数 |
| PUT | `/routing-tiers` | `{ enabled?, rounds? }`，轮数夹在 1–10 |
| POST | `/routing-tiers/assign` | `{ includeManual? }` 按能力自动分组 |
| GET | `/routing-tiers/models` | `?tier=&q=&limit=` 可编辑的成员列表 |
| PUT | `/routing-tiers/models/:id` | `{ tier: 1\|2\|3 }` 手动移动单个模型 |

前端入口：侧栏 Analytics → **Tuning**（`/tuning`）。「一键刷新所有厂商免费模型」就在这一页**最上面**，
页面标题右侧也放了同一个按钮。侧栏 Analytics 的下拉菜单里另有「最近调用」。

---

## 第二轮：本地化收尾（v0.16.29）

第一轮只解决了「免费额度」这一件事，界面和可观测性没跟上。这一轮按实际操作路径重做。

### 1. 一键刷新覆盖所有厂商

旧实现从 `api_keys` 反推要问谁：没配密钥的厂商**连报告里都不出现**。
现在改为从 `getAllProviders()` 枚举全部已注册厂商：

- OpenAI 兼容 + 有可用密钥 → 逐个问 `/models`（仍串行，避免触发对方限流）；
- OpenAI 兼容 + `keyless` → 用空凭据匿名问（适配器本来就不发 `Authorization` 头）；
- 其余（Google / Cohere / 搜索 / 决策 / 媒体适配器 / 自定义端点）→ 进 `skipped`，附**具体原因**。

报告新增 `skipped[]` 与 `providersRegistered / platformsSkipped`，前端可展开逐家看为什么没刷。
仍然**只增不删**：上游没列出的模型只报 `missing`，不会因为分页或临时故障清空链路。

### 2. 三梯队 + 可配轮数

新增迁移 `20261002_000001_model_routing_tier.ts`：`models.routing_tier`（默认 3）、
`routing_tier_source`（`auto` / `manual`）。服务和设置见 `services/tier-routing.ts`：
`routing_tier_enabled`（默认开）、`tier1_rounds`（默认 2，上限 10）。

`buildTierWalkOrder()` 把策略排好的链展开为：第一梯队走 N 遍 → 第二梯队 → 其他梯队。
接入点在 `router.ts` 的 `routeRequest()`，位于所有建链路径汇聚之后、发请求循环之前。
同一梯队内部保持策略原顺序；重复出现的第一梯队行不是重复发请求 ——
`skipModels` / `skipPlatforms` 已经记下上一轮被排除的行，第二轮只会重试仍可能恢复的
（例如刚 429 的），硬失败直接跳过。

「按能力自动分组」把能力档 1→第一梯队、2→第二梯队、其余→其他梯队；
`routing_tier_source='manual'` 的行永不被覆盖，除非显式勾选「连手动指定的也覆盖」。
前端提供按梯队筛选、搜索、逐行下拉改梯队。

**默认分组不是空话**：迁移给每行 `routing_tier=3`，若不做初始化，开机时第一梯队是空的、
「默认优先第一梯队」会变成空转。所以 `ensureDefaultRoutingTiers()` 挂在三条数据落地路径上：
开机引导（`index.ts`）、目录同步 apply 之后（`catalog-sync.ts`）、一键刷新之后（`model-refresh.ts`），
都在 `recomputeCapabilityTiers()` 之后调用。它等价于 `assignRoutingTiersByAbility(db, false)`：
把 `auto` 行按最新能力档重新分好，但 `manual` 行原地不动 —— 用户手改过的模型，
重启、目录同步、刷新都不会把它挪走。有专门测试覆盖「开机后第一梯队非空」和「后续 sync 不覆盖手动行」。

### 3. 分析页顶部一键看最近调用

- 顶栏 **Analytics 下拉菜单**新增「最近调用」→ `/analytics?recent=1`，`AnalyticsPage` 读到就弹窗；
- 页面标题右侧同一个按钮，标题正下方还有一条**实时状态条**，直接显示最近一次
  「请求模型 → 实际厂商 / 实际模型 → 成功或失败 → 错误摘要」，不用滚到图表底部；
- 弹窗列出时间 / 请求模型 / 实际厂商 / 实际模型 / 结果 / 尝试数 / 耗时 / 错误，
  打开期间每 5 秒刷新；点任意行进入原有的故障转移链路详情（每家厂商、每个模型、每把密钥）。
- 命令面板（Ctrl/⌘ K）也加了「调优」和「最近调用」两个入口。

### 4. 全部厂商限制：一个界面说明 + 配置

`services/provider-roster.ts` 提供 `providerLimitRoster()`：
遍历**全部**已注册厂商，每个都带 `name / kind / keyless / quotaFacts / notes / limits`。
`QUOTA_FACTS` 里逐家写明官方免费额度的形状（共享日配额、月信用点、按模型计量、
需要实名/Telegram 验证、只有付费没有免费档……），没有公布数值的就直说没有，不编数字。
调优页表格把「官方说明」和「本地实际生效的 RPM/RPD/TPM/TPD/并发/计量范围/备注」并排，
可搜索、可只看已生效、可逐行编辑保存（空 = 不额外限流）。

### 5. 移除高级 / 检查更新 / 升级

- 设置对话框删掉「Advanced」分区（只剩 General / Compression / Preview）；
- 顶栏账户菜单去掉「Upgrade」「Check for Updates」，顶栏去掉 Premium 入口；
- 命令面板去掉 Premium 页，改指向 Tuning / 最近调用；
- `/premium` 路由重定向到 `/tuning`；搜索就绪提示里的 premium 链接改指 Tuning；
- 移除更新提醒、新构建提示、更新对话框的挂载；
- 桌面端托盘菜单删掉「检查更新」，`initUpdater({ autoCheckEnabled: () => false })`
  关掉后台自动检查（IPC 仍保留，避免 preload 兼容问题）。
- `PremiumPage.tsx` / `updates-dialog.tsx` 等文件**保留但不挂载**：以后再合上游时少一堆冲突，
  但用户界面里已经完全没有许可证、升级、检查更新的入口。

### 6. i18n

60 个语言包补齐本轮 57 个新键（`nav.recentCalls`、`tuning.tier*`、`tuning.roster*`、
`tuning.reason*`、`analytics.quickView*`），简/繁中文给了对应文案，其余沿用英文。
`node scripts/check-i18n.mjs` → 60 locales / 1374 keys 通过。

### 版本

桌面版本 `0.16.29`（`desktop/package.json` 与 lock 同步），发布 tag 必须是 `v0.16.29`，
工作流的「Verify desktop version matches the tag」会校验。

## 第三轮：把入口提到顶栏 + 逐功能截图自检（v0.16.30）

用户反馈「没看到分组、也没看到按厂商配置，最近调用要做成顶栏菜单，不要下面的，
每个功能做完了要截图自己查看验证」。查下来功能其实都在，但**入口埋得太深**：
分组和厂商配置在 `/tuning` 页面，而 `/tuning` 挂在「分析」下拉里；最近调用同理。
这一轮把入口提到顶栏一级，并用 Playwright 驱动本机 Chrome 真跑一遍、逐屏截图核对。

### 1. 顶栏新增两个一级入口

顶栏现在是：模型 / 试验场 / 密钥 / 智能体 / 分析 / **分组与厂商** / **最近调用**。

- **分组与厂商**：split control。点文字进 `/tuning`，点右侧箭头出下拉：
  「模型分组」`/tuning?section=tiers`、「厂商配置」`/tuning?section=providers`、
  「一键刷新所有厂商免费模型」`/tuning?section=refresh`。
- **最近调用**：一级按钮，**在当前页直接弹窗**，不跳走 —— 正在试验场调参时也能一眼看到
  是哪家厂商哪个模型在服务、成功还是失败。

实现要点：

- `components/recent-calls-quick-view.tsx`（新）：把「最近调用」弹窗从 `AnalyticsPage`
  里抽成独立组件。`RecentCallsDialog` 自带取数（`/api/analytics/requests?range=24h&limit=100`，
  打开期间 5 秒刷新），所以任何页面都能开；`AnalyticsPage` 继续复用同一个
  `RecentCallsQuickView`，两个地方共用 React Query 缓存。
- `App.tsx`：`navItems` 的类型放宽成 `{ to, labelKey, action? }`，`action: 'recent-calls'`
  的条目渲染成按钮而不是链接，桌面顶栏和移动端菜单各一份。
- `TuningPage.tsx`：三张卡片加 `id`（`tuning-refresh` / `tuning-tiers` / `tuning-providers`），
  读 `?section=` 后 `scrollIntoView` 并给目标卡片加 `ring-2 ring-primary` 高亮。

### 2. 逐功能截图自检（本机 Chrome + playwright-core）

不装浏览器，直接用本机 Chrome：`playwright-core`（`--no-save`）+ `executablePath` 指向
`C:/Program Files/Google/Chrome/Application/chrome.exe`。脚本落在 `D:\tmp`（临时产物不进仓库）。

走查结果（全部 0 console error）：

| 功能 | 验证方式 | 结果 |
| --- | --- | --- |
| 顶栏一级入口 | 读 `header nav` 文本 | 模型 \| 试验场 \| 密钥 \| 智能体 \| 分析 \| 分组与厂商 \| 最近调用 |
| 最近调用弹窗 | 点顶栏按钮 → 读弹窗 DOM | 弹窗可见，列 = 时间/请求模型/提供方/实际模型/状态/尝试次数/延迟/错误 |
| 分组与厂商下拉 | 点 chevron → 截图 | 模型分组 / 厂商配置 / 一键刷新所有厂商免费模型 |
| 梯队分组 | `/tuning?section=tiers` | 第一梯队 3、第二梯队 109、其他梯队 354；轮数可配（默认 2，上限 10） |
| 编辑梯队成员 | 点「编辑梯队成员」 | 成员表展开，200 行可逐个改梯队 |
| 厂商配置 | `/tuning?section=providers` | 90/90 家厂商，每行 7 个输入项 + 计量范围下拉 |
| 限额保存 | 改 RPM=7 → 点「保存」 | toast「已完成」，`provider_limits` 里 agnes 的 rpm 由 10 改成 7（随后已还原为 10） |

### 3. 顺手修掉的一个真 bug

下拉第三项原本写成 `tuning.navRefreshAll`，但这个键并不存在，界面直接显示键名。
改用已存在的 `tuning.refreshAll`。并补了一个**全项目静态 i18n 键扫描**脚本
（扫 `t('x.y')` 静态调用，比对 `en.json`）——生产代码 0 缺失，剩下 2 处都在测试文件里。

### 版本

桌面版本 `0.16.30`（`desktop/package.json` 与 lock 同步），发布 tag 必须是 `v0.16.30`。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `CATALOG_SYNC_INTERVAL_MS` | 目录轮询间隔，默认 `10800000`（3h），`0` 关闭定时 |
| `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` | 覆盖账户级每分钟限额，`0` 关闭该闸门 |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` | 同上，按天 |
| `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` | 同上，按天 token |
