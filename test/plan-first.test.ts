import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent";
import { createCognitionTools } from "../src/runtime/cognition-tool";
import { fileToolGuard } from "../src/runtime/file-tool-guard";
import { hasRecordedPlan } from "../src/runtime/planning-policy";
import { TaskLedger } from "../src/runtime/task-ledger";
import { recordApprovedPlan } from "./support/approved-plan";

type ToolCallEvent = { toolName: string; input: unknown };
type ToolCallResult = { block?: boolean; reason?: string } | void;

function toolCallHandler(guard: PreparedExtension): (event: ToolCallEvent) => Promise<ToolCallResult> {
  let captured: ((event: ToolCallEvent) => Promise<ToolCallResult>) | undefined;
  const factory = guard.factory;
  if (!factory) throw new Error("file tool guard factory did not load");
  factory({ on: (name: string, handler: typeof captured) => { if (name === "tool_call") captured = handler; } } as never);
  if (!captured) throw new Error("tool_call hook did not load");
  return captured;
}

async function fixture(startMode: "plan" | "execute") {
  const root = await mkdtemp(join(tmpdir(), "alpha-plan-first-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, "app.ts"), "export const value = 1;\n");
  const ledger = await TaskLedger.create(join(root, "state"), {
    objective: "Change the value", projectRoot, taskType: "code-change",
    criteria: [{ id: "check", description: "Check passes", kind: "test" }], startMode,
  });
  return { root, ledger };
}

test("before a plan is recorded only planning tools run and other calls are rejected at call time", async () => {
  const { root, ledger } = await fixture("execute");
  try {
    expect(hasRecordedPlan(ledger.state)).toBe(false);
    const call = toolCallHandler(fileToolGuard(ledger.state.projectRoot, undefined, [], false, false, undefined, () => !hasRecordedPlan(ledger.state)));
    expect(await call({ toolName: "write", input: { path: "app.ts", content: "changed" } })).toEqual({ block: true, reason: "先用 alpha_plan 记录计划" });
    expect(await call({ toolName: "alpha_spawn", input: {} })).toEqual({ block: true, reason: "先用 alpha_plan 记录计划" });
    // Planning tools stay usable, so the very same run can record the plan and then act.
    expect(await call({ toolName: "read", input: { path: "app.ts" } })).toBeUndefined();
    expect(await call({ toolName: "alpha_plan", input: {} })).toBeUndefined();
    await recordApprovedPlan(ledger);
    expect(hasRecordedPlan(ledger.state)).toBe(true);
    expect(await call({ toolName: "write", input: { path: "app.ts", content: "changed" } })).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("自动批准模式 approves the recorded plan at once and never pauses for review", async () => {
  const { root, ledger } = await fixture("execute");
  try {
    expect(ledger.state.phase).toBe("plan");
    await ledger.reviseCognition({
      summary: "Change the value", reason: "clear task", candidates: [],
      nodes: [
        { id: "inspect", objective: "Check the value", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [], status: "planned" },
        { id: "work", objective: "Update app.ts", kind: "execute", phase: "execute", dependsOn: ["inspect"], expertDecision: { reason: "the coordinator works itself" }, host: "coordinator", skillIds: [], status: "planned" },
        { id: "review", objective: "Check the update", kind: "review", phase: "review", dependsOn: ["work"], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [], status: "planned" },
      ],
    });
    expect(ledger.state.phase).toBe("execute");
    expect(ledger.state.planApproval).toMatchObject({ contractVersion: 1, cognitionRevision: 2 });
    expect(ledger.state.status).toBe("active");
    expect(ledger.state.pendingQuestion).toBeUndefined();
    expect(ledger.state.pauseReason).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("等待审批模式 keeps the plan unapproved until the user reviews it", async () => {
  const { root, ledger } = await fixture("plan");
  try {
    await ledger.reviseCognition({
      summary: "Change the value", reason: "clear task", candidates: [],
      nodes: [
        { id: "inspect", objective: "Check the value", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [], status: "planned" },
        { id: "work", objective: "Update app.ts", kind: "execute", phase: "execute", dependsOn: ["inspect"], expertDecision: { reason: "the coordinator works itself" }, host: "coordinator", skillIds: [], status: "planned" },
        { id: "review", objective: "Check the update", kind: "review", phase: "review", dependsOn: ["work"], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [], status: "planned" },
      ],
    });
    expect(ledger.state.phase).toBe("plan");
    expect(ledger.state.planApproval).toBeUndefined();
    await ledger.submitPlanForReview();
    expect(ledger.state.phase).toBe("plan-review");
    expect(ledger.state.planApproval).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("自动批准模式 re-approves a revised plan against the source as it is now", async () => {
  const { root, ledger } = await fixture("execute");
  const plan = (objective: string) => [
    { id: "inspect", objective: "Check the value", kind: "investigate" as const, phase: "investigate" as const, dependsOn: [], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator" as const, skillIds: [], status: "planned" as const },
    { id: "work", objective, kind: "execute" as const, phase: "execute" as const, dependsOn: ["inspect"], expertDecision: { reason: "the coordinator works itself" }, host: "coordinator" as const, skillIds: [], status: "planned" as const },
    { id: "review", objective: "Check the update", kind: "review" as const, phase: "review" as const, dependsOn: ["work"], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator" as const, skillIds: [], status: "planned" as const },
  ];
  try {
    await ledger.reviseCognition({ summary: "Change the value", reason: "clear task", candidates: [], nodes: plan("Update app.ts") });
    expect(ledger.state.phase).toBe("execute");
    // The coordinator edits source inside the run, then revises an un-entered node. The approval must bind to the
    // source as it is now instead of failing the fingerprint check and parking the task in the review lane.
    await writeFile(join(ledger.state.projectRoot, "app.ts"), "export const value = 2;\n");
    await ledger.reviseCognition({ summary: "Change the value", reason: "learned the real shape", candidates: [], nodes: plan("Update app.ts and its call site") });
    expect(ledger.state.phase).toBe("execute");
    expect(ledger.state.planApproval).toMatchObject({ contractVersion: 1, cognitionRevision: 3 });
    expect(ledger.state.lastFailure ?? null).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("自动批准模式 ends the run at the graph boundary so the next run enters the first node", async () => {
  const { root, ledger } = await fixture("execute");
  try {
    const moved: Array<{ next?: { nodeId: string; sameConfig: boolean } }> = [];
    const tools = createCognitionTools(ledger, join(root, "state"), { onCursorMoved: input => { moved.push(input); } });
    const alphaPlan = tools.find(tool => tool.name === "alpha_plan");
    if (!alphaPlan) throw new Error("alpha_plan tool is missing");
    await alphaPlan.execute("call-1", {
      summary: "Change the value", reason: "clear task", candidates: [], nodes: [
        { id: "inspect", objective: "Check the value", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [] },
        { id: "work", objective: "Update app.ts", kind: "execute", phase: "execute", dependsOn: ["inspect"], expertDecision: { reason: "the coordinator works itself" }, host: "coordinator", skillIds: [] },
        { id: "review", objective: "Check the update", kind: "review", phase: "review", dependsOn: ["work"], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [], gateRole: "code-review" },
      ],
    } as never, undefined, undefined as never);
    expect(ledger.state.phase).toBe("execute");
    // Without the boundary the run keeps a session that predates the graph and no node is ever entered.
    expect(moved).toEqual([{ next: { nodeId: "inspect", sameConfig: false } }]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
