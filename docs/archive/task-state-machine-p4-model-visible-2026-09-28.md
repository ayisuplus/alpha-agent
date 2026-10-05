# P4 模型可见即记录（2026-09-28）

> 归档（2026-09-30）：本文记录已放弃或已被取代的旧架构与方案，不代表当前版本。当前方向见 [原生 OMP 重构](../2026-09-29-omp-native-refactor.md) 与 [定版收束建议](../2026-09-30-final-convergence-recommendations.md)。

承接 [P3 子代理生命周期](task-state-machine-p3-worker-lifecycle-2026-09-28.md)，执行 [计划](cognitive-state-machine-plan-2026-09-28.md) §4.5 与 P4。

## 一、结论

模型看到的每一步都能从事件日志重建。每次模型运行把**任务上下文块**存进按内容寻址的 `prompt-blobs`，把哈希与体积记进 `step/context` 事件；`bun run replay <taskId>` 重放该任务的每一步：按 `seq` 折叠出当时的任务状态、按哈希取回上下文块、核对哈希与目标行，并打印当时的用量。评测报告新增「每步上下文」与「首响应」两列。

真实证据（一次完整评测运行，`artifacts/eval-2026-09-28-p4-replay`）：

```
#6 2026-09-28T12:13:09.611Z coordinator xiaomi-token-plan-cn/mimo-v2.6-flash 8201 tokens 1586B 已核对 Preserve earlier task requirements unless the user explicitly superseded them.
共 1 步 · 上下文合计 1586 字节 · 核对通过 1 步
```

评测报告里同一轮的表格行：`| product-copy | ✅ | complete | 40s | 1 | 0 | 14,866 | 4634 + 3567 | 1.5k | 1.6s | all checks passed |` —— 每步上下文 1.5k 字节、首响应 1.6 秒。

## 二、事件与存储

`step/context`（每次模型运行一条，紧跟在提示词组装之后）：

| 字段 | 含义 |
|---|---|
| `stage` / `model` | 这一步的角色（coordinator / implementation / review / worker / answer）与模型 |
| `promptHash` | Alpha 组装给请求的三块之哈希：运行时契约、任务上下文块、工具文本 |
| `taskContextHash` / `taskContextBytes` | 任务上下文块的哈希与字节数；文本存在 blob 存储里 |
| `systemTokens` / `toolTokens` / `contextShare` | 固定提示词体积（与 `run/ended` 的 `prompt` 同源） |
| `toolNames` | 这一步实际给出的工具名 |

大块内容按哈希寻址：`<dataRoot>/prompt-blobs/<sha256>.txt`，同文本只存一份（`writePromptBlob` 幂等）。事件里只有哈希，`TaskState.stepContexts` 只留摘要（阶段、模型、体积、工具数），投影文件不会被上下文撑爆。

`run/ended` 顺带记录 `firstResponseMs`（模型首个可见响应的延迟），时间线的运行行与评测报告都用它解释"慢"。

## 三、replay 的核对规则

`bun run replay <taskId> [--data .alpha] [--json]`，只读：

1. 按 `seq` 切片折叠，得到该步之前的任务状态（目标、契约版本、验收缺口、计划步骤、阶段、暂停/停止原因码）。
2. 按 `taskContextHash` 取回存储块；**哈希必须一致**，否则该步记为未核对并给出原因。
3. 块里若含 `Current objective v<N>: …` 行（`taskPrompt` 的格式），该行必须与折叠出的状态一致——这是"日志 ↔ 存储块 ↔ 状态"的三方交叉核对。回答类与首轮的块没有目标行，只用哈希绑定。
4. 每步打印 `seq、时间、阶段、模型、tokens、字节、块首行`，最后给汇总（步数、总字节、核对通过数）；任何一步未核对或没有步则退出码非 0。

## 四、验收对照

| 计划 P4 要求 | 结果 |
|---|---|
| `step/context` 事件 + 按哈希存储大块内容 | 见第二节；`test/step-context.test.ts` 覆盖按内容寻址、幂等、事件与摘要 |
| `bun run replay <taskId>` 重建每步任务上下文 | `src/runtime/task-replay.ts` + `scripts/replay.ts`；`test/replay.test.ts` 覆盖逐步状态重建、篡改存储块只使该步未核对、缺失存储块给出原因、无上下文任务返回空 |
| 评测报告增加每步上下文体积与首次响应延迟 | `eval/run.ts` 表格新增两列，取值分别是最慢一轮的首响应与最大任务上下文块 |
| 验收：任一次评测运行可用 replay 重建，哈希一致 | 真实评测运行（product-copy）重放：1 步全部核对通过（见第一节） |

## 五、验证

- `bun run check` 通过；`bun run test` **459 通过、0 失败**（P3 时 453）。
- `bun run characterize` 三场景一致（探针新增 `recordStepContext`，`recordRun` 增记 `firstResponseMs`）。
- 真实评测：`bun run eval --tasks product-copy --label p4-replay` 1/1 通过；`bun run replay <taskId>` 对该运行核对通过。

## 六、缺口

- `promptHash` 覆盖的是 **Alpha 组装**的三块（运行时契约、任务上下文、工具文本）；OMP 自身的系统提示与项目 context files 的文本没有入 blob，只在 `systemTokens` 里计数。要把"模型看到的一切"全部落盘，需要 P5 一并评估 OMP 会话文件的归档。
- 计划里"与 OMP 会话对照"尚未实现：OMP 会话在 `<dataRoot>/omp/sessions`（OMP 自己的格式），replay 目前对照的是事件、状态与存储块三方。与 OMP 会话逐条对照需要读它的会话格式，列为下一步。
- `firstResponseMs` 按运行记录；评测报告取一个任务里最慢的一轮，中位数留到 P6。
- `step/context` 目前在每次运行开始时记一条；压缩后重发的认知快照（`session.steer`）不单独成事件，留待 P5 决定是否纳入。
