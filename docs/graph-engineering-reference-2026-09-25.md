# Graph Engineering 与 Alpha 认知运行时

2026-09-25 调研。这里的 Graph Engineering 指任务、执行者和运行状态之间可检查的结构，不指必须引入图数据库或某个图执行框架。这个术语仍在形成中，不同项目的边界并不一致。

## 参考来源

- [Graph Engineering in the Era of LLM Agents, arXiv:2608.21156v2](https://arxiv.org/html/2608.21156v2)：把目标分解、执行者协作、状态记录、故障定位与恢复视为系统级问题；它是综述和研究框架，不是 Alpha 的性能证明。
- [Agent Graph 的工程说明](https://github.com/context4ai/agent-graph/blob/main/docs/en/graph-engineering.md)：强调外部事实、类型化结果、显式门禁和可核查依据；指令与模型总结不能自行充当事实。
- [graph-engineering Skill 的项目说明](https://github.com/luxiaolei/graph-engineering/blob/main/README.md)：展示受治理的项目局部 Graph 合同和人工审阅边界；其具体文件格式与 Alpha 运行时无须相同。

## Alpha 当前的对应关系

| 结构 | Alpha 当前实现 | 仍需验证的边界 |
| --- | --- | --- |
| 任务图 | TaskLedger 的步骤 ID、依赖、状态；工单不得跳过依赖 | 跨任务依赖和动态重规划尚未实跑 |
| 执行者图 | 专家快照、工单模式与读写范围 | 多专家复杂协作的收益尚无对照评估 |
| 状态与权限 | 计划待审、执行、验收、预算和恢复状态 | 长任务重启后的现场恢复要继续验证 |
| 证据图 | 源码版本绑定的审查引用、配置检查日志、任务验收证据 | 源码引用只能证明片段存在，不能单独证明行为正确 |

本轮采用最小的可验证改进：计划工具把执行模式限定在 schema 中；成功记录计划后运行时结束规划轮次；独立审查的通过结论要求当前源码原文引用，并与实际配置检查和任务验收分开。2026-09-25 的独立实跑中，规划用 4 次工具调用、1 次有效 `alpha_plan` 进入待审阅；审查保存了当前源码片段，而测试验收缺口仍未完成。该结果验证了这两个边界，不证明复杂多代理图的整体效果或行业领先地位。
