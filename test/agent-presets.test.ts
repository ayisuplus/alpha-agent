// P5 declarations, handoff and gates (docs/plan-graph-and-expert-state-2026-09-29.md §5, §6): built-in experts only
// reference the controlled vocabulary, every referenced role has a claimer, gates gate completion and expire when
// their inputs change, gate roles resolve to an expert or a neutral reviewer, and task-local experts need the user's
// approval to enter the library.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExpertStore, snapshotExpert, type ExpertSnapshot } from "../src/runtime/experts";
import { gateActorFor } from "../src/runtime/expert-selection";
import { TaskLedger, type PlanNode } from "../src/runtime/task-ledger";

const vocab = JSON.parse(await readFile(join(import.meta.dir, "..", "presets", "agents", "roles.json"), "utf8")) as { roles: Array<{ id: string }>; artifactTypes: Array<{ id: string }> };
const index = JSON.parse(await readFile(join(import.meta.dir, "..", "presets", "agents", "index.json"), "utf8")) as { presets: Array<{ id: string; handoff?: { role: string; consumes: string[]; produces: string[]; next: string[]; gate: string[] } }> };

test("built-in experts only reference vocabulary roles and artifact types", () => {
  const roles = new Set(vocab.roles.map(item => item.id));
  const artifacts = new Set(vocab.artifactTypes.map(item => item.id));
  for (const preset of index.presets) {
    const handoff = preset.handoff;
    if (!handoff) continue;
    expect(roles.has(handoff.role), `${preset.id} role ${handoff.role}`).toBe(true);
    for (const item of [...handoff.consumes, ...handoff.produces]) expect(artifacts.has(item), `${preset.id} artifact ${item}`).toBe(true);
    for (const item of [...handoff.next, ...handoff.gate]) expect(roles.has(item), `${preset.id} relation ${item}`).toBe(true);
  }
});

test("every role a handoff references has a built-in expert claiming it", () => {
  const claimed = new Set(index.presets.map(preset => preset.handoff?.role).filter((role): role is string => !!role));
  for (const preset of index.presets) {
    for (const role of [...(preset.handoff?.next ?? []), ...(preset.handoff?.gate ?? [])]) {
      expect(claimed.has(role), `role ${role} referenced by ${preset.id} has no expert`).toBe(true);
    }
  }
});

function node(id: string, kind: PlanNode["kind"], phase: PlanNode["phase"], dependsOn: string[], extra: Partial<PlanNode> = {}): PlanNode {
  return { id, kind, phase, objective: `Work on ${id}`, dependsOn, expertDecision: { reason: "the coordinator works this node itself" }, host: "coordinator", skillIds: [], status: "planned", ...extra };
}

async function gateTask(): Promise<{ ledger: TaskLedger; project: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "alpha-agent-presets-"));
  const project = join(root, "product");
  await Bun.write(join(project, "report.md"), "v1");
  const ledger = await TaskLedger.create(join(root, "state"), {
    objective: "Ship the report", projectRoot: project, taskType: "general", criteria: [],
  });
  await ledger.reviseCognition({
    summary: "Produce and gate the report", reason: "task start", candidates: [],
    nodes: [
      node("scan", "investigate", "investigate", []),
      node("work", "execute", "execute", ["scan"], { produces: ["report"] }),
      node("gate", "review", "review", ["work"], { gateRole: "compliance" }),
    ],
  });
  await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "r1" });
  await ledger.exitNode({ nodeId: "scan", runId: "r1", artifacts: [], findings: [{ claim: "The task needs a report", source: "report.md" }], note: "Scanned", unresolved: [] });
  await ledger.enterNode({ nodeId: "work", host: "coordinator", runId: "r1" });
  const { createHash } = await import("node:crypto");
  const contents = await readFile(join(project, "report.md"));
  await ledger.exitNode({ nodeId: "work", runId: "r1", artifacts: [{ path: "report.md", hash: createHash("sha256").update(contents).digest("hex"), kind: "report" }], note: "Wrote the report", unresolved: [] });
  return { ledger, project, root };
}

