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

### 1. 端到端评测（进行中）
- 第一轮（`--label p6-round-1`，任务：`content-pipeline`、`stale-premise`、`sales-question`、`lru-cache`、`approval-loop`，并发 2）在本轮施工结束时仍在运行，结果落在 `artifacts/eval-2026-09-29-p6-round-1/`（`results.json` 逐任务写盘，可随时查看已完成部分）。
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
