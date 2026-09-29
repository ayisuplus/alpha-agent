# Alpha 本机首版

当前 Windows 安装入口：[Alpha-Setup-0.1.0-x64.exe](Alpha-Setup-0.1.0-x64.exe)。本次 OMP 发行归档与校验值见 [2026-09-29 发行归档](docs/2026-09-29-release-archive.md)。

网页搜索与操控现由 Alpha 内核统一管理：Tavily 搜索、Firecrawl 提取和采集、带来源哈希的归档，以及 Electron 可见标签页共享任务授权和人工接管状态。密钥在「设置 → 网页服务」配置；完整边界与验证见 [网页内核说明](docs/web-kernel-2026-09-25.md)。

在 Windows 上运行 [Alpha.cmd](release/alpha-portable-2026-09-24T16-40-57-095Z/Alpha.cmd)（源码版用 `bun run desktop` 启动，新便携包用 `bun run package:portable` 生成）。工作台为三栏：左侧搜索和切换任务；中间是任务对话——头部显示目标版本、验收项与最近问题，时间线按轮展示 Alpha 的说明、工具调用、构建与浏览器验收结果，可下钻到逐步验收证据和源码 diff，底部唯一的输入框随任务状态切换为开始构建、运行中补充要求、继续修复或修订目标；右侧是实际运行的产品预览，可拖动分隔条调整宽度、接管或交回 Alpha。提交软件产品需求后，Alpha 会在本项目的 `release/products/` 中构建产品，并在 `release/.alpha/` 中保存任务、构建、预览和浏览器证据。预览只监听本机 `127.0.0.1`；关闭 Alpha 后预览服务停止，再次启动可从工作台重新发布并复验。

首版的执行引擎使用 OMP 和 Hashline；完成状态由构建、当前预览和浏览器验收共同决定。ComfyUI 是 Alpha 的内置插件，在「设置 → 插件」中可整体启停，并分别启停图片、配音和视频工具；设置在下一轮任务开始时生效。第三方 GitHub 仓库可在同一处安装为插件，按仓库提交号保存并独立启停；Alpha 装载 `skills/*/SKILL.md` 与同目录参考文件，并可单独启用仓库 `package.json` 声明的 Pi 扩展 Hook，以及根目录 `.mcp.json` 声明的 MCP 服务。Hook 与 MCP 都默认关闭并可分别开启；MCP 工具按插件和服务命名，仍须经过 Alpha 的工具白名单。设置中的「检测」可验证已启用 MCP 服务的连接与工具发现；服务所需程序、凭据及依赖须在本机可用。Hook 开启后会以 Alpha 进程权限执行第三方代码；Claude Hook 脚本尚未接入。ComfyUI 服务须由用户自行保持运行在 `127.0.0.1:8188`，Alpha 不会替换成其他生成服务。模型仍使用本机已有的 OMP 认证配置，便携包并不包含凭据或模型。

「设置 → 专家库」提供 30 个有人设和独立 Skill 的核心模板，覆盖全栈开发、AI/计算机科研、内容创作、平面游戏开发与文档办公。内容创作线在通用策划、剧本、视觉之外，新增面向中国媒体的抖音/快手增长、B站社区运营、小红书种草、微信生态（视频号/公众号/小绿书）、内容数据复盘、直播运营与内容合规审核共 7 个角色；平面游戏线新增游戏系统设计、2D 游戏程序、2D 游戏美术与动画、游戏测试与数值平衡共 4 个角色，不预绑引擎，按工单选定后实现。文档办公线新增 Word 文档、Excel 表格、PPT 演示、PDF 与文档处理、文件管理共 5 个角色。科研线的文献、实验、数据分析与论文写作 4 个角色已加深方法并附参考清单，内容创作线新增文章写作与改稿专家。完整人设与所选 Skill 进入相应实例，随工单保存固定快照；通用实例仍可完成不需要专家的任务。默认展示启用专家，停用名单可展开恢复。已有 WorkBuddy 导入库可用 `bun run scripts/curate-experts.ts --apply` 备份并整理；重复整理保留用户修改。已安装的核心专家可用 `bun run scripts/sync-core-experts.ts` 预览与当前模板的差异，加 `--apply` 先备份再更新，用户改过的专家不会被覆盖；`--add <模板 ID>` 可加入尚未安装的模板。专家职责、交接边界和验证方法见 [核心专家说明](docs/core-experts-2026-09-27.md)与[内容创作专家扩展](docs/content-experts-2026-09-27.md)，参考来源见 [来源记录](presets/agents/SOURCES.md)。游戏线职责、交接边界与验证方法见 [平面游戏开发专家扩展](docs/game-experts-2026-09-27.md)；科研线与文章写作专家见 [科研与写作专家更新](docs/research-writing-experts-2026-09-27.md)。

