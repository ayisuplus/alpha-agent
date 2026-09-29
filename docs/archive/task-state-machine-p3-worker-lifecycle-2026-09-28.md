# P3 子代理生命周期（2026-09-28）

> 归档（2026-09-30）：本文记录已放弃或已被取代的旧架构与方案，不代表当前版本。当前方向见 [原生 OMP 重构](../2026-09-29-omp-native-refactor.md) 与 [定版收束建议](../2026-09-30-final-convergence-recommendations.md)。

承接 [P2 状态与暂停原因显式化](task-state-machine-p2-reason-codes-2026-09-28.md)，执行 [计划](cognitive-state-machine-plan-2026-09-28.md) §4.2 子代理事件与 P3。

## 一、结论

子代理的生命周期、信箱和计划步骤看板都进了任务事件日志，父任务从此只信事件：

- `worker/activated` 记录子进程**pid**与工作区，`worker/result` 记录 attempt 的**停止原因**（`completed` / `needs-input` / `aborted` / `error` / `max-tokens` / `budget` / `refusal` / `no-result`）。"子代理没交结果"是日志里的一条事实，不再是 findings 里的一句话。
- 信箱双写：`worker/message-queued` 与 `worker/message-acknowledged` 是事实来源，**收件箱 = 已排队 − 已确认**（`pendingFromState`），重启后未送达消息仍在队列里。per-agent 文件保留为子进程的传输层（150ms 轮询、ack 标记、`alpha_worker_result` 的 completed-gate 都继续读本地文件）。
- 计划步骤带**看板修订号**：`step/changed` 带 `expectedRevision` 比较并交换，`claimedBy` 记录认领者，`plan/revised` 冻结已认领的步骤。
- 重启恢复按 pid 回收孤儿子进程（先确认它仍是 bun 的 worker，避免 pid 复用误杀），把没交结果的尝试标为 `no-result`。

期间修掉三个真实缺陷，都是新测试抓到的：

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | 硬杀服务器后子进程成孤儿，父日志里没有它们的 pid | 孤儿继续改工作区、写没人读的结果，没人能停它 | `worker/activated` 记 pid；恢复时先确认身份再强杀 |
| 2 | `cancelAll` 只中止"账本状态还在跑"的尝试 | 实例被外部关掉（重启对账）后，真实子进程无人中止，测试与生产都会悬住 | 无论实例状态如何都 abort 尝试 |
| 3 | 事件锁两种实现各有坑：`writeFile(...,"wx")` 在 Windows 上**不排他**（两进程同时进临界区 → 重复 seq）；目录锁在写入持有者前的窗口会被误抢 | 并发写入互相破坏日志 | `mkdir` 原子锁 + 锁内写持有者（pid）+ 2 秒宽限 + 持有者进程死亡立即接管 |

两进程各追加 100 个事件的测试先抓到 #3，再抓到 #2——这正是该测试存在的意义。

## 二、事件与停止原因

新事件（4 个）：

| 事件 | 载荷要点 | 作用 |
|---|---|---|
| `worker/activated` | attemptId、orderId、agentId?、pid?、workRoot?、worktreePath?、activatedAt | 子进程活着的证据；pid 用于回收 |
| `worker/result` | attemptId、stopReason、findings、reviewVerdict?、detail?、recordedAt | 尝试的结局，无论 worker 是否提交结果都会写 |
| `worker/message-queued` | message（完整 AgentMessage） | 邮件入队 |
| `worker/message-acknowledged` | id、agentId（null = 主代理收件箱）、acknowledgedAt | 邮件被读/确认 |

`step/changed` 增加 `expectedRevision?` 与 `claimedBy?`。

停止原因的信号来源（今天就能取到）：

| stopReason | 信号 | 代码 |
|---|---|---|
| `completed` | 子进程写回 `alpha_worker_result` | `scripts/run-worker.ts` 结果分支 |
| `needs-input` | 子进程因 NeedsInputError / needs-context 结束 | `run-worker.ts` catch、`work-orders.ts` 非完成状态 |
| `max-tokens` | 模型回复因 token 上限结束（原来被压平成普通 Error） | `omp-runner.ts` `stopReason === "length"` → `WorkerStopError("max-tokens")` |
| `budget` | 工具次数/时长预算耗尽 | `omp-runner.ts` `budgetReason` → `WorkerStopError("budget")` |
| `aborted` | 用户或主代理取消、租约中止 | `model-workers.ts` `workerSignal.aborted` |
| `no-result` | 子进程没提交结果（`run-worker.ts` 明确抛出）、610 秒硬超时、模型卡住无响应、崩溃后无 result.json | `workerStopReason` 分类器 |
| `error` | 其他失败 | 同上 |
| `refusal` | **无生产者**：SDK 的 StopReason 联合里没有拒绝 | 保留给将来 |

