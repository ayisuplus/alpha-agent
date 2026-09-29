# 计划图与专家状态：施工进展与未完事项（2026-09-29）

[施工方案](plan-graph-and-expert-state-2026-09-29.md) 的执行记录。所有改动已提交（`dc4a7e4`，122 个文件）。本文列出**已验证的完成项**与**未完成项**，供继续施工时直接接着做。

## 已完成且已验证

| 阶段 | 内容 | 验证证据 |
|---|---|---|
| P0 | 量化基线写入方案附录 A（能力池 119 条/111 条 expert-、默认 2 Skill、提示词 token、评测三任务轮次与 token） | 方案附录 A；`artifacts/probe-*-p0-baseline.log` |
| P1 | 先计划工具守卫、计划自动批准（`planApprovalMode`）、默认 Skill 空池、能力目录移除专家随包 Skill | `test/plan-first.test.ts` 3/3；capability 测试 |
| P2 | `src/runtime/expert-scope.ts` 六步装载；mounts 声明（`index.json` skill→primarySkill）；主方法注入+预算退回；人设删除"先读取随包方法" | `test/expert-scope.test.ts` 5/5；`test/experts.test.ts` 11/11 |
| P3 | PlanNode 词汇（mode→kind）、三阶段骨架、alpha_plan 校验、node/entered\|waiting\|exited 生命周期、alpha_step 退出节点+游标推进+node-switch、AccessLevel 两档、旧任务单节点图 | `test/plan-graph.test.ts`；`scripts/probe-plan-graph.ts` 全绿 |
| P4 | rework/premise 回边、node/reopened（含自动返工 2 轮上限）、消费输入过期、plan-graph/gate 缺口投影、指定专家图约束 | `test/plan-graph.test.ts` 14/14（含四项 P4 测试）；全量 500/500 |
| P5（部分） | roles.json 词表、内容线 11 专家 handoff、交接边界段生成、下游交接上下文（`handoffSection`）、defaultGates、gate 承担者解析、候选增强、专家提案+用户批准、`test/agent-presets.test.ts` | `test/agent-presets.test.ts` 5/5；characterization 18/18 |
| P6（部分） | PlanGraph 界面组件、新任务文案（自动批准计划）、AGENTS.md §3 与术语表同步 | `bun run build:desktop-ui` 通过 |

通用验证：`bun run check` 0 错误；`bun run scripts/characterize-ledgers.ts` 3 场景一致；P4 时点全量 `bun run test` 500/500。

## 未完成（按方案阶段）

### P5 收尾
1. **`bun run test` 全量最终绿**：P5 后只跑了 agent-presets/characterization/cognitive-workflow（绿），未跑最后一轮全量。跑 `bun run test` 确认 500+ 全绿（P5 改了 task-profile/development-workflow/expert-tools/routes，可能有零星断言要对齐）。
2. **专家人设正文的交接句清理**：生成的"交接边界"段已入包（`personaText` 生成），但 11 个内容线人设里的手写交接句（"…交X专家…"）仍在——它们含跨线路由与权威规则，未机械删除以"保留原意"。可后续逐条并入 handoff 声明后删除。
3. **专家声明的 gate 覆盖在 alpha_plan 已校验**（defaultGates + 专家 gate），但 P5 测试列表里的"原开发审查测试迁移"只完成了语义迁移（gap 名 → gate；workflow 关闭 gate 节点），开发审查工作流的**最终审查节点化**只做到"recordIntegratedFinalReview 关闭 code-review gate 节点"，其内部仍是 final-review 实例流程；§6.2 的"上下文隔离"已由 `handoffSection` 承接，但工作流审查 worker 的提示词尚未裁剪为"仅目标、验收、产物、交接"。

### P6 未做
1. **端到端评测四类场景**（真实模型）：内容任务（调研→选题→脚本→脚本合规→画面→终审，含一次 changes-requested 返工）、代码任务（较难代码 + 多轮暂停）、小任务开销（改一行字 vs P0 基线）、中途改计划（premise 回退 + 修订）。命令：`bun run eval`（内容/改计划场景需先补 eval 任务脚本）。
2. **界面剩余**：图上"暂停时标出停在哪个节点"已由 PlanGraph 的 waiting 待办展示部分覆盖；gate 结论/交接产物展示已在 NodeCard 中；节点专家显示已含 activation/expertDecision。边（dependsOn/rework/premise）目前以"依赖"文字呈现，未画箭头——可选增强。
3. **quick_validate.py 不可用**：AGENTS.md §6 引用的 `skill-creator/scripts/quick_validate.py` 在本仓库与相邻项目均不存在，无法执行（缺口，未伪造）。`test/agent-presets.test.ts` 已替代其校验职责（词表引用、角色承担）。
4. **文档收尾**：方案文档头部"状态：方案已定稿，未实施"可更新为施工进展指针（本文）；§13 的目标值已在 P0 后填写，P6 评测后按实测校准。

### 其他已知缺口
- `compliance` gate 无专家时的"暂停+能力缺口"已有实现与单测（`gateActorFor`），但**端到端**（真实任务跑到该路径）未验证。
- 临时专家（temporaryExpert）在 `resolveExpertScope` 可装载，但其"存库提案"链路只做了 ledger/工具/路由 + 单测，工作台 UI 的提案审批按钮未做（P6 界面范围）。
- `alpha_reopen` 工具已实现（rework/premise/重做过期），但未接入主代理提示词的工具说明清单（`sessionToolNames` 已含 alpha_step/alpha_plan 等——alpha_reopen 需要加入 coordinator 工具表与提示词）。**注意**：`sessionToolNames` 的 coordinator 分支未列入 alpha_reopen，模型看不到该工具——这是 P5 的漏项，续做时第一件事补上。
