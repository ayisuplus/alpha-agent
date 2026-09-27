# 核心专家的来源与取舍

核对日期：2026-09-27。人设中的姓名是虚构角色名，不代表真人履历。Alpha 的 13 份人设和 13 份 Skill 按实际工单与工具边界编写；以下仓库作为方法参考，没有安装其插件、Hook、MCP 或运行第三方脚本。原有上游文件及许可证保留在 `upstream/`，本次不扩张导入。

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

来源与许可证按具体文件区分；不能因为 GitHub 可读就认为仓库所有内容都允许复制。此轮采用方法层面的参考与 Alpha 自有文本；没有复制 Anthropic 文档处理包或其执行脚本。
