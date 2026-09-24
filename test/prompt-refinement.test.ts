import { expect, test } from "bun:test";
import { PromptRefinementError, protectedTokens, refinePrompt } from "../src/runtime/prompt-refinement";

test("prompt refinement uses separate models and preserves concrete task constraints", async () => {
  const calls: Array<{ model: string; input: { original: string; proposed?: string } }> = [];
  const responses = [
    JSON.stringify({ category: "software", optimized: "构建本机记账本，支持新增支出，且在 375px 宽度可用。", changes: ["整理了功能和屏幕约束"], unresolved: ["是否需要数据持久化"] }),
    JSON.stringify({ faithful: true, english: "Build a local expense tracker that supports adding expenses and works at 375px width.", issues: [] }),
  ];
  const result = await refinePrompt("做本机记账本，能新增支出，375px 也能用", "provider/optimizer", "provider/translator", ".", async (model, _system, input) => {
    calls.push({ model, input: JSON.parse(input) as { original: string; proposed?: string } });
    return responses.shift()!;
  });
  expect(calls.map(call => call.model)).toEqual(["provider/optimizer", "provider/translator"]);
  expect(calls[1].input.proposed).toBe(result.optimized);
  expect(result).toMatchObject({ category: "software", usedOriginal: false, unresolved: ["是否需要数据持久化"], warnings: [] });
  expect(result.english).toContain("375px");
});

test("a dropped literal constraint rejects the rewrite before translation", async () => {
  const calls: Array<{ original: string; proposed?: string }> = [];
  const result = await refinePrompt("只做 2 个页面，网址 https://example.com。", "a/b", "c/d", ".", async (_model, _system, input) => {
    const parsed = JSON.parse(input) as { original: string; proposed?: string };
    calls.push(parsed);
    return calls.length === 1
      ? JSON.stringify({ category: "software", optimized: "做一个页面。", changes: ["精简了"], unresolved: [] })
      : JSON.stringify({ faithful: true, english: "Make only 2 pages. URL: https://example.com.", issues: [] });
  });
  expect(calls[1].proposed).toBe(calls[0].original);
  expect(result.usedOriginal).toBe(true);
  expect(result.optimized).toBe(calls[0].original);
  expect(result.changes).toEqual([]);
  expect(result.warnings.join(" ")).toContain("2");
});

test("fidelity review can reject semantic drift without losing the original", async () => {
  let count = 0;
  const result = await refinePrompt("写一封温和的拒绝邮件", "a/b", "c/d", ".", async () => {
    count++;
    return count === 1
      ? JSON.stringify({ category: "writing", optimized: "写一封严厉的拒绝邮件", changes: ["加强语气"], unresolved: [] })
      : JSON.stringify({ faithful: false, english: "Write a gentle rejection email.", issues: ["语气从温和变成严厉"] });
  });
  expect(result.usedOriginal).toBe(true);
  expect(result.optimized).toBe("写一封温和的拒绝邮件");
  expect(result.warnings).toContain("语气从温和变成严厉");
});

test("invalid or lossy model output fails without a replacement", async () => {
  await expect(refinePrompt("做点东西", "a/b", "c/d", ".", async () => "not json")).rejects.toBeInstanceOf(PromptRefinementError);
  let count = 0;
  await expect(refinePrompt("做 3 个页面", "a/b", "c/d", ".", async () => {
    count++;
    return count === 1
      ? JSON.stringify({ category: "software", optimized: "做 3 个页面", changes: [], unresolved: [] })
      : JSON.stringify({ faithful: true, english: "Make pages.", issues: [] });
  })).rejects.toThrow("英译遗漏");
  expect(protectedTokens("访问 https://example.com。保持 `abc` 和 375px")).toEqual(["https://example.com", "`abc`", "375px"]);
  let auditCount = 0;
  await expect(refinePrompt("写简短邮件", "a/b", "c/d", ".", async () => {
    auditCount++;
    return auditCount === 1
      ? JSON.stringify({ category: "writing", optimized: "写简短邮件", changes: [], unresolved: [] })
      : JSON.stringify({ faithful: true, english: "Write a brief email.", issues: ["漏掉了收件人"] });
  })).rejects.toThrow("互相矛盾");
});
