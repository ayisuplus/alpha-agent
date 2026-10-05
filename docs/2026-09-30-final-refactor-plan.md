# Alpha 最终重构方案（2026-09-30）

状态：**定稿，待实施**。本文是这次重构唯一的施工依据。诊断过程与证据见 [定版收束建议](2026-09-30-final-convergence-recommendations.md)，历史方案见 [docs/archive/](archive/README.md)。第 11 节列出的事实，已对照 OMP 源码（`reference/oh-my-pi`，18.2.11）、安装包（18.4.3）和天枢源码（`reference/Tianshu-harness`）核实。

---

## 1. 目标

**Alpha = 原生 OMP 内核 + 天枢证据层 + Alpha 方法（Skill）+ 本机能力 + 桌面工作台。**

重构完成后，要同时做到三件事：

1. **一个产品。** 界面上只有 Alpha 一个产品名；终端第一眼就能认出是 Alpha，而不是原版 OMP。
2. **长在一起。** 天枢读取 OMP 的原生事件，写入 OMP 的原生会话和界面面板；本机能力优先使用 OMP 原生工具，只补 OMP 没有的部分。不再有两套东西并排运行。
3. **干净。** 运行入口不再依赖旧任务系统；发行包里只有真正在用的东西；模型进程接触不到任何不该有的令牌或调试端口。

## 2. 现状与问题（摘要）

| 层 | 现状 | 问题 |
|---|---|---|
| 身份 | 首页说"我是 Alpha"，对话署名"OMP"，终端与原版 OMP 完全相同 | 三个主体在接力，不像一个产品 |
| 方法 | 30 个专家（人设 + Skill）没有接入原生入口 | Alpha 最有价值的行业方法不在运行中 |
| 天枢 | 只改编了 `cognitive-frame`、`control-plane` 两个文件，约 350 行，得到三条启发式；只监听两类事件；状态写私有文件；提醒以隐藏上下文注入；终端看不到 | 与 OMP 并排运行，没有结合；"写文档也提醒没跑测试"；天枢最有特色的"宣称必须有证据"没有接进来 |
| 浏览器 | OMP 原生 `browser` 和 `alpha_browser` 同时挂给模型；为显示网页，对整个 Electron 进程开放 CDP；桥接令牌和调试端口经环境变量进入模型进程；只允许公网 HTTPS | 两个浏览器；安全边界反了；打不开本机开发服务器 |
| 办公 | OMP `read` 本就能读 Office 文件，Alpha 却要求先复制进 `.alpha` 换 ID；生成（纯文本排版）和编辑（只能替换文本）是两套引擎；办公 Skill 承诺的能力工具都做不到；预览生成了但看不见 | 读取重复；能力弱且割裂；方法与能力脱节 |
| 媒体 | 产出写进 `<项目>/public/alpha-assets/`，视频工具要求项目里已有 `public/` | 沿用旧"Web 产品任务"约定 |
| 代码 | `src/native` 约 900 行，但导入闭包有 63 个文件、约 8,800 行，旧任务账本、专家、计划器都被带进发行包 | 旧系统无法归档；"专家已取消"在代码层面不成立 |
| 会话与进程 | 会话按"目录里有文件就 `--continue`"恢复；每打开一个会话常驻一个 OMP 进程 | 可能接到错误的会话；进程只增不减 |
| 边界 | 默认工作目录包含 `.alpha`（会话、浏览器 Cookie）；本地接口没有令牌、不校验 Host；启动被更新检查阻塞 | 智能体默认站在自己的数据上面；本地接口可被其他程序调用 |

## 3. 已定决策

| # | 决策 | 含义 |
|---|---|---|
| D1 | 执行内核是原生 OMP 18.4.3 | 不自建执行循环、计划图、专家调度或编排层 |
| D2 | 取消专家，方法转为 Skill | 人设、交接声明、角色词表全部退役；方法以 Skill 随包发行 |
| D3 | 天枢是 Alpha 自己的可见层 | 只建议、不拦截、不自行开启新一轮；在状态栏、提醒和 `/tianshu` 里以"天枢"之名出现 |
| D4 | 桌面视觉样式保持现状 | 不改纸墨风格；界面改动只涉及内容、接线和信息层级；新增元素只用现有样式变量和类名 |
| D5 | 终端外观不同、操作相同 | 主题、页眉、标题、状态段体现 Alpha 与天枢；按键和命令与 OMP 相同 |
| D6 | OMP 只在"关于"页致谢 | 产品名只有 Alpha |
| D7 | 缓存与前缀稳定是硬约束 | 身份说明固定不变；天枢只往尾部追加，不改历史 |
| D8 | 本机能力原生优先、约定统一 | OMP 已有的能力直接用原生；Alpha 只补 OMP 没有的部分，并统一路径、返回、预览和授权（第 6.1 节） |
| D9 | 天枢只移植与 OMP 不重叠的部分 | 移植宣称—证据对账、机械变更分类；计划模式、目标、交接、倒带、LSP、MCP、多代理、自研 TUI 一律以 OMP 为准 |

