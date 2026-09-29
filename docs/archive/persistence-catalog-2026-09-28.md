# 持久化清单（2026-09-28）

> 归档（2026-09-30）：本文记录已放弃或已被取代的旧架构与方案，不代表当前版本。当前方向见 [原生 OMP 重构](../2026-09-29-omp-native-refactor.md) 与 [定版收束建议](../2026-09-30-final-convergence-recommendations.md)。

[P5](cognitive-state-machine-plan-2026-09-28.md) 的交付：Alpha 落在磁盘上的每一种文件，都有格式版本、迁移路径和一句话说明。参考 dsh 的 persistence-catalog。

分类口径：

- **事件化**：任务范围内的状态，事实来源是任务事件日志（`.alpha/tasks/<id>/events.v1.jsonl`），原文件降级为投影（读取方不变，写入方先追加事件再重写投影）。
- **事件 + 投影（全局）**：跨任务状态，用同一套日志原语（`src/runtime/task-events/log.ts` 的 `appendEvent`/`readEvents`，通用信封 `{seq, at, actor, runId?, type, payload}`）写全局日志，原 JSON 文件保持投影。
- **保持原样**：缓存、日志、二进制/媒体产物、只读来源归档——它们不是状态，不需要事件化。

## 一、任务范围

| 路径 | 格式与版本 | 用途 | 分类 | 迁移路径 / 状态 |
|---|---|---|---|---|
| `.alpha/tasks/<id>/events.v1.jsonl` | 追加式 JSONL，信封 `{seq, at, actor, runId?, type, payload}`；版本在文件名 | 任务状态的唯一事实来源（45+ 事件类型） | —（本体） | v1 现行；v2 迁移包按"一步 v1→v2"实现 |
| `.alpha/tasks/<id>.json` | 单个 JSON（`TaskState` 投影），无内嵌版本字段 | 未迁移读取方的投影（界面、脚本、自动化） | 保持原样（投影） | 可由折叠重建；删除只影响加载速度 |
| `.alpha/tasks/<id>/snapshot.<seq>.json` | 单个 JSON `{version, seq, offset, state}` | 折叠缓存 | 保持原样（缓存） | 删掉只影响加载速度 |
| `.alpha/prompt-blobs/<sha256>.txt` | 纯文本，按内容寻址 | `step/context` 引用的模型可见上下文块 | 保持原样（blob） | 同文本只存一份；删除后 replay 报"存储块缺失" |
| `.alpha/operation-journal/<taskId>.json` | 单个 JSON `JournalEntry{taskId, runId, startedAt, status, finishedAt?, format: "operation-journal", version: 1}` | 每任务一个运行闩：死机后知道哪次运行还活着 | **事件化** | 事件 `operation/started|finished`；投影同形保留（`reconcile()`、扫描脚本仍读它）；旧文件无 `format` 字段也照读 |
| `.alpha/approvals/<taskId>/<id>.json` | 单个 JSON `CommandRequest{status, review, exactAction, result}`，新增 `format`/`version` | 命令与精确文件动作的审批与执行回执 | **事件化** | 事件 `approval/requested|reviewed|claimed|finished`；投影同形保留（`code-acceptance.ts`/`code-check.ts` 的回执查找不变） |
| `.alpha/web-approvals/<taskId>.json` | JSON 数组，新增 `format`/`version` | 网页只读授权与外部写入审批 | **事件化** | 事件 `web-approval/requested|decided|read-granted|write-begun|write-finished|reconciled`；投影保留（`GET/POST /api/tasks/:id/web-approvals` 不变） |
| `.alpha/web/<taskId>.json` | 单个 JSON（检索作业状态），新增 `format`/`version` | 网页检索/抓取的作业与额度记录 | 保持原样（任务级回执） | 若需要重放检索过程，按 `web/searched`、`web/crawl-*` 事件化；当前只读用途不值得 |
| `.alpha/project-turns/<runId>.json` | 单个 JSON（回合脏基线与提交），新增 `format`/`version` | 项目状态回合：跑前脏基线、代码提交、记忆提交 | 保持原样（恢复日志） | `checkpoint/*` 事件已覆盖提交事实；脏基线是恢复用的保守日志，事件化留待需要 |
| `.alpha/mcp-permissions.json` | 单个 JSON（授权 + 回执 map），新增 `format`/`version` | MCP 逐工具授权与外部动作回执 | 保持原样（授权） | 回执半可按 `mcp-receipt/*` 事件化；授权是设置，不是任务状态 |
| `.alpha/imports/<id>.json` | 单个 JSON（导入清单），新增 `format`/`version` | 导入既有项目的清单与来源 | 保持原样（来源归档） | 一次性产物，只读 |
| `.alpha/sources/<taskId>/<id>.json`、`.alpha/reviews/<taskId>/<operationId>.json` | 单个 JSON（来源/审阅归档），新增 `format`/`version` | 研究来源（`research-source.ts` 归档）与源码审阅记录 | 保持原样（来源归档） | 一次性产物，只读 |
| `.alpha/tasks/<id>/worker-messages/**`、`.alpha/worker-agents/<taskId>/<agentId>/state/**` | 每条消息一个 JSON、ack 标记文件 | 子代理信箱的传输层（子进程 150ms 轮询） | 保持原样（传输层） | 事实来源已是 `worker/message-queued|acknowledged` 事件；文件保留给子进程 |
| `.alpha/workers/<taskId>/<instanceId>/**`、`.alpha/worker-runs/<taskId>/<instanceId>/**` | 目录：base/ 冻结副本、merge.json、result.json、events.jsonl | 子代理工作副本、合并报告、结果 | 保持原样（工作区） | `worker/*` 事件已覆盖生命周期；这些是可检查的工作产物 |

