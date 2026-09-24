# Alpha 本机首版

在 Windows 上运行 [Alpha.cmd](release/alpha-portable-2026-09-24T03-33-26-979Z/Alpha.cmd)（该便携包早于三栏工作台；源码版用 `bun run desktop` 启动，新便携包用 `bun run package:portable` 生成）。工作台为三栏：左侧搜索和切换任务；中间是任务对话——头部显示目标版本、验收项与最近问题，时间线按轮展示 Alpha 的说明、工具调用、构建与浏览器验收结果，可下钻到逐步验收证据和源码 diff，底部唯一的输入框随任务状态切换为开始构建、运行中补充要求、继续修复或修订目标；右侧是实际运行的产品预览，可拖动分隔条调整宽度、接管或交回 Alpha。提交软件产品需求后，Alpha 会在本项目的 `release/products/` 中构建产品，并在 `release/.alpha/` 中保存任务、构建、预览和浏览器证据。预览只监听本机 `127.0.0.1`；关闭 Alpha 后预览服务停止，再次启动可从工作台重新发布并复验。

首版的执行引擎使用 OMP 和 Hashline；完成状态由构建、当前预览和浏览器验收共同决定。需要原创图片、配音或视频时，Alpha 可主动调用本机已有的 ComfyUI；该服务须由用户自行保持运行在 `127.0.0.1:8188`，Alpha 不会替换成其他生成服务。模型仍使用本机已有的 OMP 认证配置，便携包并不包含凭据或模型。

当前首版面向静态 Web 软件产品和本机预览。动态后端、任意桌面软件自动操作、外部平台部署不在这一版范围内。生成媒体的技术解码与页面检查不等于主观审美或音色验收。

详细施工与失败记录见 [验收记录](docs/implementation-status.md)；工作台重构见 [三栏工作台](docs/workbench-redesign-2026-09-24.md)，上一轮见 [任务审阅迭代](docs/workbench-iteration-2026-09-24.md)，此前对照见 [Codex 工作台对照记录](docs/codex-workbench-benchmark-2026-09-24.md)；参考框架分析和原施工计划见 [设计基线](docs/alpha-analysis-and-build-plan.md)。
