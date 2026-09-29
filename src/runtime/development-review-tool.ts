// Review-evidence validation for the paths that actually record review verdicts: a review worker's result
// (worker-result-tool) and subagent messages (agent-mailbox). The session-side `alpha_review_result` tool that used to
// live here was unreachable — review runs are review-kind work orders — and was removed with the reviewer role (§12).
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { stripReadSelector } from "./file-tool-guard";

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
