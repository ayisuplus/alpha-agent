# P0 基线与护栏（2026-09-28）

> 归档（2026-09-30）：本文记录已放弃或已被取代的旧架构与方案，不代表当前版本。当前方向见 [原生 OMP 重构](../2026-09-29-omp-native-refactor.md) 与 [定版收束建议](../2026-09-30-final-convergence-recommendations.md)。

[任务状态机重构计划](cognitive-state-machine-plan-2026-09-28.md) 的 P0 交付。目标是在动账本之前，先把"现在的行为是什么"和"哪些不变量已经被违反"固定下来，供 P1 的事件日志改造逐字节对照。背景见同日的 [Harness 修复与评测](harness-fixes-eval-2026-09-28.md)。

## 一、交付物

| 产物 | 路径 | 作用 |
|---|---|---|
| 不变量检查（纯函数） | `src/runtime/task-invariants.ts` | 计划 §4.6 的可执行版本，每条违反带稳定错误码；P1 的 `foldTask` 直接复用 |
| 完成判定（纯函数） | `src/runtime/task-ledger.ts` `computeCompletionGaps` | 从 `TaskLedger.completionGaps()` 抽出，账本方法与不变量检查共用同一份判定，避免两处漂移 |
| 账本扫描 | `scripts/check-task-invariants.ts`（`bun run invariants`） | 只读扫描 `.alpha/tasks` 与 `.alpha/operation-journal`，报告写入 `artifacts/` |
| 特征探针框架 | `test/support/ledger-characterization.ts` | 85 步探针覆盖全部 48 个修改方法；冻结时钟 + 值驻留归一化，输出可复现 |
| 特征基线 | `test/fixtures/ledger-characterization/{web-product,code-change-plan,general-needs-input}.json`、`test/ledger-characterization.test.ts` | 三个场景每步的前后状态差异；`bun run characterize` 校验，`--write-fixtures` 重建 |
| 真实账本回放 | `scripts/characterize-ledgers.ts --real`（`bun run characterize:real`） | 对 `.alpha/tasks` 的**副本**回放同一探针，结果写 `artifacts/ledger-characterization-2026-09-28.json` |

扫描与回放都不写 `.alpha`：真实账本先复制到临时目录再加载，回放后 `.alpha/tasks` 仍是 13 个 `.json`，没有新增 `.bak` 或 `.tmp`。

## 二、不变量与错误码

错误码稳定，只增不改号；`I1` 需要只追加事件日志，快照上无法表达，P1 之后才可检查（`UNCHECKABLE_INVARIANTS` 里记着原因）。

| 码 | 检查 | 现状 |
|---|---|---|
| `I2/stale-operation-lock` | 操作日志仍标记运行中，但任务不是 active | 未发现 |
| `I3/complete-without-current-evidence` | complete 时 `computeCompletionGaps` 必须为空 | 未发现 |
| `I4/contract-history-not-monotonic`、`-not-past`、`-version-gap`、`-history-incomplete`、`evidence-from-future-contract`、`run-from-future-contract` | 契约版本单调、逐版有历史、没有来自未来版本的记录 | 未发现（13 个账本都还是 v1） |
| `I5/worker-request-without-instance`、`integration-without-result`、`agent-attempt-unknown`、`agent-status-mismatch`、`review-without-instance` | 子代理结果只能来自已激活实例；集成只能在返回结果之后 | 未发现（`returned` + `integration: pending` 是合法的"待集成"，不算违反） |
| `I6/needs-input-without-question`、`-without-reason-code`、`unknown-reason-code` | 每个暂停都有问题和原因码，码在已知集合内 | 未发现（唯一一个 needs-input 账本带 `MCP`） |
| `I7/amendment-*`、`instance-ahead-of-cognition`、`plan-approval-*`、`negative-no-progress-runs` | 认知修订、计划批准、无进展轮数都不越界 | 未发现 |
| `S/leftover-pause-fields`、`complete-with-failure`、`stopped-without-reason`、`step-running-without-instance`、`step-complete-with-unmet-dependency` | 计划外的状态一致性检查（P2 转换表会天然保证） | **4 条违反**，见下 |

## 三、对现有 13 个账本的扫描结果

状态分布：complete 8、stopped 3、active 1、needs-input 1。

