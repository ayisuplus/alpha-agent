# Alpha 定版收束建议（2026-09-30）

状态：**诊断与建议，已整合进 [最终重构方案](2026-09-30-final-refactor-plan.md)**。实施以最终方案为准，本文保留为诊断和证据来源。

> 更正（2026-09-30）：本文 P0-2 第 3 步写的 `--skills <目录>` 是错的。`--skills` 是按名称过滤的参数，挂载 Skill 目录应使用 `--plugin-dir` 或 `--config` 设置 `skills.customDirectories`，见最终方案第 7 节。

> 修订（同日）：用户确认最终方向为**退回原生 OMP**；**取消专家，专家内容转化为 Skill**。本文已按此修订：删除"人设转 task agent""按专家选模型"等内容；composable 方案与主线化、计划图方案一律归档为历史材料。

依据：2026-09-30 对当前分支 `ui/workbench-settings`（`cefc87e`）的代码阅读，范围为 `src/native/`、`desktop/ui/src/app/`、`presets/agents/`、`README.md` 与 `docs/`。本文只提建议，不改代码；涉及删除文件的条目需用户另行确认（AGENTS.md 第 2 节）。

---

## 0. 一句话诊断

拼接感不是某个模块写得差，而是三件事叠在一起：

1. **产品在用零件的名字说话。** 首页说"我是 Alpha"，对话里回答的是"OMP"，侧栏写"OMP · 天枢认知"，右栏默认展示"efe / sensorium / pal: missing"。用户看到的是三个主体在接力，而不是一个产品。
2. **最有价值的沉淀没有装上去。** 30 个专家背后的行业方法（合规、平台运营、科研统计、办公文档……）是 Alpha 相对裸 OMP 的主要增量，但目前完全没有接入原生入口；真正在跑的只有 OMP 内核、三条运行提醒和几个本机工具。

3. **天枢和 OMP 是并排运行，不是长在一起。** 天枢只看两类事件、写自己的文件、在上下文末尾悄悄附加一句话；OMP 原生的目标、待办、压缩、顾问和界面面板它都没接上，所以终端里看不到天枢，外观和原版 OMP 一模一样（第 8 节）。

好消息是：这三件事都不需要再改架构。OMP 18.4.3 原生支持 `--skills`、`--append-system-prompt` 和 `.omp/skills` 目录发现，而 30 个 `SKILL.md` 已经带有 `name`/`description` frontmatter。取消专家、把方法并入 Skill，正好可以用原生机制接回；身份问题主要是文案和信息层级问题。

## 1. 接缝清单（带证据）

