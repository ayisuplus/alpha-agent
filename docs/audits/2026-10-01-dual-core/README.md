# 双内核审查与界面实施证据

本目录随本轮提交保留审查探针、真实隔离界面截图和版本绑定记录。结论与优化顺序见 [审查报告](../../2026-10-01-dual-core-and-ux-audit.md)。

## 内核复现

在仓库根运行：

```powershell
bun run docs/audits/2026-10-01-dual-core/reproduce.ts
```

探针调用当前天枢纯归约函数、启动环境构建与 RPC 桥；本地命令部分使用实际 OMP 18.4.3 的 `agentInvoked:false` 协议响应，不调用模型或用户配置，不执行输出中展示的 Git 命令。实际 OMP `/tools` 的界面故障另保留在 `local-command-terminal-block.png`。

`observations.txt` 是本轮最后一次执行的输出。退出 0 仅表示探针完成，打印的缺陷仍然存在；没有把这些观测作为通过验收。

## 界面复验

```powershell
bun run build:desktop-ui
bun run scripts/probe-workbench-ui.ts artifacts/dual-core-ux-audit-2026-10-01
```

脚本提供真实 Alpha 服务、真实 OMP、独立配置和本机固定模型，在输出目录生成 `startup.json`。使用其本机 URL 在内置浏览器打开；不要把其中的临时访问令牌提交到 Git。结束预览可在该脚本所在终端按 Ctrl+C。

- 选择隔离的“示例项目”，发送“验证工具”：真实读取材料并用 `alpha_office` 创建 Word，验证产物卡片及页面预览。
- 再发送“验证错误”：固定模型返回预设 401，验证失败可见且有设置/刷新恢复入口。截图里该会话的失败状态是主动测试数据。
- 检查首页草稿、模型菜单、搜索、归档、侧栏收起/展开、浅深主题、中英语言、15/16px 字号、键盘焦点和工作区。
- 尺寸与动态设置的复验结果记录在报告及 `evidence.json`。所有临时视口和减少动态效果的模拟在结束前恢复。

`baseline-home.png` 是改动前的真实首页；两个 `implemented-*-home.png` 是最终前端资源的实际首页，输入文字是未发送草稿。`implemented-tool-thread.png` 保留真实工具成功与文件产物。截图未包含用户凭据。

这组证据验证源码、前端构建与本机界面/协议链，不证明云模型质量、Goal/Vibe 跨模式运行、Electron 桌面桥或安装包验收。本轮没有修改内核问题，也没有重新打包安装。
