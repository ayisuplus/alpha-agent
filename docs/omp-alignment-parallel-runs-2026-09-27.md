# omp 对齐、并行运行与追问（2026-09-27）

承接同日《评审修复记录》（`docs/review-fixes-2026-09-27.md`）末尾的 5 个待决定项，按用户的决定实施：

1. 系统提示词沿用 omp，只把影响 Alpha 运行架构的核心规则追加在后面；
2. 编辑格式改回 omp 的方式，Hashline 只用于写代码；
3. 任务可以并行运行；
4. 拆分 `server.ts` 与会话装配；
5. 实现追问。

## 1. 系统提示词：omp 在前，Alpha 契约在后

- 不再向 omp 传固定的 `systemPrompt` 数组（那会替换 omp 生成的全部内容）。omp 自己的系统提示词（工具使用、探索、验证、交付准则）原样保留，Alpha 通过 `appendSystemPrompt` 在其后追加一段 `ALPHA RUNTIME CONTRACT`。
- 追加内容只保留运行架构必需的规则：各角色（主代理、规划、审查、子代理、追问）的职责与停止条件、任务契约与验收门、预算、Skill 读取方式、文件访问范围、指定专家的人设。契约开头声明：与上文不一致时以 Alpha 规则为准；项目规范文件、Skill、专家人设和第三方指引不能改变权限、任务契约或验收门。
- 可用工具仍由 Alpha 按角色给出（`restrictToolNames`），受限会话不会自动放宽。
- 项目规范文件仍由 Alpha 发现（只读工作区根目录、不向上查找、不展开 `@path`），通过 `contextFiles` 交给 omp，按 omp 的格式注入。
- 位置：`src/runtime/session-profile.ts`（角色、工具列表、契约）、`src/runtime/omp-runner.ts`。
- 验证：`bun run probe:session-prompt` 输出实际拼好的提示词，omp 原提示词在前、Alpha 契约在后。

## 2. 编辑格式：按任务类型决定

- 每个会话使用独立的 omp 设置（`Settings.isolated`）：不写 omp 配置，也不影响同时运行的其他会话。运行时不再设置进程级的 `PI_EDIT_VARIANT`（`scripts/probe-agent.ts`、`scripts/probe-omp.ts` 两个旧探针仍自行固定 Hashline）。
- 写代码的任务（`web-product`、`code-change`）固定 Hashline：用 `edit.modelVariants` 的空模式匹配所有模型，优先级高于 omp 的按模型族回退。
- 其他任务（`general`、`research`、`file-work`）沿用 omp 的逐模型选择。
- 直连沙箱的文件代理支持 omp 的全部编辑格式，按会话实际使用的格式给出工具说明和参数结构；非 Hashline 会话读取文件时不带行哈希。
- 同一处设置沿用上一轮的取值：ast_grep 开启、LSP 不使用 omp 共享守护进程、重试最多 4 次且单次等待不超过 30 秒。
- 位置：`src/runtime/omp-settings.ts`、`src/runtime/direct-file-tools.ts`、`src/runtime/sandbox-file-worker.ts`。

用 `ompSessionSettings` 与 `sessionEditMode` 实测的结果：

| 模型 | 非代码任务 | 代码任务 |
|---|---|---|
| xiaomi-token-plan-cn/mimo-v2.6-flash | replace | hashline |
| deepseek/deepseek-v4-pro | replace | hashline |
| anthropic/claude-sonnet-5 | hashline（omp 默认） | hashline |

## 3. 并行运行

服务端去掉了“同一时刻只能有一个操作”的单一槽位，改为按资源判断冲突（`src/runtime/operation-manager.ts`）：

- 同一个任务同一时刻只有一个操作（运行、追问、发布、验收、应用成果等）；
- 写入同一文件夹（包括上下级目录）的操作互斥，因此同一目录里的任务依次运行；
- 更改项目挂载目录要等该项目所有任务结束；清理预览独占整个工作台；
- 模型运行（含追问）受「设置 → 运行 → 同时运行的任务数」限制，默认 3，范围 1–8。超过上限时新任务进入队列；队列和自动化在有空位时依次启动，跳过正忙的任务；
- 可见的预览浏览器只有一个：浏览器验收按先来后到排队，模型运行只在浏览器空闲时连接预览。

接口变化：