| # | 接缝 | 表现 | 位置 |
|---|---|---|---|
| S1 | 身份分裂 | 助手消息署名"OMP"；品牌副标题"OMP · 天枢认知"；弹窗"OMP 请求打开网页""OMP 需要输入"；侧栏"原生会话""用 OMP 继续" | [NativeApp.tsx:36](../desktop/ui/src/app/NativeApp.tsx:36)、[:255](../desktop/ui/src/app/NativeApp.tsx:255)、[:260](../desktop/ui/src/app/NativeApp.tsx:260)、[:297-298](../desktop/ui/src/app/NativeApp.tsx:297) |
| S2 | 方法资产离线 | `presets/agents/` 里 30 个人设和 30 个 Skill 没有被原生 RPC 或 TUI 装载，打包也不带；AGENTS.md 第 3、4、6 节仍按"专家包"约束它们 | [rpc-process.ts:26](../src/native/rpc-process.ts:26) 只挂两个扩展；`src/native/` 中没有任何对 `presets/agents` 的引用 |
| S3 | "天枢"名大实小 | 实际只有三条启发式：重复失败、改后未验证、上下文占用 80%。右栏默认 tab 展示内部质量字段和三个 `missing`；验证命令只认 `bun/npm/pnpm/yarn/cargo/go/pytest` 的 test/check/build，漏掉 `tsc`、`vitest`、`jest`、`ruff`、`mypy`、`dotnet test`、`mvn`/`gradle` 等；修改只认 `edit/write/apply_patch` 三个工具名 | [tianshu-cognition.ts:75](../src/native/tianshu-cognition.ts:75)、[:85](../src/native/tianshu-cognition.ts:85)、[NativeApp.tsx:289](../desktop/ui/src/app/NativeApp.tsx:289) |
| S4 | 本机能力是挂上去的 | 原生扩展从旧目录 `src/runtime/`、`src/plugins/` 引用模块，并用参数顺序垫片适配旧签名；工具命名有三套风格（`alpha_office_*`、`alpha_browser`、ComfyUI 与文档工具各自的名字）；产物（Office 前后预览、截图、生成媒体）落在 `.alpha/` 下，界面看不到 | [capabilities-extension.ts:6-10](../src/native/capabilities-extension.ts:6)、[:45-47](../src/native/capabilities-extension.ts:45) |
| S5 | 执行过程和对话割裂 | 对话只渲染文本；工具调用、自动压缩、重试只在"日志" tab 里以 `tool_execution_start: bash` 这样的原始帧名出现 | [NativeApp.tsx:275](../desktop/ui/src/app/NativeApp.tsx:275) |
| S6 | 界面是一个大组件，旁边还有一整套旧界面 | `NativeApp` 约 300 行、30 多个 `useState`；`App.tsx`、`Thread.tsx`、`PlanGraph`、`ExpertPicker`、`AutomationsView`、`EvidenceView`、`state/workbench.ts`（834 行）仍在 `src` 中但未挂载 | `desktop/ui/src/main.tsx` 只挂 `NativeApp` |
| S7 | 两套会话事实源 | Alpha 的 `sessions.json` 和 OMP 会话目录并存；标题默认是目录名，没有使用 OMP 的会话名 | [server.ts](../src/native/server.ts) `createSession` |
| S8 | 叙事接缝 | README 约八成篇幅是"旧版说明"；`docs/` 约 40 份文档大多已被取代；未跟踪的 [alpha-composable-agent-2026-09-29.md](archive/alpha-composable-agent-2026-09-29.md) 自称"最终方案"，方向（节点级编排、"智能体工作的 ComfyUI"）与同日"退回原生 OMP"的决定相反，两份"最终"并存 | `README.md`、`docs/` |
| S9 | 更新提示的"我"指代不清 | 横幅写"请告诉我'更新 Alpha 的 OMP'"，但对话里的智能体工作在用户的项目目录里，实际升级流程是在开发环境中另行处理 | [NativeApp.tsx:266](../desktop/ui/src/app/NativeApp.tsx:266) |

## 2. 收束原则（只用于定版）

1. **一个产品名，一个自己的层。** 产品名只有 Alpha。天枢是 Alpha 自己的证据与自检层，在它起作用的地方（状态栏、提醒消息、`/tianshu`）以"天枢"之名出现；OMP 只作为引擎在"关于"页致谢。（2026-09-30 按用户意见修订：Alpha 不能看起来和 OMP 一模一样，天枢是区别所在，见第 8 节。）
2. **一句能被界面印证的价值句。** 建议定版用：「Alpha：带行业方法和本机工具的桌面智能体，模型厂商随你选。」界面上的每个元素都应能指回这句话里的某个词；指不回去的，就降级或收起来。
3. **零件不自称。** 扩展和模块不向用户暴露内部状态（`mode active`、`turn`、`missing`、原始帧名）。
4. **资产用原生机制接回，不新造运行时。** 方法只以 OMP Skill 的形式存在，流程模板接 OMP 的提示模板或斜杠命令；不再有"专家"这一层概念。
5. **定版不做架构翻修。** 以下建议都是接线、文案、渲染和归档层面的改动。

## 3. 建议

按性价比排序。P0 建议在定版前完成，P1 可以随定版带上，P2 放到定版之后。工作量为粗估。

### P0-1 统一身份与语言（约半天）

- 助手消息署名改为"Alpha"；品牌副标题改为用户语言，例如"本机智能体"。
- "原生会话"改为"会话"；"旧任务 · 只读"改为"旧版任务"，默认折叠；"用 OMP 继续"改为"继续这个任务"；弹窗里的"OMP"一律改为"Alpha"。
- OMP 版本和许可证移到"设置 → 关于"；天枢保留在界面上，但只出现在它真正起作用的位置（第 8 节）。
- 用 `--append-system-prompt <文件>` 给模型一段**固定不变**的身份与能力说明：名字、可用的本机能力，以及"遇到行业任务先看有没有对应的 Alpha Skill"。文件内容不带日期、路径或会话变量，保证前缀稳定、缓存可命中。RPC 和 TUI 两个入口用同一个文件。

### P0-2 取消专家，方法并入 Skill（约 1–2 天）

现状：30 个专家各有一份人设 `.md` 和一个主方法 `SKILL.md`，两者一一对应；`SKILL.md` 已有 `name`/`description` frontmatter，基本符合 OMP 的 Skill 格式。人设里真正有价值的不是虚构姓名和性格，而是**负责范围、事实原则和禁止事项**（例如合规审核里的"以官方现行文本为准，注明来源和生效日期""不提供规避审核、伪造资质、洗稿的方法"）。

