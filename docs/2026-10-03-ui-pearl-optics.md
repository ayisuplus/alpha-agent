# Alpha 工作台 · 珍珠光学（Pearl Optics）界面升级 · 2026-10-03

用户要求从前端设计角度审查工作台，并升级为有未来科技感的界面，至少使用**天蓝**和**珍珠白**两种颜色。经确认采用以下方向：**克制未来**、**珍珠白浅色为默认**、**保留系统标题栏，只同步窗口底色**、**使用系统 Segoe UI Variable 字体，不打包字体**。

本次只改样式、两个状态属性和窗口底色。产品结构、路由、执行内核、工具接口和文案都没有变化。

## 审查结论

2026-10-01 的“温润科技＋立体层次”版本把强调色降成了钢蓝 `#316E97`，主按钮改成“底边厚度 + 按压下沉”的拟物写法，界面里已经没有真正的天蓝，也没有珍珠白。层级靠实体阴影和厚度来表达，与未来感需要的发光、透光、细线和精密感正好相反。此外，首页没有标志性视觉，运行时界面几乎是静止的。

审查中还发现并修复了以下实际问题：

| 问题 | 位置 | 处理 |
| --- | --- | --- |
| Office 预览使用了未定义的变量 `--surface`、`--radius-md`、`--text-primary`、`--bg`，背景、圆角和文字色都失效 | `NativeApp.css` Office 预览段 | 改用已定义的令牌 |
| 命令面板的结果列表被 `.native-modal > div`（对话框按钮行的规则）误设为横向 flex，命令被挤成窄列 | `NativeApp.css` | 为结果列表恢复 grid，输入框占满宽度 |
| 纸墨时期遗留的暖色阴影、写死的终端底色和模态遮罩、`--ink` 引用 | `settings.css`、`NativeApp.css` | 全部改用令牌 |
| 工作区、对话框和重命名表单中的文本框是未加样式的原生控件；运行时的“中途补充”下拉框也是 | `NativeApp.css` | 统一为珍珠凹面字段 |
| Electron 窗口底色写死为 `#f8fafc`，深色主题启动时会先闪白 | `desktop/main.cjs` | 底色跟随主题 |
| 字号令牌 `--text-xs` 与 `--text-sm` 同为 13px，没有展示字号 | `tokens.css` | 补齐刻度 |

## 设计语言

核心原则是**用光而不是厚度来表达层级**。天蓝只用在“活着的东西”上：主操作、焦点、运行状态和选中指示。珍珠白承担所有表面。

| 层 | 内容 | 浅色 · 珍珠 | 深色 · 深空 |
| --- | --- | --- | --- |
| 后层 | 画布、侧栏 | `#ECEFF1` 加两处静态天蓝极光；侧栏为半透明珍珠 | `#060B14` 加天蓝星云辉光 |
| 主工作面 | 主区、工作区、设置 | 珍珠白 `#FAFAF7`，细线，浅环境阴影 | `#0E1726` |
| 操作面 | 输入舱、产物卡、激活会话 | `#FDFDFB` 叠一层低饱和珍珠虹彩（冰蓝→微粉），天蓝发光细线 | `#142033` |
| 浮层 | 菜单、命令面板、对话框、错误提示、回到最新 | 玻璃：80% 不透明加 `blur(20px)`；对话框背后是变暗遮罩 | 同左 |

文字：浅色正文为深墨蓝 `#0F1B2A`，深色正文为珍珠白 `#F4F3EE`。天蓝分成三种用法：
- `--accent-fill` `#38BDF8`：发光和填充。
- `--accent`：文字安全的天蓝，浅色 `#0369A1`、深色 `#7DD3FC`，用于链接和小字。
- `--focus-color`：浅色 `#0284C7`、深色 `#7DD3FC`，用于焦点描边。

主按钮是天蓝渐变胶囊（`#7DD3FC → #38BDF8 → #0EA5E9`），文字为 `#082F49`。

## 实施内容

