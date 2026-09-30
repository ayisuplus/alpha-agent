# Alpha 工作台体验修复 · 2026-09-30

按 `2026-09-30-zcode-product-gap-review.md` 的 A、B、C 三组实施。保留原生 OMP 18.4.3、天枢建议、暖白/墨色/植物绿品牌、Greeting 与 Halftone 开场，以及可视化模型、账号和运行配置。

参考为 ZCode 官方工作台展示及固定源码快照 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。本轮自行实现交互与样式，没有复制其代码、品牌资产或引入新依赖。

## 已完成

| 原问题 | 当前行为 |
| --- | --- |
| 草稿随页面卸载丢失 | 首页与每个会话独立保存文字、附件路径、工作目录及选择；图片仅在当前窗口保存，明确提示刷新后重新添加。保存失败时提示复制内容。 |
| 发送期间新草稿被清空 | 按会话检查草稿版本；旧请求成功不会清空后来编辑的内容。设置往返后的新输入组件也能同步已发送草稿的清理。 |
| 上翻被新输出拉回底部 | 向上阅读暂停跟随；“回到最新”及主动滚到尾部恢复。阅读位置按会话保存。最终回答保持到历史同步完成，避免落库间隙造成内容收缩。 |
| 仅图片无法发送 | 生成非空图片分析提示并传递原生 images。目录标有“支持图片”；已声明仅支持文字的模型会在创建任务前提示更换，保留材料。 |
| 首页与会话发送规则不同 | 共用 NativeComposer、模型选择与附件处理。Ctrl/⌘+Enter 发送，普通 Enter 与 Shift+Enter 换行；组合输入期间不发送。同步请求锁防止重复提交。 |
| 弹窗只有 ARIA 属性 | 共用 NativeModal：进入时聚焦、Tab 循环、Escape 取消、关闭后返回触发位置；后端已取消的请求不能继续提交。 |
| 工具输出难扫读 | 显示实际动作、目标、运行/完成/失败与实际耗时；完整参数和输出在详情中。工具结果与 live 消息按原顺序组合，避免重复工具行。 |
| 结果缺少连贯入口 | 产物卡片和回答中的相对文件链接打开右栏预览；路径与哈希可展开，系统打开入口保留。消息可复制。预览意图绑定所属会话，避免切项目串页。 |
| 审查只有整块 diff | 按文件展开，显示实际增删行数和颜色，保留原始差异。Git 使用 cwd-relative diff，子目录会话不会重复拼接路径。未跟踪文件仍只列路径。 |
| 控件与信息层级不统一 | 字体角色、常用控件尺寸、边框、圆角、焦点与颜色使用统一规则。重命名、归档、导出及低频输入操作进入更多菜单；原始错误可展开。 |
| 错误不说明下一步 | 图片、授权、网络、本机能力分别给出实际处理提示；可打开相关设置或刷新状态，不自动重复发送任务。 |
| 持续使用不便 | cwd 分组、项目折叠、会话置顶与终态未读提示；右栏可拖动/键盘调整并保存宽度；Skill 可加入当前草稿，命令列表来自原生目录并限制展开高度。 |
| 界面偏好缺少闭环 | 浅色、深色、跟随系统与文字大小设置。Ctrl+N 新会话、Ctrl+, 设置、Ctrl+Shift+F 文件；模型菜单支持方向键与 Enter。 |

没有新增执行编排、专家状态或另一套进度来源。工具摘要取自真实消息和事件，天枢百分比只做显示舍入；无阶段数据时不补造阶段。

## 验证记录

- `bun run check` 通过；新增 UI 文件由 NativeApp 的导入链纳入原生类型检查。
- `bun run build:desktop-ui` 通过。Vite 仍提示主 chunk 超过 500 kB；本轮没有以无关拆包重构扩展范围。
- 完整 `bun run test`：**93 pass、0 fail、617 assertions、17 个文件，218.02 秒**。包含原生配置、API 边界、工具、Office、媒体缺口、文件预览、Git 审查、天枢及 UI 契约。
- 完整套件之后补充了 live/历史原索引合并回归；最终 UI、草稿与子目录 Git 定向测试合计 **18 pass、0 fail、69 assertions**。子目录路径先复现重复拼接，再修复通过。
- PDF 测试有既有字体加载及字体函数警告，未导致测试失败。Skill 内容、打包脚本与依赖没有变更，因此没有重跑 Skill 内容验证或重打安装包。

