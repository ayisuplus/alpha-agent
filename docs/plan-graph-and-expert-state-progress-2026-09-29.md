# 计划图与专家状态：施工进展与未完事项（2026-09-29）

[施工方案](plan-graph-and-expert-state-2026-09-29.md) 的执行记录。施工主体见 `dc4a7e4`；后续提交：`4ccaf97`（进展记录）、`22bf782`（评测场景）、`fff7a59`（界面回边）、`274409d`（专家提案界面）。

## 已完成且已验证

| 阶段 | 内容 | 验证证据 |
|---|---|---|
| P0 | 量化基线写入方案附录 A（能力池 119 条/111 条 expert-、默认 2 Skill、提示词 token、评测三任务轮次与 token） | 方案附录 A；`artifacts/probe-*-p0-baseline.log` |
| P1 | 先计划工具守卫、计划自动批准（`planApprovalMode`）、默认 Skill 空池、能力目录移除专家随包 Skill | `test/plan-first.test.ts` 3/3；capability 测试 |
| P2 | `src/runtime/expert-scope.ts` 六步装载；mounts 声明（`index.json` skill→primarySkill）；主方法注入+预算退回；人设删除"先读取随包方法" | `test/expert-scope.test.ts` 5/5；`test/experts.test.ts` 11/11 |
| P3 | PlanNode 词汇（mode→kind）、三阶段骨架、alpha_plan 校验、node/entered\|waiting\|exited 生命周期、alpha_step 退出节点+游标推进+node-switch、AccessLevel 两档、旧任务单节点图 | `test/plan-graph.test.ts`；`scripts/probe-plan-graph.ts` 全绿 |
| P4 | rework/premise 回边、node/reopened（含自动返工 2 轮上限）、消费输入过期、plan-graph/gate 缺口投影、指定专家图约束 | `test/plan-graph.test.ts` 14/14；全量 500/500 |
| P5 | roles.json 词表、内容线 11 专家 handoff、交接边界段生成、下游交接上下文（`handoffSection`）、defaultGates、gate 承担者解析、候选增强、专家提案+用户批准（含工作台界面）、`test/agent-presets.test.ts` | `test/agent-presets.test.ts` 5/5；characterization 18/18 |
| P5 补漏 | `alpha_reopen` 进入 coordinator 工具表与提示词（§3.5/§6.1） | `bun run check`；`test/plan-graph.test.ts`（reopen 行为） |
| P6 界面 | PlanGraph：阶段、节点、依赖、**回边**、游标高亮、专家、交接产物、gate 角色与结论、等待节点标记；react-dom/server 渲染冒烟 8/8 通过 | `bun run build:desktop-ui`；冒烟脚本（已删除） |
| P6 界面 | 专家提案审批按钮（存入专家库/拒绝）+ 折叠栏提醒；客户端 `decideExpertProposal` | `bun run build:desktop-ui`；路由契约见 `src/server/routes/tasks.ts` |
| P6 评测 | 新增两类场景任务：`content-pipeline`（内容线全流程 + 合规 gate 陷阱）、`stale-premise`（前提有误：objective 指向 money.ts，真实缺陷在 total.ts 的 `Math.round`）；`eval/run.ts` 支持 `checks.text`、代码任务的答案检查、从事件日志读取计划图指标（计划提交/修订、rework/premise/redo 回边、changes-requested 结论） | `bun run eval --selfcheck` 12/12 |
| 全量验证 | `bun run test` **505/505 通过**（67 文件，138s）；`bun run check` 0 错误；`bun run scripts/characterize-ledgers.ts` 三场景一致；`sync-core-experts --apply` 14 个包刷新 | 见上；日志在会话记录与 `artifacts/` |

## 未完成

### 0. 第一轮评测暴露并已修复的三个缺陷（2026-09-29）
第一轮（deepseek/deepseek-flash）5/5 独立检查通过，但账本显示四个任务停在 `active`：这是真实缺陷，不是评测噪声。
| # | 现象（证据） | 根因 | 修复 |
|---|---|---|---|
| F1 | `lru-cache`/`stale-premise` 停在 `plan-review`，失败记录"计划自动批准未完成：Plan or project changed" | `reviseCognition` 在 auto 模式用**旧**的源指纹提交审批，而协调者在同一轮里改过源码 | `reviseCognition` 先 `refreshRevision()` 再记录修订，计划与审批绑定当前源码（§3.5） |
| F2 | 除 `approval-loop` 外节点全部停在 `ready/planned`，图空转：模型反复 `alpha_plan`（plans 1/rev 1–3）干完活也不进节点 | 首个计划在**本轮内**自动批准，但本轮会话是在没有节点时创建的（无节点、默认权限），且没有任何机制把首节点纳入游标 | `alpha_plan` 自动批准后立即发 `onCursorMoved`（`sameConfig: false`）结束本轮；driver 按 `node-switch` 续跑，下一轮进入首节点并重建会话（§3.6/§7） |
| F3 | harness 在运行边界（`running=false` 的间隙）就判定任务结束并评分，`rework/premise/redo` 统计因此失真 | `waitForTask` 只要见过 running 就认为"不再 running"即结束 | 引入稳定窗口：`active` 任务需连续 4 次（约 20s）空闲才判定结束 |
| F4 | 修好 F1/F2 后的冒烟运行停在第 2 个节点：模型为了给出产物哈希去调 `powershell Get-FileHash`，触发命令审批暂停 | `alpha_step` 要求模型自己算 sha256；而哈希本应由运行时在退出时对文件计算（模型没有理由为此执行 shell） | `alpha_step` 的 `artifacts[].hash` 改为可选，缺省时由工具读取文件计算 sha256 并写入交接记录；`exitNode` 的校验不变 |
| F5 | 同上冒烟：run 以 `node-switch` 结束后 driver 没有继续——被 `acceptRun` 的"本轮没有可审阅产出"错误提前终止 | `verifyCycle()` 无条件跑验收，节点切换这种运行边界被当成一次失败的尝试 | `verifyCycle` 在验收前跳过 `node-switch` 的运行；driver 随后按既有分支继续到下一个节点 |

