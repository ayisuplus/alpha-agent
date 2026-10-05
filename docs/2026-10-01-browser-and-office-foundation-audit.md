# 内置浏览器与 Office 预览基础审查

核对日期：2026-10-01。产品源码基线：`02a31c3cee2422e3559a0b7f48ce75b6d7584831`。
参考 OMP 仓库 HEAD：`73a11421fe34fbab8ad058ab9c1a2e4f447852ea`；本次实现与探针以安装的 OMP **18.4.3** 为准。

用户补充要求：优先保留 Office 原格式能力，重点观察内置浏览器自动化点击。
本次交付为源码审查与隔离运行探针，未修改产品代码或更换文档引擎。

## 1. 已核对的构建基础

| 部分 | 实际链路 | 当前位置 |
| --- | --- | --- |
| 浏览器执行 | OMP Eval 的 `browser` 预声明空间 → Puppeteer → CDP → 独立 Electron/Chromium 浏览器宿主 | `src/native/launch.ts`、`desktop/browser-host.cjs`、安装包的 `src/tools/browser/` |
| 侧栏网页显示 | `Page.startScreencast` 的 JPEG 帧 → Electron IPC → React 图片 | `desktop/main.cjs`、`desktop/ui/src/app/NativeWorkspace.tsx` |
| 人工接管 | 同一宿主、同一 targetId；原生窗口移到侧栏屏幕矩形，交还后移到屏幕外 | `desktop/main.cjs`、`desktop/browser-host.cjs` |
| Office 预览 | 原件临时副本 → LibreOffice 无界面转换为 PDF → PDF.js Canvas | `src/native/project-file.ts`、`src/native/capabilities/office/office-runtime.ts`、`OfficePdfPreview.tsx` |
| PDF 预览 | 原 PDF → PDF.js，不经过 LibreOffice | `NativeFiles.tsx`、`OfficePdfPreview.tsx` |
| 文本及媒体 | React 文本/Markdown、隔离 HTML iframe、HTML 图片/音频/视频元素 | `NativeFiles.tsx` |

实测宿主：Electron 41.2.2、Chromium 146.0.7680.188；开发目录可用的 LibreOffice 来自系统安装。
发行脚本规定复制 LibreOffice 26.2.5.2 到 `runtime/libreoffice` 并核对二进制哈希；本轮没有重新打包或验证安装包。

### Office 保真结论

当前侧栏属于静态页面预览，没有接入原格式 Office 文档视图。PDF 中的数值、分页和版面，不能替代工作表、公式结构、批注修订及演示交互。

隔离 XLSX 探针含公式 `A2*3`、单元格批注和隐藏工作表。转换结果显示计算值 `21`，没有显示批注和隐藏工作表；原始 XLSX 的 SHA-256 保持不变。丢失的是预览中可访问的结构与交互，不是原件内容被删除。
探针的打印区域外单元格仍出现在导出 PDF 中，因此本报告不将“打印区域外内容必定丢失”列为已验证结论。

## 2. 自动化点击如何执行

1. 模型在 OMP Eval 中调用 `browser.open()`，读取 DOM/无障碍快照，或用 CSS、文本、ARIA 和元素 id/ref 定位目标。
2. 元素点击走 `tab-worker.ts` 的 `tab.click` / handle.click → `interactions.ts` 的 `clickElement`。
3. `actionableClickPoint` 滚动目标到可见范围，等待位置稳定，并以 `elementFromPoint` 检查页面内遮挡。
4. 最终调用 Puppeteer `page.mouse.click`，由 CDP 发送鼠标输入；正常激活页面的事件 `isTrusted` 为 `true`。
5. `tab.clickAt(x,y)` 则直接发送坐标输入，仅检查坐标为有限数值，不具有上述元素定位与遮挡检查。

侧栏图片没有参与上述鼠标坐标计算。它只是同一 Chromium 页面的观测画面；点击链直接操作浏览器页面。

## 3. 重点发现

### P1：原生页面层级与 CDP 目标未同步，点击可正常返回却无效

宿主预置三个重叠的 `WebContentsView`。源代码只在启动和控制面的 `show` 操作中调用宿主 `bringToFront(targetId)`。
OMP 的 connected 模式独立选用 CDP 页面，并不会通过这个宿主控制面同步原生视图层级。

复现证据：

- `observations-three-views-2026-10-01T08-24-58-821Z.json`：普通按钮初始点击计数 `0`；`page.bringToFront()` 后仍为 `0`；以相同 targetId 通过宿主控制面前置原生视图、随即交还后为 `1`。
- 同次 `eachNativeView` 的 index 2：`before=0, afterCdp=0, afterNative=1`。
- `observations-three-views-2026-10-01T08-26-33-482Z.json` 的 index 1、2 均得到 `0 → 0 → 1`。
- 单视图对照能触发正常点击、移动目标点击、iframe 点击、ARIA 点击与坐标点击。

结论：这是已复现的产品宿主/执行集成缺口。仅检查 DOM 可见性和 CDP 鼠标调用是否返回，不能证明原生视图接收了输入。
修复方向：在宿主中按稳定 targetId 激活实际承载页面的视图，保留屏幕外运行；把执行、截屏流和接管绑定到同一页面身份。

### P1：多个 OMP 进程可能采用同一页面，互相导航

在三视图实际宿主中，第一个 OMP 进程保留 `/main` 页面的 worker，第二个独立 Bun/OMP 进程打开 `/second` 后，第一进程原句柄的 `url()` 也变为 `/second`。
`primaryTabs.targetId` 与第二进程输出的 targetId 相同。该现象在两份带时间戳的三视图日志中均出现。

