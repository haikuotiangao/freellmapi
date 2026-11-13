# 本地分支改造说明（fork tuning）

基于上游 `tassfeenahmed/freellmapi` **v0.16.27**（2026-11-12 的提交，比九月的快照领先 307 个提交）。
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

### 1. 数据层：`20261113_000001_model_cost_tier.ts`

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
| GET | `/limits` | 全部厂商限流配置 |
| PUT | `/limits/:platform` | 局部更新，未传字段保持原值 |
| POST | `/limits/seed` | 重新播种内置档位（不覆盖已存在行） |
| POST | `/refresh` | `{ platforms?: string[] }` 刷新厂商模型 |

前端入口：侧栏 Analytics → **Tuning**（`/tuning`）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `CATALOG_SYNC_INTERVAL_MS` | 目录轮询间隔，默认 `10800000`（3h），`0` 关闭定时 |
| `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` | 覆盖账户级每分钟限额，`0` 关闭该闸门 |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` | 同上，按天 |
| `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` | 同上，按天 token |
