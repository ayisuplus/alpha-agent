# 任务状态机重构总结（2026-09-28）

按 [认知状态机计划](cognitive-state-machine-plan-2026-09-28.md) 完成 P0–P6 的落地记录。计划的核心一句话已经实现：**只追加的事件日志是任务状态的唯一事实来源，账本与所有投影都是日志的折叠结果；模型看到的每一步都能从日志重建。**

## 一、结论

- "认知虚拟机"改称**任务状态机**：保留天枢的三条原则（确定性运行时监管概率性模型、版本化目标、证据门禁、无进展即停），不再沿用 CVM 名称。每个状态、每次转换、每个暂停原因都显式入日志，可回放、可测试。
- 评测暴露的四类问题（卡"需要输入"、审查子实例不返回、并行会话互覆盖、审批暂停原因不清）在事件日志里都能直接读出原因：原因码、审查重试、子代理生命周期、操作闩锁都成了事件。
- 全部改动零数据迁移破坏：旧账本首次触碰时把原文件**一次性导入**为起源事件（原文件不动、只读可用），投影文件按原形状重写，读取方不变。

## 二、阶段与产物

| 阶段 | 交付 | 验证 |
|---|---|---|
| P0 基线 | 表征测试 `test/ledger-characterization.test.ts` + 三份场景基线（`test/fixtures/ledger-characterization/`）+ 不变量脚本 `bun run invariants`（`I2`–`I7` 与 `S/*` 家族，每条违反带稳定错误码；`I1` 需要事件日志才能检查） | `docs/task-state-machine-p0-baseline-2026-09-28.md`：13 个存量账本 4 条违反（`S/complete-with-failure` ×3、`S/step-running-without-instance` ×1），此后每阶段不新增 |
| P1 事件日志 | `src/runtime/task-events/`（types/log/fold/apply/transitions）：只追加 `events.v1.jsonl`、序号 CAS 并发写、断尾截断、旧账本导入一次；账本的修改方法全部走"计划事件→追加→投影"（55 处提交点） | 3 场景 × 85 步特征基线逐字节一致；`characterize:import` 13/13 |
| P2 原因码 | `pause-reasons.ts`：16 个自由文本暂停值收敛为 **8 个暂停码 + 7 个停止码**（`TaskState.pauseReason`、`stop{reason,detail,stoppedAt}`），界面按码渲染标题与恢复动作；审查子实例不返回改为**重试一次、修复回退主代理、都不行才 `worker-no-result` 暂停**；`task-event-summary.ts` 时间线从事件重建（`GET /api/tasks/:id/events?since=<seq>`），每轮运行带 `runId`，目标续跑带修订号 | `pause-reasons.test.ts`；P2 边界轮 8/8 通过、自评验收 7（P1 轮 6），cart-rounding 从"审查未返回而暂停"转为验收 |
| P3 子代理 | 子代理生命周期全部事件化：排队、派发、激活、结果、更新、信箱消息与 ack（`worker/*`、`worker-run/prepared`、`worker-request/*`、`workers/reconciled`）；实例与请求的状态不再只活在附属文件里 | `task-events-worker.test.ts`；`bun run invariants` 的 `I5` 家族（结果只能来自已激活实例）在事件折叠上可查 |
| P4 模型可见即记录 | `step/context` 事件 + `prompt-blobs/<hash>.txt`（大块内容按哈希落盘）+ `bun run replay <taskId>` 重建每步任务上下文 | 真实评测运行（product-copy）重放 1/1 步核对通过；`replay.test.ts` 覆盖篡改/缺失块；评测报告新增"每步上下文/首响应"列 |
| P5 附属存储 | 任务范围：操作日志、命令审批、网页授权并入事件（`operation/*`、`approval/*`、`web-approval/*`），投影同形保留；全局：队列、自动化改为事件 + 投影（`.alpha/task-queue/events.v1.jsonl`、`.alpha/automations/events.v1.jsonl`）；全部 JSON 存储带 `format`/`version`，读取方宽容 | `docs/persistence-catalog-2026-09-28.md`：每种持久化文件逐行给出格式版本、分类、迁移路径与一句话说明 |
| P6 评测验证 | 扩充任务 `async-pool`（更难代码：并发上限/顺序/错误即停）与 `approval-loop`（多轮暂停：`autoResume` 带简报续跑并计数）；3 轮 10 任务对比 | `docs/task-state-machine-p6-eval-2026-09-28.md`（数字见该文档） |

## 三、事件类型全景

任务日志（`.alpha/tasks/<id>/events.v1.jsonl`）共 **62 种事件类型**，权威列表在 `src/runtime/task-events/types.ts`。按聚合分组：

- 任务与目标：`task/created`、`task/imported`、`status/changed`（暂停/停止的原因码与恢复简报都在这个事件的载荷里）、`goal/changed`、`phase/changed`、`contract/revised`、`criteria/set`、`input/attached`、`model/set`
- 计划与证据：`plan/submitted|approved|revised`、`evidence/recorded`、`review/recorded`、`preview/published`、`checkpoint/started|committed|failed`
- 运行与模型：`run/ended`、`step/changed`、`step/context`（每步给模型看了什么：提示词哈希、任务上下文字节、工具集）、`failure/recorded|cleared`、`repair-attempt/recorded`、`guidance/recorded|status-changed`
- 子代理：`worker/queued|dispatched|activated|finished|result|updated`、`worker-run/prepared`、`worker-request/recorded|updated`、`worker-outcome/recorded`、`worker-receipt/recorded`、`worker/message-queued|message-acknowledged`、`workers/reconciled`
- 附属：`operation/started|finished`、`approval/requested|reviewed|claimed|finished`、`web-approval/requested|decided|read-granted|write-begun|write-finished|reconciled`
- 其余：`capabilities/set`、`candidates/set`、`capability-gap/recorded|resolved`、`skill-search/recorded`、`skill-proposal/decided`、`source/revision-refreshed`、`worker-cognition/updated`、`project-version/confirmed`、`development/enabled`

全局日志复用同一套原语（信封、序号 CAS、断尾截断）：`queue-item/*`、`schedule/*`、`automation/*`、`automation-run/*`，外加两个一次性起源事件 `queue/imported`、`automation/imported`。

## 四、对齐与安全

- 运行时仍是确定性外壳：完成由证据门禁判定（`acceptance.ts`），不靠模型自述；停止必带原因码（`I6`/`S/stopped-without-reason`）；一任务同时只有一个活动运行（`I2/stale-operation-latch`，由账本闩锁自证）。
- 并发安全：事件追加用序号 CAS（乐观并发），账本写入仍保留整文件哈希比对；投影失败不破坏日志（重放可修复）。
- 不改用户数据：所有对真实账本的测试跑在副本上；导入只读原文件。

## 五、缺口与待决定（沿用计划第七节）

1. 规划期是否"只换提示词不换工具"（dsh 做法）：建议 P6 评测后对比再定。
2. 是否正式弃用"认知虚拟机"名称（本文档已按"任务状态机"行文）。
3. 事件日志是否承载子代理完整会话（当前只记描述、激活与结果）。
4. 暂停码 `question` 与 `budget` **没有生产者**：模型没有向用户提问的工具；预算用尽走 `stopped` + `stop.reason = "budget"` 而不是暂停。要么补工具/改判定，要么删掉这两个码。
5. `.alpha/web-secrets.json`（Electron 写入的密文）与 `mcp-permissions` 的回执半尚未事件化；`.alpha/web/`、`.alpha/project-turns/` 保持原样（重放需要时再事件化，事件类型已列在持久化清单）。