工作台现在提供 Web 产品、已有项目代码修改、研究和文件四种任务。代码任务将当前项目快照导入受管理的 Git 工作树或副本，在副本中运行已配置检查；额外命令逐条审批，应用回原项目须审阅差异与冲突。研究任务归档网页来源和访问日期；文件任务可上传输入并生成带版本证据的 PDF、DOCX、XLSX。侧栏「自动化」支持一次性与周期计划、独立新任务或跟进已有任务、模型选择、暂停与运行记录；任务详情仍可管理待执行队列和旧版定时。定时只在应用运行时执行；应用关闭期间错过的轮次在下次启动最多补排一次。第三方 MCP 工具在「设置 → 插件 → 检测」后须逐工具授权；外部写入以请求标识记录回执，结果不确定时不会自动重发。

文件任务可通过[内置办公文档处理](docs/office-processing.md)读取并修改 DOCX、XLSX、PPTX 和文本 PDF，生成独立版本及任务内的前后 PDF 预览。

构建进程仍在可信 Windows 本机运行，当前没有 OS 级沙箱。动态后端、任意桌面软件自动操作、外部平台部署不在这一版范围内。生成媒体的技术解码与页面检查不等于主观审美或音色验收。

详细施工与失败记录见 [验收记录](docs/implementation-status.md)；本轮评审修复与待决定事项见 [评审修复记录](docs/review-fixes-2026-09-27.md)；工作台重构见 [三栏工作台](docs/workbench-redesign-2026-09-24.md)，上一轮见 [任务审阅迭代](docs/workbench-iteration-2026-09-24.md)，此前对照见 [Codex 工作台对照记录](docs/codex-workbench-benchmark-2026-09-24.md)；参考框架分析和原施工计划见 [设计基线](docs/alpha-analysis-and-build-plan.md)。

评测：`bun run eval` 通过工作台接口给 Alpha 派 `eval/` 中的任务，用 Alpha 看不到的隐藏测试和答案检查打分，并记录 Alpha 自己的验收结论，可用 `--app` 对比其他版本；用法见 [评测集说明](eval/README.md)，首轮结果与发现的问题见 [Harness 修复与评测](docs/harness-fixes-eval-2026-09-28.md)。运行会真实调用模型。测试（`bun test`）通过 `bunfig.toml` 预加载关闭真实 Windows 沙箱，不会弹出沙箱安装窗口。

任务状态机：任务账本的事实来源是 `.alpha/tasks/<id>/events.v1.jsonl` 只追加事件日志，`<id>.json` 是它的投影；追加用序号比较并交换、锁目录带持有者信息（进程死了立刻接管），主进程与子代理进程可以并发写同一任务。任务暂停带原因码（等待批准、沙箱不可用、模型不可用、项目状态异常、能力缺失、子代理未交结果、等待回答、预算用尽），停止带停止码，工作台按码渲染恢复按钮；时间线的持久轨读事件日志（`GET /api/tasks/<id>/events?since=<seq>`），活动日志只留工具调用与流式文本。`bun run invariants` 只读扫描现有账本是否违反不变量并出报告，`bun run characterize` 校验账本 48 个修改方法的行为基线（`--write-fixtures` 重建），`bun run characterize:real` 对真实账本的副本回放同一探针，`bun run characterize:import` 校验旧账本"导入 → 折叠 → 投影"与原文件一致（都不写 `.alpha`）。子代理的生命周期也在事件里：`worker/activated` 记子进程 pid（硬杀后恢复时回收孤儿进程），`worker/result` 记停止原因（未交结果/超时/预算/取消/超 token 等），信箱按"已排队减已确认"重建，计划步骤带看板修订号与比较并交换。模型看到的每一步也入日志：`step/context` 记上下文哈希与体积，大块内容按哈希存 `<dataRoot>/prompt-blobs/`，`bun run replay <taskId>` 重建每一步的任务上下文并核对哈希与目标行；评测报告带「每步上下文」与「首响应」。重构计划见 [任务状态机重构计划](docs/cognitive-state-machine-plan-2026-09-28.md)，基线与存量违反见 [P0 基线与护栏](docs/task-state-machine-p0-baseline-2026-09-28.md)，事件日志落地见 [P1 事件日志与折叠](docs/task-state-machine-p1-event-log-2026-09-28.md)，原因码与时间线见 [P2 状态与暂停原因显式化](docs/task-state-machine-p2-reason-codes-2026-09-28.md)，子代理生命周期见 [P3 子代理生命周期](docs/task-state-machine-p3-worker-lifecycle-2026-09-28.md)，模型可见即记录见 [P4 模型可见即记录](docs/task-state-machine-p4-model-visible-2026-09-28.md)。
