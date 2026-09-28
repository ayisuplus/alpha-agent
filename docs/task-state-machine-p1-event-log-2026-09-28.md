# P1 事件日志与折叠（2026-09-28）

承接 [任务状态机重构计划](cognitive-state-machine-plan-2026-09-28.md) §4.1–§4.3 与 P1，基线来自同日的 [P0 基线与护栏](task-state-machine-p0-baseline-2026-09-28.md)。

## 一、结论

账本的事实来源已从"整文件可变快照"改为**只追加事件日志**：48 个修改方法全部改成"生成事件 → 干跑校验 → 序号比较并交换追加 → 应用到内存状态 → 写 JSON 投影"，`<id>.json` 降级为投影，供尚未迁移的读取方使用。

行为不变有三重证据：P0 的特征基线（3 场景 × 85 步）逐字节一致且未重建；13 个真实账本副本"导入 → 折叠 → 投影"与原文件逐字节一致；全量测试 429 通过、0 失败（P0 时 273）。

## 二、结构

| 文件 | 作用 |
|---|---|
| `src/runtime/task-events/types.ts` | 45 个事件类型与 payload 契约。payload 携带 reducer 无法纯算的值：生成的 id、时间戳、`fingerprintSource` 读到的源码指纹 |
| `src/runtime/task-events/errors.ts` | `InvariantError(code, message)`（message 保持改造前原文，旧断言与基线继续匹配）、`EventConflictError` |
| `src/runtime/task-events/log.ts` | `events.v1.jsonl`、目录锁、序号比较并交换追加、断尾行截断、快照（带字节 offset）与按 offset 读取 |
| `src/runtime/task-events/state.ts` | `replaceState`：按 payload 的键序原地替换状态，保证投影字节不变 |
| `src/runtime/task-events/apply.ts` + `apply/*.ts` | 5 个家族的纯 reducer：contract 11、lifecycle 8、plan 9、evidence 6、worker 11，加一张分发表 |
| `src/runtime/task-events/transitions.ts` | 状态与阶段转换表（计划 §4.3），fold 逐个事件校验 |
| `src/runtime/task-events/fold.ts` | `foldTask`：序号连续、起源事件唯一、转换合法；支持从快照续折 |
| `src/runtime/task-completion.ts` | `computeCompletionGaps` 从账本移出，reducer 与不变量检查共用一份判定 |
| `src/runtime/task-ledger.ts` | `load` 改为折叠日志；旧账本首次加载写 `task/imported` 并备份 `<id>.json.pre-events.bak`；删除整文件哈希比较与 legacy 备份分支 |

reducer 是纯函数：不读时钟、不生成 id、不碰文件系统，所有这类值都从 payload 来。因此折叠可重放，`foldTask(events)` 与当时写出的投影一致。

## 三、事件类型（45 个）

| 类别 | 事件 |
|---|---|
| 起源 | `task/created`、`task/imported` |
| 契约与输入 | `contract/revised`、`criteria/set`、`input/attached`、`capabilities/set`、`project-version/confirmed`、`model/set`、`guidance/recorded`、`guidance/status-changed`、`goal/changed` |
| 阶段与状态 | `phase/changed`、`status/changed`（complete / stopped / active+reopenReason(+guidance) / needs-input+question+service） |
| 计划与认知 | `plan/submitted`、`plan/approved`、`plan/revised`、`step/changed`、`candidates/set`、`capability-gap/recorded`、`capability-gap/resolved`、`skill-search/recorded`、`skill-proposal/decided` |
| 证据与运行 | `evidence/recorded`、`preview/published`、`run/ended`、`source/revision-refreshed`、`failure/recorded`、`failure/cleared` |
| 开发审查 | `development/enabled`、`review/recorded`、`repair-attempt/recorded` |
| 子代理 | `worker/dispatched`、`worker/queued`、`worker/updated`、`worker-cognition/updated`、`worker-receipt/recorded`、`worker-request/recorded`、`worker-request/updated`、`worker-run/prepared`、`worker/finished`、`workers/reconciled`、`worker-outcome/recorded` |
| 检查点 | `checkpoint/started`、`checkpoint/committed`、`checkpoint/failed` |

