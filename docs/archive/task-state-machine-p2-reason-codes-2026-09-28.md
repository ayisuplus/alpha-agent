# P2 状态与暂停原因显式化（2026-09-28）

> 归档（2026-09-30）：本文记录已放弃或已被取代的旧架构与方案，不代表当前版本。当前方向见 [原生 OMP 重构](../2026-09-29-omp-native-refactor.md) 与 [定版收束建议](../2026-09-30-final-convergence-recommendations.md)。

承接 [P1 事件日志与折叠](task-state-machine-p1-event-log-2026-09-28.md)，执行 [计划](cognitive-state-machine-plan-2026-09-28.md) §4.4 与 P2。

## 一、结论

暂停和停止都带原因码了。`blockedService` 的 16 个自由文本取值换成计划 §4.4 的 8 个原因码（`TaskState.pauseReason`），停止新增 `stop { reason, detail, stoppedAt }`（7 个停止码），界面按码渲染标题与恢复按钮，不再靠字符串特例。子代理"没交结果"默认不再暂停任务：独立审查先重试一次，修复子代理没返回就由主代理直接修，两者都不行才升级为 `worker-no-result` 暂停。时间线的持久轨改为读事件日志（新路由 `GET /api/tasks/:id/events?since=<seq>`），活动日志只保留瞬时行。目标续跑带修订号，折叠时校验单调。

评测已经能回答"为什么没自评验收"。P1 边界那轮（`artifacts/eval-2026-09-28-p1`，8/8 独立检查通过、自评验收 6）里两个"通过但未自评验收"的任务，事件日志直接给出原因：

| 任务 | 事件序列 | P2 之后 |
|---|---|---|
| cart-rounding | `run/ended{stage:worker, outcome:budget}`（审查子实例 600 秒用尽）→ `worker/updated{failed}` → `status/changed{needs-input, service:"worker-review"}` | 先重试一次独立审查；仍无结果才以 `worker-no-result` 暂停，界面给出重派/直接审阅/忽略三个动作 |
| range-merge | 审查已返回并集成 → `failure/recorded`（模型 45 秒无响应）→ `status/changed{stopped}`（无原因） | `status/changed{stopped, reason:"model"}`，界面显示"已停止：模型无响应" |

## 二、原因码、停止码与恢复动作

| 原因码 | 含义 | 动作（计划 §4.4） | 界面落点 |
|---|---|---|---|
| `approval` | 命令、文件、网页或 MCP 动作等待批准 | 批准 / 拒绝 | 提示"在下方审批区批准或拒绝"（审批面板本就在线程内，批准后自动继续） |
| `question` | 模型向用户提问 | 回答 | 提示"在输入框回答后继续"；**当前无生产者**，见缺口 |
| `worker-no-result` | 子代理结束但没有结果 | 重派 / 主代理直接审阅 / 忽略该子代理 | 「忽略该子代理」按钮打开任务详情（实例可在此停止）；重派与直接审阅给提示 |
| `sandbox` | 沙箱不可用 | 查看诊断 / 改权限模式 | 「查看诊断」打开设置→诊断；权限模式提示在新建任务的项目准备页修改 |
| `model` | 模型不可用 | 换模型 | 「更换模型」打开设置→模型；线程头部仍可就地换任务模型 |
| `project-state` | 项目目录或检查点异常 | 重新检查 | 「重新检查项目」调用既有 recheck 接口 |
| `capability` | 专家或 Skill 缺失 | 安装 / 跳过 | 「安装能力」打开任务详情（Skill 提案在此决定）；跳过给提示 |
| `budget` | 预算用尽 | 追加预算 | 「追加预算」打开设置→运行；**当前无生产者**，见缺口 |

停止码：`user`（用户取消）、`model`（模型无响应）、`sandbox`、`budget`、`error`、`no-progress`（连续两轮无进展）、`reconciled`（重启后对账停止）。`goalStopReason` 现在是类型化的联合，停止码优先于过去对 `lastFailure` 的正则猜测。

16 个旧 service 到 8 个码的迁移表在 `src/runtime/pause-reasons.ts` 的 `LEGACY_SERVICE_TO_REASON`；`task/imported` 折叠时按它归一化，原始值仍留在事件里，因此不丢信息。无法映射的更老取值保持无码，由不变量 `I6/needs-input-without-reason-code` 报出来。

## 三、改了什么

