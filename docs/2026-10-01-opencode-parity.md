# Alpha 桌面对标实施与验收

固定基线：OpenCode v1.18.33，tag commit `51ef4be1d3c122f18fefb510dca8d778571f4f18`。Alpha 起点 `b2f4438`，OMP 18.4.3。实现 Windows 本机、中英文桌面；不迁入 OpenCode 内核、Solid 前端或其 JS 插件 ABI。

来源：<https://github.com/anomalyco/opencode/tree/v1.18.33/packages/app>、<https://github.com/anomalyco/opencode/tree/v1.18.33/packages/desktop>、<https://opencode.ai/docs/plugins/>、<https://opencode.ai/docs/skills/>、<https://opencode.ai/docs/mcp-servers/>。功能参考与重新实现，不复制品牌、图标或视觉资产。OMP 与 OpenCode 原始许可保持保真。

| 批次 | 来源 / 功能 | Alpha 适配 | 验收状态 |
| --- | --- | --- | --- |
| 1 | skills、mcp、plugins | 原生 SDK 宿主、运行时目录、Skill 导入编辑启停、MCP 生命周期与认证、原生插件管理 | 已接入；fixture 和 Electron 渲染通过，完整外部授权验收待做 |
| 2 | session commands、composer、requests | 共享命令目录、补全、多图草稿、队列、原生会话树、全文搜索标签、压缩导出、todo 与子 agent | 原生会话、图片队列取回/冷恢复、非空 Todo、两个实际并行子任务及记录冷恢复通过；Electron 入口通过 |
| 2 | OMP 原生计划机制 | local:// 文件、xd://propose 审阅、五种选择、模型工具恢复、暂停重进 | 五种选择及取消压缩通过真实内核 fixture；Electron 审阅和清空执行通过；外部编辑器/系统另存对话框待人工验收 |
| 3 | workspace、file、review、terminal | worktree、文件搜索标签与行引用、行级反馈、独立 shell、外部编辑器 | 已接入；原生行为与 Electron 操作通过，外部编辑器系统交互待人工验收 |
| 3 | snapshot / revert | 独立快照、差异预览、冲突保护、撤销重做 | 原生集成与 Electron 撤销重做通过；冲突由集成专项验证，UI 冲突专项待做 |
| 4 | providers、models、permissions、LSP | 原生配置与凭据、自定义服务商、权限规则、规则命令任务配置与 LSP | 已实现；配置/遮罩/项目来源/冷恢复、实际工具拒绝、原生 LSP 格式化与重连通过；外部 OAuth 待验收 |
| 4 | settings、desktop menu、updater | 快捷键、字体主题、通知声音、语言、多窗口、日志、导入与在线更新 | 已实现；生产 Electron 双窗口/英文/冷恢复/规则/LSP 配置/原生日志通过；更新助手与回滚通过；系统通知声音待人工验收 |
| 4 | packaging | 便携包、Office 探针、安装包、更新失败恢复 | 最终打包与完整发行包更新专项执行中，结果另记 |

每批记录类型检查、原生测试、UI 构建及真实行为证据；fixture、外部服务、Electron 与安装包验收分别记录。源码实现或 API 成功响应不能代替真实运行验收。

后续项：公开分享、远程服务器、WSL、macOS/Linux、IDE/CI。当前公开分享由本地导出代替。

## 逐项验收台账