## 4. 目标架构

```
桌面工作台（Electron + React，样式不变）
   │  HTTP + SSE，仅 127.0.0.1，每次启动一个令牌，校验 Host
Alpha sidecar  src/native/server.ts
   │  会话索引 · 配置 · 更新提醒 · 终端切换 · 进程回收
   │  每个会话一个 OMP 进程（RPC 或终端，同一时间只有一个写入者）
OMP 18.4.3  ── 启动参数统一由 src/native/launch.ts 构造
   ├─ --plugin-dir presets/alpha-plugin                  30 个 Alpha Skill
   ├─ --append-system-prompt presets/alpha-identity.md   固定不变的身份与能力说明
   ├─ --config .alpha/native/alpha-settings.yml          每次启动生成：browser.cdpUrl 等
   ├─ --extension src/native/tianshu/extension.ts        天枢证据层
   ├─ --extension src/native/capabilities/extension.ts   alpha_office 与 ComfyUI 媒体工具
   └─ --resume <OMP 会话 ID>                              按会话显式恢复
        │
        │  OMP 原生 browser 工具 ──CDP──▶ Alpha 浏览器宿主（独立 Electron 进程，只承载智能体页面）
        │                                   └─ 截屏流送到工作台"浏览器"面板；"接管" = 宿主窗口来到前台
        │  OMP 原生 read ──▶ 按路径读取 docx / xlsx / pptx / pdf / epub
```

### 4.1 改动清单

**新增**

| 路径 | 作用 |
|---|---|
| `src/native/launch.ts` | 统一构造 OMP 的参数、环境变量、工作目录和生成的配置文件 |
| `src/native/tianshu/` | `extension.ts`、`state.ts`、`signals.ts`、`claims.ts`、`change-class.ts`、`render.ts`、`theme.ts`；取代 `tianshu-extension.ts` 和 `tianshu-cognition.ts` |
| `src/native/capabilities/` | `extension.ts`、`office/`（UNO 运行时、`office-worker.py`、`create`、`pdf`）、`comfyui/`；取代 `capabilities-extension.ts` |
| `desktop/browser-host.cjs` | Alpha 浏览器宿主 |
| `presets/alpha-plugin/` | `.claude-plugin/plugin.json`、`skills/<30 个>/SKILL.md`、`SOURCES.md` |
| `presets/alpha-identity.md` | 身份与能力说明 |
| `presets/terminal-themes/alpha-ink.json` | 终端主题 |
| `scripts/validate-skills.ts` | Skill 校验，取代 `validate-expert-packs.ts` |
| `test/native-launch`、`native-imports`、`native-capabilities`、`native-tianshu`（`.test.ts`） | 新增测试 |

**修改**：

- `src/native/server.ts`、`rpc-process.ts`、`configuration.ts`；
- `desktop/main.cjs`、`preload.cjs`；
- `desktop/ui/src/app/*`，包括 `NativeTerminal.tsx`；
- 打包与探针脚本；
- `AGENTS.md`、`README.md`、`docs/2026-09-29-omp-native-refactor.md`。

**删除**：删除前先打标签 `legacy-final`，Git 历史保留全部内容。

- 代码：`src/runtime/`、`src/server/`、`src/plugins/`（ComfyUI 部分迁入 `capabilities/`）、`src/cli.ts`、`src/server.ts`；
- 测试与脚本：非 `native-*` 的旧测试、调用旧 server 的 `scripts/probe-*`、专家相关脚本（`sync-core-experts`、`curate-experts`、`import-workbuddy-experts`、`probe-core-experts`、`validate-expert-packs`）；
- 专家包：`presets/agents/` 的人设、`index.json`、`roles.json`；
- 桌面：未挂载的旧组件与 `state/workbench.ts`；Electron 主进程中的 HTTP 桥、全局 CDP 端口和"产品预览"视图。

## 5. 内核接入

### 5.1 统一启动（`launch.ts`）

- 现状：OMP 的启动参数在 [rpc-process.ts:26](../src/native/rpc-process.ts:26) 和 [server.ts](../src/native/server.ts) 的终端分支各拼了一遍。
- 做法：由 `launch.ts` 一次性构造插件目录、身份说明、生成的配置、两个扩展、`--resume`，RPC 模式另加 `--mode rpc-ui`。RPC 和终端共用同一份构造结果。
- 生成的配置 `.alpha/native/alpha-settings.yml` 每次启动时写入，包括 `browser.cdpUrl`。如果 Skill 插件方式不符合预期，也在这里加上 `skills.customDirectories` 作为兜底。
- 环境变量只传 Alpha 扩展真正需要的；不传任何令牌或调试端口。
- 验收：`native-launch.test.ts` 断言两种模式的参数只在 `--mode` 上不同，并且环境变量里没有令牌。

