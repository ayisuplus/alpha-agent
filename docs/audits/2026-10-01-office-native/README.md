# 2026-10-01 · 本机 Office 原格式预览验证

本次交付使用本机已安装的 LibreOffice 26.2.5.2，build `cd7284b4cbbfeb507e630c1aac019f4157393acb`。没有安装、下载、降级依赖，也没有改系统设置或用户文档。产品调用见 `src/native/capabilities/office/office-view.ts`；每个视图持有独立 Python 进程、私有 profile 和原文件临时副本。

Writer 的 DOCX 由 LibreOfficeKit 直接加载、绘制原文档 tile。Windows 本构建的 Calc / Impress `documentLoad` 在本机探针中不返回，所以这两类由**同版本 LibreOffice UNO 原文档模型**承载，使用原生单元格区域 / DrawPage 绘制 PNG。每次滚动、缩放、切换、选择都作用于该持续存活的模型；公式、批注、隐藏表状态、笔记从真实模型读取。没有经过 PDF，也没有把 HTML 文档转换当原格式预览。Writer 批注的原生 HTML 字段仅解析成纯文字元数据，原字段仍保留。

## 已测能力矩阵

| 格式 | 原生入口 | 实测结果 | 当前边界 |
| --- | --- | --- | --- |
| DOCX | LibreOfficeKit `documentLoadWithOptions`、`paintTile` | 原版面 tile、TWIPs 文字选择、插入修订的作者/类型/范围、中文批注正文与作者 | 修订枚举和显示只读；不接受/拒绝修订；只覆盖本次 fixture 的结构 |
| XLSX | UNO 原 SpreadsheetDocument + 原生 `calc_png_Export` 选区绘制 | Visible / Hidden / Second 三表与真实 `IsVisible`；B2 `=A2*3` / `21`；B2 批注；打印区 A1:B2 外 A20；滚动、2 倍缩放、可见表切换 | 默认网格线、行列标题等原应用界面未嵌入；源单元格自身格式与边框由原生绘制；隐藏表保持隐藏，选择时明确报错 |
| ODS | 同上 | 3 表/隐藏状态、原生有效位图、B2 公式/结果/批注、可见表切换 | 由本次 XLSX fixture 保存的 ODS 验证；不宣称覆盖全部表格结构 |
| PPTX | UNO 原 PresentationDocument / DrawPage + 原生 GraphicExportFilter | 两页真实文字与形状、页切换、2 倍缩放 tile、按原形状坐标读文字、两页完整中英文多段笔记 | 动画、嵌入音视频未验证；选择为形状文字，不是 PowerPoint 的字符编辑；不提供编辑 |
| ODP | 同上 | 两页有效原生位图、页切换、完整中英文笔记 | 原形状文字选择入口存在；本次固定坐标选择没有命中文字，未把该项记作通过 |
| ODT | Windows LibreOfficeKit 探针 | 此 fixture 加载没有返回，30 秒保护终止 | 当前 API 立即给出“尚未通过验证，请在原应用中打开；可选择静态预览” |
| RTF | 未验证 | 未宣称可用 | 与 ODT 一样明确拒绝原格式入口，允许用户选择原应用 / 静态副本 |

上述为本机基本结构 fixture 验证，不代表 Microsoft Office 全结构兼容验收。DOCX、XLSX、PPTX 的产品 UI 接入及完整发行验证由根任务另行记录。

## API 与生命周期

- `openOfficeView(path, signal?)`：返回 `id / kind / parts / part / width / height / readOnly / comments / revisions`；幻灯片另有 `notes?: {part, text}[]`。`parts[].hidden` 只来自真实 UNO `IsVisible`。
- `renderOfficeView(id, {part?, x?, y?, width?, height?, scale?}, signal?)`：坐标与文档尺寸是 TWIPs；15 TWIPs = 1 CSS px（scale=1）。`width / height` 是 PNG 像素尺寸，1–2048；实际返回 PNG 保持该尺寸。原生 UNO 100mm 几何以 `72/127` 换算 TWIPs，缓冲区按 `scale/15` 映射并裁剪，未重排原文件。
- `selectOfficeView(id, {part?, x, y, count?:1|2}, signal?)`：返回原引擎文字；Calc 另给真实 `formula / cellAddress`；返回当前 part 与尺寸。没有编辑、保存、执行任意 UNO 命令的公开接口。
- `getOfficeView(id)`、`isOfficeViewOpen(id)`、`closeOfficeView(id)`：供 session 所有权管理及失效名额清理。

