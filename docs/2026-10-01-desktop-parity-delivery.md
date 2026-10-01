# Alpha 0.3.0 Windows 桌面对标交付

四批桌面功能已接入，执行继续使用 OMP 18.4.3。功能参考固定 OpenCode v1.18.33；逐项行为、原生入口、来源及验收边界见 [对标台账](2026-10-01-opencode-parity.md)。日常界面保留 Alpha 的中性表面和克制天蓝强调，依赖与许可集中在“关于”和原始来源记录。

## 打开方式

- 开发工作区：在 `E:\projects\alpha-agent` 运行 `bun run desktop`。
- 便携包：双击 `C:\Users\36322\.codex\worktrees\opencode-parity\alpha-agent\release\alpha-portable-2026-10-01T03-11-37-097Z\Alpha.cmd`；保留完整目录，不能只复制启动文件。
- 安装包：`C:\Users\36322\.codex\worktrees\opencode-parity\alpha-agent\release\alpha-installer-2026-10-01T03-15-49-015Z\Alpha-Setup-0.3.0-x64.exe`。安装包未签名，本轮未在用户系统执行安装。

便携包自带 Bun、Electron、OMP、办公运行时和原生 Skill；不需要用户另装 Bun 或 Office。首次在“设置 → 模型与账号”配置自己的服务商，选择模型与思考设置。测试用的本机模型和测试账号不随包发行。

## 从桌面进入

| 入口 | 实际能力 |
|---|---|
| 设置 → 技能 / MCP / 插件 | 查看当前会话真实目录；Skill 正文、材料、导入、复制编辑、启停与调用；三种 MCP 传输、连接和 OAuth；原生插件安装、来源、版本、许可、配置、功能和诊断 |
| Ctrl+K / 输入框 / 会话入口 | 共享命令目录、原生命令、文件补全与行引用、图片附件、草稿、实时补充和排队；搜索、标签、原生会话树、历史导航、分支、压缩和本地导出 |
| 进入计划 / 审阅计划 | 原生 local:// 计划文件和 xd://propose；五种审阅选择、修订、反馈、暂停重进、模型/工具恢复及 goal/vibe 互斥 |
| 项目 / 文件 / 审查 / 终端 | 项目和 worktree、搜索与多标签、差异行反馈、独立 shell、多终端标签、编辑器入口、安全快照与撤销重做 |
| 设置 / 关于 | 原生服务商、模型角色、权限、规则、命令、任务与 LSP；字体主题、中英文、快捷键、通知声音、多窗口、遮罩日志、本地/在线更新 |

更改扩展时，忙碌的原生会话继续运行；界面提示待生效，结束后点击“重新加载”并确认加载状态。内置 Skill 的编辑复制到用户或项目目录。文件恢复遇到任务后的编辑会停止，保留后续内容及原有 Git 暂存区。

## 已验证的边界

- 原生全套、类型检查、UI 构建与 30 个 Skill 校验通过；冻结后的最终测试数字写入下方。
- 真正生产 Electron main/preload/server：双窗口共用一个原生会话，语言字体同步和重载恢复；Skill 连续保存、内置复制、插件配置/功能/生命周期、忙碌重载提示、文件补全、组合输入防误发、模态焦点及关一窗后另一窗保留均通过。
- 真正原生计划专项：五种审阅、write/edit 工作区限制、持续修订、上下文切换后产物、暂停与冷恢复、模型工具恢复、取消/失败压缩及互斥通过。
- 真正原生工作区与桌面专项：保留暂存/未暂存/新文件、二进制/删除恢复、跨会话和崩溃间隙；预览后再编辑文件，桌面确认撤销会被拒绝且保留用户内容。
- Microsoft Learn 公开 HTTP MCP 已经原生 manager 实际连接、调用工具、重连和刷新；stdio/SSE、OAuth PKCE、LSP 格式化以及断线取消使用本机模拟服务，分别记录，不能算外部账号或第三方语言服务验收。
- 完整发行包更新在隔离目录经过生产桌面 → 独立助手 → 新进程启动握手，验证原生会话、草稿、偏好和用户文件保留。旧版本标识为同一代码的人工 0.2.99，不能算历史 0.2.0/0.2.1 升级验收。

