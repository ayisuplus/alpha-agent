# Alpha

Alpha = 原生 OMP 内核 + 天枢证据层 + Alpha 方法（Skill）+ 本机能力 + 桌面工作台。当前版本 0.2.0，执行内核为 OMP 18.4.3；界面上只有 Alpha 一个产品名，OMP 只在“关于”页与更新横幅出现。每次启动检查一次 OMP 更新，只提醒，不自动升级。

## 组成

- **执行内核**：原生 OMP 18.4.3。会话按 `--resume <会话 ID>` 显式恢复；RPC 与终端两种模式共用 `src/native/launch.ts` 的同一份启动构造。
- **天枢证据层**：`src/native/tianshu/` 扩展，读 OMP 原生事件、写 OMP 原生会话与面板；重复失败、改后未验证、宣称与证据不符等信号只作提醒，不拦截、不自行开启新一轮。`/tianshu` 展开当前证据帧。改编自 [Tianshu-harness v3.27.0](https://github.com/huiliyi37/Tianshu-harness/releases/tag/v3.27.0)（Apache-2.0，见 `licenses/`）。
- **Alpha 方法**：30 个行业 Skill 随包发行（`presets/alpha-plugin/`），`--plugin-dir` 挂载；`bun run validate:skills` 校验。
- **本机能力**：`alpha_office`（inspect/edit/create/convert/pdf/preview，读取用 OMP 原生 `read`）、`alpha_generate_image/voice/video`（ComfyUI，产出在 `outputs/media/`）、可见浏览器（OMP 原生 `browser` 连 Alpha 浏览器宿主，会话级授权）。
- **桌面工作台**：Electron + React，纸墨风格；浏览器面板可实时查看、接管与交还。

## 开发与验证

```bash
bun run desktop        # 源码运行桌面
bun run check          # 类型检查
bun run test           # 原生测试套件
bun run validate:skills
bun run package:portable   # 便携发行包（含打包探针）
bun run package:exe        # Windows 安装包
```

模型、API Key 与设置直接使用 OMP 原生配置存储；本地接口只在 127.0.0.1 上服务，需要随机会话令牌。实现与验收边界见 [原生 OMP 重构说明](docs/2026-09-29-omp-native-refactor.md)，本次重构的施工依据见 [最终重构方案](docs/2026-09-30-final-refactor-plan.md)。

## 历史材料

旧架构（计划图、专家包、任务状态机、三栏工作台等）的说明与施工记录已归档到 [docs/archive/](docs/archive/README.md)，不代表当前版本。旧版 README 正文见 [README-legacy.md](docs/archive/README-legacy.md)。