test("a gate without a passing verdict blocks completion, and a changed artifact expires the verdict", async () => {
  const { ledger, root } = await gateTask();
  try {
    await ledger.enterNode({ nodeId: "gate", host: "coordinator", runId: "r1" });
    await ledger.exitNode({ nodeId: "gate", runId: "r1", artifacts: [], findings: [{ claim: "The report is off", source: "report.md" }], verdict: "changes-requested", note: "Fix the report", unresolved: ["数字口径待核"] });
    // An unpassed gate blocks completion (§6.2).
    expect(ledger.completionGaps()).toContain("gate");
    await ledger.reopenNode({ nodeId: "gate", reason: "复审" });
    await ledger.enterNode({ nodeId: "gate", host: "coordinator", runId: "r2" });
    await ledger.exitNode({ nodeId: "gate", runId: "r2", artifacts: [], findings: [{ claim: "The report matches", source: "report.md" }], verdict: "pass", note: "Checked the report", unresolved: [] });
    expect(ledger.completionGaps()).toEqual([]);
    // Changing the reviewed artifact expires the verdict: the gate gap returns (§6.2 版本绑定).
    await writeFile(join(ledger.state.projectRoot, "report.md"), "v2");
    await ledger.reopenNode({ nodeId: "work", reason: "重做报告" });
    await ledger.enterNode({ nodeId: "work", host: "coordinator", runId: "r3" });
    await ledger.exitNode({ nodeId: "work", runId: "r3", artifacts: [{ path: "report.md", hash: createHash("sha256").update("v2").digest("hex"), kind: "report" }], note: "Rewrote the report", unresolved: [] });
    expect(ledger.completionGaps()).toContain("gate");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("gate roles resolve to a declaring expert, code-review falls back to a neutral reviewer, others report a gap", () => {
  const declaring = [{ id: "compliance-reviewer", package: { skills: [{ id: "alpha-core:check", hash: "a".repeat(64) }], handoff: { role: "compliance", consumes: [], produces: ["compliance-verdict"], next: [], gate: [] } } }] as unknown as ExpertSnapshot[];
  expect(gateActorFor(declaring, "compliance")).toMatchObject({ expert: { id: "compliance-reviewer" }, neutral: false });
  expect(gateActorFor([], "compliance")).toEqual({ missing: "compliance" });
  expect(gateActorFor([], "code-review")).toEqual({ neutral: true });
  expect(gateActorFor([], "")).toEqual({ neutral: true });
});

test("a task-local expert enters the library only through the user's decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-expert-proposal-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "v1");
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Keep the expert", projectRoot: project, taskType: "general", criteria: [] });
    const id = await ledger.proposeTemporaryExpert({ name: "任务内专家", description: "仅本任务", instructions: "只在本任务使用", skillIds: [] });
    expect(ledger.state.cognition?.expertProposals).toMatchObject([{ id, status: "pending" }]);
    const store = new ExpertStore(join(root, "state"));
    const installed = await store.create({ name: "任务内专家", description: "仅本任务", instructions: "只在本任务使用", skillIds: [] });
    await ledger.decideExpertProposal(id, "installed", installed.id);
    expect(ledger.state.cognition?.expertProposals?.[0]).toMatchObject({ id, status: "installed", installedExpertId: installed.id });
    expect(snapshotExpert(await store.get(installed.id)).name).toBe("任务内专家");
    const rejected = await ledger.proposeTemporaryExpert({ name: "另一个专家", description: "不入库", instructions: "同上", skillIds: [] });
    await ledger.decideExpertProposal(rejected, "rejected");
    expect(ledger.state.cognition?.expertProposals?.[1]).toMatchObject({ id: rejected, status: "rejected" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
