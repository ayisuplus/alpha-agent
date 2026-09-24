import { expect, test } from "bun:test";
import type { ActivityEntry, ReviewSummary } from "../desktop/ui/src/api/types";
import { fileDiff } from "../desktop/ui/src/state/diff";
import { criterionState, parseEvidence, parseFailure } from "../desktop/ui/src/state/evidence";
import { DEFAULT_RESUME_INSTRUCTION, guidanceText, titleOf } from "../desktop/ui/src/state/labels";
import { attachLiveText, buildTimeline, livePhase, mergeActivity, type Turn } from "../desktop/ui/src/state/timeline";

let clock = Date.parse("2026-09-24T03:00:00.000Z");
function entry(operationId: string | null, kind: ActivityEntry["kind"], value: string, extra: Partial<ActivityEntry> = {}): ActivityEntry {
  clock += 1_000;
  return { id: crypto.randomUUID(), operationId, kind, value, recordedAt: new Date(clock).toISOString(), contractVersion: 1, revision: null, previewId: null, ...extra };
}
const at = (offset: number) => new Date(Date.parse("2026-09-24T03:00:00.000Z") + offset * 1_000).toISOString();
const baseTask = { objective: "构建一个计数器：点击加一", contractVersion: 1, contractHistory: [], guidanceHistory: [], createdAt: at(0) };
const turns = (items: ReturnType<typeof buildTimeline>) => items.filter((item): item is Turn => item.type === "turn");

test("timeline groups one turn per operation, merges streamed text and pairs tool calls", () => {
  clock = Date.parse("2026-09-24T03:00:00.000Z");
  const activity = [
    entry("run-1", "status", "任务已创建"),
    entry("run-1", "text", "I'll read "),
    entry("run-1", "text", "the files."),
    entry("run-1", "tool", "read · 开始", { callId: "a", target: "src/app.js" }),
    entry("run-1", "tool", "read · 开始", { callId: "b", target: "src/index.html" }),
    entry("run-1", "tool", "read · 结束", { callId: "b" }),
    entry("run-1", "tool", "read · 结束", { callId: "a", error: true }),
    entry("run-1", "tool", "edit · 开始"),
    entry("run-1", "tool", "edit · 结束"),
    entry("run-1", "status", "验证构建"),
    entry("run-1", "tool", "build · 通过"),
    entry("run-1", "status", "浏览器验收"),
    entry("run-1", "tool", "browser · 验收失败：Element is obscured: BUTTON", { error: true }),
    entry("run-1", "status", "待验收"),
  ];
  const items = buildTimeline({ task: baseTask, activity, reviews: [], busy: false });
  expect(items[0]).toMatchObject({ type: "objective", version: 1, text: baseTask.objective });
  const [turn] = turns(items);
  expect(turn).toMatchObject({ index: 1, kind: "create", outcome: "待验收", toolCount: 3, modelRun: true, live: false });
  expect(turn.blocks[0]).toMatchObject({ type: "text", text: "I'll read the files." });
  const tools = turn.blocks[1];
  expect(tools.type).toBe("tools");
  if (tools.type !== "tools") throw new Error("unreachable");
  expect(tools.calls.map(call => [call.target ?? call.name, call.state])).toEqual([["src/app.js", "error"], ["src/index.html", "done"], ["edit", "done"]]);
  const checks = turn.blocks.filter(block => block.type === "check");
  expect(checks).toMatchObject([{ name: "build", passed: true }, { name: "browser", passed: false, detail: "Element is obscured: BUTTON" }]);
});

