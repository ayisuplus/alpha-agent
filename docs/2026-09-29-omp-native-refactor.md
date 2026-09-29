# Alpha 原生 OMP 重构（2026-09-29）

Alpha 的执行内核现为 `@oh-my-pi/*` 18.4.3。桌面程序启动本地 sidecar；每个新会话对应一个 OMP RPC 进程，模型选择、消息、工具、压缩、steer、abort 和会话文件均由 OMP 管理。工作台只传输原生协议和呈现事件，不再让 Alpha 的计划图、专家状态、任务调度器或自建工具循环决定执行顺序。需要完整键盘交互时，可在本轮完成后切换到同一会话的原生 TUI；TUI 退出后重新接入 RPC，同一时间只有一个写入者。

天枢 v3.27.0 的认知帧与控制面思路被改编为 OMP 扩展中的**证据建议**。扩展只观察已完成的工具结果、显式测试命令及 OMP 上下文用量，生成重复失败、验证债和上下文压力信号；不创建第二执行循环，不拦截工具，也不替 OMP 作准入判断。OMP 未提供的 EFE、Sensorium、PAL 保持 `missing`。来源为 [Tianshu-harness v3.27.0](https://github.com/huiliyi37/Tianshu-harness/releases/tag/v3.27.0) 的 `src/agent/cognitive-frame.ts`、`src/agent/control-plane.ts`，改编代码在 `src/native/tianshu-cognition.ts`，许可证在 `licenses/Tianshu-APACHE-2.0.txt`。

本机能力通过 OMP 扩展注册：可见浏览器、ComfyUI 图片/语音/视频、文档创建、Office/PDF 附件读改导出。浏览器只连桌面本机桥接；ComfyUI 未启动时上报缺口，不启动服务或替换工作流。Office 操作复制原件并产出单独版本与预览。旧 `.alpha/tasks` 只读列出；点击“用 OMP 继续”时，新建原生会话并填入可审阅的上下文草稿，旧记录不被修改。

`bun run check` 和 `bun run test` 只验收原生入口；旧架构的默认脚本入口已移除。`bun run package:portable` 只复制原生入口的可达源码、三个 ComfyUI 工作流、桌面界面和 Office 运行时，不携带旧计划器、调度器、沙箱包装器或旧专家包。`Alpha.cmd` 是发行包入口。打包探针检查 UI 哈希、OMP RPC 启动和 Office 读改。原仓库旧源码/测试保留为 Git 历史材料，但不在运行入口或发行包中。

Alpha 自身的更新监视器在桌面运行时启动，并每 15 分钟查询官方 npm registry 中四个 OMP 包的 `latest`。四包版本一致且高于当前锁定版本时，桌面显示持续可见的更新提示；窗口不在前台时发出一次系统通知。检测状态保存在 `.alpha/native/omp-update.json`，也可从界面重试失败检查。监视器只提醒，不下载、不升级、不唤醒 AI；用户看到后再要求 Codex 分析并更新。桌面关闭时监视器停止。

当前验收边界：已验证本机原生 RPC 会话、实际 MiMo 模型一轮对话、同会话 TUI 回退、Office 文档读改、前端构建、类型检查和可携带包探针。可见浏览器需要桌面 Electron 实例及其桥接，外部 ComfyUI 工作流需要用户已有服务；这些服务的端到端生成结果不由本次离线探针证明。