原因链：Alpha 会话共用宿主；OMP connected 模式按 URL/标题和可见性采用现有页面；Alpha 尚未提供跨进程的页面占用权或工作流级互斥。
共享标签页/登录状态是当前产品契约，但现有实现没有避免执行过程中的互相导航。
修复方向：由宿主管理页面分配/占用，按 Alpha 会话和 targetId 绑定；共享登录状态时仍保证同一页面的完整操作序列不会被另一会话打断。

### P2：禁用按钮点击也正常返回

在正常激活的页面中，`tab.click('#disabled')` 正常返回，按钮事件计数仍为 `0`。
当前 `isClickActionable` 检查布局、透明度、pointer-events 和遮挡，没有检查 disabled 状态；鼠标事件发送结束后也不核对预期页面状态。
修复方向：点击前检查禁用状态，操作后以目标状态、导航、响应或其他适当证据核实结果，避免以调用返回作为业务成功依据。

### P2：重复目标及新窗口流程需要明确契约

- `.duplicate` 匹配两个按钮时，探针只点击第一个，返回计数 `[0]`，没有报告目标歧义。
- `setWindowOpenHandler(() => ({ action: 'deny' }))` 拒绝所有新窗口；激活页面的 `target=_blank` 链接未生成新页面，也未导航当前页面。

修复方向：语义定位匹配多个目标时提示进一步限定；把合理的新页请求交给受管页面体系处理，明确实际宿主页数量和分配上限。

### 已有有效行为

- 普通激活页面的点击是可信鼠标输入；单视图对照验证了位置变化、iframe、ARIA 和坐标操作。
- 页面内遮挡返回明确错误；被删除的旧元素 id 被判定 stale。
- 实际 CDP 截屏流可持续产生 JPEG 帧；探针观测到操作前后画面帧。
- 浏览器/所有 Eval 调用受 Alpha 会话授权门约束；现有测试验证人工接管暂停新的调用。实际桌面 UI 中的接管/交还点击与真实登录尚未进行人工验收。

## 4. 原格式 Office 预览建议

推荐目标：Office 原格式在本地文档引擎中保持加载，侧栏连接引擎的渲染与交互，默认只读；PDF 保留用于导出和静态回退。

这涉及原格式文档宿主与侧栏接口，不能只改 `OfficePdfPreview.tsx` 的样式，也不能把“已有 LibreOffice 命令行转换器”视为“已有可嵌入的完整 Office 视图”。

可行性依据：

- [LibreOfficeKit 官方说明](https://docs.libreoffice.org/libreofficekit.html) 提供原文档瓦片渲染、鼠标/键盘输入和选择回调；该页明确标注渲染 API 的实验性质，并有 Windows 构建说明。Windows 发行包适配和功能覆盖需要先做真实原型，不能保证全部 Office 特性。
- [Collabora Office 官方 Windows 架构说明](https://www.collaboraonline.com/blog/collabora-office-26-04-release/) 描述了本地进程内文档引擎及本地 WebView2 UI。这是本地原格式引擎加网页界面的现有参考；本轮没有安装、接入或验证 Collabora。

最小原型验收：

| 类型 | 必须观察的原格式能力 |
| --- | --- |
| Word | 原分页、字体与图片、文本选择、批注与修订的显示 |
| Excel | 工作表切换、公式与结果的区分、批注、隐藏表状态、大表滚动 |
| PowerPoint | 幻灯片切换、备注；动画和嵌入媒体分别验证，不以静态缩略图代替 |
| 共用 | 不覆盖原件、只读状态、关闭与取消、DPI/侧栏缩放、便携运行与缺失引擎提示 |

Office 下一步先验证上述原型，再确定嵌入方式。浏览器下一步优先解决视图激活与页面占用，再补操作结果核对。

## 5. 复现与验证边界

隔离探针：`docs/audits/2026-10-01-browser-and-office/probe.ts`。

```powershell
bun run docs/audits/2026-10-01-browser-and-office/probe.ts
bun run docs/audits/2026-10-01-browser-and-office/probe.ts --single-view
```

探针只访问本机临时 HTTP 服务，浏览器 profile 放独立临时目录；控制面接管实验将窗口保持在屏幕外。不会使用用户真实登录、模型密钥或会话。
`--single-view` 在临时副本中只把宿主的页面数量改为 1，作为对照，不修改产品宿主。
探针退出时关闭自己的 Chromium 宿主、OMP worker 与临时 HTTP 服务；保留隔离目录和 JSON 供复查。

`observations.json` / `observations-activation.json` 是探索过程记录；前者的 iframe 数字定位用法错误、早期 fixture 遮挡其他目标等问题已在探针中纠正，不计作产品缺陷。
产品问题结论主要绑定两份带时间戳的三视图日志及单视图对照。

验证：`bun run check` 通过；`bun run test` 本轮通过（138 pass / 0 fail / 977 expect，30 个文件，349.09 秒）。
现有套件通过不代表原生浏览器点击链已通过验收；上面的实测探针另行揭示了现有套件未覆盖的宿主层级和跨进程页面问题。
探针记录返回值与页面实际状态，不以进程退出码 0 表示浏览器所有用例合格。
本轮未改变产品行为、未重新打包，未验证外网站点、验证码、下载、真实 Office 动画或桌面人工交互。
