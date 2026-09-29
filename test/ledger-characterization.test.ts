import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskLedger } from "../src/runtime/task-ledger";
import { characterizeScenario, probeSteps, scenarios, withScratch, type Characterization } from "./support/ledger-characterization";

async function recorded(): Promise<Characterization[]> {
  return withScratch("alpha-characterization-test-", async root => {
    const results: Characterization[] = [];
    for (const scenario of scenarios) results.push(await characterizeScenario(scenario, root));
    return results;
  });
}

// The P0 baseline for the P1 event-log refactor: every mutating method must replay to exactly the recorded changes.
test("ledger mutations reproduce the recorded characterization baseline", async () => {
  const results = await recorded();
  expect(results.map(item => item.scenario)).toEqual(scenarios.map(item => item.name));
  for (const result of results) {
    const file = join("test", "fixtures", "ledger-characterization", `${result.scenario}.json`);
    const baseline = JSON.parse(await readFile(file, "utf8")) as Characterization;
    expect(result.steps.map(step => step.name)).toEqual(baseline.steps.map(step => step.name));
    for (const [index, step] of result.steps.entries()) {
      expect({ scenario: result.scenario, ...step }).toEqual({ scenario: result.scenario, ...baseline.steps[index] });
    }
    expect(result.finalState).toEqual(baseline.finalState);
  }
});

test("the baseline covers the whole lifecycle, accepted calls and the guards that reject them", async () => {
  const [webProduct, codeChangePlan] = await recorded();
  const byName = new Map(webProduct.steps.map(step => [step.name, step]));
  const outcome = (name: string) => byName.get(name)?.outcome;
  const error = (name: string) => byName.get(name)?.error;
  for (const name of ["reviseCognition", "queueWorker", "updateWorker:completed", "complete", "reopen", "reviseObjective"]) {
    expect(outcome(name)).toBe("ok");
  }
  // 自动批准 approves the plan at once, so the review-lane calls are guards in this scenario, not accepted steps.
  expect(outcome("submitPlanForReview")).toBe("error");
  expect(error("approvePlan")).toBe("Task has no plan awaiting review");
  expect(error("recordGuidance:blank")).toBe("Guidance is required");
  expect(error("complete:again")).toBe("Task is complete");
  expect(error("resume:active")).toBe("Only a stopped or waiting task can be resumed");
  expect(error("recordEvidence:stale-revision")).toBe("Evidence revision is stale");
  // The node lifecycle (§3.4): accepted entries, pauses, resumes and handoffs — and the guards that reject them.
  for (const name of ["enterNode:s1", "exitNode:s1", "enterNode:s2", "waitNode:s2", "enterNode:s2-resume", "exitNode:s2", "enterNode:gate", "exitNode:gate", "enterNode:s3", "exitNode:s3"]) {
    expect(outcome(name)).toBe("ok");
  }
  expect(error("enterNode:s2-early")).toBe("节点前置未完成：s2");
  expect(error("enterNode:gate-early")).toBe("节点所在阶段尚未开放：gate");
  expect(error("enterNode:s2-again")).toBe("节点当前状态不能进入：s2");
  expect(error("enterNode:done")).toBe("节点当前状态不能进入：s1");
  expect(error("enterNode:host-mismatch")).toBe("节点执行位置与计划不符：s2");
  expect(error("enterNode:missing")).toBe("计划中没有节点：missing");
  expect(error("exitNode:blank-note")).toBe("交接记录必须说明做了什么、哪些待核验");
  expect(error("exitNode:s1-no-findings")).toBe("调查节点的发现必须逐条带依据（文件片段、网页来源或用户素材）");
  expect(error("exitNode:s2-no-artifact")).toBe("执行节点缺少声明的产物：patch");
  expect(error("exitNode:s2-not-entered")).toBe("只有进入过的节点可以退出：s2");
  expect(error("exitNode:finished")).toBe("节点已结束：s1");
  expect(error("exitNode:gate-no-verdict")).toBe("审查节点必须给出 gate 结论");
  expect(error("exitNode:s3-ungrounded")).toBe("审查结论必须引用产物或源码原文");
  expect(error("waitNode:s2-again")).toBe("只有进入中的节点可以等待：s2");
  expect(error("waitNode:missing")).toBe("计划中没有节点：missing");
  expect(webProduct.steps.filter(step => step.outcome === "error").length).toBeGreaterThan(20);
  // 等待审批 keeps the plan lane open: submission and approval replay there, and the node board runs the same
  // lifecycle while the plan awaits review (§3.3) — accepted calls and the same rejecting guards.
  const review = new Map(codeChangePlan.steps.map(step => [step.name, step]));
  for (const name of ["reviseCognition", "submitPlanForReview", "approvePlan", "enterNode:s1", "exitNode:s1", "waitNode:s2", "enterNode:s2-resume", "exitNode:s2", "exitNode:s3"]) {
    expect(review.get(name)?.outcome).toBe("ok");
  }
  expect(review.get("enterNode:s2-early")?.error).toBe("节点前置未完成：s2");
  expect(review.get("exitNode:finished")?.error).toBe("节点已结束：s1");
});

// Keeps the baseline honest as the ledger grows: a new mutating method without a probe step fails here, not silently.
test("the probe covers every mutating ledger method", () => {
  // Reads, private helpers and the event-log plumbing are not task mutations, so the probe does not cover them.
  const notMutations = ["completionGaps", "assertActive", "save", "commit", "appendPlanned", "reload", "bindRun", "eventSeq", "eventsFile"];
  const methods = Object.getOwnPropertyNames(TaskLedger.prototype).filter(name => name !== "constructor" && !notMutations.includes(name)).sort();
  const probed = [...new Set(probeSteps.map(step => step.name.split(":")[0]))].sort();
  expect(probed.filter(name => !methods.includes(name))).toEqual([]);
  expect(methods.filter(name => !probed.includes(name))).toEqual([]);
});
