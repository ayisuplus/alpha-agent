# 大模型与基准评测专项检查

核对日期：2026-09-27。以下是设计评测时逐项确认的问题；具体模型版本、API 行为、价格与限额以官方文档为准，并在实验记录中注明查阅日期。

## 模型与版本

- 记录模型全名、版本或快照标识、服务商和调用日期。闭源 API 可能在同一名称下更新，长期实验固定快照，或记录日期并在结束前重测关键结果。
- 开源模型记录权重来源与修订号、量化方式、推理框架及其版本。

## 提示与解码

- 系统提示、提示模板和少样本示例（数量、选择方式、顺序）保存为文件；示例选择在运行前固定。
- 记录解码参数：温度、top-p、最大输出长度、停止符、采样次数。温度大于 0 时同一输入多次采样并报告波动；报告 pass@k 时写明 k、采样数与估计方法。
- 答案抽取与解析写成经过测试的代码；统计解析失败率，失败样本不静默丢弃。
- 比较不同模型时说明提示是否专门为某个模型调过；公平做法是使用同一模板，或给每个模型同等的调提示预算。

## 数据污染与测试集复用

- 对比测试数据的发布时间与模型的训练数据截止时间；用可行的方法（文本重叠检测、改写或新收集的平行测试集等）评估污染风险，并写明检测方法的局限。基准污染会系统性抬高分数（参见 Sainz et al., Findings of EMNLP 2023）。
- 在同一测试集上反复调提示或选模型会过拟合该测试集；保留一份不参与任何选择的留出集。

## 以模型为评判者

- 记录评判模型、评判提示和评分标准。
- 检查已知偏差：交换候选顺序后重评（位置偏差）、控制回答长度（冗长偏差）、评判模型偏好与自己相近的回答（自我偏好）（参见 Zheng et al., NeurIPS 2023 Datasets and Benchmarks）。
- 抽取样本做人工标注，报告评判模型与人工的一致性；一致性不足时不能单独依赖模型评判。

## 智能体与工具使用任务

- 固定环境版本、工具集合、最大步数、超时与重试策略。
- 成功率与成本（token 数、调用次数、墙钟时间）一起报告；分开统计任务失败、环境错误、超时和解析失败。
- 环境不稳定时重复运行并报告波动。

## 计算量与调参预算

- 报告每个设置的 token 用量或 GPU 时间。方法的提升依赖更多推理计算或更大的调参预算时，与给予同等计算和调参预算的基线比较。
- 只报告调参后的最好结果会高估；可以报告随调参次数变化的期望最佳结果（参见 Dodge et al., EMNLP 2019 "Show Your Work"）。

## 报告前核对

- 参照目标会议的检查清单（例如 NeurIPS Paper Checklist）核对：数据与代码可得性、超参数与搜索方法、计算资源、误差条与统计显著性的定义、局限；答案指向正文位置。
- 机器学习复现计划与检查清单的背景可参见 Pineau et al., JMLR 22 (2021)；数据泄漏的常见类型可参见 Kapoor and Narayanan, Patterns 2023。

## 延伸阅读（2026-09-27 核对存在与出处）

- Sainz et al., "NLP Evaluation in trouble: On the Need to Measure LLM Data Contamination for each Benchmark", Findings of EMNLP 2023.
- Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023 Datasets and Benchmarks Track.
- Dodge et al., "Show Your Work: Improved Reporting of Experimental Results", EMNLP-IJCNLP 2019.
- Pineau et al., "Improving Reproducibility in Machine Learning Research (A Report from the NeurIPS 2019 Reproducibility Program)", JMLR 22 (2021).
- Kapoor and Narayanan, "Leakage and the reproducibility crisis in machine-learning-based science", Patterns (2023), doi:10.1016/j.patter.2023.100804.
- Bouthillier et al., "Accounting for Variance in Machine Learning Benchmarks", MLSys 2021.
