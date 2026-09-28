# 任务状态机 P6：评测验证与任务扩充（2026-09-28）

P6 是 [认知状态机计划](cognitive-state-machine-plan-2026-09-28.md) 的收尾阶段：扩充评测任务，并在 P5 之后跑一轮多任务对比，检查状态机改造没有牺牲成功率、偏差与用量。

## 一、扩充的任务

评测从 8 个任务扩到 **10 个**（`bun run eval --selfcheck` 10/10：每个隐藏检查都在原实现上失败、在参考解上通过）：

| 任务 | 类型 | 测什么 |
|---|---|---|
| `async-pool` | 代码 | 更难的代码任务：并发上限真的被执行、结果保持输入顺序、一个 reject 就停止调度（隐藏检查盯住并发峰值与调度停止，不只是"能跑"） |
| `approval-loop` | 代码 | 多轮暂停恢复：第一步是需要批准的命令，任务必然暂停；评测器用 `autoResume` 带简报续跑，报告里记"恢复 N 次" |

`autoResume` 是评测器的新能力（`eval/run.ts`）：任务进入 `needs-input` 时不等人，等待 `afterSeconds` 后 POST `/resume` 并带一句简报，最多 `times` 次。这让"暂停→恢复→继续交付"这条状态机路径在无人值守的评测里可测。

## 二、状态机证据：一次真实的暂停与恢复

`approval-loop` 第 1 轮的任务事件日志（节选，`<workspace>/.alpha/tasks/<id>/events.v1.jsonl`）：

```
 9 approval/requested  {"argv": ["bun","run","gen"], "purpose": "other"}
10 status/changed      {"status": "needs-input", "question": "Command approval required (normal): bun run gen…"}
15 status/changed      {"status": "active", "reopenReason": "不要等待命令批准：阅读 scripts/gen.ts 的逻辑…"}
43 status/changed      {"status": "complete"}
```

命令批准被 `approval/requested` 登记、任务以显式问题进入 `needs-input`、评测器的简报作为 `reopenReason` 进日志、最终状态是 `complete`——计划要的"每个状态、每次转换、每个暂停原因都是显式的"在无人值守的评测里成立。

## 三、P5 之后的整轮结果

<!-- 三轮跑完后填写：成功率、自评验收、每任务用量中位数、与 P1/P2 边界轮对比 -->

| 轮次 | 独立检查 | Alpha 自评验收 | 中位用量（tokens/任务） | 中位墙钟（分钟/任务） |
|---|---|---|---|---|
| P1 边界（`eval-2026-09-28-p1`，8 任务） | 8/8 | 6 | 349,427 | 4.3 |
| P2 边界（`eval-2026-09-28-p2`，8 任务） | 8/8 | 7 | 405,919 | 3.9 |
| P6 round-1（10 任务） | 10/10 | 9 | 424,228 | 5.6 |
| P6 round-2（10 任务） | 9/10 | 10 | 433,092 | 3.2 |
| P6 round-3（10 任务） | 10/10 | 10 | 533,346 | 4.4 |

三轮合计 30 次真实运行：独立检查 **29/30**、Alpha 自评验收 **29/30**；全部运行的用量中位数 463,189 tokens、耗时中位数 4.9 分钟。与基线同口径的老 8 任务（24 次运行）：独立检查 23/24、自评验收 24/24、中位用量 396,509 tokens、中位耗时 3.9 分钟——对照 P1（349,427 / 4.3）与 P2（405,919 / 3.9），改造没有让用量和耗时恶化。

### 每任务三轮中位数

| 任务 | 中位用量 | 中位耗时（分钟） | 中位轮次 | 独立检查（/3） | 自评验收（/3） |
|---|---|---|---|---|---|
| approval-loop | 528,369 | 4.2 | 4 | 3 | 3 |
| async-pool | 486,121 | 6.3 | 3 | 3 | 2 |
| cart-rounding | 705,674 | 10.4 | 3 | 3 | 3 |
| csv-quotes | 362,112 | 5.5 | 3 | 3 | 3 |
| lru-cache | 465,574 | 5.7 | 3 | 3 | 3 |
| product-copy | 14,691 | 0.5 | 1 | 2 | 3 |
| range-merge | 1,149,022 | 6.8 | 4 | 3 | 3 |
| sales-question | 29,001 | 0.6 | 1 | 3 | 3 |
| sales-summary | 64,742 | 0.9 | 1 | 3 | 3 |
| slugify-unicode | 1,965,376 | 13.6 | 4 | 3 | 3 |

### 偏差（30 次里的 3 个异常）

| 现象 | 数据 | 判断 |
|---|---|---|
| `product-copy` 假阳性（第 2 轮） | 独立检查失败（答案用了禁词"最/第一/国家级/顶级"）而 Alpha 自评"已验收" | **验收盲区，已修复**：目标明示的禁用词现在是运行时证据门禁（`compliance` 验收项，`src/runtime/stated-prohibitions.ts` + `recordAnswerCompliance`）——命中即不自评验收，失败原因点名具体词 |
| `async-pool` 未自评验收（第 1 轮） | 模型停在 `stopped`，独立检查其实全过 | 保守失败，不是假阳性；P2 的停止原因码能直接读出它停在哪 |
| `slugify-unicode`、`range-merge` 用量波动大 | slugify 三轮 0.4M/0.4M/2.0M tokens；lru-cache 第 3 轮 2.0M | 重试轮次（3→5 轮）驱动用量；`step/context` 与 `run/ended` 事件可逐步归因，无需猜 |

### 暂停/恢复

`approval-loop` 三轮都是"命令批准 → `needs-input` → 简报续跑 → 验收"，`pauses` 计数 1/1/1——多轮暂停恢复路径 100% 可复现，且每一步都落在事件日志里（见第二节）。

## 三、结论

1. **状态机改造没有牺牲成功率与用量**：老 8 任务 24 次运行 23/24 通过、24/24 自评验收，中位用量 396,509 tokens 与 P2 边界轮（405,919）持平，中位耗时 3.9 分钟不变。30 次运行里唯一一次独立检查失败是文案禁词（见偏差表），与状态机无关。
2. **每个状态与转换都可读、可回放**：暂停/恢复/停止都能从 `events.v1.jsonl` 直接读出原因（`approval/requested` → `status/changed{needs-input}` → `reopenReason` → `complete`）；`bun run replay` 能重建模型每步看到的上下文并核对哈希。
3. **无人值守的多轮暂停恢复成立**：`autoResume` 让"暂停→带简报恢复→继续交付"在评测里可测，3/3 轮复现。
4. **暴露并修复一个真实验收盲区**：Alpha 自评"已验收"曾不检查目标明示的禁用词（`product-copy` 禁词假阳性 1/3 复现）。现在目标里"不要使用“最”“第一”…"这类明示禁用词会生成 `compliance` 验收项，由运行时扫描任务的全部回答文本（与独立检查同面）判定：命中即不自评验收、失败原因点名具体词，干净才记通过证据。真实任务验证：强制违禁场景止步 `active` + `Answer uses prohibited terms: 顶级`，干净场景验收且回答零禁词。