### 5.2 身份说明（`alpha-identity.md`）

内容：名字是 Alpha；有哪些本机能力、各用什么工具；遇到行业任务先看有没有对应的 Alpha Skill；天枢提醒是基于运行证据的建议，由你判断。文件内不含日期、路径或会话变量，保证前缀稳定。

### 5.3 专家转 Skill

1. **合并规则**：每个专家的人设并入对应的主方法 `SKILL.md`。

   | 人设内容 | 去向 |
   |---|---|
   | 负责范围 | `description`（决定何时触发）+ 正文"适用范围" |
   | 事实原则、禁止事项、时效规则的核对要求 | 正文"原则与边界"一节 |
   | 判断偏好 | 工作步骤或验收依据 |
   | 虚构姓名、性格描写、"你是 Alpha 的…" | 删除 |
   | 交接、`handoff`、`next`、gate 声明 | 删除；需要时改写成一句普通建议 |

2. **description**：每条都写明在什么任务下使用，中英文关键词都要有。测一下 30 条合计的长度，确认上下文占用可以接受。
3. **挂载**：打包成 Claude 插件格式的目录，用 `--plugin-dir` 挂载。这种方式是进程级、追加式的，不写入用户的 `~/.omp`。**`--skills` 是按名称过滤的参数，不能用来挂载目录。**
4. **与能力对齐**：办公类 Skill（`craft-documents`、`build-slides`、`process-data`、`handle-documents`）和媒体相关 Skill 各加一节"工具用法"：写明用 `read`、`alpha_office` 的哪个动作，何时用 `preview` 自检，以及超出能力范围时如何上报缺口。没有工具支撑、也给不出备选做法的承诺，要么删掉，要么改成"说明限制"。
5. **独立复核**：`check-content-compliance` 正文写明"对外发布前，建议在独立子任务中复核，不要同一上下文自审"。只作建议，运行时不拦截。
6. **校验**：`validate-skills.ts` 检查以下内容：
   - frontmatter、篇幅、结构；
   - description 是否写明触发场景；
   - 是否含已退役的术语，如交接、工单、handoff、gate、alpha_plan（目前有 9 个 Skill 含这类术语）；
   - 办公和媒体类 Skill 是否含"工具用法"一节。
7. **验收**：
   - 新会话能发现 30 个 Alpha Skill，用户自己的 Skill 仍在；
   - "帮我审这条小红书文案"会读取合规 Skill 的正文；
   - 界面和发行包里不再出现"专家"。

## 6. 本机能力

### 6.1 统一约定

| # | 约定 | 含义 |
|---|---|---|
| C1 | 原生优先 | 读文档用 OMP `read`；浏览器自动化用 OMP `browser`；搜索和抓取用 `web_search`/`fetch` |
| C2 | 一种能力一个工具 | 办公能力合并为 `alpha_office`；工具名统一 `alpha_*`；参数结构化，不用 JSON 字符串 |
| C3 | 按路径进、按路径出 | 输入是项目内路径，或用户明确给出的路径；产出写在项目内，名字可读，永不覆盖原件；不再有附件 ID，也不在 `.alpha` 里存产物副本 |
| C4 | 统一返回 | `{ summary, artifacts: [{ path, kind, sha256, preview? }] }`；来源与哈希用 `appendEntry` 记进会话 |
| C5 | 看得见 | 每个产物在对话里是一张卡片：缩略图或页面预览、打开、在文件夹中显示；编辑类产物带前后对比 |
| C6 | 方法与能力对齐 | 见 5.3 第 4 条 |
| C7 | 边界在运行时 | 浏览器授权走 OMP 原生审批，或由扩展在 `tool_call` 上确认；令牌和调试端口不进入模型进程 |

### 6.2 浏览器：一个工具、一个可见浏览器

1. **浏览器宿主**：
   - 由 Electron 主进程拉起第二个 Electron 进程 `desktop/browser-host.cjs`，复用已打包的 Electron，不新增依赖。
   - 只在 `127.0.0.1` 随机端口开放 CDP。
   - 配置目录用 `.alpha/browser-profile/`，与桌面界面的配置分开。
   - 窗口默认隐藏，标题为"Alpha 浏览器"；Alpha 退出时宿主随之退出。
