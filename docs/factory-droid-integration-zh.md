# Factory Droid（droid）用量接入

Factory AI 的 CLI 叫 `droid`（数据目录 `~/.factory`，`FACTORY_HOME` 可改），和 Factory 平台同名。这次只接**用量**：droid 还没做成 CC Switch 的应用（没有 `AppType`），所以没有供应商卡片、MCP、Skills、会话浏览，用量页里它是个没有品牌图标的筛选档（两位字母标记 `Dr`）。

## 数据在哪

```text
~/.factory/sessions/<workspace-slug>/<session-id>.jsonl          事件流（有每次调用的模型，没有用量）
~/.factory/sessions/<workspace-slug>/<session-id>.settings.json  权威元数据 + 累计 token
```

老版本把会话平铺在 `sessions/` 下，两种布局都扫；`.settings.json.bak` 是上一版快照，不读。明细进 `proxy_request_logs`，`data_source = 'droid_session'`、`app_type = 'droid'`，没有供应商归属的用量归到占位供应商 `_droid_session`（用量页显示为 **Factory Droid (Session)**）。

## 为什么是「按天 × 模型摊」

droid **不写逐条请求的用量**。本机实测（2026-11，192 个真实会话）：`message` 行只有 `role`、`content`、`modelId`、`apiProvider`、`reasoningEffort`；整场会话的累计计数器只写在旁车文件里，而且边跑边整份重写。所以拿不到「这一次调用用了多少 token」。

摊法：把正文里 `role = assistant` 的行当作一次模型调用的锚点，按「日期 × 模型」分组计条数，两次同步之间的累计差值按条数占比分摊，`created_at` 取组内最后一次调用的真实时间戳。

依据（本机 56 个单模型会话实测）：每次调用的 `outputTokens` 中位 947、`cacheReadTokens` 中位 74084，同一会话里上下文大小基本恒定，所以**按调用次数摊**是一阶近似里最靠得住的。

不摊就会错得更多 —— 本机实测：

| 现状（一场会话一行） | 影响 |
| --- | --- |
| 旁车的 `model` 只是**最后一次选择**的模型 | 26 个会话中途换过模型，占 **53.5% 的 token**；其中一个旁车写 `glm-5.2`，正文实际是 `claude-opus-4-8` / `claude-sonnet-5` / `glm-5.2` / `kimi-k2.7-code` |
| 时间只能取旁车文件的修改时间 | 21 个会话跨自然日，占 **44.8% 的 token**，全压在最后一天 |

改成分摊后，同机对比：覆盖天数 55 → 68；`2026-10-10` 从 229.0M 降到 57.9M（那 229M 里的大部分其实发生在 10-09）；`claude-sonnet-5` 169.4M → 306.3M、`glm-5.2` 268.5M → 145.6M；总量守恒（2,117,299,172 token 一分不差）。

**这是估算**：token 总量是测出来的（旁车累计），「哪一天、哪个模型」的切分按调用次数算。请求条数同样取决于同步间隔（自动同步 10 分钟一轮），一轮里的多次调用会合并到同一个分组。`latency_ms` 记 0：会话级只有 `assistantActiveTimeMs`，没有单次计时。

## 字段语义（本机实测）

| 字段 | 结论 |
| --- | --- |
| `tokenUsage.inputTokens` | **不含缓存**。缓存型会话里它比 `cacheReadTokens` 小两三个数量级（例：3.9M / 124M），所以按 `INPUT_TOKEN_SEMANTICS_FRESH` 记账，droid **不进** `CACHE_INCLUSIVE_APP_TYPES` |
| `tokenUsage.outputTokens` | **已含 `thinkingTokens`**。`lastCallTokenUsage` 里根本没有 thinking 字段，thinking 是 Factory 自己按推理内容算的拆分，不能再加一次 |
| `tokenUsage.cacheReadTokens` / `cacheCreationTokens` | 单列，不从 input 再扣 |
| `inclusiveTokenUsage` / `childInclusiveTokenUsageBySessionId` | 含子代理，**不用**：`tokenUsage` 只含本会话，子代理会话自己也有旁车文件，各算一次就不重复 |
| 计数器单调性 | 不严格单调。71 个带 `.bak` 的会话里 1 个被清零重写，所以增量按分量饱和相减，回退当作「从 0 重新开始」，绝不写负数 |
| 旁车 mtime vs 正文最后一条消息 | 中位差 0 秒、最大 116 秒，可当作「这次调用发生的时刻」；只有拿不到锚点时才退回它 |
| 老版本正文没有 `modelId` | 47 个会话（占 21.3% 的 token）的 assistant 行只有纯 `tool_use` 块。这类锚点**照算时间和条数**、模型留空，摊的时候归到旁车给的模型上 |

