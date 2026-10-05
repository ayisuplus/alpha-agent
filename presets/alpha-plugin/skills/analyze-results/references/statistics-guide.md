# 统计方法选择与结果报告参考

核对日期：2026-09-27。本表是起点而不是机械的决策树，方法选择要回到实验设计与数据结构。

## 按设计选择方法

| 场景 | 常用做法 | 注意 |
|---|---|---|
| 两个模型，同一组种子（配对） | 配对差值的均值与区间；配对 t 检验或 Wilcoxon 符号秩检验；种子很少时直接列出每个种子的差值 | 种子数很少时推断很脆弱，结论写成描述性 |
| 两个模型，同一测试集，各运行一次 | 对测试样本做配对自助法，得到差值区间；置换检验；二分类正误可用 McNemar 检验 | 只反映测试集抽样的不确定性，不反映训练随机性 |
| 多个种子 × 同一测试集 | 分别报告两类波动，或按"种子—样本"层次重采样 | 不能把"种子数 × 样本数"当作独立样本量 |
| 多个模型 × 多个数据集 | 逐数据集报告；汇总用平均排名，Friedman 检验后，所有模型两两比较用 Nemenyi 检验，与一个对照比较用 Holm 等逐步校正；或报告胜平负计数 | 数据集少时检验力很低；不同指标不直接平均 |
| 强化学习或每个任务只有少量运行 | 四分位均值（IQM）、按任务分层的自助法区间、性能分布曲线 | 按任务分层重采样 |
| 人工评分（有序量表） | 按有序数据处理：中位数与分布、非参数检验或序数模型；一致性用 κ 或 α | 李克特分数不宜直接当连续值求均值后比较 |
| 比例与计数 | 比例的区间（如 Wilson 区间）；用合适的比例检验或回归模型比较 | 写清分母 |
| 观测数据中的关联 | 回归并报告系数区间，控制已知混杂因素 | 不写成因果 |

## 多重比较

- 族错误率：Holm 逐步校正，与 Bonferroni 一样控制族错误率，但检验力更高。
- 错误发现率：Benjamini-Hochberg，适合大量探索性比较。
- 事先写明比较族包含哪些比较；探索性结果标注"需要新数据确认"。

## 检验力与样本量

- 小样本、小效应的实验检验力低，即使显著，估计的效应也更可能被夸大。
- 有试点数据时，用观测到的波动估计达到最小有意义差异所需的种子数或测试样本数，并在方案中写明。

## 报告格式示例

- "方法 A 比基线高 1.8 个百分点（5 个种子的配对差值均值；95% 自助法区间 [0.6, 3.1]，10,000 次重采样，百分位法）。"
- "准确率 71.2 ± 0.9（均值 ± 标准差，n = 5 个种子）。"——必须写明 ± 后面是标准差、标准误还是区间半宽。
- "在 12 个数据集上平均排名 2.1（Friedman 检验 p = 0.004；与对照的 Holm 校正事后比较见表 3）。"
- 以上数字仅为格式示例，不是任何真实结果。

## p 值与区间的解读

- p 值是在零假设及模型假设都成立时，观察到至少如此极端数据的概率；它不是假设为真的概率，也不衡量效应大小或重要性（参见 ASA 关于 p 值的声明，Wasserstein and Lazar 2016）。
- 不显著不等于等效；需要主张"没有实质差异"时，事先设定等效界，再用区间判断。

## 图表

- 小样本连续数据优先显示单个数据点，而不是只画柱状图（参见 Weissgerber et al., PLoS Biology 2015）。
- 误差条定义写进图注；同一张图里不混用不同定义。

## 延伸阅读（2026-09-27 核对存在与出处）

- Demšar, "Statistical Comparisons of Classifiers over Multiple Data Sets", JMLR 7 (2006) 1–30.
- Dror, Baumer, Shlomov, Reichart, "The Hitchhiker's Guide to Testing Statistical Significance in Natural Language Processing", ACL 2018.
- Koehn, "Statistical Significance Tests for Machine Translation Evaluation", EMNLP 2004.
- Card et al., "With Little Power Comes Great Responsibility", EMNLP 2020.
- Bouthillier et al., "Accounting for Variance in Machine Learning Benchmarks", MLSys 2021.
- Agarwal et al., "Deep Reinforcement Learning at the Edge of the Statistical Precipice", NeurIPS 2021.
- Wasserstein and Lazar, "The ASA's Statement on p-Values: Context, Process, and Purpose", The American Statistician 70(2) (2016) 129–133.
- Weissgerber et al., "Beyond Bar and Line Graphs: Time for a New Data Presentation Paradigm", PLoS Biology 13(4) (2015) e1002128.
