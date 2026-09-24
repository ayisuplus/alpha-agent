# Alpha 本机首版

在 Windows 上运行 [Alpha.cmd](release/alpha-portable-2026-09-24T02-47-03-212Z/Alpha.cmd)。工作台左侧可搜索和切换历史任务，中间显示目标版本、验收进度、失败原因和继续入口，右侧显示实际运行的产品预览。提交软件产品需求后，Alpha 会在本项目的 `release/products/` 中构建产品，并在 `release/.alpha/` 中保存任务、构建、预览和浏览器证据。预览只监听本机 `127.0.0.1`；关闭 Alpha 后预览服务停止，再次启动可从工作台重新发布并复验。

首版的执行引擎使用 OMP 和 Hashline；完成状态由构建、当前预览和浏览器验收共同决定。需要原创图片、配音或视频时，Alpha 可主动调用本机已有的 ComfyUI；该服务须由用户自行保持运行在 `127.0.0.1:8188`，Alpha 不会替换成其他生成服务。模型仍使用本机已有的 OMP 认证配置，便携包并不包含凭据或模型。

当前首版面向静态 Web 软件产品和本机预览。动态后端、任意桌面软件自动操作、外部平台部署不在这一版范围内。生成媒体的技术解码与页面检查不等于主观审美或音色验收。

详细施工与失败记录见 [验收记录](docs/implementation-status.md)；本轮任务工作台对照见 [Codex 工作台对照记录](docs/codex-workbench-benchmark-2026-09-24.md)；参考框架分析和原施工计划见 [设计基线](docs/alpha-analysis-and-build-plan.md)。
