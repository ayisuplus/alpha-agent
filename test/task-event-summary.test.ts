import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../src/runtime/task-ledger";
import { readEvents, taskLogDir } from "../src/runtime/task-events";
import { summarizeTaskEvents } from "../src/runtime/task-event-summary";
import { recordApprovedPlan } from "./support/approved-plan";

async function fixture(): Promise<{ root: string; ledger: TaskLedger }> {
  const root = await mkdtemp(join(tmpdir(), "alpha-event-summary-"));
  const projectRoot = join(root, "project");
  await Bun.write(join(projectRoot, "cart.ts"), "export const total = 0;\n");
  const ledger = await TaskLedger.create(join(root, "data"), {
    objective: "Fix the cart total", projectRoot, taskType: "code-change",
    criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }],
  });
  return { root, ledger };
}

test("the durable track narrates a run and attributes it to the run", async () => {
  const { root, ledger } = await fixture();
  try {
    ledger.bindRun("run-1");
    await recordApprovedPlan(ledger);
    await ledger.recordGuidance("Keep the public API unchanged");
    await ledger.recordEvidence({ criterionId: "check", kind: "test", passed: true, revision: ledger.state.revision!, source: "alpha_check test" });
    await ledger.enableDevelopmentWorkflow();
    await ledger.recordDevelopmentReview({ verdict: "pass", findings: [], instanceId: "primary" });
    await ledger.complete();

    const rows = summarizeTaskEvents(await readEvents(taskLogDir(ledger.file)));
    // Plan-first adds planning rows before the work; the narration contract is that every durable step is labeled.
    expect(rows.map(row => row.label)).toEqual(expect.arrayContaining(["任务创建", "用户补充", "证据 check 通过", "独立审查已启用", "独立审查：通过", "已验收"]));
    expect(rows.at(-1)?.label).toBe("已验收");
    expect(rows.at(-1)?.tone).toBe("success");
    // The task and its skeleton existed before the run was bound, so only the later rows belong to it.
    expect(rows.filter(row => row.runId === null).map(row => row.label)).toEqual(["任务创建", "计划骨架：调查 · 执行 · 审查"]);
    expect(rows.filter(row => row.runId === "run-1").length).toBe(rows.length - 2);
    expect(rows.map(row => row.seq)).toEqual(rows.map((_row, index) => index + 1));
    const guidance = rows.find(row => row.label === "用户补充")!;
    expect(guidance.detail).toBe("Keep the public API unchanged");
    expect(guidance.tone).toBe("info");
    const evidence = rows.find(row => row.label === "证据 check 通过")!;
    expect(evidence.detail).toBe("alpha_check test");
    expect(evidence.tone).toBe("success");
    // Structured references let the workbench join rows without parsing labels.
    expect(evidence.refs).toMatchObject({ criterionId: "check", passed: true });
    expect(evidence.refs?.evidenceId).toBe(ledger.state.evidence[0].id);
    const review = rows.find(row => row.label === "独立审查：通过")!;
    expect(review.refs).toMatchObject({ verdict: "pass", passed: true });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("pauses and stops say which code stopped the task", async () => {
  const { root, ledger } = await fixture();
  try {
    await ledger.needInput("Approve `bun test`?", "approval");
    await ledger.resume("Approved");
    await ledger.recordFailure("Model produced no response within 45000 ms");
    await ledger.stop("model");

    const rows = summarizeTaskEvents(await readEvents(taskLogDir(ledger.file)));
    const paused = rows.find(row => row.type === "status/changed" && row.label.startsWith("需要回答"));
    expect(paused?.label).toBe("需要回答：等待批准");
    expect(paused?.tone).toBe("warning");
    expect(paused?.detail).toBe("Approve `bun test`?");
    expect(rows.find(row => row.label === "已恢复运行")?.tone).toBe("info");
    const stopped = rows.find(row => row.label.startsWith("已停止"));
    expect(stopped?.label).toBe("已停止：模型无响应");
    expect(stopped?.tone).toBe("warning");
    expect(paused?.refs?.pauseReason).toBe("approval");
    expect(stopped?.refs?.stopReason).toBe("model");
    expect(rows.find(row => row.type === "failure/recorded")?.detail).toBe("Model produced no response within 45000 ms");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bookkeeping events stay off the timeline while the ones a person reads do not", async () => {
  const { root, ledger } = await fixture();
  try {
    const guidanceId = await ledger.recordGuidance("Use pnpm");
    await ledger.setGuidanceStatus(guidanceId, "delivered");
    await ledger.setInitialCandidates(["backend"]);
    await ledger.recordFailure("Transient failure");
    await ledger.clearFailure();
    await ledger.prepareWorkerRun();

    const types = summarizeTaskEvents(await readEvents(taskLogDir(ledger.file))).map(row => row.type);
    expect(types).toContain("guidance/recorded");
    expect(types).toContain("failure/recorded");
    for (const silent of ["guidance/status-changed", "candidates/set", "failure/cleared", "worker-run/prepared"]) {
      expect(types).not.toContain(silent);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("long details are truncated for transport", async () => {
  const { root, ledger } = await fixture();
  try {
    await ledger.recordFailure(`Verification step 3/13 failed: ${"x".repeat(400)}`);
    const row = summarizeTaskEvents(await readEvents(taskLogDir(ledger.file))).find(item => item.type === "failure/recorded");
    expect(row?.detail?.length).toBe(241);
    expect(row?.detail?.endsWith("…")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