计划里的 `worker/descriptor` 不再单独建事件：`worker/queued` 的载荷已经包含工单、专家快照、Skill 快照与能力快照，就是描述事件，避免同一事实两处记账。

## 三、信箱与步骤看板

**信箱**（`src/runtime/agent-mailbox.ts` + `apply/mailbox.ts`）：文件布局一字未改（子进程轮询 `<state>/inbox`、ack 标记文件、`hasUnansweredWorkerRequest` 读本地 ack），事件是事实来源。`collect`/`send`/`report` 在建信后追加 `worker/message-queued`（按 id 去重），`acknowledge` 在写标记文件的同时追加 `worker/message-acknowledged`。ledger 写失败只记 `ALPHA_MAILBOX_*` 日志，绝不影响投递——投递仍走文件。

**看板**（`apply/plan.ts` + `task-invariants.ts`）：`CognitionStep.revision`（缺省 0）与 `claimedBy`；`step/changed` 在 `expectedRevision` 存在且不匹配时抛 `apply/step-revision-conflict`，每次迁移 +1，缺省 `expectedRevision` 的旧日志照常折叠；`plan/revised` 按 id 带走 revision/claimedBy，并把"已认领"加入冻结集合（改写报错文案不变）。`S/step-running-without-instance` 接受"claim 指向一个已被对账关闭的实例"（重启现场的常态），其余情形照旧报违反；新增 `I7/step-revision-negative`。

## 四、验收对照

| 计划 P3 验收 | 结果 |
|---|---|
| `worker/descriptor`、`worker/activated`、`worker/result`（stopReason）写入父任务日志 | 见第二节；descriptor 由 `worker/queued` 承担 |
| 信箱改为事件，可由已排队减已送达重建 | `pendingFromState(state, recipient)`；测试证明它与文件收件箱一致，重启后消息仍在 |
| 计划步骤改为带修订号的任务板，认领/完成走比较并交换 | `expectedRevision` + `claimedBy`；两个把手并发 `updateStep`，输家在锁内重折后重放，两条事件都在日志里且修订号递增 |
| 杀进程重启后子代理、未送达消息、计划步骤可恢复 | 测试：真实子进程被回收、旁观进程不被杀；`workers/reconciled` 给每个未结束尝试写 `stopReason: "no-result"`；步骤状态随折叠恢复 |
| 子代理不提交结果时主代理得到 `no-result` 并继续 | `worker/result{no-result}`（测试）+ `reviewNoResultDecision`（重试一次独立审查 → 仍不行才以 `worker-no-result` 暂停；`needs-input` 单独暂停并给出实例 findings） |

## 五、验证

- `bun run check` 通过；`bun run test` **453 通过、0 失败**（P2 时 447）。
- 新测试：`test/worker-lifecycle.test.ts`（no-result 事实进入日志与时间线、硬杀后回收孤儿、pid 身份守卫、8 种停止信号的分类）、`test/step-board.test.ts`（CAS 与重启现场）、`test/task-events-mailbox.test.ts`（排队/确认/重建）。
- 特征基线：改动只落在 `cognition.steps[*].revision`，并在探针里新增 4 个方法（`recordWorkerActivation`、`recordWorkerResult`、`recordWorkerMessage`、`acknowledgeWorkerMessage`）；`bun run characterize` 三场景一致。
- `bun run characterize:import` 13/13、`bun run invariants` 4 条存量违反不变。

## 六、缺口

- `refusal` 没有生产者（SDK 无此信号），保留给模型层将来上报。
- 子代理自己的 ledger 文件路径仍未显式写进父日志：从 `worktreePath` 能推出 pointer 位置，P4 重放要连子代理会话时再决定是否单列字段。
- 信箱是**双写**：事件是事实来源，文件仍是子进程的传输层；若要子进程直接读父日志（tail `events.v1.jsonl`），要在 P5 一并评估延迟与折叠成本。
- 步骤认领仍由 `worker/queued` 隐式完成（工单 id = 步骤 id），没有独立 `step/claimed` 事件；计划里"认领走 CAS"由 `expectedRevision` 承担。