2. **收回暴露面**：
   - 删除桌面主进程的全局 `remote-debugging-port`（[main.cjs:18](../desktop/main.cjs:18)）；
   - 删除 HTTP 桥，包括其中的 `/secrets/*`（[main.cjs:195-213](../desktop/main.cjs:195)）；
   - 删除"产品预览"视图（[main.cjs:341](../desktop/main.cjs:341)）。
3. **接到 OMP**：生成的配置里把 `browser.cdpUrl` 指向宿主。`alpha_browser` 退役。允许访问 localhost，也就是本机开发服务器。
4. **授权**：每个会话第一次操作浏览器时，询问"允许 Alpha 在本会话中操作浏览器？仅这次 / 本会话 / 拒绝"；授权可以在面板或"本机能力"页撤销。优先用 OMP 原生审批按工具设定；如果不支持，由能力扩展在 `tool_call` 上确认。
5. **面板**：
   - 显示宿主中属于当前会话的标签页，按本会话 `browser` 调用中的标签名和 URL 关联。
   - 画面用 CDP `Page.startScreencast` 实时显示，只读。
   - 点"接管"，宿主窗口移到面板位置并带到前台，用户可以登录、过验证码；点"交还"，窗口重新隐藏，智能体继续使用同一登录状态。
6. **终端模式**：使用同一个宿主，面板照常显示。
7. **退路**：
   - 截屏流不理想时，面板退化为"标签列表 + 最新截图 + 显示窗口"；
   - 宿主不可用时，OMP 默认的无头浏览器照常工作，面板提示"当前为不可见模式"。
8. **验收**：
   - 模型只有一个浏览器工具；
   - 能打开 `http://localhost:5173`；
   - 模型执行的命令读不到任何 Alpha 令牌或调试端口；桌面界面不出现在任何 CDP 目标中；
   - 首次操作浏览器时弹出会话级授权；
   - 面板实时显示页面，接管后能手动登录，交还后智能体仍保持登录状态；
   - 关闭 Alpha 后宿主进程随之退出。

### 6.3 办公：按路径、一个工具、看得见

读取直接用 OMP 的 `read`。`alpha_office` 只负责 OMP 没有的部分：

| action | 做什么 | 引擎 |
|---|---|---|
| `inspect` | 列出可编辑地址：段落序号与样式、表格名与单元格、工作表与已用区域、幻灯片与形状，并标出不支持的结构 | LibreOffice UNO |
| `edit` | 按地址编辑：带期望值的文本替换，插入段落或标题，增加表格行，写入单元格区域（值或公式），增删或复制幻灯片，修改形状的文本或图片 | UNO |
| `create` | Markdown → docx 或 pdf（保留标题、列表、表格、粗体和斜体）；表格数据 → xlsx（表头样式、列宽、公式）；大纲 → pptx（每页标题加要点，可选版式） | docx/pdf：Markdown 转 HTML 后由 LibreOffice 导入；pptx：UNO Impress；xlsx：exceljs |
| `convert` | docx、xlsx、pptx、odf、html 与 pdf 之间互转 | `soffice --convert-to` |
| `pdf` | 合并、拆分、旋转、加水印、按页提取 | pdf-lib |
| `preview` | 把指定页渲染成 PNG，供模型自检和界面卡片使用 | UNO 导出，或渲染 PDF |

- **路径**：`edit` 输出 `<原目录>/<原名>.alpha-v<N>.<扩展名>`；`create` 和 `convert` 输出到 `outputs/<名称>.<扩展名>`；永不覆盖原件。
- **预览**：`edit`、`create`、`convert` 完成后自动附带预览，`edit` 附带前后对比。
- **参数**：`edit` 的操作在 schema 中定义为联合类型。
- **退役**：
  - 工具：`alpha_office_attach`、`alpha_office_read`、`alpha_office_status`（状态并入"本机能力"页和报错说明）、`alpha_document`；
  - 目录：`.alpha/task-inputs`、`.alpha/artifacts`；`.alpha/office-jobs` 改用系统临时目录，用完即删。
- **验收**：
  - 直接 `read` 项目里的 docx 就能读到内容；
  - "把报告第 3 段改成……并导出 PDF"：一次 `inspect`、一次 `edit`、一次 `convert`，产出都在项目里，对话中有前后对比卡片；
  - "按这份大纲做 8 页 PPT"：生成 pptx，卡片显示缩略图；
  - PDF 合并和加水印可用；
  - LibreOffice 缺失时，依赖它的动作返回明确的缺口说明，"本机能力"页显示原因；生成 xlsx 和 PDF 操作不受影响。

### 6.4 媒体（ComfyUI）