- `src/runtime/pause-reasons.ts`（新）：8 个原因码、13 个恢复动作、7 个停止码、迁移表与类型守卫。
- `TaskState`：`blockedService` → `pauseReason`；新增 `stop`；`goal` 新增 `revision`，`stopReason` 改为 `GoalStopReason` 联合。
- 事件：`status/changed` 的 needs-input 带 `reason`、stopped 带 `reason`/`detail`；`goal/changed` 带 `revision`，reducer 要求它恰好递增 1；事件信封新增 `runId`，由 `TaskLedger.bindRun(runId, actor)` 在运行开始时绑定（`registerRun`、两处 `onLedger`、验收路径的每次重载）。
- reducer 在回到工作的每条路径上清掉暂停与停止字段：resume、reopen、complete、`phase/changed(clearPause)`、`worker-run/prepared`、`contract/revised`、`project-version/confirmed`。修订目标过去会留着 `pendingQuestion`，现在一并清掉。
- 全部 `needInput`/`stop` 调用点改用码（`cli.ts`、`server.ts`、`omp-runner.ts`、`development-workflow.ts`、`operation-journal.ts`、`worker-supervisor.ts`、`server/context.ts`、`server/runs.ts`、`server/routes/start.ts`）。顺带修正两处误标：直连文件工具与命令工具把沙箱不可用报成 `approval`，现在是 `sandbox`。
- `development-workflow.ts`：审查子实例未返回 → 标记失败并重试一次独立审查（主代理不能自证审查，所以不会由它接管结论）；修复子实例未返回 → 取消该次尝试，由主代理直接修（复用原来"没有实施者时"的路径）；只有主代理也拿不出可核验结论时才以 `worker-no-result` 暂停。
- `src/runtime/task-event-summary.ts`（新）+ `GET /api/tasks/:id/events?since=`：把事件折成时间线行（`label`/`detail`/`tone`/`refs`），簿记类事件不出行；switch 是穷尽的，新增事件类型不分类就编译不过。`refs` 提供结构化关联（`criterionId`、`evidenceId`、`passed`、`verdict`、`stepId`、`workerId`、`orderId`、`pauseReason`、`stopReason`），界面不再解析中文标签。
- 工作台：`PauseAlert` 按码渲染标题、问题文本、6 个有路由的按钮与其余动作的位置提示；停止原因与目标修订进入详情；时间线持久轨来自事件（按 `runId` 归入轮次，`seq` 定序），检查块通过 `refs.criterionId` 关联证据；没有事件日志的旧任务按原样渲染。导出报告也吃事件。
- 日志锁从"目录锁 + 30 秒陈旧"改为**带持有者信息的锁文件**（`wx` 独占创建，内含 pid 与时间）：持有者进程已死就立刻接管。这修掉了一个真实故障——被杀掉的运行会留下锁目录，之后同一任务的写入要干等 30 秒。

## 四、验收对照

| 计划 P2 要求 | 结果 |
|---|---|
| 状态与阶段只能经由转换表改变，删除散落的直接赋值 | P1 已完成；本轮复核 `state.status =` / `state.phase =` 只出现在 `task-events/apply/*` 的 reducer 里 |
| 实现 §4.4 原因码，界面按码显示恢复按钮 | 8 个码全部有标题与动作；6 个动作接既有路由，其余 7 个给出发生位置的提示（没有端点的不造按钮） |
| 时间线直接读持久事件 | `GET /api/tasks/:id/events?since=` + 工作台合并；轮次结果取自 `status/changed` 等活动阶段字符串只在有事件时被抑制 |
| 目标续跑改为 `goal/changed` 快照 + 修订号 | revision 单调，reducer 拒绝不跟随的修订；无进展停止写成 `stop.reason = "no-progress"` |
| `worker-no-result` 不再直接暂停任务 | 审查重试一次、修复回退主代理；只在都无法处理时暂停 |
| 评测中"独立检查通过但自评未验收"能从事件看出原因码 | 见第一节的两个任务；停止与暂停都带码 |

## 五、验证

- `bun run check` 通过；`bun run test` **447 通过、0 失败**（P1 时 438）。新增：`test/pause-reasons.test.ts`（码与动作、停止记录生命周期、旧账本归一化、目标修订）、`test/task-event-summary.test.ts`（持久轨叙述、runId 归属、簿记事件不出行、详情截断、`refs`）、`GET /events` 的路由与游标断言、锁接管测试。
- 特征基线：改动只落在 `blockedService → pauseReason`、新增 `stop.*`、新增 `goal.revision` 三处（逐路径核对过），重建后 `bun run characterize` 三场景一致。
- `bun run characterize:import`：13 个真实账本副本导入后只归一化暂停原因码，投影文件未被改写。
- `bun run invariants`：4 条存量违反不变（P0 记录的 3 条 `S/complete-with-failure` 与 1 条 `S/step-running-without-instance`）；带 `blockedService: "MCP"` 的旧账本现在读作 `pauseReason: approval`，无违反。
- 界面用 `react-dom/server` 真实渲染验证：8 个码的标题、6 个按钮、提示文案、无码回退、停止原因；时间线在有事件与无事件两种输入下的渲染。
- P2 边界评测（`artifacts/eval-2026-09-28-p2`）：8/8 独立检查通过，Alpha 自评验收 **7**（P1 边界那轮是 6）；唯一未自评验收的 slugify-unicode 停止在 `status/changed{stopped, reason:"model"}`——正是 P1 那轮缺失的原因码。cart-rounding（P1 里因"审查子实例未返回"暂停）本轮已验收：审查重试一次后返回并集成。

## 六、缺口

- `question` 与 `budget` 两个码**没有生产者**：模型没有向用户提问的工具（所有暂停都来自授权、沙箱或子代理路径），预算用尽走的是 `stopped` + `stop.reason = "budget"` 而不是暂停。要么补工具/改判定，要么在下一版删掉这两个码。
- `redispatch`、`review-directly`、`skip-capability`、`change-permission-mode` 四个动作没有端点，界面只给提示；P3 的子代理生命周期是补重派端点的合适位置。
- 轮次归属依赖事件信封的 `runId`；没有绑定运行的写入（例如工作台直接改设置）落在时间线的任务级。
- 活动日志仍是工具调用、流式文本、错误文本与用户追问的唯一来源；P4 的 `run/started`/`step/context` 之后可以再收拢一部分。