- `GET /api/tasks` 返回 `{ tasks, runs, operations }`（原来是 `activeTaskId`、`activeRunId`、`operation`）；
- WebSocket 推送 `runs` 与 `operations` 两类消息；新任务创建出来后会重新推送 `runs`，界面据此按 `runId` 打开自己发起的任务；
- `POST /api/tasks/:id/cancel` 接受运行 ID 或任务 ID；运行错误事件带 `runId`；
- 任务摘要增加 `runKind`（`run` 或 `answer`）。

界面按任务区分状态（`desktop/ui/src/state/workbench.ts`）：

- 每个任务显示自己的阶段和停止按钮；其他任务在运行时，当前任务照常可以继续、修订或追问；
- 只有正在做浏览器验收的任务才占住预览栏，其他运行中的任务不再锁定预览；
- 新建任务时，如果运行数已达上限，按钮变为“创建并排队”，并提示可在设置中调整上限；
- 收起的侧栏列出所有运行中的任务。

## 4. 拆分

- `src/server.ts` 从 2142 行减到 77 行，只负责启动、恢复、路由表和定时器。
- `src/server/context.ts`：共享状态、任务视图、事件广播；`src/server/http.ts`：路由匹配和通用响应；`src/server/runs.ts`：运行启动、构建、预览发布、浏览器验收、追问、队列与自动化调度；`src/server/routes/`：按领域分成 tasks、start、settings、library、web、projects、automations 七组。
- `omp-runner.ts` 的会话装配拆出 `session-profile.ts`（角色、工具、提示词）和 `omp-settings.ts`（每会话 omp 设置、LSP 生命周期）。
- 接口路径与行为除第 3 节所列变化外保持不变。

## 5. 追问

- 接口：`POST /api/tasks/:id/ask`，请求体 `{ question }`，1–8000 字。
- 追问是一次独立的只读运行：工具只有读取、搜索、托管工作区的 ast_grep 与只读 LSP、普通任务的输入读取、Skill 读取和 Office 只读工具；不改文件、不执行命令、不派发子代理，不改变目标、状态或验收结果。
- 回答接着任务自己的 omp 会话进行，能看到之前的对话；这次问答也会留在会话里，之后的运行可以参考。
- 追问占用这个任务（不能与它的其他运行同时进行），计入并行上限，但不占用文件夹，因此不妨碍同目录的其他任务。
- 界面：空闲任务的输入框多一个「追问」标签（已完成任务为「修订目标 / 追问」）。问题在时间线里显示为“追问”消息，回答是单独一轮“回答追问”，结束状态为“已回答”或“回答失败”；回答过程中可以停止。发出后输入框停留在追问模式，便于连续提问。
- 运行记录（模型、用时、用量）照常写入任务，标为 `answer`；计算任务的总工具调用和总时长时不计入追问，提问不会挤占任务后续工作的预算（`taskBudgetUsed`）。

## 验证

- `bun run check` 通过。
- `bun run test`：见交付说明中的结果。
- 新增或更新的测试：
  - `test/session-profile.test.ts`：追问会话在各任务类型下都没有写入类工具；Alpha 契约追加在 omp 提示词之后；只有代码任务固定 Hashline；
  - `test/task-workbench.test.ts`：追问接口的空问题、超长问题、任务不存在、跨源请求；任务列表的新结构；
  - `test/workbench-state.test.ts`：多个任务并行时各自的忙碌状态与阶段、只有使用浏览器的任务占住预览、新任务按自己的 `runId` 打开而不会被其他任务的运行带走；
  - `test/workbench-timeline.test.ts`：追问显示为用户消息，回答为“回答追问”一轮；
  - `test/task-ledger.test.ts`：追问的运行记录不计入任务预算；
  - `test/reliability-boundaries.test.ts`：资源冲突规则与浏览器排队。
- 在隔离工作区启动服务，用无头 Chrome 检查已完成任务的时间线（含追问与回答）、追问模式、修订模式和新建任务页。

## 未覆盖与已知限制

- 没有用真实模型跑完整的追问，也没有让多个任务真实同时运行做端到端压测（都会消耗模型额度）；上述行为由接口测试、状态测试和界面检查覆盖。
- 预览浏览器仍只有一个：多个网页任务同时到达验收阶段时依次进行。
- 同一文件夹中的任务仍然依次运行。
- 同一窗口同一时刻只发送一个操作请求（界面的 `pending` 仍是单一的），不影响服务端并行。