每条 worker RPC 最多 30 秒；超时/取消会关闭视图并终止其完整进程树。启动的是 `pythonloader.uno.ini` 指定的**实际 CPython 解释器**，不是会留下子进程的 `program/python.exe` 包装器。所有 Python / UNO 路径与 bootstrap 仅设置在子进程环境。测试中在 DOCX 加载 250ms 时取消，2.3 秒左右返回且私有文档副本目录不再存在。正常关闭后 map 已移除；隐藏表选择错误则不销毁当前可见表视图。

UNO 原文件加载使用 `ReadOnly=true / Hidden=true / NEVER_EXECUTE / NO_UPDATE`；LOK 禁止宏、将 view 设为只读并禁用批注修改与修订管理。绘图产生的唯一文件是私有目录的 PNG；不保存原格式副本，更不覆盖原始文件。`backend-evidence/observations.json` 记录 8 个输入的 SHA256，全部 `originalUnchanged=true`。

## 证据与复现

在项目根执行（只使用已有 Bun 与已有 LibreOffice）：

```powershell
bun test ./test/native-office-view.test.ts
bun run check
bun docs/audits/2026-10-01-office-native/probe-api.ts
```

`fixtures/` 保存本次小型原格式输入；`make-fixtures.ts` 用已有 docx / ExcelJS 生成批注与表格 fixture，跟踪修订/演示底稿复制自项目测试夹具。中英多段笔记的 PPTX 在 `uno-view-probe.py` 中用 `UNO_VIEW_PROBE_WRITE_NOTES=1` 于私有副本创建；ODS / ODP / ODT / RTF 为同版本 LibreOffice 对这些自建 fixture 保存的格式副本。既有 fixture 足以直接复跑测试与 API 探针，不要求重新生成。

`backend-evidence/` 保留实际产品 API 的元数据、选择结果、原始 SHA256、PNG SHA256、800×600 PNG 尺寸和耗时。关键 PNG 已人工查看：Word 修订/批注锚点、表格首屏/第 20 行滚动/公式区域 2 倍缩放/第二表、演示首屏/第二页 2 倍缩放，以及 ODS / ODP 的原生画面。`initial-word/` 保留直接 DLL 探针最初的原生 tile 与修订返回值。`uno-window-observations.json` 保留窗口捕获失败证据：`PrintWindow=true`，但像素只有黑色和 alpha，故未把该入口交付成成功预览。

最终验证记录在 `verification.txt`。整套原生回归、UI 和便携包验证属于根任务，不能仅由本子任务测试推定通过。

## ABI / 官方来源

- DLL：`C:\Program Files\LibreOffice\program\mergedlo.dll`，147,882,408 字节，SHA256 `f5af105e70bcd55bcf0468ef438037c9ad5d927fbb037dad2f18819de6dd40aa`。`pe-exports.py` 确认 `libreofficekit_hook / libreofficekit_hook_2 / lok_preinit / lok_preinit_2 / unit_lok_process_events_to_idle` 等可调用入口。生产 worker 的 ABI 槽位来自下面同版本头文件，并检查表大小/空指针。
- [同版本 LibreOfficeKit.h](https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/include/LibreOfficeKit/LibreOfficeKit.h)、[Init.h](https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/include/LibreOfficeKit/LibreOfficeKitInit.h)、[枚举](https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/include/LibreOfficeKit/LibreOfficeKitEnums.h)：Windows 初始化、profile、tile / part / selection / 只读接口。
- [同版本 GraphicExportFilter.cxx](https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/filter/source/graphic/GraphicExportFilter.cxx)、[Calc docuno.cxx](https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/sc/source/ui/unoobj/docuno.cxx)：选择区域直接进入原生绘制设备，不经过 PDF，支持 `RenderToGraphic`。
- [同版本 notesuno.cxx](https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/sc/source/ui/unoobj/notesuno.cxx)：实际 annotation / caption 数据。此构建的批注文字在 `getAnnotationShape()` 物化原生 caption 后才能可靠读取。
- [同版本 unotxdoc.cxx](https://raw.githubusercontent.com/LibreOffice/core/libreoffice-26.2.5.2/sw/source/uibase/uno/unotxdoc.cxx)：Writer 原生批注 HTML 与修订范围数据。
- [Windows LibreOfficeKit 问题 172283](https://bugs.documentfoundation.org/show_bug.cgi?id=172283)：官方页面在本次查询受到 Anubis 访问限制，未核实当前处理状态。Windows Calc / Impress 挂住的结论来自本机可复现探针，不把网上问题状态当当前事实。`unipoll` 与 Windows 消息泵尝试没有解开本构建的加载阻塞，未用于产品。

后续更新 LibreOffice 时需要重新验证本矩阵与 ABI，不能以“DLL 有导出符号”替代真实原文档加载/绘制证明。