1. **合并**：每个专家的人设按下表拆解，并入对应的 `SKILL.md`，人设文件本身不再发行。

   | 人设内容 | 去向 |
   |---|---|
   | 负责范围 | 并入 `description`（决定何时触发）和正文开头的"适用范围" |
   | 事实原则、禁止事项、时效规则的核对要求 | 并入正文，作为"原则与边界"一节 |
   | 判断偏好（例如"拿不准就标待核"） | 并入工作步骤或验收依据 |
   | 虚构姓名、性格描写、"你是 Alpha 的…" | 删除 |
   | 交接边界、`handoff`、`next`、gate 声明 | 删除；需要时改写成一句普通建议，例如"对外发布前建议先用 check-content-compliance 复核" |

2. **description 是唯一的入口**：OMP 平时只把 Skill 的描述放进上下文，模型据此决定是否读取正文。取消专家以后，description 的质量直接决定方法会不会被用上，所以每条都要写清楚"在什么任务下使用"，中英文关键词都要有。同时测一下 30 条描述的总长度，确认对上下文的占用可以接受。这也延续了"方法不常驻主池、用到才读正文"的初衷。
3. **挂载**：启动 RPC 和 TUI 时都加 `--skills <appRoot>/presets/skills`（目录名见第 5 点）。发行包自带这些 Skill，不写入用户全局的 `~/.omp`。动手前先核实：`--skills` 是在原生发现的基础上**追加**，还是会**替换**原生发现；如果是替换，要保留用户自己的 Skill。
4. **独立复核的自然形态**：`check-content-compliance` 正文里写明"对外发布前，建议在独立的子任务中复核，不要在同一上下文里自审"。这由 OMP 原生的 task 子代理承担，属于软约定，运行时不做拦截。
5. **目录与配套清理**（移动和删除需用户确认）：
   - `presets/agents/skills/` → `presets/skills/`，`SOURCES.md` 随迁。
   - 退役：人设 `.md`、`index.json`、`roles.json`，以及 `scripts/sync-core-experts.ts`、`curate-experts.ts`、`import-workbuddy-experts.ts`、`probe-core-experts.ts`。
   - 改写：`validate-expert-packs.ts` 改为 `validate-skills.ts`，只校验 frontmatter、篇幅、结构，以及 description 是否写明触发场景；`test/agent-presets.test.ts` 同步改写或退役。
   - 界面：删除 `ExpertsSettings`、`ExpertPicker` 等旧组件；设置里加一个只读的"技能"列表，显示名称、描述和来源。启停功能放到 P1。
6. **AGENTS.md 同步改写**：第 3 节"专家与 Skill 编写规范"改为"Skill 编写规范"（输入与前置阅读、工作步骤、交付物、验收与缺口处理、原则与边界）；第 4 节"事实与合规"保留，来源记录路径改为 `presets/skills/SOURCES.md`；第 6 节的验证命令换成新的 Skill 校验。按惯例在文内留痕。

### P0-3 天枢做实、做成 Alpha 的辨识度（约 2 天）

原建议是"改名降调"，已按用户意见撤回：天枢不该变小，而应该名实相副，同时成为 Alpha 和原版 OMP 在外观上的区别。完整方案见第 8 节，其中 8.2 顺带解决了 A5。

### P0-4 工具过程进入对话流（约 1 天）

这是"像一个产品"最直观的一项改动。

- 在对话中把 `toolCall`/`toolResult` 渲染成可折叠的行：工具名、参数摘要、成功或失败、耗时。自动压缩和自动重试也用一行说明展示。
- "日志" tab 只留作诊断用，默认不显示。
- Office 编辑、导出、截图、ComfyUI 生成返回的产物路径，在对话里渲染成可以点开的卡片（PDF 预览、图片、音频、视频）。能力是否"长在产品里"，取决于用户能不能看到它的产出。

### P1-1 本机能力收拢成一个模块