- `alpha_generate_image`、`alpha_generate_voice`、`alpha_generate_video` 三个工具保留，因为它们的输入差异较大。`alpha_comfy_status` 并入"本机能力"页。
- 三个工具统一采用 C3–C5 的约定：产出写到 `outputs/media/<可读名>.<扩展名>`，或写到用户指定的位置；不再写 `public/alpha-assets/`，也不再要求项目里有 `public/`。
- 保持不变的部分：不替用户启动 ComfyUI，不替换工作流，服务不可用时上报缺口。
- 验收：在非 Web 项目中生成图片成功，文件位于 `outputs/media/`，对话中显示卡片。

### 6.5 代码迁移

- 迁入 `capabilities/`：`office-runtime`、`scripts/office-worker.py`、`comfy-client`、`image/voice/video-tool`、`media-integrity`、`store-tag`。统一改用 OMP 18.4 的调用签名，删掉参数顺序垫片（[capabilities-extension.ts:45-47](../src/native/capabilities-extension.ts:45)）。
- 随 `alpha_browser` 一起退役：`browser-kernel`、`visible-browser`、`browser-bridge`、`research-source`、`web-retrieval`、`web-permissions`。牵出旧账本的那条依赖链因此消失。
- 由 `alpha_office create` 取代并退役：`document-tool`。
- 验收：
  - `native-imports.test.ts` 断言从三个入口出发的导入闭包只包含 `src/native/**`；
  - `native-capabilities.test.ts` 覆盖工具注册、工具名、参数 schema 和路径规则。

## 7. 天枢：长进 OMP

原则：**读 OMP 原生事件，写 OMP 原生会话和面板，配合 OMP 原生机制。** 不另开存储，不另开通道，不拦截工具，不自行开启新一轮。

1. **观测**：监听以下事件：
   - `message_end`、`turn_end`；
   - `tool_call`（取文件路径与命令）、`tool_result`；
   - `goal_updated`、`todo_reminder`，以及 todo 工具的结果；
   - `session_compact`、`retry_fallback_applied`；
   - `session_start`、`session_switch`、`session_branch`、`session_tree`。
2. **状态进会话**：状态变化时写入 `pi.appendEntry("alpha-tianshu", 快照)`；会话开始、切换、分叉或切换会话树节点时，从当前分支的条目重建。删除 `.alpha/native/cognition/*.json` 和 `ALPHA_COGNITION_FILE`。
3. **变更分类**：改编天枢的 `change-classification.ts`。只有代码或测试文件的变更，以及改动工作树的 git 操作，才算"代码变异"；文档、README、本地化文件的写入不算。修改类工具名集中为常量：`edit`、`ast_edit`、`write`。
4. **信号**：

   | 信号 | 触发 | 解除 | 对谁 |
   |---|---|---|---|
   | 重复失败 | 同一错误签名连续 ≥ 2 次 | 同类调用成功 | 模型 + 状态栏 |
   | 改后未验证 | 发生代码变异 | 变异之后测试、类型检查或 lint 成功 | 模型 + 状态栏 |
   | 宣称与证据不符 | 本轮结束时，最后一条回复宣称"全绿""N/N 通过""已修复""typecheck 干净"，但没有晚于最后一次代码变异的对应验证 | 补上验证 | 用户（对话内可见）+ 下一轮模型 |
   | 待办与验证脱节 | 待办全部完成，但仍有改后未验证 | 验证完成 | 模型 + 状态栏 |
   | 压缩后重锚 | 发生 `session_compact` | 发出一次即解除 | 模型 |
   | 模型降级 | `retry_fallback_applied` | 恢复原模型 | 仅状态栏 |
   | 上下文占用 | 始终显示 | 无 | 仅状态栏 |

   "宣称与证据不符"改编自天枢的 `claim-audit.ts`，是天枢"模型之外的第二套价值函数"的核心。宣称要分类型对账：测试宣称要有测试类验证背书，类型检查宣称要有类型检查类验证背书，二者不能互相代替。在 Alpha 里它只作提醒，不拦截。

   验证命令的识别范围从现有的 `bun/npm/pnpm/yarn/cargo/go/pytest` 扩充到 `tsc`、`vitest`、`jest`、`ruff`、`mypy`、`cargo clippy`、`dotnet test`、`mvn test`、`gradle test`。
5. **投递**：
   - 信号新出现或升级时，才发一条持久消息 `pi.sendMessage({ customType: "alpha-tianshu", display: true, … })`。
   - 流式进行中用 `deliverAs: "aside"`，空闲时一律用 `"nextTurn"`，因为 `aside` 在空闲时会自行开启一轮。
   - 条件持续期间不重复注入；面向模型的文字不带证据哈希，写"由你判断"；证据放在 `details` 里。
