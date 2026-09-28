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
  const [webProduct] = await recorded();
  const byName = new Map(webProduct.steps.map(step => [step.name, step]));
  const outcome = (name: string) => byName.get(name)?.outcome;
  const error = (name: string) => byName.get(name)?.error;
  for (const name of ["reviseCognition", "submitPlanForReview", "approvePlan", "queueWorker", "updateWorker:completed", "complete", "reopen", "reviseObjective"]) {
    expect(outcome(name)).toBe("ok");
  }
  expect(error("recordGuidance:blank")).toBe("Guidance is required");
  expect(error("submitPlanForReview")).toBeUndefined();
  expect(error("updateStep:during-plan-review")).toBe("Plan is awaiting review");
  expect(error("complete:again")).toBe("Task is complete");
  expect(error("resume:active")).toBe("Only a stopped or waiting task can be resumed");
  expect(error("recordEvidence:stale-revision")).toBe("Evidence revision is stale");
  expect(webProduct.steps.filter(step => step.outcome === "error").length).toBeGreaterThan(20);
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
