import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { TaskLedger } from "./task-ledger";
import { stripReadSelector } from "./file-tool-guard";

const parameters = type({ verdict: "'pass' | 'changes-requested' | 'inconclusive'", findings: "string[]", evidence: type({ path: "string", excerpt: "string" }).array().optional() });

export async function validateReviewEvidence(projectRoot: string, items: Array<{ path: string; excerpt: string }>): Promise<Array<{ path: string; excerpt: string }>> {
  const root = await realpath(projectRoot);
  const evidence: Array<{ path: string; excerpt: string }> = [];
  for (const item of items) {
    if (item.excerpt.trim().length < 20 || item.excerpt.length > 500) throw new Error("源码引用须为 20–500 字符的原文");
    const path = await realpath(resolve(root, stripReadSelector(item.path)));
    const relativePath = relative(root, path);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../") || isAbsolute(relativePath)) throw new Error("源码引用必须位于项目目录内");
    if (!(await readFile(path, "utf8")).includes(item.excerpt)) throw new Error(`源码引用与当前文件不一致：${item.path}`);
    evidence.push({ path: relativePath.replaceAll("\\", "/"), excerpt: item.excerpt });
  }
  return evidence;
}

export function createDevelopmentReviewTool(ledger: TaskLedger, instanceId: string, projectRoot: string): CustomTool<typeof parameters> {
  return {
    name: "alpha_review_result", label: "Submit independent review", loadMode: "essential", parameters,
    description: "Review source correctness. For pass, cite at least one current source file with an exact excerpt (20+ characters) in evidence. Findings are observations, not test results; configured checks run separately.",
    async execute(_id, args) {
      try {
        if (args.verdict === "pass" && !args.evidence?.length) throw new Error("通过审查需要当前源码引用");
        const evidence = await validateReviewEvidence(projectRoot, args.evidence ?? []);
        await ledger.recordDevelopmentReview({ verdict: args.verdict, findings: args.verdict === "pass" ? ["源码审查通过；配置检查与任务验收分别判定。"] : args.findings, evidence, instanceId });
        return { content: [{ type: "text", text: "源码审查结论已记录；检查和任务验收仍由运行时另行判定。" }] };
      } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
    },
  };
}