- 把原生扩展实际依赖的旧模块（`browser-bridge`、`browser-kernel`、`document-tool`、`office-runtime`、`plugins/comfyui`）迁到 `src/native/capabilities/`，改成 18.4 的签名，删掉参数顺序垫片。
- 工具统一使用 `alpha_*` 前缀，统一返回 `{ summary, artifacts: [{ path, kind, preview? }] }`，这样 P0-4 的卡片可以用同一套渲染。
- 设置里加"本机能力"页：Office 引擎、浏览器桥接、ComfyUI 三个状态，并各带一个"检测"按钮（已有 `officeRuntimeStatus`）。这样能力缺口在用户视角可见，不必等模型调用失败才发现。
- 迁完之后，`src/runtime/`、`src/server/` 以及对应的旧测试就没有运行入口引用了，可以整体归档（Git 历史中已有）。**删除或移动前需用户确认。**

### P1-2 界面拆分与清理

- 把 `NativeApp` 拆成 `Sidebar`、`Home`、`Thread`、`Workspace`、`Dialogs`，再加一个 `useSession` hook 统一处理 state、messages 和事件流。
- 未挂载的旧组件和 `state/workbench.ts` 移到归档目录或删除（**需用户确认**）。其中 `Greeting`、`Halftone`、`NewTask.css` 仍在使用，必须保留。

### P1-3 会话单一事实源

- 首轮对话结束后，标题改用 OMP 的会话名；`sessions.json` 只保存 `cwd` 和 `legacyTaskId` 的映射。

### P1-4 文档与叙事收束

- **已完成（2026-09-30）**：README 只保留当前版本，旧版正文移到 [archive/README-legacy.md](archive/README-legacy.md)；32 份被取代的方案、施工和评测记录移入 [docs/archive/](archive/README.md)，每份文件头加了归档说明，正文和历史数字没有改动，相对链接已修正。`docs/` 只保留当前的 6 份文档。
- AGENTS.md 第 1 节把"原专家包源码保留作历史材料"改为"专家已取消，方法以 Skill 随包发行"。

### P1-5 更新提示改写

- 改为"OMP 内核有新版本 x（当前 y）。升级需在开发环境中进行，步骤见 …"。不再让对话里的智能体扮演升级者。

### P2 定版之后

- **验证 Skill 的价值**：用现有 `eval/` 挑几个内容和合规任务，在同一模型下对比"挂载 Alpha Skill / 不挂载"。有差距，就说明这些方法是 Alpha 的实在增量；没差距，就优先改 description 和正文，不要加机制。
- **流程模板**：用 OMP 的提示模板或斜杠命令保存可复用的流程，不自建图引擎。
- **旧版任务**：导入量不大时，可以提供一次性"转成会话草稿"后隐藏旧版列表。

## 4. 不建议做的

- 不要为了消除拼接感再造编排层、计划图或专家调度器。用"模型强一倍"检验：模型越强，这些东西越多余。
- 不要把天枢扩展成拦截器或准入门控；它保持"只建议"的定位才与原生内核兼容。
- 不要在定版前追新 OMP 版本；先把 18.4.3 上的接线做干净。
- 不要把 373 个原生设置当作主界面；设置页保留"常用"一组即可，其余收进"高级"。

## 5. 定版验收清单

- [ ] 从首页到对话，界面上只出现"Alpha"一个主体名；OMP/天枢只出现在"关于"页。
- [ ] 新会话能发现 30 个 Alpha Skill，用户自己的 Skill 仍在；一个"帮我审这条小红书文案"的请求能自动读取 `check-content-compliance` 正文，读取过程在对话中可见。
- [ ] 界面和发行包里不再出现"专家"概念；AGENTS.md 已改为 Skill 规范并留痕。
- [ ] 工具调用在对话流中可见；Office 编辑产出的前后预览能在界面中打开。
- [ ] "本机能力"页三项状态可见，并能手动检测。
- [ ] `bun run check`、`bun run test`、新的 Skill 校验、打包探针全部通过；发行包包含 `presets/skills/`。
- [ ] README 首屏只描述当前版本；`docs/` 中没有两份互相矛盾的"最终方案"。

## 6. 建议顺序

| 顺序 | 项 | 粗估 | 依赖 |
|---|---|---|---|
| 1 | P0-1 身份与语言 | 0.5 天 | 无 |
| 2 | P0-3 天枢做实 + 终端辨识度（第 8 节） | 2 天 | 先核实 RPC 是否转发 setStatus / setWidget |
| 3 | P0-4 工具进对话 | 1 天 | 无 |
| 4 | P0-2 专家并入 Skill | 1–2 天 | 先核实 `--skills` 是追加还是替换原生发现 |
| 5 | P1-1 能力模块 + 能力页 | 1–1.5 天 | P0-4 的卡片渲染 |
| 6 | P1-2/3/4/5 清理与文档 | 1 天 | 删除和移动需用户确认 |

