# Alpha 评测集

> 历史材料：本目录针对已退役的 Alpha HTTP 协议，`bun run eval` 已不可用，不属于当前版本验收入口。当前检查使用根目录 README 中的 check / test / validate:skills / build:desktop-ui。下文保留旧评测方案供参考。

用来回答"这次改 harness 之后，Alpha 是变好了还是变差了"。评测脚本像用户一样通过工作台 HTTP 接口给 Alpha 派任务，等它自己结束，再用 Alpha 看不到的检查打分：

- 代码任务：一个带 bug 的小仓库。Alpha 能看到仓库和可见的冒烟测试；打分时把隐藏测试放进它改完的项目副本里运行。
- 通用任务：用正则检查回答内容（必须出现的数值、禁用词、字数范围），或逐行比对生成的文件。

同时记录 Alpha 自己的结论（是否"已验收"），所以能看出两类问题：**自评通过但独立检查失败**（误判验收），以及**独立检查通过但自评没验收**（漏判）。

## 用法

```bash
bun run eval --selfcheck                         # 先确认评分本身可靠
bun run eval                                     # 用当前代码跑全部任务
bun run eval --tasks cart-rounding,lru-cache --concurrency 2
bun run eval --app <另一份代码目录> --label head   # 用旧版本跑同一批任务
bun run eval compare artifacts/eval-…-head artifacts/eval-…-current
```

- `--selfcheck`：每个隐藏测试都必须在原始代码上失败、在参考解法（`solution/`）上通过，CSV 答案要能从附件数据算出来。评分有错时先修评分，不要拿去比较版本。
- 结果写在 `artifacts/eval-<日期>-<标签>/`（`results.json` 和 `report.md`，不入库）。
- 每次运行都在系统临时目录建一个独立工作区，只复制 `.alpha` 里的 `settings.json`、`agent-presets.json`、`expert-packs/`、`plugin-packs/`。不复制任务、自动化和网页密钥；模型凭据沿用 OMP 的共享存储，不复制。
- 默认每个任务最多 25 分钟（`--timeout-min` 可改），超时会停止任务并记为失败。
- 运行会真实调用模型并消耗额度。

## 任务

| 任务 | 类型 | 考察点 |
|---|---|---|
| cart-rounding | 代码 | 运算顺序（先折扣后计税）、十进制四舍五入与浮点误差 |
| slugify-unicode | 代码 | Unicode 处理：保留中文、去除重音、合并分隔符 |
| range-merge | 代码 | 左闭右开边界、空区间、排序后合并、不修改输入 |
| lru-cache | 代码 | 读写都更新使用顺序、容量为 0 |
| csv-quotes | 代码 | 从零写一个小解析器：引号、转义、空字段、未闭合报错 |
| sales-question | 通用 | 读取附件、汇总计算、直接回答 |
| sales-summary | 通用 | 读取附件、生成指定格式的文件 |
| product-copy | 通用 | 中文文案：字数、必含卖点、广告法绝对化用语 |

## 加任务

在 `tasks/<id>/` 下放 `task.json`（`kind`、`objective`、`files`/`hidden`、`checks`）。代码任务还要有 `repo/`（带 `package.json` 的 `test` 脚本和可见测试）、`hidden/`（隐藏测试，从 `../src` 引用源码）和 `solution/`（参考解法，只用于自检）。加完先跑 `--selfcheck`。

8 个任务只能看出明显的变化；两个版本相差一两题时，先扩大任务数或重复运行，再下结论。公开基准（SWE-bench Verified Mini、Aider Polyglot 等）可以按同样方式接入。