## 二、全局（跨任务）

| 路径 | 格式与版本 | 用途 | 分类 | 迁移路径 / 状态 |
|---|---|---|---|---|
| `.alpha/task-queue.json` | 单个 JSON（队列项 + 计划），新增 `format`/`version` | 待执行任务队列与旧版定时 | **事件 + 投影（全局）** | 全局日志 `.alpha/task-queue/events.v1.jsonl`（`queue-item/*`、`schedule/*`）；投影重写；API 读取方不变 |
| `.alpha/automations.json` | 单个 JSON（自动化 + 运行历史），新增 `format`/`version` | 自动化定义、运行历史、通知策略 | **事件 + 投影（全局）** | 全局日志 `.alpha/automations/events.v1.jsonl`（`automation/*`、`automation-run/*`）；投影重写；调度器读取方不变 |
| `.alpha/settings.json` | 单个 JSON（全局设置），新增 `format`/`version` | 模型、预算、生成、界面等全局设置 | 保持原样（设置） | 设置是配置不是状态；改动历史需要时再加 `settings/changed` |
| `.alpha/agent-presets.json`、`.alpha/plugin-packs/installed.json`、`.alpha/mcp-tool-catalog.json` | 单个 JSON，均新增 `format`/`version`（工具目录用 `{tools, format, version}` 信封，旧的裸数组照读） | 专家库、已安装 Skill、已发现的 MCP 工具目录（缓存） | 保持原样（安装清单/缓存） | 安装/卸载是操作的结果，来源在 `SkillPluginStore`；需要审计时再事件化 |
| `.alpha/projects.json` | 单个 JSON，新增 `format`/`version` | 项目登记（挂载、权限模式、版本） | 保持原样（设置） | 同上 |
| `.alpha/workbench.json` | 单个 JSON，新增 `format`/`version` | 界面状态（侧栏、钉住、归档、标题） | 保持原样（界面状态） | 不属于任务状态 |
| `.alpha/web-secrets.json` | 单个 JSON（密文映射），由 `desktop/main.cjs`（Electron 主进程）写入 | 网页检索密钥 | 保持原样（密钥） | 永不入事件日志、不加版本字段（内容是密文，格式由 Electron 侧维护） |
| `.alpha/comfy-jobs/**`、`.alpha/evidence/**`、`.alpha/check-logs/**`、`.alpha/build-logs/**`、`.alpha/previews/**`、`.alpha/screenshots/**`、`.alpha/browser-progress*` | 目录/文件、媒体与日志 | 媒体任务、验收证据、检查与构建日志、预览快照 | 保持原样（产物） | 事件只记哈希与路径（`evidence/recorded`、`preview/published`）；文件本身是产物 |
| `.alpha/omp/**`、`.alpha/sessions/**`、`.alpha/omp-sessions/**` | OMP 自己的会话格式 | 模型会话原文 | 保持原样（外部格式） | P4 缺口：与 `step/context` 对照需要读 OMP 会话格式 |
| `.alpha/task-meta.json`（WorkbenchMeta）、`.alpha/window-state.json`、`.alpha/expert-packs/**`、`.alpha/plugin-packs/**` | 单个 JSON / 目录 | 任务元数据、窗口状态、打包的专家与插件 | 保持原样 | 元数据/安装包，不是任务状态 |