P0 合计约 3–4 天，做完后"拼接感"的主要来源（S1、S2、S3、S5）就消除了；P1 解决的是维护层面的接缝（S4、S6、S7、S8、S9）。

## 7. 按最终方向复查架构（2026-09-30）

前提：执行内核是原生 OMP，专家已取消、方法以 Skill 发行，Alpha 自己只保留桌面工作台、运行提醒和本机能力三层。按这个前提逐层检查，下面是仍不合理的地方，按严重程度排序。

### A1（高）原生入口仍然带着整个旧任务系统

`src/native/` 本身约 900 行，但从三个入口（server、两个扩展）出发的导入闭包有 **63 个文件、约 8,800 行**，其中约 57 个文件在 `src/runtime/` 和 `src/plugins/`。牵出旧系统的是这一条链：

`capabilities-extension` → `runtime/browser-kernel` → `research-source` → `web-permissions` → `task-ledger` → `task-events/*`、`experts`、`expert-package`、`planning-policy`、`work-orders`、`agent-mailbox`、`sandbox-exec`、`plugins/mcp`、`plugins/third-party` ……

后果有三：

- 打包脚本"只复制可达源码"，所以旧账本、专家、计划器实际上仍在发行包里。
- 只要这条链还在，`src/runtime/` 就无法归档；"专家已取消"在代码层面也不成立（`experts.ts` 仍会被加载）。
- 浏览器读取授权沿用旧的"任务账本 ID"模型，而原生路径传进去的是 Alpha 会话 ID。这条路径在原生模式下的行为没有测试覆盖。

建议：把浏览器、Office、文档、ComfyUI 相关模块迁到 `src/native/capabilities/`。浏览器授权改用 OMP 原生的 `ctx.ui.confirm`（写操作已经在用），砍掉对 `web-permissions` 和 `task-ledger` 的依赖。目标是闭包里只剩原生层和能力层，大约十几个文件。迁完之后，`src/runtime/`、`src/server/`、旧测试和调用 `src/server.ts` 的旧 `scripts/probe-*` 可以一起归档。**这是定版前最该做的一项**，也是 P1-1 的具体落点。

### A2（高）默认工作目录包含 Alpha 自己的数据

- 安装版：`ALPHA_WORKSPACE_ROOT` 为 `%LOCALAPPDATA%\Alpha`，数据根是它下面的 `.alpha/`，新会话不选目录时 `cwd` 就是 `%LOCALAPPDATA%\Alpha`（[server.ts](../src/native/server.ts) `createSession`，[installer/main.cjs:18](../installer/main.cjs:18)）。
- `.alpha/` 里有会话 JSONL、运行提醒快照、Office 附件，以及 `electron-profile`，也就是可见浏览器的 Cookie 和登录状态（[desktop/main.cjs:11](../desktop/main.cjs:11)）。
- 源码版的工作区是仓库根目录，默认会话直接在 Alpha 自己的源码里工作。

结果是智能体默认就站在自己的数据和浏览器登录状态上面，一条宽泛的整理或清理指令就可能读到或改到它们。建议：默认工作目录改为数据根之外的独立目录，例如 `%LOCALAPPDATA%\Alpha\workspace` 或"文档\Alpha"；数据根不要放在任何默认 `cwd` 下面。

### A3（中）会话存储与 OMP 分家

每个会话都把 `PI_CODING_AGENT_SESSION_DIR` 设成 `.alpha/native/sessions/<Alpha ID>`；恢复逻辑是"目录里有任何 `.jsonl` 就加 `--continue`"（[server.ts](../src/native/server.ts) `host`）。这会带来三个问题：

- 在终端里直接用 `omp` 看不到、也恢复不了 Alpha 的会话，反过来也一样。这与"加强版 OMP"的定位相悖。
- 如果 OMP 在同一进程内新建或分叉会话（`command` 接口会原样转发 `handoff` 等命令），同一目录会出现第二个会话文件，下次 `--continue` 可能悄悄接到另一条会话上。
- 标题和更新时间由 Alpha 另行维护（对应前文 S7）。

建议：以 OMP 会话为唯一单位。Alpha 记录中保存 OMP 的会话 ID 或文件路径，恢复时显式指定这个会话；会话列表尽量读取 OMP 自己的最近会话列表，Alpha 只保存界面元数据。动手前先核实 OMP 18.4.3 按 ID 恢复会话的参数。

### A4（中）OMP 进程只增不减