6. **压缩协同**：`session_compact` 之后，下一轮投递一次重锚消息，内容是当前目标、未完成的待办、未解决的验证债和宣称问题。不再建议模型"压缩"，因为模型没法自己执行压缩。
7. **面板**：
   - `setStatus("tianshu", …)`：终端页脚与桌面顶栏共用；
   - `registerMessageRenderer("alpha-tianshu", …)`：提醒带专属竖条，与 OMP advisor 的样式区分；
   - `registerCommand("tianshu")`：展开当前证据帧（事实、信号、证据来源、测量质量）。
8. **许可**：改编代码的文件头注明来源文件和 Apache-2.0；`licenses/Tianshu-APACHE-2.0.txt` 已有，另补一份 NOTICE。
9. **验收**：`native-tianshu.test.ts` 覆盖以下场景：
   - 写 `.md` 不产生验证债；
   - 宣称"全绿"但没有新鲜的测试证据时，产生提醒；
   - 类型检查不能背书测试宣称；
   - 分叉后状态随分支回退；
   - 空闲时不开启新一轮；
   - 压缩后只重锚一次。

## 8. 界面

### 8.1 终端：外观不同、操作相同

- **主题**：
  - "墨·深"主题 `alpha-ink`，色值取自 [纸墨风格](ui-paper-ink-style-2026-09-27.md)，与内嵌终端底色 `#25231f` 对齐；`NativeTerminal.tsx` 的 xterm 16 色 ANSI 调色板改成同一套。
  - 只有当用户的 OMP 主题设置仍是默认值时才启用：sidecar 通过 `NativeConfiguration` 读取主题设置的来源，只在"未设置"时传入 `ALPHA_TERMINAL_THEME=1`。
- **页眉**：`setHeader` 换成一行：`α Alpha · 天枢`、模型与思考强度、项目目录、会话名。
- **标题**：`setTitle("Alpha · <会话名>")`。
- **状态段**：由第 7 节提供，例如 `天枢 ✓`、`天枢 · 改后未验证`、`天枢 · 宣称待证`。
- **命令**：`/tianshu`；`/alpha`，显示已装的 Alpha Skill、本机能力状态和版本。
- **入口**："切换到原生终端"改名为"Alpha 终端"。
- **验收**：
  - 第一眼能看出不是原版 OMP；
  - 快捷键与 OMP 相同；
  - 用户换过主题后，Alpha 不再覆盖；
  - 16 色终端下正常显示。

### 8.2 桌面：样式不变，只改内容和接线

- **身份文案**：
  - 助手署名改为 Alpha；
  - "原生会话"改为"会话"；
  - "旧任务 · 只读"改为"旧版任务"，默认折叠；
  - "用 OMP 继续"改为"继续这个任务"；
  - 弹窗里的"OMP"改为"Alpha"；
  - 品牌副标题改为 `Alpha · 天枢`；
  - OMP 版本移到"关于"。
- **更新横幅**：改为"OMP 内核有新版本 x（当前 y），升级需在开发环境中进行"。
- **对话流**：
  - 工具调用显示为可折叠行（工具名、参数摘要、成功或失败、耗时）；
  - 自动压缩和自动重试各显示一行说明；
  - 产物显示为卡片（C5）；
  - `alpha-tianshu` 提醒以天枢样式显示在对话里。
- **顶栏**：显示天枢状态段，即 RPC 转发的 `setStatus`。`setWidget` 的字符串行显示在输入框上方。
- **右栏**：
  - 撤掉"认知" tab；
  - "浏览器"按 6.2 第 5 条实现；
  - "文件"保留；
  - "日志"只留作诊断，默认隐藏。
- **设置**：
  - "本机能力"页：Office 引擎、浏览器宿主、ComfyUI 的状态和"检测"按钮，以及当前会话的浏览器授权与撤销；
  - 只读的"技能"页；
  - "关于"页：Alpha 版本、OMP 版本与许可、天枢来源与许可。
- **代码结构**：`NativeApp` 拆成 `Sidebar`、`Home`、`Thread`、`Workspace`、`Dialogs` 和 `useSession`。
- **验收**：
  - 从首页到对话，界面上只出现 Alpha 这一个产品名，天枢只出现在状态段、提醒和关于页；
  - 终端和桌面显示相同的天枢状态；
  - Office 编辑的前后预览能在对话中打开；
  - 视觉样式与 0.1.1 相同。

## 9. 会话、进程与边界

- **会话**：
  - 首次连接后用 `get_state` 读取 `sessionId`、`sessionFile`、`sessionName` 并记录下来；之后用 `--resume <sessionId>` 显式恢复。
  - `sessions.json` 只保存界面元数据和旧任务映射；标题在首轮之后改用 OMP 的会话名。
  - 是否改用 OMP 默认会话目录（让 `omp --resume` 也能看到 Alpha 的会话），放到最后单独决定。