浏览器验证使用隔离工作区、真实 Alpha 服务/OMP/原生工具及确定性的本机 OpenAI 接口测试响应。没有使用付费模型或写入真实用户的模型配置；这些结果验证交互与请求链路，不证明模型任务质量。

实际操作覆盖：

- 首页、会话、设置往返及重载的草稿和工作目录；图片在设置往返后保留。
- 仅图任务、仅文字模型的图片拒绝提示、双击仅创建一个会话；请求中实际含图片。
- 持续输出时主动上翻、回答结束、回到最新，以及保存的阅读位置恢复。
- 项目弹窗和原生 ask：初始焦点、Tab/Shift+Tab 循环、Escape 取消与焦点返回。
- 真实 read/write 修改样例 `app.ts`，右栏显示 `+1/-1`，预览内容为 `export const greeting = "你好，Alpha";`。
- 真实 read + alpha_office 生成 Word；产物卡片及回答文件链接打开右栏，实际文档页面渲染成功。
- 切到另一项目后显示该项目文件列表，没有带入旧文件预览。
- 模型菜单的键盘选择；Skill 页加入 `/skill:craft-documents`，原生 `get_available_commands` 也确实公开该名称。
- 授权 401 提示相关设置，关闭提示后下一轮可以成功；不自动重发。
- 消息复制、Ctrl+N、Ctrl+Shift+F、右栏键盘调整与指针拖动，主题、宽度和会话置顶重载后保留。设置开关保持 22px 胶囊轨道。
- 1366×768、1920×1080、780×720 无页面横向溢出；窄窗口右栏为覆盖面板，收起后输入/选择模型/发送操作可达。

## 产物与复现

- 实现：`desktop/ui/src/app/NativeComposer.tsx`、`NativeModal.tsx`、`workbench-state.ts` 及既有工作台组件；模型输入类型在 `src/native/configuration.ts`，差异路径在 `src/native/project-review.ts`。
- 回归：`test/native-workbench.test.ts`、`native-ui-contract.test.ts`、`native-project-review.test.ts`、`native-configuration.test.ts`。
- 浏览器隔离探针：`scripts/probe-workbench-ui.ts`。运行 `bun run build:desktop-ui` 后执行 `bun run scripts/probe-workbench-ui.ts`，本机地址与令牌在 `artifacts/workbench-polish-2026-09-30/startup.json`。测试工作区、模型请求元数据与截图都在这个 artifacts 目录，未纳入 Git。
- 正常仓库桌面启动：`bun run desktop`。本轮更新了源码与 `desktop/dist` 界面构建，现有安装包没有重打或替换。

最终界面截图：

- [Word 交付与右栏预览](../artifacts/workbench-polish-2026-09-30/office-preview-final.jpg)
- [深色工作台](../artifacts/workbench-polish-2026-09-30/dark-theme-final.jpg)
- [窄窗口](../artifacts/workbench-polish-2026-09-30/narrow-final.jpg)
- [响应式测量](../artifacts/workbench-polish-2026-09-30/responsive-proof.json)
- [持续阅读测量](../artifacts/workbench-polish-2026-09-30/scroll-proof.json)

## 尚未覆盖

Windows 桌面桥接文件选择器、真实中文输入法选词操作及 125%/150% 系统缩放尚未实际操作验收；组合输入保护有函数回归。跟随系统主题已实现，但本轮没有切换 Windows 系统主题验证联动。

列表虚拟化、细粒度任务归属撤销、Skill 市场和远程工作流没有在这次体验修复中加入。最终审美仍需用户在自己的常用窗口与字号下审阅。

初始 `reference/oh-my-pi` 脏状态和 `.tmp-host-window.png` 均保留；参考子仓库 HEAD 为 `73a11421fe34fbab8ad058ab9c1a2e4f447852ea`。本轮提交只包含体验修复、对应回归、隔离探针及本记录。
