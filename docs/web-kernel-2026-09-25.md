# Alpha 网页内核（2026-09-25）

网页能力由 Alpha 自己的任务运行时编排，不通过安装第三方插件替换执行链。`BrowserKernel` 持有页面身份、任务归属、串行操作和人工接管状态；`VisibleBrowser` 通过 CDP 连接 Electron 返回的精确 target ID。产品预览与公开网页分别使用独立的 `WebContentsView`，都嵌入工作台右侧浏览器栏；用户看到和 Agent 操作的是同一个 Chromium 页面。公开网页使用隔离的 `persist:alpha-web` 会话，只能访问公网 HTTPS 主页面，导航和子请求经过桌面端地址检查。切换或收起右栏只改变原生视图边界，不重建网页实例。

`alpha_search` 使用 Tavily 做发现；摘要不能充当全文证据。`alpha_source` 可保存直连响应、Firecrawl 提取结果或任务持有的渲染页面，原始材料和正文分别计算 SHA-256。`alpha_crawl` 用 Firecrawl 做 map、有限页数的 crawl、状态和取消，任务记录持有作业 ID、续页和来源。`alpha_site` 是首个 GitHub 只读站点入口，与通用 `alpha_browser` 共用标签页和授权内核。指定的服务缺密钥或不可达时会报告错误，不会静默改用另一服务。

直接任务的公网读取按提供方或域名获得任务级授权；用户在工作台主动打开页面会授予该任务对应域名的读取权。公开页面上的点击、输入、选择、按键、上传和下载按完整参数摘要逐次审批。上传只能选任务项目或任务制品中的非保护文件，并锁定文件哈希；下载写入任务专属目录并计算哈希。动作开始后若中断，回执转为“结果不确定”，相同请求号不能自动重放。浏览器观察覆盖主文档、开放的 Shadow DOM 和同源 iframe，元素引用在下一次观察或导航后失效。模型和用户共用一个控制状态；接管后排队动作不会再启动。Worker 的浏览器请求由主侧校验并转发，过期或取消的请求不会执行。

桌面右栏「浏览器」显示产品预览和当前任务的公开网页标签页；「网页工作」区保留授权回执、采集作业及来源哈希；「设置」区保存 Tavily 和 Firecrawl 密钥于当前 Windows 用户加密存储。环境变量 `TAVILY_API_KEY` 和 `FIRECRAWL_API_KEY` 也可供侧车使用。未配置密钥时公开浏览器和直连来源仍可工作，付费提供方调用会明确失败。

验证：`bun test ./test/web-kernel.test.ts ./test/browser-verifier.test.ts ./test/task-workbench.test.ts`、`bun run check`、`bun run build:desktop-ui`、`bun run probe:browser`、`bun run probe:preview-browser` 和 `bun run probe:web-desktop`。桌面探针在独立临时工作区启动真实 Electron 和侧车，检查加密密钥路由、GitHub 标签页和精确 CDP target。提供方调用在测试中使用注入的模拟响应；真实 Tavily、Firecrawl 配额和登录网站的提交路径需要配置凭据后再验收。