| 编号 | 桌面行为 | 原生入口 / 实现 | 当前证据 |
|---|---|---|---|
| 1.1 | 启动身份、配置与 Skill 和 CLI 一致 | 保留 runRootCommand；同一 SDK session 加 IPC | native-host.test：CLI 清单相等；启动参数测试 |
| 1.2 | Skill 来源、启停、正文与参考材料 | 原生 loadSkills / capability all；原生 disabledExtensions；有边界的正文读写 | native-host.test；Electron 41.2.2 清单、正文导航 |
| 1.3 | Skill 本地导入并调用 | 原生 scanSkillsFromDir 验证，复制到原生目录，原生 /skill: | native-extensions.test：导入后的方法正文进入本机模型请求 |
| 1.4 | Skill 编辑与内置复制 | 原生 frontmatter 解析，旧内容比较，用户/项目目录 | 正文保存及旧内容冲突拒绝通过；生产 Electron 项目 Skill 连续两次保存及实际重载通过；内置复制有入口，UI 专项待做 |
| 1.5 | MCP 添加编辑删除启停 | 原生 config-writer / getMCPConfigPath；外部来源只读 | native-extensions.test 三种配置添加；编辑/删除专项待做 |
| 1.6 | MCP 状态、测试、重连、工具资源刷新 | 当前 MCPManager 和原生 xd:// 路由 | stdio/HTTP/SSE 连通与资源读取、重连；实际模型调用通过 |
| 1.7 | MCP OAuth、取消与手动回调 | 原生 discoverOAuthEndpoints / MCPOAuthFlow / AuthStorage | 本机 metadata→PKCE→回调→token 入原生凭据库及取消通过；外部服务授权待验收 |
| 1.8 | 插件安装、链接、更新卸载、诊断 | 原生 PluginManager | 本地插件加载、禁用后重启、链接更新、卸载且源文件保留通过；实际本机 marketplace 的项目安装、禁用/启用冷恢复、1.1 更新与卸载通过；公共 registry 待外部验收 |
| 1.9 | 插件配置、功能、来源许可错误 | 原生 settings/features/doctor，SDK 加载错误 | secret 配置不出现在目录响应；其它桌面操作专项待验收 |
| 1.10 | 配置状态与运行状态区分 | 单写者；空闲安全重开，忙碌待生效；其他已打开会话提示待加载 | 代码已接；忙碌、异步任务、终端接管专项待做 |
| 2.1 | 菜单/快捷键/斜杠共享命令与补全 | 原生 get_available_commands + 桌面命令目录 | Electron 命令目录和导航通过；Slash/Tab/中文组合输入有入口，逐键专项待做 |
| 2.2 | 文件引用、附件草稿恢复 | 原生 prompt；Electron preload 的磁盘存储，限制图片合计大小 | Electron 销毁/重建窗口后文字和图片恢复通过；根目录 @ 补全已接；行范围引用留在第三批 |
| 2.3 | 排队、中途补充及队列状态 | 原生 steer/follow_up、getQueuedMessages、popLastQueuedMessage / toRestoredQueuedMessage | 实际生成中取回 steering 图片，保留 follow-up 并实际消费；先保存原生原图恢复格式再 dequeue，冷恢复通过 |
| 2.4 | 会话全文搜索标签、分支、历史树 | 原生 session-loader / sessionManager / navigateTree / branch | native-session.test：正文搜索、标签、历史导航、带图片分支、新旧 ID 与冷启动恢复通过 |
| 2.5 | 压缩、本地导出 | 原生 compact / export_html | 真实原生 HTML 生成通过；Electron 系统保存框待人工验收 |
| 2.6 | todo、子 agent、待处理请求 | 原生 RPC / lifecycle bus / readRpcSubagentTranscript | 非空 Todo、两个实际并行子任务、完成和重启后读取真实原生日志通过；待处理请求沿用原生 RPC UI |
| 2.7 | 原生计划入口、修订和重进恢复 | 原生 plan 状态、产物和模式日志；薄桌面审阅控制器 | native-plan.test：write/edit 限制、持续修订、暂停/重进、审阅重启恢复通过；local:// 使用原生 resolver 预览 |
| 2.8 | 计划五种审阅与分节反馈 | 原生 preparePlanForReview、compact、newSession、模型转换和产物复制 | 五种选择、旧内容冲突、关闭不批准、压缩取消不执行通过；分节反馈已接；外部编辑器/系统另存待人工验收 |
| 2.9 | 计划模型工具恢复、互斥、内部停止 | 原生 model-transition、tool partition、mode exit teardown | 模型恢复、计划角色实时更改、批准后实际 write 恢复通过；内部停止独立显示；goal/goal_paused/vibe 冷恢复后拒绝进入计划通过，真实原生压缩失败不执行通过 |
| 3.1 | 项目、worktree、保留既有改动 | 原生 createSessionWorktree 与 vcs，Alpha 注册自建工作树 | 原生与 Electron 创建通过；保留暂存/未暂存/新文件、拒绝脏清理通过 |
| 3.2 | 文件树、搜索、标签与行引用 | 现有安全文件 API + 原生 fuzzyFind/grep | Unicode 路径、字面内容搜索通过；Electron 双标签与真实行范围回填通过 |
| 3.3 | 修改审查和行级反馈 | projectReview + 原生 diff 行号，反馈回填输入框 | Electron 选择差异行、输入反馈、回填保留草稿通过 |
| 3.4 | 文件撤销重做与冲突阻止 | Alpha 数据目录独立 Git 快照 | 原生二进制/删除恢复、用户编辑/跨会话冲突、冷崩溃间隙、长路径通过；Electron 预览撤销/重做通过 |
| 3.5 | 独立项目 shell、多标签、编辑器 | 原生 PtySession；现有会话终端接管 | 两个真实 PowerShell 标签、输出与写文件、跨项目拒绝通过；Electron 标签开关通过；编辑器按钮已接，系统编辑器待人工验收 |
| 4.1 | 自定义服务商端点、Key/OAuth | 原生 ModelRegistry/AuthStorage/models.yml | 端点与模型校验、密钥遮罩保留、旧版本写入冲突、原生 OAuth 表单与退出已接；外部账号授权不计完成 |
| 4.2 | 模型与计划/执行思考设置 | 原生 getKnownRoleIds/getRoleInfo/roleCandidatePool / settings | 所有原生角色、计划角色、项目来源/删除覆盖/冷恢复专项通过；不自建模型元数据默认值 |
| 4.3 | 规则、自定义命令、原生任务配置 | 原生 capability / discoverAgents / parseAgent | 正文及来源/覆盖/复制编辑/内容冲突；新命令进入原生目录、规则实际加载、任务定义和无效输入拒绝通过；Electron 连续保存通过 |
| 4.4 | 项目权限规则，保留默认自主 | 原生 tools.approval / ClientBridge | allow/prompt/deny 原生规则；项目拒绝 write 实测通过，既有文件不动；审批请求沿用原生 UI，不另造权限执行器 |
| 4.5 | LSP、格式化管理状态 | 原生 getConfigDirPaths/loadConfig/configCache/warmupLspServers/shutdownAll | 配置编辑/来源只读/遮罩/版本冲突；stdio initialize→实际 write 格式化→stop→reconnect→冷恢复通过；真实第三方 LSP 服务待项目验收 |
| 4.6 | 快捷键、字体主题、通知声音、语言 | desktop/commands.json + 持久 Electron storage | 共用菜单/快捷键/斜杠目录，英文静态与插值文字、语言/字体跨窗口和重载通过；不翻译用户正文或工具 ID；通知/声音系统效果待人工验收 |
| 4.7 | 多窗口、日志 | BaseWindow/WebContentsView + getLogsDir/getLogPath | 两窗口共用单原生会话、关一窗保留另一窗；原生日志末尾 256 KiB、遮罩、越界拒绝实测；生产 Electron 日志入口通过 |
| 4.8 | 本地包与在线更新、校验备份恢复 | Alpha AppUpdates + 独立 Windows helper；原生 compareVersions | 源未配置如实显示；完整 payload/ZIP/下载 SHA256、取消、旧版本冲突、备份、启动握手/失败重启旧版、部分替换恢复专项通过；完整发行包专项另记 |
| 4.9 | 便携与安装包运行验收 | package-portable、portable/Office probe、installer | 已补全命令目录/更新助手/全包 SHA256；最终打包执行中 |

