// Exercises the plan-graph lifecycle end to end at the ledger level: skeleton → plan → auto-approval → node entry
// guards → exit conditions → handoffs. Run: bun run scripts/probe-plan-graph.ts
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../src/runtime/task-ledger";

const root = await mkdtemp(join(tmpdir(), "alpha-plan-graph-"));
const project = join(root, "project");
await mkdir(project);
await writeFile(join(project, "a.txt"), "v1");
try {
  const ledger = await TaskLedger.create(join(root, "state"), { objective: "Graph probe", projectRoot: project, taskType: "general", criteria: [] });
  console.log("created:", ledger.state.phase, ledger.state.planApprovalMode, "stages:", (ledger.state.cognition?.stages ?? []).join(","));
  await ledger.reviseCognition({
    summary: "Plan the probe work", reason: "probe", candidates: [],
    nodes: [
      { id: "inspect", objective: "Look at the input", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the probe investigates itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "work", objective: "Produce the report", kind: "execute", phase: "execute", dependsOn: ["inspect"], expertDecision: { reason: "the probe executes itself" }, host: "coordinator", skillIds: [], produces: ["report"], status: "planned" },
      { id: "review", objective: "Check the report", kind: "review", phase: "review", dependsOn: ["work"], expertDecision: { reason: "the probe reviews itself" }, host: "coordinator", skillIds: [], gateRole: "compliance", status: "planned" },
      { id: "gate2", objective: "Second gate without dependencies", kind: "review", phase: "review", dependsOn: [], expertDecision: { reason: "the probe reviews itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ],
  });
  console.log("after plan:", ledger.state.phase, "approved:", !!ledger.state.planApproval, ledger.state.cognition?.nodes.map(node => `${node.id}=${node.status}`).join(" "));

  for (const [label, call] of [
    ["stage-order", () => ledger.enterNode({ nodeId: "gate2", host: "coordinator", runId: "r1" })],
    ["dependency", () => ledger.enterNode({ nodeId: "work", host: "coordinator", runId: "r1" })],
  ] as const) {
    try { await call(); console.log(`FAIL ${label} guard: accepted`); } catch (error) { console.log(`guard ok ${label}:`, error instanceof Error ? error.message : error); }
  }

  await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "r1" });
  try { await ledger.exitNode({ nodeId: "inspect", runId: "r1", artifacts: [], note: "x", unresolved: [] }); console.log("FAIL findings guard: accepted"); } catch (error) { console.log("guard ok findings:", error instanceof Error ? error.message : error); }
  await ledger.exitNode({ nodeId: "inspect", runId: "r1", artifacts: [], findings: [{ claim: "Input seen", source: "a.txt" }], note: "Looked at the input", unresolved: ["OCR not run"] });
  console.log("inspect:", ledger.state.cognition?.nodes[0].status, "handoff:", JSON.stringify(ledger.state.cognition?.nodes[0].handoff?.unresolved));

  await ledger.enterNode({ nodeId: "work", host: "coordinator", runId: "r1" });
  console.log("work access:", ledger.state.cognition?.nodes[1].activation?.access);
  try { await ledger.exitNode({ nodeId: "work", runId: "r1", artifacts: [], note: "done", unresolved: [] }); console.log("FAIL produce guard: accepted"); } catch (error) { console.log("guard ok produce:", error instanceof Error ? error.message : error); }
  await writeFile(join(project, "report.md"), "content");
  const hash = createHash("sha256").update(await readFile(join(project, "report.md"))).digest("hex");
  try { await ledger.exitNode({ nodeId: "work", runId: "r1", artifacts: [{ path: "report.md", hash: "0".repeat(64), kind: "report" }], note: "done", unresolved: [] }); console.log("FAIL hash guard: accepted"); } catch (error) { console.log("guard ok hash:", error instanceof Error ? error.message : error); }
  await ledger.exitNode({ nodeId: "work", runId: "r1", artifacts: [{ path: "report.md", hash, kind: "report" }], note: "Wrote the report", unresolved: [] });

  await ledger.enterNode({ nodeId: "review", host: "coordinator", runId: "r1" });
  console.log("review access:", ledger.state.cognition?.nodes[2].activation?.access);
  try { await ledger.exitNode({ nodeId: "review", runId: "r1", artifacts: [{ path: "report.md", hash, kind: "report" }], findings: [{ claim: "Report matches", source: "report.md" }], note: "checked", unresolved: [] }); console.log("FAIL verdict guard: accepted"); } catch (error) { console.log("guard ok verdict:", error instanceof Error ? error.message : error); }
  await ledger.exitNode({ nodeId: "review", runId: "r1", artifacts: [{ path: "report.md", hash, kind: "report" }], findings: [{ claim: "Report matches", source: "report.md" }], verdict: "pass", note: "Checked the report", unresolved: [] });

  console.log("final:", ledger.state.cognition?.nodes.map(node => `${node.id}=${node.status}`).join(" "), "· gaps:", ledger.completionGaps().join(",") || "none");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