- **进程**：
  - 没有事件流订阅、已空闲、且超过 10 分钟的 OMP 进程自动停止；
  - 同时存活的进程最多 4 个，按最近使用淘汰；
  - GET 请求不再拉起进程，改由显式的 POST `/open` 拉起。
- **默认工作目录**：改为 `<工作区>/workspace`（安装版为 `%LOCALAPPDATA%\Alpha\workspace`）；`.alpha/` 不再位于任何默认工作目录之下。
- **本地接口**：Electron 每次启动生成一个令牌传给 sidecar，所有 `/api` 请求都必须带上；`Host` 只能是 `127.0.0.1:<端口>`。
- **更新检查**：先启动服务，再在后台检查更新，结果到了再显示横幅。
- **验收**：
  - 在同一进程内新建或分叉会话后，下次打开仍回到 Alpha 记录的会话；
  - 连续打开 10 个会话，常驻进程不超过 4 个；
  - 默认工作目录里看不到 `.alpha`；
  - 不带令牌或 `Host` 不对的请求返回 403；
  - 断网时启动不再额外等待。

## 10. 实施计划

### 10.1 里程碑

| 里程碑 | 内容 | 粗估 |
|---|---|---|
| **M0 安全补丁（可单独发 0.1.2）** | 能力扩展读取桥接令牌和 CDP 端口后，立即从 `process.env` 中删除，并冒烟确认模型执行的命令读不到它们；删除桥上的 `/secrets/*`。全局 CDP 端口的残余风险留到 M2 消除 | 0.5 天 |
| M1 地基 | 打标签 `legacy-final` 并记录基线；5.1、5.2；6.5；9 中的默认工作目录 | 2–3 天 |
| M2 本机能力 | 6.2、6.3、6.4。浏览器先做两天的截屏流与接管原型；不理想就采用 6.2 第 7 条的退路 | 5–7 天 |
| M3 长在一起 | 5.3 专家转 Skill（含与能力对齐）；第 7 节天枢 | 3–4 天 |
| M4 看得见的一体 | 8.1 终端；8.2 桌面 | 3 天 |
| M5 收尾 | 第 9 节其余部分；删除旧代码；打包与探针；文档；发版 0.2.0 | 2 天 |

合计约 16–20 个工作日。每个里程碑单独提交或开 PR；M1 完成前不删除任何旧代码。

### 10.2 文档与规则同步（M5）

- `AGENTS.md`：
  - 第 1 节写明专家已取消、方法以 Skill 随包发行；
  - 第 3 节改为 Skill 编写规范（输入与前置阅读、工作步骤、交付物、验收与缺口处理、原则与边界、工具用法）；
  - 第 4 节的来源路径改为 `presets/alpha-plugin/SOURCES.md`；
  - 第 6 节换成新的校验命令；
  - 按惯例在文内留痕。
- `README.md` 与 [原生 OMP 重构](2026-09-29-omp-native-refactor.md)：更新到 0.2.0 的架构和能力。
- 发行说明与归档：按 [发行归档](2026-09-29-release-archive.md) 的做法归档 0.1.1。

### 10.3 总验收清单

- [ ] 导入闭包只包含 `src/native/**`；发行包里没有旧任务系统和专家包。
- [ ] 30 个 Alpha Skill 能被发现，用户自己的 Skill 仍在；办公和媒体类 Skill 写明了工具用法；界面和发行包中不再出现"专家"。
- [ ] 浏览器：只有一个浏览器工具；能打开本机开发服务器；模型进程读不到令牌或调试端口，桌面界面不在 CDP 目标中；面板可以实时查看、接管和交还。
- [ ] 办公：直接 `read`；`inspect` → `edit` → `convert` 整条链可用，不覆盖原件；能生成 pptx、docx、pdf、xlsx；PDF 合并和加水印可用；产物有卡片。
- [ ] 媒体：产出在 `outputs/media/`，不依赖 `public/`。
- [ ] 天枢：写文档不报验证债；无证据的"全绿"会被提醒；分叉后状态正确回退；空闲时不开启新一轮；压缩后只重锚一次。
- [ ] 终端一眼可辨是 Alpha，操作与 OMP 相同，不覆盖用户主题。
- [ ] 桌面只出现 Alpha 这一个产品名；工具过程和产物在对话中可见；终端与桌面的天枢状态一致；视觉样式与 0.1.1 相同。
- [ ] 会话按 ID 恢复；进程有上限；默认工作目录中没有 `.alpha`；本地接口需要令牌。
- [ ] `bun run check`、`bun run test`（含 `native-launch`、`native-imports`、`native-capabilities`、`native-tianshu`）、`validate-skills`、打包探针全部通过。

### 10.4 风险与回退