## 已执行证据

- 第一批接入回归：`bun run check`、`bun run test` 103 pass/0 fail（673 assertions，227.16 秒）、`bun run build:desktop-ui` 通过。之后增加 OAuth、工具刷新和编辑冲突专项：1 pass/0 fail，22 assertions；不将本机模拟服务等同于外部服务验收。
- `native-extensions.test.ts` 使用实际 OMP 会话和本机模型/MCP fixture，不调用外部模型，不用 fixture 结果冒充外部授权验收。三种传输连接、读取资源与重连，Skill 被载入请求，MCP 经原生 write→xd 路由调用。
- Electron 41.2.2 隔离渲染探针：44 个运行时 Skill、正文导航、MCP/插件入口，无水平溢出。截图在 `artifacts/parity-2026-10-01/`，结果 `extension-ui-result.json`。这是 Electron renderer 验证，尚不等同于发行包 / 原生文件对话框 / 用户授权验收。
- 内置浏览器对 loopback 返回 ERR_BLOCKED_BY_CLIENT；未替换线上服务。Electron 探针改用本机隔离渲染。
- Bun 1.3.14 的 `.rejects.toThrow` 与子进程 IPC 组合在本机会阻塞预期的拒绝事件；改为先 await 捕获错误再断言，确认越界读取真实被拒绝。
- 第二批回归：`bun run check`、`bun run test` 110 pass/0 fail（741 assertions，266.94 秒）、`bun run build:desktop-ui` 通过。随后增加原生计划模型角色变更与实际写入恢复专项：5 pass/0 fail、45 assertions；local:// 预览与遍历拒绝专项另记。
- `native-plan.test.ts` 使用真实 write/edit/xdev、原生会话日志、模型切换、压缩与取消，不用提示词模拟写入限制。原生模式退出 teardown 包围上下文与模型工具转换；避免压缩完成后排队输入在计划模型上提前运行。
- Electron 第二批结果 `session-ui-result.json`：真实生产 preload 与磁盘状态存储、窗口重建恢复图片/文字和选择、命令目录、历史/进度入口、计划正文编辑、关闭不批准、清空上下文后执行。截图 `plan-review-electron.png`、`session-electron.png`；本机模型固定输出只证明接口与渲染，不代替外部模型或系统文件对话框验收。
- 原生 RPC branch 的响应只返回 `text`，会丢弃 SDK 的 `selectedImages`。桌面通过同一 session 的 SDK branch 补充带图响应，未改动原生 RPC 协议；记录旧 ID 与新 ID，并保持两者原始会话文件。
- 第二批提交后的全套复核：110 pass/0 fail、747 assertions、261.59 秒。
- 第三批全套回归：118 pass/0 fail、793 assertions、283.38 秒；`bun run check`、`bun run build:desktop-ui` 通过。随后会话终端身份与快照收尾调整的专项：1 pass/0 fail、42 assertions、140.16 秒。未修改 Skill 正文。
- `native-project-workbench.test.ts`：调用实际 OMP worktree、native fuzzy/grep、PtySession，验证源项目既有暂存/未暂存/新文件保留，拒绝脏工作树清理；真实模型 fixture 的 write 后，只有原生 settled 才写结束快照，撤销恢复原始材料且暂存区不动。
- `native-project-snapshots.test.ts`：独立裸 Git 对象、原始二进制/CRLF、文件删除与新文件、撤销重做、预览后用户编辑、跨会话后续改动、崩溃间隙及 Windows 长路径均有专项。恢复前保存恢复记录与备份对象，恢复中遇到后续编辑会停止并回滚自身已经应用的内容。
- 快照排除 Alpha 数据目录、原生全局运行目录和当前 profile；Git 项目沿用 Git 的 tracked/untracked/ignore 边界，子模块目录不被替换或重置。单文件 50 MB、总计 512 MB 上限超出会如实阻止任务启动并报告，未把超限工作区算作验收完成。
- Windows Git 初始化与对象写入遇到 MAX_PATH：复用 `pi-natives/path.getWindowsShortPath`，同时启用该次命令的 core.longpaths；没有改动系统长路径开关，也没有把快照迁出 Alpha 数据目录。
- 当前原生 `worktreeRemove(path, false)` 在实测中能删除带复制改动的工作树，因此 Alpha 在调用前必须验证两次 Git 状态，并只接受自己登记的工作树；不调用原生 source clean、不重置源仓库、不删除分支。
- Electron 41.2.2 第三批 `ALPHA_PROJECT_UI_OK`：项目搜索、双文件标签、行范围回填、差异行反馈、两个独立终端标签、真实 native write 后的预览撤销/重做，以及从桌面创建真实工作树。证据 `artifacts/parity-2026-10-01-batch3-proof/project-ui-result.json`、`project-workbench-electron.png`；UI 冲突展示、系统编辑器/选择目录对话框仍单独待验收。
- 会话终端持续通过原生 session-loader 读取当前日志 ID/title；退出后完成身份和快照收尾再交回 RPC，避免 TUI `/new` 后误续旧会话。计划关闭审阅同时保存正文和分节反馈，不批准执行。
- 终端身份专项补充：native-project-workbench 共 3 pass/0 fail、24 assertions、19.11 秒；实际 TUI `/new`、发出任务、停止后 RPC 恢复到新 ID，原 ID 保留且终端结束快照已落盘。

