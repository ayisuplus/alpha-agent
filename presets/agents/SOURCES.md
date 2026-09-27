# 核心专家的来源与取舍

核对日期：2026-09-27。人设中的姓名是虚构角色名，不代表真人履历。Alpha 的 29 份人设和 29 份 Skill 按实际工单与工具边界编写；以下仓库作为方法参考，没有安装其插件、Hook、MCP 或运行第三方脚本。原有上游文件及许可证保留在 `upstream/`，本次不扩张导入。

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
| [Remotion / best-practices](https://github.com/remotion-dev/skills/blob/cf49eff5d4463b33966b6618c83f7295797dd028/skills/remotion-best-practices/SKILL.md) | `cf49eff5d4463b33966b6618c83f7295797dd028` | 查阅其按模式加载资源的结构；本轮未引入 Remotion 专家，也不以它替换用户指定的视频服务。 |
| [agency-agents / Bilibili Content Strategist](https://github.com/msitarzewski/agency-agents/blob/6d58ad4c0a3b8cfa9bb77125f18152312dd1e5bb/marketing/marketing-bilibili-content-strategist.md) | `6d58ad4c0a3b8cfa9bb77125f18152312dd1e5bb`（2026-06 抓取时该文件的最新提交） | 借鉴分区、弹幕触发点与充电/花火/课堂变现的梳理；删除固定增长承诺，补齐官方口径核实与时效标注。 |

### 平台规则与事实核对来源（2026-09-27 核对）

以下为平台官方与监管来源，用于核对人设与 Skill 中涉及的机制、标注和红线；它们是事实来源，不是可复制的代码或文本。第三方创作者经验（抖音/B站博主口述、运营博客等）只作线索，已在 Skill 中要求使用前重新核实官方页面。

| 来源 | 用途 |
|---|---|
| [抖音安全与信任中心](https://www.douyin.com/trust) 及抖音创作者服务中心、巨量学/巨量算数、抖音电商学习中心 | 核对推荐排序原理（行为概率 × 行为价值）、流量机制、创作者与直播电商规则。 |
| [中央网信办规范短视频内容标注（新华网）](http://www.xinhuanet.com/politics/20260512/2791fd855e074f0287620ef6bbf647db/c.html) / [央视网答记者问](https://news.cctv.cn/2026/05/12/ARTILwWrbjnWICzUIj8VTHqS260512.shtml) | 核对六类必选内容标注标签（虚构演绎、AI 生成、营销信息、转载、个人观点、无需标注）与落地时间。 |
| [B站创作中心 / 创作学院](https://member.bilibili.com/platform/upload-manager/article) 及 B 站官方动态 | 核对分区、投稿规格、完播与互动指标、标题封面规范。 |
| [小红书创作中心](https://creator.xiaohongshu.com) 及蒲公英/聚光官方说明 | 核对搜索与推荐机制、笔记与商业合作标识规则。 |
| [微信公众平台](https://mp.weixin.qq.com) / 微信公开课 / 视频号官方规则 | 核对视频号社交推荐、公众号推送与完读、小绿书及公私域联动规则。 |
| 《中华人民共和国广告法》及市场监管、平台广告审核规范 | 核对极限词、绝对化用语、虚假宣传与特殊品类广告边界。 |

### 平面游戏专家的来源与取舍（2026-09-27）

游戏线 4 位专家（系统设计、程序、美术动画、试玩与平衡）的人设与 Skill 由 Alpha 自有文本编写，参考的是通行游戏开发工程实践，**没有引用外部仓库、插件或第三方脚本，也没有复制任何教程、文档或素材**；因此本轮不新增一手来源条目，也不声明可复制来源。

| 类别 | 说明 |
|---|---|
| 通用工程实践 | 核心循环与最小可玩切片、固定步长主循环、宽相/窄相碰撞、输入缓冲与土狼时间、图集与批处理、退化策略排查等属于行业通行做法，按 Alpha 的工单边界重写。 |
| 需要实测或查官方文档的数字 | 图集尺寸与纹理上限、目标帧率下的帧预算、输入延迟、加载耗时、内存占用、引擎 API 行为——Skill 中一律要求实测或查所用引擎官方文档并注明版本与日期，本文档不提供固定数值。 |
| 美术与音频资产 | 风格参考必须记录真实来源与查看日期；AI 生成素材只作概念与占位并标注，最终资产须替换，版权与素材许可由用户自行确认。 |

来源与许可证按具体文件区分；不能因为网页可读就认为素材或文档允许复制。引擎与平台能力持续更新，下一次使用相关 Skill 时应按当时所用引擎重新核对。


