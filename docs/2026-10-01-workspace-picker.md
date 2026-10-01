# 工作区下拉选择修复

原新会话输入框仅提供路径输入和文件夹图标，缺少明确的项目选择及退出项目入口。现在输入框底部的工作区下拉菜单提供：已有项目、添加文件夹、不在项目中工作。

- 已有项目直接读取 `/api/native/projects`；菜单获得焦点或被点击时刷新目录。添加文件夹复用 Electron `choosePaths("directory")` 和现有 Projects 管理接口，服务端确认并返回规范路径后才选中。
- 浏览器预览没有 Electron 文件夹选择器时，提供完整本机路径输入弹窗；无效路径保持弹窗与原选择，并显示实际失败原因。桌面选择取消或添加失败也保留原选择与草稿。
- 不在项目中工作将首页草稿 cwd 设为空，由既有 `createSession` 使用 `defaultWorkspaceRoot`，即 Alpha 数据根下的 `workspace`。OMP 仍有真实工作目录；未重写内核或项目发现机制。
- 选择复用已有首页草稿保存；刷新后恢复。使用原生 select 的键盘交互和现有 Alpha 表面、字体及焦点样式，补齐中英文标签。

## 验证

在既有隔离工作树 `C:\Users\36322\.codex\worktrees\opencode-parity\alpha-agent` 实施。证据根为该目录下的 `artifacts/workspace-picker-2026-10-01/`，不写入 Git 或用户运行配置。

- `bun run check`：通过。
- `bun run test`：137 通过、0 失败、973 断言、30 文件；373.79 秒。记录：`native-tests.log`。
- `bun run build:desktop-ui`：通过，保留既有大文件块提示。
- `scripts/probe-workspace-picker.cjs`：生产 Electron main/preload、真实本机服务和 OMP 会话，模型使用隔离的确定性本机服务。`workspace-picker-result.json` 全部功能断言通过：添加、取消、失败保留、项目列表刷新、目录选择与草稿刷新恢复、两种目录实际执行、键盘选择、浏览器路径输入和焦点恢复、中英文。
- 项目选择和无项目选择均从首页发送任务，并通过原生 `read`/`write` 改写各自目录中的 `app.ts`；同时核对原生会话记录 cwd。未仅以菜单文本作为执行证据。
- 键盘通过 Chromium Input 自动化与焦点模拟验证。系统文件夹对话框返回值由探针模拟，实际调用生产 IPC 并核对 openDirectory 参数；真人系统对话框操作仍待验收。
- 最后一次可选截图捕获报 Electron `UnknownVizError`，单独记录，不计为视觉验收。此前成功截取的英文首页已检查，但该截图不作为最后一次探针截图证据。

本次更新源码和当前桌面 UI 构建；此前 0.3.0 便携包和安装包仍对应其原交付版本，没有重新打包。

## 当前预览页

更新界面构建后，原预览后端仍运行较早源码，项目目录接口返回 404。确认四个会话均未打开后，更新该预览后端，保留原预览数据根和模型服务。新服务仍有四个会话和两个项目；监听端口按既有原生规则重新分配。新的本机运行信息保存在主工作区 `artifacts/ui-redesign-2026-10-01/review/workspace-picker-startup.json`，旧记录保留。

通过 Codex 内置浏览器在当前用户预览页检查了已有项目、不在项目中工作及添加文件夹路径弹窗；无项目选择显示正确，取消弹窗正常。当前截图位于主工作区 `artifacts/workspace-picker-2026-10-01/add-folder-preview.png` 与 `no-project-preview.png`。这份当前预览截图与上面的隔离 Electron 截图捕获失败分开记录。

## 复现

先运行 `bun run scripts/probe-workbench-ui.ts artifacts/workspace-picker-2026-10-01` 保持隔离模型服务可用。另一个 PowerShell 中设置 `ALPHA_EVIDENCE_DIR` 为上述证据绝对目录、`ALPHA_FIXTURE_STARTUP` 为其中的 `startup.json`，通过 `Start-Process -WindowStyle Hidden -Wait` 启动 `node_modules/electron/dist/electron.exe scripts/probe-workspace-picker.cjs`。不使用用户凭据。