## 尚未计入完成的验收

外部服务商/MCP 的实际账号 OAuth、公共插件 registry、第三方 LSP 项目、原生系统另存/目录对话框与外部编辑器、真实 Windows 输入法、系统通知声音、干净机器 NSIS 安装以及历史版本迁移仍待实测。异步子任务期间的扩展重载专项也待补验；当前原生异步任务、收尾与冷恢复专项已通过，但不替代这项组合验收。

公开分享、远程服务、WSL、其他系统和 IDE/CI 按本轮范围保留为后续项。因此本次交付是已实现并具有上述证据的可运行版本，不能标记为用户方案的全量真实验收已完成。

## 复核入口

```powershell
bun run check
bun run test
bun run build:desktop-ui
bun run validate:skills
bun run package:portable
bun run package:exe <verified-portable-directory>
```

生产桌面、更新和项目恢复探针：`scripts/probe-desktop-windows.cjs`、`scripts/probe-app-update.ts`、`scripts/probe-project-ui.cjs`。使用 `scripts/probe-workbench-ui.ts` 生成隔离的 startup.json，再按脚本参数运行；不要指向用户账号配置。Electron 在 PowerShell 中用 `Start-Process -Wait -PassThru -WindowStyle Hidden` 取得真实退出码。探针失败写入当前失败结果，不能把旧的 JSON 成功记录当作本次通过。

## 发行记录

产品源码 `ce66ee7edfbb16eb7478a3da3a4f1f15b84a356d`。验收脚本和文档的后续提交不改变发行文件；以 release.json 的源码、UI 和完整 payload SHA256 为身份。

最终原生回归：137 pass / 0 fail / 973 assertions / 372.96 秒，日志 `artifacts/parity-2026-10-01-batch4-proof/native-tests-delivery-final.log`。类型检查、UI 构建通过，Skill 校验为 30 个 / 4833 description 字符。

生产桌面结果 `artifacts/parity-2026-10-01-delivery-ui/desktop-windows-result.json` 全部通过；项目恢复结果 `artifacts/parity-2026-10-01-delivery-project/project-ui-result.json` 包含 conflict=true。最终便携包的更新结果 `artifacts/parity-2026-10-01-delivery-update-final/app-update-result.json` 也全部通过。

最终安装器：658318391 字节，SHA256 `185ba900049f1ca28e3593ce9a697106cb00b41f916e224212023ff960fff680`；独立重算一致。build.json 的 payloadSmoke 和 productionDesktopSmoke 均为 passed，包含完整文件哈希、随包原生服务、实际 Alpha.exe 入口、独立随包 Electron 工作台及健康检查。其源码身份与最终便携包一致，均为上述 ce66ee7。

四批功能分别提交为 `b47a90a`、`5f8cff3`、`7ba470a`、`d727ddd`，随后修复与验收分别追加提交。主工作区合并采用 fast-forward，不改动原有 `.tmp-host-window.png` 和 `reference/oh-my-pi` 子模块内容；子模块 HEAD 保持 `73a11421fe34fbab8ad058ab9c1a2e4f447852ea`。

失败的临时 staging 目录不作为交付。自动审批拒绝清理其中两份，返回 blocked by policy；保留它们并在最终交付中单独说明。安装器探针的临时 Electron profile 若被 Windows 暂时占用，会记录保留路径，启动探针本身失败仍会阻止发行。

最后一次安装器探针通过，临时 profile `C:\Users\36322\AppData\Local\Temp\alpha-installer-desktop-uNq4U5` 因 EBUSY 保留；日志 `package-installer-delivery-final.log` 明确记录，不把临时目录清理结果混同启动验收。
