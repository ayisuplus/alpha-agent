# Alpha

当前 Windows 安装入口：[Alpha-Setup-0.1.1-x64.exe](Alpha-Setup-0.1.1-x64.exe)。本次 OMP 发行归档与校验值见 [2026-09-29 发行归档](docs/2026-09-29-release-archive.md)。

当前版本以 OMP 18.4.3 为执行内核，Alpha 提供桌面工作台、天枢证据认知扩展和本机工具能力。每次启动检查一次 OMP 更新，只提醒，不自动升级。源码开发运行 `bun run desktop`；当前便携版位于 `release/alpha-portable-2026-09-29T14-14-35-861Z/`。实现与验收边界见 [原生 OMP 重构说明](docs/2026-09-29-omp-native-refactor.md)。

0.1.1 恢复原欢迎动画与开场布局，并提供可视化模型选择、API Key 管理和原生 OMP 配置。范围与验证见 [桌面界面恢复](docs/2026-09-29-desktop-ui-restoration.md)。

## 历史材料

旧架构（计划图、专家包、任务状态机、三栏工作台等）的说明与施工记录已归档到 [docs/archive/](docs/archive/README.md)，不代表当前版本。旧版 README 正文见 [README-legacy.md](docs/archive/README-legacy.md)。