# OMP 18.4.3 原生能力复用审查

2026-10-01：按用户提醒，先审查当前安装版本源码，再继续桌面实现。以下为源码核对结果，不等于运行验收。

| 能力 | 已有原生入口 | Alpha 必要适配 | 禁止重复实现 |
|---|---|---|---|
| 启动、身份、配置、恢复 | `runRootCommand` 注入 `createAgentSession`，随后原生 `runRpcMode` | 同一 SDK session 上绑定独立 IPC 管理通道 | 第二套启动器、模型执行循环、依赖源码修改 |
| Skill 发现和调用 | `loadSkills`、`session.skillsSettings`、`effectiveExtensionRoots`、`refreshSkillsAndCommands`、原生 `/skill:` | 目录与正文编辑界面；本地作者 Skill 复制导入 | 自建去重/禁用规则；将远程 registry 的 `skill import` 误当本地导入 |
| Skill 包安装 | `skillshare/installer` 的 install/update/uninstall/list | 如开放包入口，直接调用原生安装器 | 自建包缓存、完整性与版本算法 |
| MCP | `loadAllMCPConfigs`、config-writer、当前 `MCPManager`、`MCPOAuthFlow` | 表单、当前会话状态、授权 URL 与手动回调输入 | 第二个连接管理器、改写外部工具配置、另造 OAuth |
| 插件 | `PluginManager` install/link/uninstall/settings/features/doctor | 操作与诊断界面、敏感设置隐藏、加载结果 | 自建插件加载器；执行 OpenCode 插件 ABI |
| 会话、排队、压缩、子任务 | 原生 RPC、`sessionManager.getTree`、`navigateTree` | 命令目录、导航与状态界面 | 自建会话树或任务编排 |
| 计划 | 原生 `PlanModeState`、`preparePlanForReview`、`resolveApprovedPlan`、model-transition、plan-files/autosave、写入 guard | 原生 TUI 尚无独立公开的五选项审阅控制器；桌面需接入这些原语并验证 TUI 行为 | 将计划降为提示词开关；放宽原生 write/edit 限制；复用 ACP 无表单时自动批准的回退 |
| worktree | `createSessionWorktree`、原生 vcs worktree API、task/worktree isolation | 项目入口、列表、冲突与清理界面 | 自建 dirty baseline/任务 merge；调用 `cleanSourceCheckoutIfConfigured` 清空用户仓库 |
| 文件恢复 | 原生 checkpoint/rewind **仅改变上下文** | 独立 Alpha Git 快照、差异预览、后续修改冲突拒绝 | 把对话 rewind 伪称文件恢复；整体 hard reset 用户仓库 |
| 权限、LSP、格式化 | 扩展 tool_call、ClientBridge、原生配置及 LSP 生命周期 | 项目规则表单、请求显示、运行状态 | 恢复退役专家/计划图调度；重复语言服务进程 |
| 终端 | 已有 `PtySession`；会话终端接管机制 | 独立项目 shell 标签 | 用 RPC bash 假装交互 shell；让两个进程写一个会话 |