| F6 | 冒烟中图跑到第 3 个节点时暂停：模型给审查节点起了 `gateRole: "self-check"`，没有任何专家能承担 → 运行到一半记能力缺口 | 计划校验只检查"任务默认 gate 与专家声明 gate 有没有节点"，没有检查节点自创的 gateRole 有没有承担者 | `alpha_plan` 用 `gateActorFor` 在记录计划前校验每个审查节点的 gateRole：没人能承担就报错并列出可用角色，让模型当场改计划（工具描述同时写明 gateRole 的取值口径） |

| F7 | 图跑通后的完整轮：`content-pipeline` 与 `approval-loop` 停在 `active`——协调者做完一个节点就停了，`draft`/`apply` 一直 `ready`，没人推进；`content-pipeline` 还因为停在只读的 `research` 节点而报"会话没有写文件工具"的能力缺口 | 运行以 `returned` 结束后，非目标模式的任务没有任何继续机制（goal 模式才有 `nextGoalCycle`） | `goal-continuation.nextPlanCycle`：批准的图里还有 `active`/`ready` 的协调者节点时，driver 自动续跑并提示"用 alpha_step 结束已完成的节点，再做下一个就绪节点"；连续两轮图与证据都没变化则记失败停下（与 goal 模式同一套无进展规则）；goal 模式仍走自己的续跑 |

回归测试：F1/F2 在 `test/plan-first.test.ts`（含 `settleBoundary` 的边界结算与 `nextPlanCycle` 的推进规则），F4/F6 在 `test/cognitive-workflow.test.ts`；均验证过"修复前失败、修复后通过"（`git stash` 对照）。

另：`totalTokens` 里 DeepSeek 会计入 prompt 缓存命中（第一轮 approval-loop 9.75M 中 7.38M 是 cacheRead），评测报告已拆成"新输入+输出 + 缓存读"两列，跨模型对比只用前者。

### 1. 端到端评测（进行中）
- 迭代过程中被缺陷中断的三轮不计入对比，作为证据保留：
  - `artifacts/eval-2026-09-29-p6-round-1-preboundary/`（暴露 F1–F3；5/5 通过但任务被提前评分）
  - `artifacts/eval-2026-09-29-p6-round-1-boundary-incomplete/`（修复 F1–F3 后暴露 F4–F6；0/5）
  - `artifacts/eval-2026-09-29-p6-round-1-stalled/`（修复 F4–F6 后暴露 F7：`sales-question`/`lru-cache`/`stale-premise` 通过，`content-pipeline`/`approval-loop` 停在图中间；3/5）
  - `artifacts/eval-2026-09-29-p6-round-1-provider-down/`、`…-xiaomi-partial/`（模型与额度问题）
- 冒烟验证（`sales-question` 单任务）：图跑通、任务 `complete`、独立检查通过，新输入+输出 29,511 tokens（P0 同任务 28,946），轮次 1→4——小任务开销的可比口径见下一轮完整评测。
- 第二轮（方案附录 A.3 要求"至少跑两轮取区间"）未跑。
- 与 P0 基线对比：`bun run eval compare artifacts/eval-2026-09-29-p6-round-3 artifacts/eval-2026-09-29-p6-round-1`。小任务（`sales-question`）看轮次与 token 增量；内容任务关注 gate 拦下数（报告"计划图"列的计划/回边/退审计数）；`stale-premise` 关注是否出现 premise 回边与计划修订。
- 注意：第一轮评测使用的是 `22bf782` 时点的工作树（服务器在启动时加载模块，之后的提交不影响该进程）。

### 2. §6.2 审查节点上下文（部分）
- 审查工作流的产物路径已含：任务目标、验收标准、变更路径与受限 diff、只读源码。
- 尚未把上游节点的交接记录（`handoffSection`）注入 `development-workflow.ts` 的审查工单 objective；`roleContract` 的 reviewer 会话分支也还没有 `handoffSection`。

### 3. 审查者会话路径是死代码（§12 收尾）
- `executionMode: "review"` 全仓库无生产者：`omp-runner.ts` 的 `reviewing` 分支、`session-profile.ts` 的 reviewer 提示词与工具表、`createDevelopmentReviewTool`(`alpha_review_result`) 实际都到不了。真实路径是 kind=`review` 的 work order（worker 角色，`alpha_worker_result`）。
- 按方案 §12"不保留调查、执行、审查三类子代理类型"，应删除这些分支；`test/cognitive-runtime.test.ts:76` 直接调用 `createDevelopmentReviewTool`，需要一并迁移或删除。

### 4. 人设手写交接句
- 生成的"交接边界"段已入包（`personaText` 生成），但 11 个内容线人设里的手写交接句仍在（含跨线路由与权威规则）。逐条并入 `handoff` 声明后再删除，属可选清理。

### 5. 其他
- `quick_validate.py`：AGENTS.md §6 引用，但本仓库与相邻项目均不存在（缺口，未伪造）；`test/agent-presets.test.ts` 已替代其词表/角色校验职责。
- 内容线合规 gate 在真实任务上的"拦下问题数"只有评测能给出（第 1 项）。
- 方案文档头部仍写"状态：方案已定稿，未实施"，可改为指向本文。