test("timeline pairs legacy tool entries without call ids in order and marks a busy latest turn live", () => {
  clock = Date.parse("2026-09-24T03:00:00.000Z");
  const activity = [
    entry("run-1", "status", "构建中"),
    entry("run-1", "tool", "read · 开始"),
    entry("run-1", "tool", "read · 开始"),
    entry("run-1", "tool", "read · 结束"),
    entry("run-1", "tool", "write · 开始"),
  ];
  const [turn] = turns(buildTimeline({ task: baseTask, activity, reviews: [], busy: true }));
  expect(turn.live).toBe(true);
  expect(turn.kind).toBe("resume");
  const tools = turn.blocks.find(block => block.type === "tools");
  if (tools?.type !== "tools") throw new Error("missing tools");
  expect(tools.calls.map(call => call.state)).toEqual(["done", "running", "running"]);
  const [idle] = turns(buildTimeline({ task: baseTask, activity, reviews: [], busy: false }));
  const settled = idle.blocks.find(block => block.type === "tools");
  if (settled?.type !== "tools") throw new Error("missing tools");
  expect(settled.calls.every(call => call.state === "done")).toBe(true);
});

test("timeline orders objective revisions, guidance and runtime-only operations", () => {
  clock = Date.parse("2026-09-24T03:00:00.000Z");
  const first = [entry("run-1", "status", "任务已创建"), entry("run-1", "text", "Done."), entry("run-1", "status", "已验收")];
  clock += 60_000;
  const revisedAt = new Date(clock).toISOString();
  const second = [entry("run-2", "status", "目标修订至 v2"), entry("run-2", "text", "Adding search."), entry("run-2", "status", "待验收")];
  const steering = new Date(Date.parse(second[1].recordedAt) + 200).toISOString();
  clock += 60_000;
  const savedAt = new Date(clock).toISOString();
  const publish = [entry("pub-1", "status", "本机预览：http://127.0.0.1:5000/"), entry("pub-1", "status", "待验收"), entry("pub-1", "status", "浏览器验收"), entry("pub-1", "status", "已验收")];
  const task = {
    ...baseTask,
    objective: "再加一个按标题搜索",
    contractVersion: 2,
    contractHistory: [{ version: 1, objective: baseTask.objective, revisedAt }],
    guidanceHistory: [
      { id: "g1", instruction: "按钮再大一点", status: "processed" as const, recordedAt: steering },
      { id: "g2", instruction: DEFAULT_RESUME_INSTRUCTION, status: "recorded" as const, recordedAt: savedAt },
    ],
  };
  const reviews: ReviewSummary[] = [
    { operationId: "run-2", contractVersion: 2, revision: null, recordedAt: second[2].recordedAt, paths: ["src/app.js"] },
    { operationId: "old-run", contractVersion: 1, revision: null, recordedAt: at(1), paths: ["src/index.html"] },
  ];
  const items = buildTimeline({ task, activity: [...first, ...second, ...publish], reviews, busy: false });
  expect(items.map(item => item.type === "turn" ? `turn:${item.kind}` : item.type === "objective" ? `v${item.version}` : item.type))
    .toEqual(["v1", "review", "turn:create", "v2", "turn:revise", "guidance", "turn:publish"]);
  const revise = turns(items)[1];
  expect(revise.review?.paths).toEqual(["src/app.js"]);
  expect(revise.blocks.map(block => block.type)).toEqual(["text", "guidance", "phase"]);
  expect(turns(items)[2]).toMatchObject({ modelRun: false, index: 3, outcome: "已验收" });
  expect(turns(items)[2].blocks.map(block => block.type === "phase" ? block.phase : block.type)).toEqual(["本机预览：http://127.0.0.1:5000/", "浏览器验收", "已验收"]);
  expect(guidanceText(DEFAULT_RESUME_INSTRUCTION)).toBe("按当前验收问题继续修复");
});

test("timeline explains tasks recorded before activity history existed", () => {
  const items = buildTimeline({ task: baseTask, activity: [], reviews: [], busy: false });
  expect(items.map(item => item.type)).toEqual(["objective", "legacy"]);
  expect(buildTimeline({ task: baseTask, activity: [], reviews: [], busy: true }).map(item => item.type)).toEqual(["objective"]);
});

test("activity merge ignores duplicates and keeps recorded order", () => {
  clock = Date.parse("2026-09-24T03:00:00.000Z");
  const a = entry("run", "status", "构建中");
  const b = entry("run", "text", "hello");
  const c = entry("run", "status", "待验收");
  const current = [a, c];
  expect(mergeActivity(current, [a, c])).toBe(current);
  expect(mergeActivity(current, [b, b]).map(item => item.id)).toEqual([a.id, b.id, c.id]);
});