## 第四批运行记录

- 配置、权限、规则命令任务、LSP、语言、多窗口、原生日志、全包更新与恢复均已接入。原生角色、Skill/MCP/插件和子任务继续由当前 OMP 会话管理；队列撤回先保存原生恢复格式，再调用 `popLastQueuedMessage`，不重做队列执行器。
- 全套回归首次发现 native 源码导入到了 scripts 更新助手：把独立助手实现移到 `src/native/app-update-installer.ts`，scripts 仅作入口。修复后 136 pass/0 fail、958 assertions、331.89 秒。最终发行前复核另记。
- `native-runtime-features.test.ts` 验证真实图片队列取回及冷恢复、非空 Todo、两个原生并行子任务与完成后的日志冷恢复，以及真实 LSP initialize→write 格式化→stop→reconnect→冷恢复。模型和 LSP 为本机 fixture，不能算外部服务验收。
- Windows 更新助手曾出现 Bun detach 后子进程随助手退出的问题，现使用 Node `child_process.spawn({detached:true})` 并等待生产启动握手。专项验证正常升级后新进程存活、启动失败恢复旧版并再次运行、部分替换恢复、下载取消、恶意 ZIP 与完整 SHA256 校验。
- `scripts/probe-desktop-windows.cjs` 使用生产 main、preload、实际原生 server：双窗口共用会话、英文/字体同步与冷恢复、规则和 Skill 连续两次保存、LSP 配置及原生日志入口均通过。扩展重载以明确的 host_exit(restarting)→host_ready 告知两窗，旧请求不能覆盖新状态；截图已检查，无 Operation incomplete 或会话断开横幅。系统文件对话框、编辑器、通知声音仍待人工验收。
- `bun run check`、`bun run build:desktop-ui`、`bun run validate:skills` 通过，30 个 Skill、4833 description 字符；没有修改 Skill 正文。UI 构建的 bundle 大小提示保留，未把它当构建失败。
- 最终发行前全套复核：137 pass/0 fail、970 assertions、349.41 秒，包含新增 goal/goal_paused/vibe 的实际原生会话模式冷恢复互斥专项。安装包保留完整可校验 payload；安装入口启动随包 Electron，使浏览器宿主及后续升级使用随包运行时。

核对路径均为当前依赖 `node_modules/@oh-my-pi/pi-coding-agent/src/`；SDK 结果为权威运行状态，配置目录只表示已配置。忙碌时的配置修改必须显示待生效，真正刷新并确认后才标记已生效。