| 违反 | 任务 | 说明 |
|---|---|---|
| `S/complete-with-failure` ×3 | `736b0baf`、`a3e792db`、`d6cfbaaf` | 都是 2026-09-23 的旧账本（`taskType` 字段缺失的那一批），已完成却留着浏览器验收失败的 `lastFailure`。当前 `complete()` 会清掉它，界面在 complete 时也不显示，但 `session-profile.ts` 仍把它当"最近审查失败"拼进提示词：这类任务一旦被续跑，模型会读到一条早已过期的失败原因 |
| `S/step-running-without-instance` ×1 | `580951d3` | 计划步骤 `s2` 仍是 running，而它对应的实例已 cancelled/failed。`reconcileRunningInstances` 只改它当轮处理的实例，历史遗留的步骤状态没人回收 |

存量数据没有修改（不改用户数据）。P2 引入转换表时需要决定：是迁移这三条旧账本，还是把 `S/*` 降级为告警。

暂停原因码现状：代码里实际写入 `blockedService` 的取值有 16 个（`approval`、`capability`、`git-backup`、`git-worktree`、`MCP`、`model`、`project`、`project-state`、`recovery`、`review-repair`、`web-approval`、`web-source`、`windows-sandbox`、`worker-approval`、`worker-integration`、`worker-review`，已钉在 `KNOWN_PAUSE_REASONS`），13 个账本里只有 1 个带原因码。计划 §4.4 的 8 个原因码与它们的映射建议：

| §4.4 原因码 | 现在的取值 |
|---|---|
| `approval` | `approval`、`web-approval`、`web-source`、`MCP` |
| `question` | **无生产者**：现在没有"模型向用户提问"的工具，所有暂停都来自授权、沙箱或子代理路径。P2 要么补一个提问工具，要么去掉这个码 |
| `worker-no-result` | `worker-review`、`review-repair`、`worker-integration`、`worker-approval` |
| `sandbox` | `windows-sandbox` |
| `model` | `model` |
| `project-state` | `project-state`、`project`、`recovery`、`git-backup` |
| `capability` | `capability`、`git-worktree` |
| `budget` | **无**：预算用尽现在写 `lastFailure` 并 stop，不是暂停 |

## 四、特征基线的覆盖与可复现性

- 48/48 修改方法都被探针调用（`test/ledger-characterization.test.ts` 用 `TaskLedger.prototype` 反射钉住，新增方法不进探针就报错），85 步里既有正常路径也有守卫拒绝路径。
- 三个场景：`web-product`（浏览器验收）、`code-change-plan`（先规划再执行）、`general-needs-input`（暂停中的通用任务）。三者都能走到 `complete` 与 `reopen`，56/56/57 步生效，其余被守卫拒绝并记录错误文本。
- 可复现性靠两件事：**冻结时钟**（每次 `new Date()` 前进 1 秒；真实时钟下两次写入落在同一毫秒会合并成一个记号，基线会漂移，已实测到）和**值驻留**（时间戳、UUID、64 位源码指纹、绝对路径按出现顺序替换为 `<at:N>`、`<id:N>`、`<rev:N>`、`<root:N>`，同一原值在整轮里始终是同一个记号）。连续两次运行输出逐字节一致。
- 真实账本回放：13 个副本共 437 步生效、668 步被拒（多数拒绝来自"任务已完成/已停止"这类状态守卫，正是要保留的行为）。

P1 的验收方式：改造后 `bun run characterize` 必须三个场景全一致；`bun run characterize:real` 的输出与 `artifacts/ledger-characterization-2026-09-28.json` 逐字节对比。

## 五、验证

- `bun run check` 通过。
- `bun run test` 全绿：新增 `test/task-invariants.test.ts`（12 个用例）与 `test/ledger-characterization.test.ts`（3 个用例），总数 258 → 273。
- `bun run invariants`、`bun run characterize`、`bun run characterize:real` 均实际运行，输出即本文第三、四节的数字。

## 六、缺口

- **评测基线未跑**：计划要求 `bun run eval` 每任务 3 次。它会真实调用模型并消耗额度（上一轮 8 个任务约 1280 万 tokens），需要先确认再跑。
- `I1`（序号连续）与"同一任务同一时刻只有一个运行"的运行时部分，快照上无法检查，等 P1 的事件日志。
- 探针只覆盖账本方法本身，不覆盖调用方的组合序列（`runs.ts`、`development-workflow.ts` 里的多方法编排）；这部分靠现有集成测试和 P6 评测兜住。
- 存量 4 条违反未修，理由见第三节。