test("live text only replaces the live turn and extends its trailing text", () => {
  clock = Date.parse("2026-09-24T03:00:00.000Z");
  const activity = [entry("done", "text", "Earlier."), entry("done", "status", "待验收"), entry("run", "status", "构建中"), entry("run", "text", "Writing ")];
  const items = buildTimeline({ task: baseTask, activity, reviews: [], busy: true });
  const next = attachLiveText(items, "the page", true, at(100));
  const before = turns(items);
  const after = turns(next);
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(after[1].blocks.at(-1)).toMatchObject({ type: "text", text: "Writing the page", live: true });
  expect(attachLiveText(items, "", true, at(100))).toBe(items);
  expect(livePhase(items)).toBe("构建中");
  const empty = buildTimeline({ task: baseTask, activity: [], reviews: [], busy: true });
  expect(turns(attachLiveText(empty, "Starting", true, at(100)))[0]).toMatchObject({ live: true, index: 1 });
});

test("browser evidence keeps the verifier's 1-based step numbers and explains the failed step", () => {
  const reason = 'Verification step 3/9 {"action":"click","selector":"#add"} failed after 2 passing steps: Element is obscured: BUTTON';
  const parsed = parseEvidence(JSON.stringify({ results: [{ index: 1, action: "fill", passed: true }, { index: 2, action: "click", passed: true }], reason }));
  expect(parsed.kind).toBe("browser");
  if (parsed.kind !== "browser") throw new Error("unreachable");
  expect(parsed.steps.map(step => step.index)).toEqual([1, 2]);
  expect(parsed.failure).toEqual({ step: 3, total: 9, spec: { action: "click", selector: "#add" }, passedBefore: 2, message: "Element is obscured: BUTTON" });
  expect(parseFailure("Preview has console errors")).toBeNull();
  expect(parseEvidence("build passed")).toEqual({ kind: "text", text: "build passed" });
  const evidence = [{ id: "e1", criterionId: "user-path", passed: false, source: "", recordedAt: at(1), contractVersion: 1, revision: "r", previewId: "p", current: true }];
  expect(criterionState("user-path", ["user-path"], evidence)).toBe("fail");
  expect(criterionState("build", ["user-path"], evidence)).toBe("pass");
  expect(criterionState("local-preview", ["local-preview"], [])).toBe("pending");
});

test("file diffs count changes with line numbers and handle added files", () => {
  const modified = fileDiff({ path: "src/app.js", before: "a\nb\nc\n", after: "a\nB\nc\nd\n" });
  expect(modified).toMatchObject({ status: "modified", additions: 2, deletions: 1, truncated: false });
  expect(modified.hunks[0].lines.map(line => `${line.kind}:${line.oldNo ?? "-"}:${line.newNo ?? "-"}:${line.text}`))
    .toEqual(["context:1:1:a", "del:2:-:b", "add:-:2:B", "context:3:3:c", "add:-:4:d"]);
  expect(fileDiff({ path: "new.css", before: null, after: "x\ny\n" })).toMatchObject({ status: "added", additions: 2, deletions: 0 });
  expect(fileDiff({ path: "old.css", before: "x\n", after: null })).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
});

test("task titles keep the distinguishing part of the original objective's first clause", () => {
  expect(titleOf("构建一个本机食谱收藏网页：可以新增食谱名称与分类")).toBe("食谱收藏网页");
  expect(titleOf("制作一个本地可用的雨后茶室氛围页，包含视频")).toBe("雨后茶室氛围页");
  expect(titleOf("继续完善这个本地便签网页：保留新增")).toBe("便签网页");
  expect(titleOf("Build a small responsive welcome page. It greets visitors.")).toBe("Responsive welcome page");
  expect(titleOf("Build a tiny static page with a counter button")).toBe("Static page with a counter button");
  expect(titleOf("做：一个很长很长的应用")).toBe("做：一个很长很长的应用");
  expect(titleOf("构建计数器")).toBe("计数器");
});