## 三、格式版本与兼容规则

- 每个 JSON 存储写入时带 `format`（存储名）与 `version: 1`；**读取方一律宽容**：缺字段照读（旧文件），未知 `version` 照读并 `console.error` 告警，不抛错。
- 迁移路径统一为"一步 vN→vN+1 的迁移包"：新版本只在需要改结构时出现，迁移包负责把旧文档读成新形状，投影写回时用新版本。
- 任务事件日志的版本在文件名（`events.v1.jsonl`）；换格式 = 新文件名 + 迁移包，旧文件保留。

## 四、崩溃安全

| 存储 | 崩溃后果 | 现状 |
|---|---|---|
| 任务事件日志 | 半行会被下次追加截断，折叠忽略断尾 | 已处理（`inspectLogTail`） |
| 各投影 JSON | 写入用临时文件 + 改名，崩溃留下 `.tmp` 垃圾但文件一致 | 已处理 |
| 操作日志闩 | 死机留下 running 闩 → 启动时 `reconcile()` 回收（含回收孤儿子进程） | 已处理（`reapOrphanWorkers`） |
| 信箱传输文件 | 死机丢不了消息（文件在）；事件侧可重建"已排队 − 已确认" | 已处理 |
| 全局日志（队列/自动化） | 同任务日志：断尾截断 + 序号 CAS | 已处理（复用 log.ts） |

## 五、P5 验收对照

| 计划 P5 要求 | 结果 |
|---|---|
| 逐个评估六种附属存储 | 见上表：任务范围 13 行、全局 8 行，每行都有用途、分类与迁移路径 |
| 能归入任务事件的归入 | `operation-journal`（`operation/started|finished`）、命令审批（`approval/requested|reviewed|claimed|finished`）、网页授权（`web-approval/requested|decided|read-granted|write-begun|write-finished|reconciled`）已事件化，投影同形保留 |
| 属于全局的改为事件 + 投影 | 任务队列（`.alpha/task-queue/events.v1.jsonl`：`queue-item/*`、`schedule/*`、`queue/imported`）与自动化（`.alpha/automations/events.v1.jsonl`：`automation/*`、`automation-run/*`、`automation/imported`）；投影 `.alpha/task-queue.json`、`.alpha/automations.json` 重写，读取方不变 |
| 每种持久化文件都有格式版本 | 全部 JSON 存储写 `format`/`version: 1`（`projects.json`、`mcp-tool-catalog.json` 用信封装数组），读取方宽容：缺字段照读、未知版本告警不抛错；任务事件日志的版本在文件名 |
| 迁移路径与一句话说明 | 上表每行；统一规则见第三节 |

事件化的一致做法：事实来源是事件，投影文件按原形状重写（读取方不变）；存储被首次触碰时把旧文件导入为一条起源事件，原文件不动；新字段在状态里出现（`TaskState.operation`、`approvals`、`webApprovals`），折叠即可重建。

## 六、验证

- `bun run check` 通过；`bun run test` **464 通过、0 失败**（P4 时 459）。
- 新增测试：`test/task-events-approval.test.ts`（命令与网页授权的生命周期事件、投影形状、折叠一致、旧文件一次性导入）、`test/global-events.test.ts`（全局日志的信封/序号/锁、队列与自动化的生命周期、导入一次），以及每个存储的 `format`/`version` 与宽容读取断言。
- `bun run characterize` 三场景一致（探针新增 `recordStepContext`、`recordOperationStarted`、`recordOperationFinished`）。
- `bun run characterize:import` 13/13、`bun run invariants` 4 条存量违反不变。

## 七、缺口

- `.alpha/web-secrets.json` 由 Electron 主进程写入（密文映射），不加版本字段；若将来由服务端写入再补。
- `.alpha/mcp-permissions.json` 的**回执半**仍是文件：可按 `mcp-receipt/begun|finished` 事件化，授权半保持设置性质。
- `.alpha/web/<taskId>.json`（检索作业）与 `.alpha/project-turns/<runId>.json`（脏基线）保持原样：前者只读回执，后者是恢复用的保守日志；需要重放时再事件化（事件类型已在上表列出）。
- 全局日志没有快照（`writeSnapshot` 面向 `TaskState`）；队列与自动化的日志目前都很小，量大了再补。

