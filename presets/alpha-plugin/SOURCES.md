# Alpha Skill 的来源与取舍

核对日期：2026-09-27（来源核对）；2026-09-30（按 D2 决策，30 份人设已并入对应 Skill，本文保留来源、取舍与许可归属）。历史人设中的姓名是虚构角色名，不代表真人履历，已随人设一并删除。Alpha 的 30 个 Skill 按实际任务与工具边界编写；以下仓库作为方法参考，没有安装其插件、Hook、MCP 或运行第三方脚本。旧 `presets/agents/upstream/` 已退役；固定版本与链接见下表，第三方许可原文保留在本文末尾。

| 一手来源 | 固定版本 | 用途与取舍 |
|---|---|---|
| [agency-agents / Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/053ddbbf392a1688fc7043d81529f47ef2cf86c8/engineering/engineering-frontend-developer.md) | `053ddbbf392a1688fc7043d81529f47ef2cf86c8` | 借鉴角色性格、职责和交付区分；不沿用固定技术栈、过度优化与无依据指标。 |
| [agency-agents / Content Creator](https://github.com/msitarzewski/agency-agents/blob/053ddbbf392a1688fc7043d81529f47ef2cf86c8/marketing/marketing-content-creator.md) | 同上 | 借鉴受众、语气与平台改编；删除固定流量、增长和 ROI 承诺。 |
| [agency-agents / Visual Storyteller](https://github.com/msitarzewski/agency-agents/blob/053ddbbf392a1688fc7043d81529f47ef2cf86c8/design/design-visual-storyteller.md) | 同上 | 借鉴叙事、镜头和音画分工；增加真实参考、身份一致性和实际生成结果的区分。 |
| [Anthropic / webapp-testing](https://github.com/anthropics/skills/blob/33375500bcea98d610eb30ce10ac4e59b89c390d/skills/webapp-testing/SKILL.md) | `33375500bcea98d610eb30ce10ac4e59b89c390d` | 借鉴观察渲染结果再操作与取证；沿用 Alpha 可用浏览器，不绑定上游 Python Playwright 脚本。 |
| [Superpowers / systematic-debugging](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/systematic-debugging/SKILL.md) | `8ca22dba9a94f28898bbce59f2537ff4d87c747d` | 借鉴复现、根因和回归的关系；不引入另一套调度或强制所有工作走同一长流程。 |
| [K-Dense / literature-review](https://github.com/K-Dense-AI/scientific-agent-skills/blob/49c6e97775eaa18ba791bebe23162a70ae601c18/skills/literature-review/SKILL.md) | `49c6e97775eaa18ba791bebe23162a70ae601c18` | 借鉴检索记录与来源核验；不沿用强制付费搜索、额外生图和生物学专用工具。 |
| [K-Dense / hypothesis-generation](https://github.com/K-Dense-AI/scientific-agent-skills/blob/49c6e97775eaa18ba791bebe23162a70ae601c18/skills/hypothesis-generation/SKILL.md) | 同上 | 借鉴观察、假设、预测与证据的区分；补充 AI 数据泄漏、公平基线、消融、冻结配置和算力预算。 |
| [K-Dense / statistical-analysis](https://github.com/K-Dense-AI/scientific-agent-skills/blob/49c6e97775eaa18ba791bebe23162a70ae601c18/skills/statistical-analysis/SKILL.md) | 同上 | 借鉴统计设计、效应与区间报告；强调独立单位和配对，不复制自动安装清单或机械选检验表。 |
| [K-Dense / scientific-writing](https://github.com/K-Dense-AI/scientific-agent-skills/blob/49c6e97775eaa18ba791bebe23162a70ae601c18/skills/scientific-writing/SKILL.md) | 同上 | 借鉴证据绑定、方法结果一致性与真实修订状态；按当前写作范围应用，不引入不相关审批流程。 |
| [Remotion / best-practices](https://github.com/remotion-dev/skills/blob/cf49eff5d4463b33966b6618c83f7295797dd028/skills/remotion-best-practices/SKILL.md) | `cf49eff5d4463b33966b6618c83f7295797dd028` | 查阅其按模式加载资源的结构；本轮未引入 Remotion 方法，也不以它替换用户指定的视频服务。 |
| [agency-agents / Bilibili Content Strategist](https://github.com/msitarzewski/agency-agents/blob/6d58ad4c0a3b8cfa9bb77125f18152312dd1e5bb/marketing/marketing-bilibili-content-strategist.md) | `6d58ad4c0a3b8cfa9bb77125f18152312dd1e5bb`（2026-06 抓取时该文件的最新提交） | 借鉴分区、弹幕触发点与充电/花火/课堂变现的梳理；删除固定增长承诺，补齐官方口径核实与时效标注。 |

### 平台规则与事实核对来源（2026-09-27 核对）

以下为平台官方与监管来源，用于核对 Skill 中涉及的机制、标注和红线；它们是事实来源，不是可复制的代码或文本。第三方创作者经验（抖音/B站博主口述、运营博客等）只作线索，已在 Skill 中要求使用前重新核实官方页面。

| 来源 | 用途 |
|---|---|
| [抖音安全与信任中心](https://www.douyin.com/trust) 及抖音创作者服务中心、巨量学/巨量算数、抖音电商学习中心 | 核对推荐排序原理（行为概率 × 行为价值）、流量机制、创作者与直播电商规则。 |
| [中央网信办规范短视频内容标注（新华网）](http://www.xinhuanet.com/politics/20260512/2791fd855e074f0287620ef6bbf647db/c.html) / [央视网答记者问](https://news.cctv.cn/2026/05/12/ARTILwWrbjnWICzUIj8VTHqS260512.shtml) | 核对六类必选内容标注标签（虚构演绎、AI 生成、营销信息、转载、个人观点、无需标注）与落地时间。 |
| [B站创作中心 / 创作学院](https://member.bilibili.com/platform/upload-manager/article) 及 B 站官方动态 | 核对分区、投稿规格、完播与互动指标、标题封面规范。 |
| [小红书创作中心](https://creator.xiaohongshu.com) 及蒲公英/聚光官方说明 | 核对搜索与推荐机制、笔记与商业合作标识规则。 |
| [微信公众平台](https://mp.weixin.qq.com) / 微信公开课 / 视频号官方规则 | 核对视频号社交推荐、公众号推送与完读、小绿书及公私域联动规则。 |
| 《中华人民共和国广告法》及市场监管、平台广告审核规范 | 核对极限词、绝对化用语、虚假宣传与特殊品类广告边界。 |

### 游戏线 Skill 的来源与取舍（2026-09-27）

游戏线 4 个方法（`design-game-systems` 系统设计、`implement-gameplay` 程序实现、`craft-game-art` 美术动画、`playtest-game` 试玩与平衡）由 Alpha 自有文本编写，参考的是通行游戏开发工程实践，**没有引用外部仓库、插件或第三方脚本，也没有复制任何教程、文档或素材**；因此本轮不新增一手来源条目，也不声明可复制来源。

| 类别 | 说明 |
|---|---|
| 通用工程实践 | 核心循环与最小可玩切片、固定步长主循环、宽相/窄相碰撞、输入缓冲与土狼时间、图集与批处理、退化策略排查等属于行业通行做法，按 Alpha 的任务边界重写。 |
| 需要实测或查官方文档的数字 | 图集尺寸与纹理上限、目标帧率下的帧预算、输入延迟、加载耗时、内存占用、引擎 API 行为——Skill 中一律要求实测或查所用引擎官方文档并注明版本与日期，本文档不提供固定数值。 |
| 美术与音频资产 | 风格参考必须记录真实来源与查看日期；AI 生成素材只作概念与占位并标注，最终资产须替换，版权与素材许可由用户自行确认。 |

### 科研线与文章写作 Skill 的来源与取舍（2026-09-27）

科研线 4 个方法（`review-literature` 文献与证据、`design-experiments` 实验设计与复现、`analyze-results` 数据分析、`write-manuscript` 论文写作与审稿）本轮重写，并新增文章写作与改稿方法 `write-articles`。文本由 Alpha 自行编写，**没有复制下列文献的原文，也没有安装插件或运行第三方脚本**；下列文献只作为方法依据，在 Skill 的参考文件中以"延伸阅读"或"参见"形式出现。每条都在 2026-09-27 通过出版方页面、ACL Anthology、DBLP 或 PubMed 等书目记录核对了题名、作者、出处与年份。

| 来源 | 性质 | 用途 |
|---|---|---|
| Demšar, JMLR 7 (2006)；Dror et al., ACL 2018；Koehn, EMNLP 2004；Card et al., EMNLP 2020 | 同行评审论文 | 多数据集比较、NLP 显著性检验选择、配对自助法、统计功效（`analyze-results`） |
| Bouthillier et al., MLSys 2021；Agarwal et al., NeurIPS 2021 | 同行评审论文 | 基准中的方差来源、少量运行时的稳健汇总与区间（`analyze-results`、`design-experiments`） |
| Wasserstein and Lazar, The American Statistician 70(2) 2016；Weissgerber et al., PLoS Biology 13(4) 2015 | 学会声明 / 同行评审论文 | p 值解读、小样本数据呈现（`analyze-results`） |
| Kapoor and Narayanan, Patterns 2023；Pineau et al., JMLR 22 (2021)；Dodge et al., EMNLP-IJCNLP 2019 | 同行评审论文 | 数据泄漏类型、复现检查清单、调参预算下的结果报告（`design-experiments`） |
| Sainz et al., Findings of EMNLP 2023；Zheng et al., NeurIPS 2023 Datasets and Benchmarks | 同行评审论文 | 基准污染、以模型为评判者的偏差（`design-experiments`） |
| Page et al., BMJ 2021;372:n71（PRISMA 2020）；Wohlin, EASE 2014 | 报告规范 / 同行评审论文 | 系统综述流程、滚雪球检索（`review-literature`） |
| Gopen and Swan, American Scientist 78(6) 1990 | 期刊文章 | 句子中已知信息与新信息的位置（`write-manuscript`） |
| [NeurIPS Paper Checklist Guidelines](https://neurips.cc/public/guides/PaperChecklist) | 会议官方说明 | 作为"目标会议检查清单"的示例；具体要求每次投稿前重新查当年官方页面 |
| GB/T 7714-2025《信息与文献 参考文献著录规则》（2025-12-02 发布，2026-07-01 实施，全部代替 GB/T 7714-2015）；GB/T 15834-2011《标点符号用法》；GB/T 15835-2011《出版物上数字用法》 | 国家标准（[全国标准信息公共服务平台](https://std.samr.gov.cn/)核对现行状态） | 中文参考文献、标点与数字规范（`review-literature`、`write-manuscript`、`write-articles`） |

取舍：

- 统计方法写成"按设计选择"的参考表，不给机械决策树，也不预设任何检验结果；示例数字明确标为格式示例。
- 数据库与检索渠道只写用途和常见陷阱，覆盖范围与访问方式以实际访问为准。
- 会议与期刊的页数、模板、匿名、检查清单和 AI 工具使用政策逐年变化，Skill 要求写作前查官方说明并记录核对日期，本文不记录具体条款。
- 文章写作 Skill 的结构、论证与改稿方法属于通行写作实践，按 Alpha 的事实原则重写；不引用或复制任何写作教材的文字。

### 第三方人设参考材料与许可（保留归属声明）

`presets/agents/upstream/` 保存着人设编写时期的第三方参考材料，文件名对应来源仓库路径：

| 上游文件 | 对应来源（见上文一手来源表） |
|---|---|
| `design-design-ui-designer.md` | agency-agents `design/design-ui-designer.md` |
| `engineering-engineering-backend-architect.md` | agency-agents `engineering/engineering-backend-architect.md` |
| `engineering-engineering-frontend-developer.md` | agency-agents `engineering/engineering-frontend-developer.md`（固定版本 `053ddbbf392a1688fc7043d81529f47ef2cf86c8`） |
| `testing-testing-test-automation-engineer.md` | agency-agents `testing/testing-test-automation-engineer.md` |

这些材料只用于借鉴角色分工与职责描述，人设与其虚构姓名已随 D2 决策退役；本插件只发行改写后的 Skill 文本，不再随包分发上述原文。随附许可文件 `presets/agents/upstream/LICENSE` 声明如下（原文保留）：

```
MIT License

Copyright (c) 2025 AgentLand Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

来源与许可证按具体文件区分；不能因为网页可读就认为素材或文档允许复制。引擎与平台能力持续更新，下一次使用相关 Skill 时应按当时所用引擎重新核对。