| 风险 | 应对 |
|---|---|
| OMP 升级后扩展 API 变化 | 锁定 18.4.3；只使用公开类型；升级前先跑 `native-*` 测试 |
| 插件方式加载 Skill 的命名或启用状态不符合预期 | 在生成的配置中设置 `skills.customDirectories` |
| 截屏流卡顿或接管体验不好 | 面板退化为"标签列表 + 最新截图 + 显示窗口" |
| `browser.cdpUrl` 连接模式与宿主不兼容 | 退回 OMP 默认的自启动浏览器（`browser.headless=false`）；面板只显示标签列表和截图 |
| LibreOffice 导入 HTML 生成 docx 时中文排版有偏差 | docx 改用 docx 库直接构建结构，PDF 仍由 LibreOffice 从 docx 转出 |
| 天枢提醒过多 | 边沿触发 + 每类信号设冷却时间；保留 `ALPHA_CVM_MODE=shadow/off` |
| 会话条目膨胀 | 只在状态变化时写入，快照只保留摘要字段 |
| 旧任务数据 | 保留 `.alpha/tasks` 的只读列表和"继续这个任务"；这部分不依赖旧运行时 |
| 整体回退 | 标签 `legacy-final`；每个里程碑可以单独回滚 |

## 11. 已核实的事实与待确认事项

### 11.1 已核实（2026-09-30）

1. `--skills a,b` 是按名称过滤（`skills.includeSkills`），**不是路径参数**。
2. `--plugin-dir <目录>` 按 Claude 插件格式（`.claude-plugin/plugin.json`、`skills/`、`commands/`）注入额外的根目录，进程级、追加式。
3. `--config <文件>` 叠加一份配置文件，可以设置 `skills.customDirectories`、`browser.cdpUrl` 等。
4. 扩展事件 `resources_discover` 在类型中有定义，但 18.4.3 中没有调用点，不能依赖。
5. RPC 模式转发 `setStatus`，`setWidget` 只转发字符串数组；`setHeader`、`setFooter`、`setTheme` 在 RPC 下不生效；`setTitle` 需要设置 `PI_RPC_EMIT_TITLE=1` 才转发。
6. `get_state` 返回 `sessionId`、`sessionFile`、`sessionName`；`--resume <id>` 和 `--session <id|路径>` 可恢复指定会话。
7. 编辑类内置工具是 `edit`、`ast_edit`、`write`，没有 `apply_patch`。另有 `todo`、`goal` 工具，以及 `goal_updated`、`todo_reminder` 事件。
8. `sendMessage` 的 `deliverAs: "aside"` 在会话空闲时会自行开启一轮。
9. 主题来源是内置主题加 `<agentDir>/themes/*.json`；`setTheme(名称)` 只对当前会话生效，不持久化。
10. OMP 自带模型顾问（`advisor.enabled`，默认关闭），使用 `<advisory severity=…>` 格式和终端专属竖条样式。
11. OMP `read` 通过 markit 按路径把 docx、xlsx、pptx、epub、pdf 转成 Markdown。
12. OMP `browser` 工具默认启用，默认无头；支持启动浏览器、连接 `browser.cdpUrl`、附着应用和 relay；动作有 `open`、`close`、`run`、`call`、`tabs`。
13. Alpha 对整个 Electron 进程开放 `remote-debugging-port`；桥接令牌和 CDP 端口经 sidecar 原样传入 OMP 子进程；桥上仍有 `/secrets/(tavily|firecrawl)` 的解密读取接口。
14. 办公类 Skill 没有提到任何 Alpha 工具；ComfyUI 工具的产出写入 `<项目>/public/alpha-assets/`。
15. 天枢源码中可以直接改编的：`src/agent/claim-audit.ts`（181 行）和 `src/agent/change-classification.ts`（350 行）。

### 11.2 实施时当场确认

- 模型执行的命令能否读到 `ALPHA_BROWSER_BRIDGE_TOKEN`，以及 M0 删除环境变量后是否确实读不到。
- OMP 审批能否按工具设定；扩展能否在 `tool_call` 中拦截并确认。
- `browser.cdpUrl` 模式下，OMP 是复用宿主已有的页面还是新建标签页；标签名能否用来关联会话。
- 插件内 Skill 的命名方式（是否带命名空间前缀），以及是否默认启用。
- 18.4.3 的 `setTheme` 能否直接接受主题对象；不能的话，把带 `alpha-` 前缀的 JSON 放进 `<agentDir>/themes/`。
- `session.compacting` 能否让扩展往摘要材料里追加内容；能的话，优先用它做压缩协同。
- 扩展能否主动请求 OMP 模型顾问复核。能的话，就形成"天枢便宜地盯，信号升级时再请模型顾问"的分层。
