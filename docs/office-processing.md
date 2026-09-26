# 内置办公文档处理

Alpha 的文件任务和受管理的通用任务可使用 `alpha_office_status`、`alpha_office_read`、`alpha_office_edit`、`alpha_office_export`。文档必须先作为任务附件上传，或由前一次 Office 操作生成；工具接受该任务内的 ID，不接受任意本机路径。规划和审阅阶段只开放状态与读取。源码版使用本机已验证的 LibreOffice，便携包只使用包内 `runtime/libreoffice`，缺失时报告不可用。

读取支持 DOCX 段落和表格、XLSX 工作表和单元格、PPTX 幻灯片及形状、文本 PDF。Excel 读取最多展示每张表前 200 行和 50 列，并标记截断；PDF 返回需 OCR 的页码，不自动识别扫描件。编辑以精确对象定位和预期旧值为前提：Word 替换段落或表格单元格内的文字；Excel 修改单元格并重算公式；PowerPoint 替换形状文字或使用另一任务附件替换图片；PDF 可选页、重排、旋转和合并。Word 修订、宏和嵌入对象，以及 Excel 数据透视表、外部连接、切片器、图表等高风险结构，和 PowerPoint 动画、SmartArt、嵌入对象、图表等结构会阻止自动编辑。

`alpha_office_edit` 不覆盖原件。它将新版本、SHA-256、编辑前后结构记录及 PDF 页面预览写到任务输出；保存后重新打开检查结构。把新版本路径写入 `alpha-deliverable.json` 后，任务验收会核对哈希并归档新版本与前后预览。工作台成果区可逐页查看 PDF 预览及下载原格式文件。自动结构检查不能保证复杂版式完全保真，最终版面仍需查看预览。

开发验证：`bun run check`、`bun test test/office-runtime.test.ts test/builtin-plugins.test.ts`、`bun run build:desktop-ui`。`bun run scripts/probe-office-runtime.ts` 用真实 Word、Excel、PowerPoint 文件验证保存和重开；`bun run package:portable` 会复制已锁定的 LibreOffice 26.2.5.2 与许可证，并在屏蔽系统安装路径后对包内引擎运行同一探针。本功能当前只面向 Windows 便携包。
