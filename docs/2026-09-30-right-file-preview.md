# 右侧文件预览

## 本次交付

右侧常驻入口增加「文件」。选择会话后，可以浏览项目目录，点击文件在右栏只读预览；保留返回文件列表、上一级、项目根目录，增加列表刷新、预览刷新、下载原文件，以及桌面版的系统应用打开。切换到审查、终端或浏览器再回来，会保留所选文件与目录；更换会话时清空选择。隐藏预览时卸载播放器和 PDF，停止播放并取消加载。

| 文件 | 当前预览 |
| --- | --- |
| 文本、代码、JSON | 原文，UTF-8 或带 BOM 的 UTF-16，最多前 1 MiB |
| Markdown | 正文、表格和代码块；链接与图片引用显示为文字，不加载外部资源 |
| HTML | 隔离 iframe，禁止脚本和外部资源，仅显示静态内容 |
| PNG/JPEG/GIF/WebP/SVG/BMP/AVIF | 浏览器图片预览 |
| MP4/WebM/MOV、MP3/WAV/OGG/M4A/FLAC | 浏览器原生播放器，支持 Range 分段读取；编码兼容性取决于浏览器 |
| PDF | 翻页、缩放、适应栏宽 |
| DOCX/XLSX/PPTX、DOC/XLS/PPT、ODT/ODS/ODP/RTF | 本机 LibreOffice 转为 PDF 后翻页预览 |
| 二进制、不支持的编码、超过 50 MiB 的图片或文档 | 显示原因，提供原文件下载/系统打开 |

Office 使用临时目录中的副本，转换结束清理临时文件，不修改源文件、不写入项目 `outputs/`。转换结果仍可能受字体、页面设置和 Office 格式兼容性影响；本次预览功能不承诺所有复杂文档保真，也不增加文件编辑功能。

## 复用来源与接入

- 从本仓库提交 `56ec970` 恢复 `OfficePdfPreview.tsx`。继续使用现有 PDF.js 依赖，并补充取消加载和缩放；没有恢复旧任务编排、证据合同或旧状态仓库。
- 复用 `src/native/capabilities/office/office-runtime.ts` 的 LibreOffice 转换器，通过 `officeDocumentPdf` 提供临时 PDF 数据。
- `src/native/project-file.ts` 负责会话项目内的文件定位、格式识别和内容响应。`GET /api/native/sessions/:id/file?path=...` 返回预览描述；`raw=1` 返回文件流，Office 加 `preview=1` 返回 PDF；`download=1` 下载原件。
- 文件接口沿用启动令牌与本机 Host 校验；解析真实路径后拒绝项目外的绝对路径、目录逃逸和链接越界。HTML 与未知文件原件采用附件响应，额外设置 `nosniff` 和沙箱策略。

## 验证与试用

- `bun run check`、`bun run build:desktop-ui` 通过；构建仍有既有大 chunk 提示。
- 完整原生套件通过：81 pass、0 fail、576 assertions，结果见 `artifacts/file-preview-2026-09-30/tests-final.log`。新增文件预览测试覆盖读取、编码、大文件截断、大小限制、目录/缺失文件、越界链接、媒体范围、原件下载与 Office 原件不变；本机接口集成测试覆盖描述/原件鉴权。
- 内置浏览器已验证 Markdown 表格、PNG 加载、PDF 第二页、Word/Excel/PPT 转换、缩放、跨面板保留所选文件、HTML 隔离、WAV/MP4 播放、下载哈希一致、损坏 PDF 提示、不支持格式、空目录与返回。
- 图片和页面证据保存在 `artifacts/file-preview-2026-09-30/`。独立试用服务的地址、工作区与 PID 记录在该目录的 `startup.json`；「文件预览验收」会话包含测试文件，没有发送模型任务。
- 当前交付更新源码和试用页，既有安装包没有重新打包。桌面系统打开沿用原有桥接，本轮界面验收在内置浏览器完成；未逐项验证每一种图片/媒体编码或老 Office 格式。