## 导入规则

- 一个旁车文件第一次被看到时，累计值就是这场会话的历史总量；之后每次只记增长的部分。
- 游标（`session_log_sync.parser_state`）存三样东西：累计水位、正文已扫到的字节位置、每个「日期 × 模型」的调用条数与最后时间。和明细同一个事务提交，明细被保留策略剪掉后不会被重新导入一次。
- 正文按字节增量扫，写到一半的尾行留到下一轮；文件被重写（变短）就从头重扫。
- `request_id = droid:<session-id>:<批次序号>:<日期>|<模型>`，同时在 `session_usage_dedup` 留永久收据。
- 文件按「修改时间 + 大小」跳过；只有正文变了而旁车没变时不重复导入。

## 模型与费用

旁车/正文里的模型名是 Factory 自己的写法，查价前归一：

- `custom:<显示名>-[<方案名>]-<序号>`（自带 Key 的卡片）→ 取显示名，如 `GLM-4.7`；
- `<供应商>/<模型>`（BYOK）→ 由查价层剥前缀；
- 精确名查不到价格时，再试去掉末尾 1~2 位序号的变体（`AG-Gemini-3.1-Pro-(High)-3` → `AG-Gemini-3.1-Pro-(High)`）。模型名本身可能就以数字结尾（`claude-fable-5`），所以精确命中优先。

本机实测的模型几乎全部命中价格表（`claude-*`、`kimi-k2.x/k3`、`glm-5.x`、`minimax-m2.7`、`gpt-5.6-*`、`gemini-3-flash-preview`），只有用户自起的卡片名（`custom:AG-…`）查不到，费用记 0 —— 不代表免费。

## 旧口径的自愈

`heal_legacy_state()` 在每轮同步开头把「只跑过开发版」的状态清掉再整份重导，只碰 `data_source='droid_session'` 的行与 `droid:` 开头的游标：

- **毫秒时间戳**：早期开发版把 `created_at` 按毫秒写进库，时间落到五万年后，用量页任何日期范围都筛不到；
- **v1 游标**：一场会话一行的旧口径，明细整场落在一天里，换成按天 × 模型分摊后必须重来。

## 没做的部分

- `AppType::Droid`、`APP_SPECS` 条目、应用页/侧栏/深链接/会话浏览，以及用量页里带品牌图标的筛选档。要做得先解决 Factory 的 live 配置写入（`~/.factory/settings.json` 只有 `sessionDefaultSettings.model`，BYOK 卡片的 key 与定义不在这个文件里）。
- 供应商归集：旁车只记模型，不记用的是哪张卡，所以全部落在 `_droid_session`。

## 验证

```bash
cargo test --lib droid
# 用真实数据目录核对（192 个会话文件、207 行明细、token 总量 2,117,299,172）
CCS_DROID_SMOKE_HOME=~/.factory cargo test --lib real_droid_home -- --ignored --nocapture
pnpm vitest run tests/components/usageProviderLabel.test.ts
```

单元测试覆盖：多模型跨天分摊与总量守恒、只记增量、计数器清零重来、无 `modelId` 时按天摊、正文锚点解析（`tool_use` 续块不算新调用、增量不重复计数）、`.bak` 与空 `tokenUsage` 跳过、`inclusive` 不参与、`custom:` 名归一、旧口径自愈、除不尽时余数分配。