- **令牌**（`desktop/ui/src/styles/tokens.css`）：新增天蓝色阶、珍珠白、玻璃、极光、珍珠光泽、发光、动效时长与缓动、展示字号；保留原有语义变量名。删除不再使用的 `--accent-soft*`、`--primary-top`、`--surface-edge`、`--ink`、`--accent-gold`、`--accent-warm`、`--halftone`。共享关键帧也放在这里。
- **主按钮**：去掉底边厚度和上浮位移。悬停时发出天蓝光，按下时缩到 `scale(.97)`。禁用态为珍珠凹面。
- **侧栏**：品牌前加一颗小能量点。激活会话改为珍珠面，左侧加一条 3px 天蓝光条。运行中的状态点有呼吸光晕。
- **首页**：原来的药丸字标换成 “Alpha Core”。这是纯 CSS 实现：外圈一道天蓝光环每 24 秒转一圈，内核是珍珠到天蓝的径向光。下面是加宽字距的 ALPHA 字标。问候语保持静态。
- **运行状态**：流式输出时，顶栏底边有一道 2px 天蓝扫描光带，状态胶囊变成脉冲点加文字，输入舱的发光细线变成沿边缘流动的光（`@property` 角度动画）。这些都由 `NativeThread.tsx` 的 `data-running` 和 `NativeComposer.tsx` 的 `data-streaming` 驱动。
- **会话**：展开工具过程后左侧显示一条时间线。产物卡顶部有一小段天蓝光标，文件类型显示为等宽胶囊。代码块左缘有一条天蓝细线，diff 的 hunk 头使用天蓝底。
- **设置与工作区**：导航选中项为天蓝左光条，开关轨道为天蓝渐变，页签下方有天蓝指示线。
- **窗口**（`desktop/main.cjs`）：启动时按已保存的主题设置底色（浅色 `#ECEFF1`，深色 `#060B14`）。切换主题、或在“跟随系统”模式下系统主题变化时，所有窗口同步更新底色。
- **字体**：字体栈前置 `Segoe UI Variable Text`，标题使用 `Segoe UI Variable Display`。中文仍回退到微软雅黑。`NativeApp.tsx` 中“Segoe”字体偏好也同步前置了 Variable。

### 刻意不做的事

- **不给消息加进入动画**。工具从单条合并为组时会重新挂载，进入动画会在这些时刻闪一下。
- **不给窄窗口的工作区抽屉加玻璃**。抽屉背后是流式更新的会话，`backdrop-filter` 会每帧重新模糊一大块区域。抽屉保持实体表面。
- **不改 `presets/terminal-themes/alpha-sky.json`**。它本来就是天蓝体系；已安装用户的副本不会被覆盖（`src/native/launch.ts`），改动会让 TUI 和 xterm 颜色不一致。`--terminal-bg` 继续取该文件的 `pageBg`。
- **不加 HUD 角标、点阵网格或常驻流光**（用户选择了“克制未来”）。

`prefers-reduced-motion` 下，工作台内的所有动画都会关闭：扫描光带变为静止的整条光，输入舱为静态渐变描边，运行点改为静态光晕。

## 验证

| 项目 | 结果 |
| --- | --- |
| `bun run check` | 通过 |
| `bun run build:desktop-ui` | 通过；仍有既存的大于 500 KB 分块提醒 |
| `bun run test` | 见文末交付记录 |
| 对比度 `bun run docs/audits/2026-10-03-pearl-optics/contrast.ts` | 直接从 `tokens.css` 读值，半透明令牌按实际底色合成，侧栏取画布与两处极光中最不利的一种。66 组全部达标：浅色辅助文字在侧栏上最低为 4.83:1，天蓝按钮文字最低为 5.01:1（`#0EA5E9` 端），浅色焦点描边为 3.92:1（非文字要求 ≥3:1） |
| 未定义变量扫描 | 无（最后一处 `--halftone` 随未引用的 `Halftone.css` 一并删除） |
| 实际界面 `capture.ts` | 隔离预览加无头 Chrome。Segoe UI Variable Text/Display 均可用。1440×900、1280×800、1101×800、1024×768、720×800、400×720 下首页与会话均无横向溢出。运行时 `data-running` 与 `data-streaming` 生效，正在播放的动画为 `alpha-orbit`、`alpha-pulse`、`alpha-scan`；模拟减少动态效果后，正在播放的动画为 0 |

截图（隔离预览，本机固定模型，不调用云模型）：

- [浅色首页](audits/2026-10-03-pearl-optics/home-light.jpg) · [深色首页](audits/2026-10-03-pearl-optics/home-dark.jpg)
- [浅色会话与产物](audits/2026-10-03-pearl-optics/thread-light.jpg) · [深色会话](audits/2026-10-03-pearl-optics/thread-dark.jpg) · [工具时间线](audits/2026-10-03-pearl-optics/tool-timeline-light.jpg)
- [运行中：扫描光带、流光输入舱、脉冲状态](audits/2026-10-03-pearl-optics/running-light.jpg)
- [玻璃命令面板](audits/2026-10-03-pearl-optics/palette-dark.jpg) · [玻璃模型菜单](audits/2026-10-03-pearl-optics/model-menu-dark.jpg) · [设置](audits/2026-10-03-pearl-optics/settings-light.jpg)
- [1101px 工作区抽屉](audits/2026-10-03-pearl-optics/drawer-1101x800.jpg) · [400px 窄窗口](audits/2026-10-03-pearl-optics/thread-400x720.jpg)