打开某个会话的事件流就会拉起一个 OMP 进程；进程只在退出或切换到终端时才移除，没有空闲回收。连续点开十几个历史会话，就会常驻十几个 Bun + OMP 进程，每个都装着浏览器内核等扩展。建议：没有事件流订阅、并且空闲超过 N 分钟的进程自动停止，另设一个同时存活的上限（例如 4 个，按最近使用淘汰）。

### A5（中）"改后未验证"提醒按代码任务设计，会干扰内容任务

[tianshu-cognition.ts:75](../src/native/tianshu-cognition.ts:75) 把任何 `edit`/`write`/`apply_patch` 都算作修改，而只有测试、构建类命令能清除这个提醒，工具结果里也不带文件路径。按最终方向，内容、办公、写作类 Skill 是重点：写一篇小红书草稿到 `.md` 之后，这个会话后续每一轮都会被注入"尚未观察到测试"，诱导模型去跑无意义的测试。建议：从 toolCall 参数里取路径，只统计代码文件扩展名，或者只在项目存在测试脚本时才启用这条提醒。

### A6（中低）本地服务没有令牌，也不校验 Host

sidecar 监听 `127.0.0.1` 的随机端口，只对带 `Origin` 头的非 GET 请求做校验。这个接口能驱动一个有 shell 权限的智能体：本机任何进程都可以直接调用；DNS 重绑定页面可以读取 GET 接口，拿到对话、文件列表和运行提醒。另外，GET `/events` 带有拉起进程的副作用。建议：Electron 生成一个每次启动不同的令牌传给 sidecar（`main.cjs` 已经在为浏览器桥接生成令牌，可以照搬），所有 `/api` 请求都要求带上；同时校验 `Host` 只能是 `127.0.0.1:<端口>`。

### A7（低）更新检查挡在启动关键路径上

`server.ts` 在监听端口之前先 `await updates.start()`，对 npm registry 的每次请求最长等 8 秒。离线或网络差时，桌面启动会被拖慢。建议：先启动服务，在后台检查，结果到了再显示横幅。"只提醒、不升级"的语义不变。

### A8（低）本机能力没有原生测试

`bun run test` 只覆盖运行提醒、配置、旧任务、模型偏好和更新检查五块。浏览器、Office、ComfyUI 和文档工具的注册、工具名和参数顺序垫片都没有测试，只有打包探针覆盖 Office。A1 重构后，建议补一个 `native-capabilities.test.ts`。

### A9（低）Skill 正文仍有旧运行时术语

30 个 Skill 中有 9 个提到"交接"或"工单"。P0-2 转换时顺手清理，并在新的 Skill 校验里把这些已退役的术语列为失败项，例如 `交接`、`工单`、`handoff`、`gate`、`alpha_plan`。

### 已经合理、建议保持的部分

- RPC 与原生终端之间的单写者切换：同一时间只有一个进程写同一会话。
- 模型、凭据和设置全部走 OMP 自己的 `ModelRegistry`、`Settings` 和凭据存储，不再维护 Alpha 白名单。
- 运行提醒只建议、不拦截，只追加在上下文末尾、不改历史，对缓存友好。
- Office 操作复制原件、产出独立版本，不覆盖原文件。
- OMP 更新只提醒、不自动升级。

### 与前文的合并顺序

| 顺序 | 项 | 说明 |
|---|---|---|
| 1 | A1 + P1-1 | 切断旧系统依赖，本机能力独立成模块。完成后才能归档 `src/runtime/` |
| 2 | A2 | 改一个默认目录，成本很低，收益是安全边界 |
| 3 | P0-1 ～ P0-4 | 身份、专家并入 Skill、天枢与终端（第 8 节，顺带修 A5）、工具进对话 |
| 4 | A3、A4 | 会话与进程生命周期 |
| 5 | A6 ～ A9 | 加固与测试 |

## 8. 天枢 × OMP：从"并排运行"到"长在一起"，以及终端辨识度（2026-09-30）

用户意见：Alpha 以 OMP 为内核，但借鉴了天枢，所以终端不能和原版 OMP 一模一样，至少外观上要有区别；另外，两边的能力都已放开，但结合得好不好并不确定。

### 8.0 判断：目前是并排运行，没有结合

天枢只监听两类事件（`message_end`、`turn_end`），状态写进自己的 JSON 文件，建议以一段隐藏上下文交给模型。OMP 18.4.3 扩展 API 提供的原生结构化信号和界面面板，天枢几乎都没有用。用户在终端里完全看不到天枢，所以终端和原版 OMP 一模一样。**"看起来一样"只是表面症状，根子是"没有结合"**：天枢一旦真正接进 OMP 的原生面板，外观差异自然就出来了。