`run/started` 与 `step/context` 按计划留到 P4；现在运行开始仍只记在操作日志里。

## 四、写入、并发与崩溃语义

- **序号比较并交换**：追加方声明期望的上一个 `seq`，不符即 `EventConflictError`；账本随后重新折叠、重放 plan 闭包（重新生成 id 与时间戳），最多 8 次，每次退避 `10ms × n`。取代了原来的整文件哈希比较。
- **两级串行**：进程内按账本文件排队（`commitQueues`），跨进程用 `events.lock` 目录锁（30 秒陈旧释放，与只读检查槽位同一套做法）。主进程与子代理进程可以同时写一个任务。
- **投影不落后于日志**：应用状态与写 JSON 投影都在锁内完成，所以并发写者不会把投影回退成旧状态。
- **断尾行**：崩溃留下的半行由 `inspectLogTail` 标为 `torn`，下次追加先截断到最后一个完整事件；折叠永远忽略断尾。
- **快照**：每 200 个事件写 `snapshot.<seq>.json`（记录字节 offset，只保留最新一份），加载时从快照续折。快照是纯缓存，删掉只影响加载耗时。
- **实测开销**：连续 200 次提交平均 1.42 ms/次；带快照加载 1.2 ms、全量折叠 0.4 ms（201 个事件）。

## 五、验收对照

| 计划 P1 的验收 | 结果 |
|---|---|
| 全部现有测试通过 | `bun run test` 429 通过、0 失败；`bun run check` 通过 |
| P0 特征测试逐字节一致 | `bun run characterize` 三个场景全一致，基线文件未重建 |
| 真实账本副本"导入 → 折叠 → 投影"与原文件一致 | `bun run characterize:import`：13/13 逐字节一致；`.alpha` 只读，回放后仍是 13 个 `.json`，无新增文件 |
| 并发写入（两进程各追加 100 个事件）无丢失 | `test/task-events.test.ts`：201 个事件、序号 1–201 连续、200 条运行记录互不覆盖、折叠结果等于重载状态 |

新增测试 156 个：`task-events.test.ts`（日志、折叠、CAS、断尾、快照、导入、转换表、两进程并发）、`task-events-{contract,lifecycle,plan,evidence,worker}.test.ts`（每个 reducer 的生效路径与守卫）。

## 六、有意的行为变化

1. **陈旧句柄不再报错，而是重新折叠后重放**。旧行为抛 `Task ledger changed in another operation` 并要求调用方重载；现在两个写者的事件都保留。`test/cognitive-workflow.test.ts` 相应改为断言两条 guidance 都在、`eventSeq` 为 3；`src/server/routes/tasks.ts` 的兜底重试改判 `EventConflictError`。
2. **批量对账共用一个时间戳**。`workers/reconciled` 一次事件覆盖所有在跑的实例（旧代码每个实例各读一次时钟）；`worker/queued` 顶替旧尝试时，旧尝试的 `endedAt` 用同一事件的 `startedAt`。
3. **旧账本备份改名且只写一次**：`.pre-contract-extension.bak` → `.pre-events.bak`。`task/imported` 不改 `updatedAt`，导入因此完全不动用户文件（13 个真实账本导入后字节未变）。
4. `async-workers` 里"取消一个尝试后兄弟仍返回"的断言改为分别等待两个实例：原写法依赖两者完成的先后顺序，`wait` 只要有一个结束就返回。

## 七、缺口与下一步（P2）

- `status/changed → needs-input` 仍带自由文本 `service`（现存 16 种取值，见 P0 报告的映射表），P2 换成 §4.4 的 8 个原因码与恢复动作，界面按码出按钮。
- 转换表已在 fold 生效，但界面与时间线仍读旧字段；P2 让时间线直接读持久事件。
- 目标续跑仍是可变字段，P2 改为 `goal/changed` 快照 + 修订号；无进展停止写成带原因码的事件。
- 每次提交都对整个状态做一次 `structuredClone` 干跑校验；状态很大时可改为只校验受影响子树。
- `TaskLedger.load` 现在读快照 + 日志尾部（列表接口另有投影 mtime 缓存），冷启动的读取次数比过去多，P6 评测时观察。