改版前的对照图见 `docs/audits/2026-10-01-dual-core/implemented-*.png`。

复现方式：

```powershell
bun run build:desktop-ui
bun run scripts/probe-workbench-ui.ts artifacts/ui-pearl-optics-2026-10-03/review
# 在另一个终端运行：
bun run docs/audits/2026-10-03-pearl-optics/capture.ts artifacts/ui-pearl-optics-2026-10-03/review/startup.json artifacts/ui-pearl-optics-2026-10-03/shots
bun run docs/audits/2026-10-03-pearl-optics/contrast.ts
```

`capture.ts` 默认使用 `C:/Program Files/Google/Chrome/Application/chrome.exe`，可以用 `ALPHA_CAPTURE_BROWSER` 指定其他浏览器。`startup.json` 里有临时访问令牌，不要提交。

## 真实参考

核对日期：2026-10-04，在本次会话中实际打开过。这些来源只用来参考材质、层级与可及性原则，没有复制任何界面源码或品牌素材。

- [Microsoft Fluent 2 · Material](https://fluent2.microsoft.design/material)：Acrylic 是半透明磨砂材质，用于菜单、弹出层等临时浮层；Smoke 用于在模态背后压暗界面。本次的浮层玻璃与对话框遮罩按这两种用途区分。
- [Microsoft Learn · Typography in Windows](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography)：Segoe UI Variable 是 Windows 11 的系统字体，覆盖英文、欧洲语言、希腊文和俄文，其他语言另有字体。因此中文继续回退到微软雅黑。
- [W3C · Understanding SC 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)：界面组件和状态的视觉标识需要相对相邻颜色至少 3:1。这是焦点描边和开关轨道选色的依据。

## 交付边界

- 交付的是源码、已构建的界面、隔离预览证据和截图。没有制作或发布安装包，也没有覆盖已安装版本。
- 网页预览无法验证 Electron 窗口底色。窗口底色另做了一次隔离的 Electron 检查（结果见文末交付记录）；系统通知、文件选择器等桌面桥未改动。
- 本次是令牌级对比度检查，不是整站 WCAG 审计。玻璃浮层按“铺在主工作面上”计算；如果浮层背后正好是高对比内容，模糊后的实际底色会有偏差。
- 最终审美以用户在桌面应用中的实际观看为准。

## 交付记录

- 基线：`716686c`（分支 `ui/workbench-settings`），截图采集于 2026-10-03。
- `bun run check` 和 `bun run build:desktop-ui` 均通过。
- `bun run test`：**161 通过，2 失败**，共 1113 次断言、33 个文件，用时 387 秒。两项失败分别是 `native-host.test.ts` 的“native CLI and SDK host discover the same skills…”和 `native-marketplace.test.ts` 的“native project marketplace plugin installs…”，原因都是 OMP 宿主启动时找不到任何模型凭据（No API key found）。把本次改动暂存、在原始代码上单独重跑这两个文件，同样是这 2 项失败，因此与本次界面改动无关。推测与 2026-10-01 清理 `MINIMAX_API_KEY` 后测试环境不再带有模型凭据有关，本次没有修改测试或环境。
- 对比度检查 66 组全部达标。`capture.ts` 测了 12 组尺寸，均无横向溢出，运行态钩子和减少动态效果的结果均符合预期。原始数据见 [capture.json](audits/2026-10-03-pearl-optics/capture.json)。
- Electron 窗口底色：用临时工作区、临时 OMP 配置和独立桌面状态启动真实 Electron，通过主进程 inspector 读取 `getBackgroundColor()`。已保存为深色时启动为 `#060B14`；经存储通道改成浅色后为 `#ECEFF1`；改为跟随系统后，系统深色为 `#060B14`、系统浅色为 `#ECEFF1`。检查结束后已关闭进程，没有使用用户的数据目录。
- 用户确认后（2026-10-05），删除了已不被引用的 `components/NewTask.css`、`Halftone.tsx`、`Halftone.css`、`Greeting.tsx`（纸墨时期的首页组件）。删除前已核对 `desktop`、`src`、`scripts`、`test` 中都没有引用。