| 结合点 | 现在 | OMP 18.4.3 已提供 | 应当 |
|---|---|---|---|
| 观测来源 | `message_end`、`turn_end` | `goal_updated`、`todo_reminder`（待办）、`session_compact`、`auto_retry_*`、`retry_fallback_applied`、`tool_approval_*`、`before_subagent_spawn`、`tool_call`/`tool_result`、`session_branch`/`session_tree` | 计划进度可以观测。源码注释说"OMP 不提供计划数据"，在 18.4.3 下已不成立 |
| 状态存放 | `.alpha/native/cognition/<Alpha 会话 ID>.json`；`session_switch` 时清零；分叉和会话树切换都没有处理 | `pi.appendEntry`：写入会话本身，不发给模型 | 状态跟着会话分叉、恢复、导出走；终端与桌面天然共享 |
| 对模型 | 每次调用都在末尾附加同一段隐藏提醒，直到条件解除；带模型用不上的证据哈希；自称"执行由 OMP 判断" | `pi.sendMessage`（`deliverAs`）、`registerMessageRenderer` | 边沿触发：信号新出现或升级时发一条持久消息；持续状态只放在状态栏 |
| 对用户 | 终端里看不到；桌面只在"认知" tab 显示 | `setStatus`、`setWidget`、`setHeader`、`setTitle`、`setTheme`、`registerCommand` | 状态栏常驻天枢段；提醒在对话中带天枢样式 |
| 与压缩 | 上下文用到 80% 时建议"可考虑 OMP 原生压缩"，但模型没法自己执行压缩 | `session_before_compact`、`session.compacting`、`session_compact`；`compaction.midTurnEnabled` 默认开启 | 压缩后把目标、待办和验证状态重新锚定一次 |
| 与 OMP 顾问 | 两套格式各自为政 | OMP 的 advisor（模型顾问，默认关闭）有 `<advisory severity=…>` 格式和终端专属竖条样式 | 天枢做零成本的确定性哨兵，沿用同一套严重级别语义；扩展能否触发模型顾问需要核实 |

### 8.1 结合原则

**天枢读 OMP 的原生事件，写 OMP 的原生会话和界面面板，配合 OMP 的原生机制（压缩、顾问、目标与待办）。** 不另开存储，不另开通道，不拦截工具，不自己开启新一轮。桌面端渲染的是 OMP 原生面板，所以终端和桌面看到的是同一份天枢。

### 8.2 信号重做

| 信号 | 证据来源 | 触发 | 解除 | 对谁 |
|---|---|---|---|---|
| 重复失败 | `tool_result` 出错，且错误签名相同 | 同一签名连续出现 ≥ 2 次 | 同类调用成功 | 模型 + 状态栏 |
| 改后未验证 | `tool_call` 参数里的路径 | 仅在代码文件被修改时触发，按扩展名判断，或项目有测试脚本时才启用（修复 A5） | 测试、类型检查、lint 命令成功；验证命令识别范围按 P0-3 原清单扩充 | 模型 + 状态栏 |
| 待办与验证脱节 | 待办事件 + 验证债 | 待办已全部完成，但验证债仍在 | 验证完成 | 模型 + 状态栏 |
| 压缩后重锚 | `session_compact` + `goal_updated` + 待办 | 刚刚发生了压缩 | 发出一次后即解除 | 模型 |
| 模型降级 | `retry_fallback_applied` | 已切换到备用模型 | 恢复原模型 | 仅状态栏 |
| 上下文占用 | 上下文用量 | 始终显示 | 无 | 仅状态栏，不再建议模型压缩 |

"修改类工具名"集中成一个常量，逐一核对 18.4.3 的实际工具名（`edit`、`write`、`ast_edit`、notebook 编辑等）。

### 8.3 状态写进会话

- 状态变化时用 `pi.appendEntry("alpha-tianshu", …)` 写入会话。`session_start`、`session_switch`、`session_branch`、`session_tree` 时，从当前分支上的条目重建状态。
- 删除私有的 `cognition/<id>.json` 和环境变量 `ALPHA_COGNITION_FILE`。桌面改为读取 RPC 转发的 `setStatus`/`setWidget`。**先核实** 18.4.3 的 RPC 模式会把这两类请求作为 `extension_ui_request` 转发；如果不转发，保留一份只读快照作为兜底。
- 这样天枢状态也不再受 A3（会话存储分家）的影响。

