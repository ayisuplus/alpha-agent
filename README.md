# Alpha

Alpha = 原生 OMP 内核 + 天枢证据层 + Alpha 方法（Skill）+ 本机能力 + 桌面工作台。当前版本 0.2.1，执行内核为 OMP 18.4.3；界面上只有 Alpha 一个产品名，OMP 只在“关于”页与更新横幅出现。每次启动检查一次 OMP 更新，只提醒，不自动升级。

当前 Windows 安装入口：`Alpha-Setup-0.2.1-x64.exe`（本地构建交付；未随源码入库）。历史 0.2.0 归档见 [发行归档](docs/2026-09-29-release-archive.md)。

## 组成

- **执行内核**：原生 OMP 18.4.3。会话按 `--resume <会话 ID>` 显式恢复；RPC 与终端两种模式共用 `src/native/launch.ts` 的同一份启动构造。
- **天枢证据层**：`src/native/tianshu/` 扩展，读 OMP 原生事件、写 OMP 原生会话与面板；重复失败、改后未验证、宣称与证据不符等信号只作提醒，不拦截、不自行开启新一轮。`/tianshu` 展开当前证据帧。改编自 [Tianshu-harness v3.27.0](https://github.com/huiliyi37/Tianshu-harness/releases/tag/v3.27.0)（Apache-2.0，见 `licenses/`）。
- **Alpha 方法**：30 个行业 Skill 随包发行（`presets/alpha-plugin/`），`--plugin-dir` 挂载；`bun run validate:skills` 校验。
- **本机能力**：`alpha_office`（inspect/edit/create/convert/pdf/preview，读取用 OMP 原生 `read`）、`alpha_generate_image/voice/video`（ComfyUI，产出在 `outputs/media/`）、可见浏览器（OMP 原生 `browser` 连 Alpha 浏览器宿主，会话级授权）。
- **桌面工作台**：Electron + React，纸墨风格；浏览器面板可实时查看、接管与交还；设置直连 OMP 原生配置（含结构化设置的 JSON 编辑）。
- **定时任务**：sidecar 调度器（间隔或 cron），仅在 Alpha 运行时执行。按本机时区计算，支持 0/7 周日和日/星期 OR 规则；重启后错过的触发只补一次。目标会话忙碌时跳过本次，同一任务未完成时不叠加；回执等待原生任务完成，支持查看执行会话。侧栏可直接管理。
- **会话管理**：侧栏搜索标题/目录并查看工作状态；会话顶部可改名、归档/恢复和导出 Markdown。原生命令入口列出当前 RPC 会话提供的命令和用户 Skill；MCP、OAuth 与完整交互管理使用 Alpha 终端。
- **浏览器边界**：所有会话共享宿主标签页与登录态。接管需先等待或停止工作中的会话，接管期间拦截新的浏览器/代码求值。原生 eval 可保留浏览器别名，因此全部 eval 统一询问授权；选择“本会话”后不重复询问。这不是系统沙箱。

## 开发与验证

支持 Windows x64。源码运行需要 Bun 1.3.14 和 Node/npm（建议 Node 22），先在干净检出中执行：

```powershell
npm ci --no-audit --no-fund
bun run build:desktop-ui
bun run desktop
```

首次在“模型与账号”保存 API Key 并选择默认模型。模型凭据与原生 CLI 共用；环境变量 Key 不传入工具进程，单独检测到它时页面会提示保存。OAuth 可在 Alpha 终端使用 `/login` 操作。

Office：源码运行可使用系统 LibreOffice；缺少时 UNO 动作会报告缺口，纯 JS 的 XLSX 创建与 PDF 操作仍可用。便携/安装包包含经探针验证的 LibreOffice 26.2.5.2。ComfyUI 由用户自行提供，默认 `http://127.0.0.1:8188`，可用 `ALPHA_COMFY_URL` 指向其他本机 HTTP 端口；“服务可连接”不代表工作流节点/模型已准备好。Alpha 不自动启动服务或替换工作流。

```bash
bun run desktop        # 源码运行桌面
bun run check          # 类型检查
bun run test           # 原生测试套件
bun run validate:skills
bun run package:portable   # 便携发行包（含打包探针）
bun run package:exe -- <便携包完整目录>  # Windows 安装包
```

模型、API Key 与设置直接使用 OMP 原生配置存储；本地接口只在 127.0.0.1 上服务，需要随机会话令牌。实现与验收边界见 [原生 OMP 重构说明](docs/2026-09-29-omp-native-refactor.md)，本次重构的施工依据见 [最终重构方案](docs/2026-09-30-final-refactor-plan.md)。

打包需已提交的源码、系统 LibreOffice 26.2.5.2，以及 `npm ci --prefix installer`。发行清单记录 Git SHA、原生源码/配置与 UI 文件哈希，便携包和安装器均检查这些哈希并使用独立 OMP 目录、测试假 Key 进行启动探针，不使用维护者账号。安装器目前未签名。

## 开源许可与参与

Alpha 自有代码使用 [Apache-2.0](LICENSE)，第三方归属见 [NOTICE](NOTICE)、`licenses/` 与 `presets/alpha-plugin/SOURCES.md`。第三方组件、用户内容、模型权重和外部服务保留各自的许可/条款。参与说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。Git 历史和 `docs/archive/` 含历史设计；当前验收仅以以上原生套件为准。

## 历史材料

旧架构（计划图、专家包、任务状态机、三栏工作台等）的说明与施工记录已归档到 [docs/archive/](docs/archive/README.md)，不代表当前版本。旧版 README 正文见 [README-legacy.md](docs/archive/README-legacy.md)。
