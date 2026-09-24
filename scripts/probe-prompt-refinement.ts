import { resolve } from "node:path";
import { refinePrompt, type PromptCategory } from "../src/runtime/prompt-refinement";

const model = "deepseek/deepseek-flash";
const samples: Array<{ category: PromptCategory; text: string }> = [
  { category: "software", text: "做一个本机记账本，只要 2 个页面，375px 手机宽度可用，不要登录。" },
  { category: "research", text: "比较两种本地搜索方法的优缺点；不确定的结论要标明，别编造来源。" },
  { category: "creative", text: "固定机位拍一段庭院短视频，画面里只有两位年轻女子，建筑不要变形。" },
  { category: "writing", text: "给房东写一封礼貌邮件，说明水管漏水，询问什么时候能维修。" },
];

for (const sample of samples) {
  const result = await refinePrompt(sample.text, model, model, resolve(".alpha"));
  if (result.category !== sample.category) throw new Error(`分类错误：${sample.category} → ${result.category}`);
  if (!result.english || !result.optimized) throw new Error(`没有完成 ${sample.category} 的处理`);
  console.log(JSON.stringify({ expected: sample.category, source: sample.text, result }));
}