### 8.4 对模型：边沿触发的持久提醒

- 信号新出现或升级时，用 `pi.sendMessage({ customType: "alpha-tianshu", display: true, … })` 发一条一行的中文建议。**投递方式要区分**：只有流式进行中才用 `deliverAs: "aside"`；会话空闲时一律用 `"nextTurn"`。原因是 `aside` 在空闲时会自己开启一轮，那就违反了"天枢不唤醒智能体"。
- 条件持续期间不重复注入；面向模型的文字去掉证据哈希，把"由 OMP 判断"改为"由你判断"。证据哈希保留在消息的 `details` 中，供 `/tianshu` 和桌面查看。
- 缓存：持久消息只追加在尾部，之后就成为稳定前缀的一部分，比现在每次调用都附加同一段更省。

### 8.5 与压缩协同

- 删除"建议压缩"这条模型执行不了的提醒。
- `session_compact` 之后，在下一轮投递一次重锚消息：当前目标、未完成的待办、未解决的验证债和重复失败。天枢的状态存在会话条目里，不受摘要影响，正好用来弥补压缩丢失的信息。**核实** `session.compacting` 是否允许扩展往摘要材料里追加内容；如果允许，优先用这种方式。

### 8.6 终端辨识度：外观不同，操作相同

原则：只改外观和信息，不改 OMP 的按键、命令和操作习惯；尊重用户自己选的主题；在 16 色终端下能正常降级。

1. **主题**：随 Alpha 发两套终端主题，"纸墨·浅"和"墨·深"，色值取自 [界面风格：纸与墨](ui-paper-ink-style-2026-09-27.md)（暖纸底、墨黑正文、鼠尾草绿用于状态和选中）。`session_start` 时，只有当用户仍在用 OMP 默认主题才调用 `setTheme`；用户自己换过主题就不动。
2. **页眉**：用 `setHeader` 换成一行紧凑页眉：`α Alpha · 天枢`、模型与思考强度、项目目录、会话名。不用大块 ASCII 字标，不挤占对话空间。
3. **窗口标题**：`setTitle("Alpha · <会话名>")`。
4. **天枢状态段**：`setStatus("tianshu", …)` 常驻页脚，例如 `天枢 ✓`、`天枢 · 改后未验证`、`天枢 · 同类失败×3`、`上下文 82%`。这是最有辨识度、也最有用的一处：看一眼就知道这是 Alpha，也知道它眼下的状态。
5. **天枢消息样式**：用 `registerMessageRenderer("alpha-tianshu", …)` 给提醒加专属的左侧竖条（常规用鼠尾草绿，严重用赭色），和 OMP advisor 的竖条区分开。
6. **命令**：`/tianshu` 展开当前证据帧（事实、信号、证据来源、测量质量）；`/alpha` 显示已装的 Alpha Skill、本机能力状态和版本。
7. **入口**：桌面上的"切换到原生终端"改名为"Alpha 终端"；可以另外提供 `Alpha.cmd --terminal` 直接进入终端模式。两个入口使用同一组扩展和同一段 `--append-system-prompt`。
8. **桌面同源**：桌面顶栏显示同一个天枢状态段；撤掉右栏的"认知" tab；提醒在对话流中用相同的天枢样式显示。

### 8.7 动手前需要核实的点

1. 18.4.3 的 RPC 模式是否转发 `setStatus`、`setWidget`、`setTitle`。
2. 自定义主题的格式，以及扩展注册主题的方式（`setTheme` 接受 `Theme` 对象或主题名）。
3. 18.4.3 编辑类工具的实际名称。
4. `session.compacting` 的返回值语义。
5. 扩展能否主动请求 OMP 的模型顾问复核。能的话，就形成"天枢便宜地盯、信号升级时再请模型顾问"的分层；不能的话，只统一严重级别语义。

### 8.8 验收

- [ ] 打开 Alpha 终端，第一眼就能看出不是原版 OMP：页眉、标题、主题、天枢状态段都有区别，快捷键和命令与 OMP 相同。
- [ ] 代码任务中修改文件后，状态段显示"改后未验证"，跑完测试恢复为 ✓；写作任务中写 `.md` 不触发。
- [ ] 同一会话在终端和桌面看到相同的天枢状态；从某条消息分叉后，天枢状态随分支正确回退。
- [ ] 自动压缩之后，下一轮模型收到一次重锚，之后不再重复。
- [ ] 会话空闲时，天枢不会自己开启新一轮。
- [ ] 用户换过主题后，Alpha 不再覆盖。
