# Alpha 原生 OMP 重构（2026-09-29，2026-09-30 更新至 0.2.0）

Alpha 的执行内核是 `@oh-my-pi/*` 18.4.3。桌面程序启动本地 sidecar（`src/native/server.ts`）；每个会话对应一个 OMP 进程（RPC 或终端，同一时间只有一个写入者），模型选择、消息、工具、压缩、steer、abort 和会话文件均由 OMP 管理。启动参数、环境和生成的配置统一由 `src/native/launch.ts` 构造：`--plugin-dir presets/alpha-plugin`（30 个 Alpha Skill）、`--append-system-prompt presets/alpha-identity.md`（固定身份与能力说明）、`--config .alpha/native/alpha-settings.yml`（每次启动生成，含 `browser.cdpUrl`）、两个扩展（天枢、本机能力）、`--resume <OMP 会话 ID>`。环境变量按白名单传入，令牌与调试端口不进入模型进程。

天枢 v3.27.0 的“宣称必须有证据”与机械变更分类被改编为 OMP 扩展中的**证据层**（`src/native/tianshu/`）。扩展读 OMP 原生事件（消息、工具、目标/待办、压缩、降级、会话树），把状态快照写入 OMP 原生会话（`appendEntry("alpha-tianshu")`），在状态栏、提醒和 `/tianshu` 里以“天枢”之名出现：重复失败、改后未验证、宣称与证据不符、待办与验证脱节、压缩后重锚等信号只作提醒，不拦截工具、不自行开启新一轮。宣称分类型对账（测试宣称需测试证据、类型宣称需类型检查证据，互不代替）。来源为 [Tianshu-harness v3.27.0](https://github.com/huiliyi37/Tianshu-harness/releases/tag/v3.27.0) 的 `src/agent/claim-audit.ts` 与 `src/agent/change-classification.ts`，许可证与 NOTICE 在 `licenses/`。

本机能力只补 OMP 没有的部分：读文档用 OMP 原生 `read`（docx/xlsx/pptx/pdf/epub）；办公生产/编辑/转换/PDF/预览合并为单一 `alpha_office`（inspect/edit/create/convert/pdf/preview，按路径进出、永不覆盖原件、产出写项目内并带预览卡片）；媒体生成 `alpha_generate_image/voice/video` 写 `outputs/media/`，ComfyUI 不可用时上报缺口；浏览器用 OMP 原生 `browser` 连接 Alpha 浏览器宿主（独立 Electron 进程，127.0.0.1 随机端口 CDP，`.alpha/browser-profile` 独立配置），会话级授权“仅这次 / 本会话 / 拒绝”，面板可实时查看、接管与交还。旧 `.alpha/tasks` 只读列出；点击“继续这个任务”时，新建原生会话并填入可审阅的上下文草稿，旧记录不被修改。

边界：本地接口只服务 127.0.0.1 且校验 Host 与每次启动生成的令牌；模型进程读不到桥接令牌或调试端口，桌面界面不出现在任何 CDP 目标中；默认工作目录是 `<工作区>/workspace`，`.alpha/` 不在任何默认工作目录之下；OMP 进程上限 4 个、空闲 10 分钟自动回收，GET 不拉起进程（显式 `POST /open`）；更新检查在启动后后台进行，只提醒不自动升级。

`bun run check` 与 `bun run test` 验收原生入口；`bun run validate:skills` 验收 Skill 包；`bun run package:portable` 只复制原生入口的可达源码、Alpha 插件、三个 ComfyUI 工作流、桌面界面、浏览器宿主和 Office 运行时。`Alpha.cmd` 是发行包入口，打包探针检查 UI 哈希、OMP RPC 启动与 Office 链路。旧任务系统（计划图、专家、调度器、旧服务与旧测试）已从工作树删除，历史保留在 Git（标签 `legacy-final`）。

## 同日桌面体验纠偏

用户指出迁移中错误地移除了设置入口与原开场界面。0.2.0 保留原开场 UI 与纸墨视觉样式，设置直接接入 OMP 原生配置（模型、凭据、运行参数），并新增“本机能力”“技能”“关于”页。完整范围和验证见 [桌面界面恢复](2026-09-29-desktop-ui-restoration.md)。
