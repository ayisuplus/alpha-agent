// Characterization harness for the task ledger: replays every mutating method against a ledger copy and records the
// normalized before/after state of each call. The recorded output is the P1 refactor's byte-for-byte baseline
// (docs/cognitive-state-machine-plan-2026-09-28.md P0/P1); volatile values are interned so runs are reproducible.
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger, type CognitionStep, type TaskState } from "../../src/runtime/task-ledger";
import type { WorkOrder } from "../../src/runtime/work-orders";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
export const ABSENT = "<absent>";

/** Replaces volatile values (timestamps, ids, source revisions, absolute paths) with stable, run-independent tokens. */
export function createNormalizer(roots: string[]) {
  const seen = new Map<string, string>();
  const used: Record<string, number> = {};
  const ordered = [...new Set(roots.filter(Boolean))].sort((left, right) => right.length - left.length);
  const intern = (kind: string, value: string) => {
    const key = `${kind}\u0000${value}`;
    const existing = seen.get(key);
    if (existing) return existing;
    used[kind] = (used[kind] ?? 0) + 1;
    const token = `<${kind}:${used[kind]}>`;
    seen.set(key, token);
    return token;
  };
  const text = (value: string) => {
    let result = value;
    for (const root of ordered) if (result.includes(root)) result = result.split(root).join(intern("root", root));
    if (TIMESTAMP.test(result)) return intern("at", value);
    if (UUID.test(result)) return intern("id", value);
    if (HASH.test(result)) return intern("rev", value);
    return result;
  };
  const normalize = (value: unknown): unknown =>
    typeof value === "string" ? text(value)
      : Array.isArray(value) ? value.map(normalize)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalize(item)]))
          : value;
  return { normalize, tokens: seen };
}

/** Leaf paths of a state tree: `evidence[0].passed`, `cognition.steps[1].status`. */
export function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const leaves = new Map<string, unknown>();
  if (Array.isArray(value)) {
    value.forEach((item, index) => { for (const [path, leaf] of flatten(item, `${prefix}[${index}]`)) leaves.set(path, leaf); });
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      for (const [path, leaf] of flatten(item, prefix ? `${prefix}.${key}` : key)) leaves.set(path, leaf);
    }
  } else leaves.set(prefix, value ?? null);
  return leaves;
}

export interface StateChange { path: string; before: unknown; after: unknown }

export function diffStates(before: Map<string, unknown>, after: Map<string, unknown>): StateChange[] {
  const changes: StateChange[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const left = before.has(path) ? before.get(path) : ABSENT;
    const right = after.has(path) ? after.get(path) : ABSENT;
    if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ path, before: left, after: right });
  }
  return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Ids the probe created earlier and later steps need; populated while the probe runs. */
export interface ProbeContext { root: string; guidanceId?: string; proposalId?: string; receiptId?: string; requestId?: string }

export interface ProbeStep { name: string; run(ledger: TaskLedger, context: ProbeContext): Promise<unknown> | unknown }

export interface StepRecord { name: string; outcome: "ok" | "error"; error?: string; changed: StateChange[] }

export interface Characterization { scenario: string; steps: StepRecord[]; finalState: unknown }

const budget = { maxToolCalls: 40, wallTimeMs: 600_000, maxTotalToolCalls: 120, totalWallTimeMs: 1_800_000 };
const recordedAt = "2026-09-28T09:00:00.000Z";

function planSteps(expertId: string): CognitionStep[] {
  return [
    { id: "s1", objective: "Read the cart code and list the rounding paths", mode: "investigate", dependsOn: [], skillIds: [], status: "planned" },
    { id: "s2", objective: "Fix the rounding and add a regression test", mode: "implement", dependsOn: ["s1"], skillIds: [], expertId, status: "planned" },
  ];
}

function workOrder(): WorkOrder {
  return {
    id: "s2", objective: "Fix the rounding and add a regression test", ownedPaths: ["src"], resources: [],
    mode: "implement", agentId: "agent-1", acceptance: ["Configured checks pass"], skillIds: [], contextRevision: 1,
    decisionReason: "Probe dispatch for characterization",
  };
}

/**
 * Every mutating ledger method, in an order that lets a planning code task reach acceptance. Steps that a scenario
 * cannot satisfy still run: the thrown guard is part of the behavior P1 must preserve.
 */
export const probeSteps: ProbeStep[] = [
  { name: "recordGuidance", run: async (ledger, context) => { context.guidanceId = await ledger.recordGuidance("Keep the public API unchanged"); } },
  { name: "recordGuidance:blank", run: ledger => ledger.recordGuidance("   ") },
  { name: "setGuidanceStatus:delivered", run: (ledger, context) => ledger.setGuidanceStatus(context.guidanceId!, "delivered") },
  { name: "setGuidanceStatus:processed", run: (ledger, context) => ledger.setGuidanceStatus(context.guidanceId!, "processed") },
  { name: "setGuidanceStatus:unknown", run: ledger => ledger.setGuidanceStatus("missing", "delivered") },
  { name: "setModel:null", run: ledger => ledger.setModel(null) },
  { name: "setModel:unsupported", run: ledger => ledger.setModel("bogus/model") },
  { name: "setGoal:enabled", run: ledger => ledger.setGoal(true, budget) },
  { name: "setGoalProgress", run: ledger => ledger.setGoalProgress(1) },
  { name: "enterPlan", run: ledger => ledger.enterPlan() },
  { name: "reviseCognition", run: ledger => {
    const expertId = ledger.state.designatedExpertId ?? "backend";
    return ledger.reviseCognition({ summary: "Fix cart rounding in two steps", candidates: [expertId, "backend"], steps: planSteps(expertId), reason: "Initial plan", scope: ["src/cart.ts"], constraints: ["No API change"] });
  } },
  { name: "reviseCognition:invalid-step-id", run: ledger => ledger.reviseCognition({ summary: "Bad plan", candidates: [], steps: [{ id: "Bad ID", objective: "x", mode: "implement", dependsOn: [], skillIds: [], status: "planned" }], reason: "probe" }) },
  { name: "reviseCognition:cycle", run: ledger => ledger.reviseCognition({ summary: "Cyclic", candidates: [], steps: [{ id: "a", objective: "x", mode: "implement", dependsOn: ["b"], skillIds: [], status: "planned" }, { id: "b", objective: "y", mode: "implement", dependsOn: ["a"], skillIds: [], status: "planned" }], reason: "probe" }) },
  { name: "updateStep:implement-during-plan", run: ledger => ledger.updateStep("s2", "complete", "Not allowed while planning") },
  { name: "submitPlanForReview", run: ledger => ledger.submitPlanForReview() },
  { name: "updateStep:during-plan-review", run: ledger => ledger.updateStep("s1", "complete", "Rejected while the plan awaits review") },
  { name: "approvePlan", run: ledger => ledger.approvePlan({ contractVersion: ledger.state.contractVersion ?? 1, cognitionRevision: ledger.state.cognition?.revision ?? 1, sourceRevision: ledger.state.revision ?? "" }) },
  { name: "approvePlan:stale", run: ledger => ledger.approvePlan({ contractVersion: 99, cognitionRevision: 99, sourceRevision: "stale" }) },
  { name: "updateStep:investigate-complete", run: ledger => ledger.updateStep("s1", "complete", "Read src/cart.ts and the existing tests") },
  { name: "updateStep:finished-step", run: ledger => ledger.updateStep("s1", "blocked", "Rewrite a finished step") },
  { name: "updateStep:unknown", run: ledger => ledger.updateStep("missing", "complete", "No such step") },
  { name: "setInitialCandidates", run: ledger => ledger.setInitialCandidates(["backend", "test-automation"]) },
  { name: "enableDevelopmentWorkflow", run: ledger => ledger.enableDevelopmentWorkflow() },
  { name: "recordCapabilityGap", run: ledger => ledger.recordCapabilityGap("tool", "No CSV fixture generator") },
  { name: "recordCapabilityGap:duplicate", run: ledger => ledger.recordCapabilityGap("tool", "No CSV fixture generator") },
  { name: "recordSkillSearch", run: async (ledger, context) => {
    await ledger.recordSkillSearch({ key: "csv-fixtures", gapDescription: "No CSV fixture generator", query: "csv fixture", proposals: [{ name: "csv-fixtures", description: "Build CSV fixtures", source: "github.com/example/csv-fixtures", revision: "e".repeat(40), path: "skills/csv-fixtures", installs: 3 }] });
    context.proposalId = ledger.state.cognition?.skillProposals?.[0]?.id;
  } },
  { name: "recordSkillSearch:repeat", run: ledger => ledger.recordSkillSearch({ key: "csv-fixtures", gapDescription: "No CSV fixture generator", query: "csv fixture", proposals: [] }) },
  { name: "decideSkillProposal:installed", run: (ledger, context) => ledger.decideSkillProposal(context.proposalId!, "installed", "csv-fixtures") },
  { name: "decideSkillProposal:again", run: (ledger, context) => ledger.decideSkillProposal(context.proposalId!, "rejected") },
  { name: "resolveCapabilityGap", run: ledger => ledger.resolveCapabilityGap("tool", "No CSV fixture generator", "Wrote the fixture by hand") },
  { name: "resolveCapabilityGap:missing", run: ledger => ledger.resolveCapabilityGap("tool", "Unknown gap", "probe") },
  { name: "recordDispatch", run: ledger => ledger.recordDispatch({ id: "attempt-coordinator", orderId: "coordinator", mode: "investigate", skills: [], decisionReason: "Coordinator inspects first" }) },
  { name: "queueWorker", run: ledger => ledger.queueWorker({ id: "attempt-worker", order: workOrder(), expert: { id: "backend", name: "后端工程师", hash: "f".repeat(64) } }) },
  { name: "queueWorker:duplicate", run: ledger => ledger.queueWorker({ id: "attempt-worker", order: workOrder() }) },
  { name: "recordWorkerActivation", run: ledger => ledger.recordWorkerActivation({ attemptId: "attempt-worker", orderId: "s2", agentId: "agent-1", pid: 4242, workRoot: "workers/attempt-worker", worktreePath: "worker-agents/agent-1/project" }) },
  { name: "recordWorkerCheckReceipt", run: async (ledger, context) => {
    context.receiptId = await ledger.recordWorkerCheckReceipt({ attemptId: "attempt-worker", sourceRevision: ledger.state.revision, passed: true, path: "check-logs/test.log" });
  } },
  { name: "updateWorkerCognition", run: (ledger, context) => ledger.updateWorkerCognition({ understanding: "Rounding happens in two places", findings: [{ text: "alpha_check test passes", evidence: [context.receiptId!] }], openQuestions: [], nextActions: ["Add a regression test"], attemptId: "attempt-worker" }) },
  { name: "updateWorkerCognition:unknown-receipt", run: ledger => ledger.updateWorkerCognition({ understanding: "Cites nothing", findings: [{ text: "Bad citation", evidence: ["missing-receipt"] }], openQuestions: [], nextActions: [], attemptId: "attempt-worker" }) },
  { name: "updateWorker:running", run: ledger => ledger.updateWorker("attempt-worker", "running", { workRoot: "workers/attempt-worker" }) },
  { name: "recordWorkerRequest", run: async (ledger, context) => {
    const request = await ledger.recordWorkerRequest({ id: "request-1", agentId: "agent-1", runId: "attempt-worker", orderId: "s2", kind: "capability", blockedStep: "s2", capabilityIds: ["csv-fixtures"], contractVersion: ledger.state.contractVersion ?? 1, sourceRevision: ledger.state.revision });
    context.requestId = request.id;
  } },
  { name: "recordWorkerRequest:reused-id", run: ledger => ledger.recordWorkerRequest({ id: "request-1", agentId: "other", runId: "attempt-worker", orderId: "s2", kind: "context", blockedStep: "s2", capabilityIds: [], contractVersion: 1, sourceRevision: null }) },
  { name: "updateWorkerRequest:awaiting-approval", run: (ledger, context) => ledger.updateWorkerRequest(context.requestId!, { status: "awaiting-approval" }) },
  { name: "updateWorkerRequest:applied", run: (ledger, context) => ledger.updateWorkerRequest(context.requestId!, { status: "applied", reason: "Installed csv-fixtures" }) },
  { name: "updateWorkerRequest:resolved", run: (ledger, context) => ledger.updateWorkerRequest(context.requestId!, { status: "rejected" }) },
  { name: "updateWorker:returned", run: ledger => ledger.updateWorker("attempt-worker", "returned", { findings: ["Rounding fixed"], integration: "pending" }) },
  { name: "updateWorker:completed", run: ledger => ledger.updateWorker("attempt-worker", "completed", { integration: "merged", integrationDecision: { action: "integrate", reason: "Patch matches the plan", runId: "run-integrate", contractVersion: 1, sourceRevision: ledger.state.revision, recordedAt } }) },
  { name: "recordWorkerResult", run: ledger => ledger.recordWorkerResult({ attemptId: "attempt-worker", stopReason: "completed", findings: ["Rounding fixed"], reviewVerdict: "pass", detail: "Worker submitted alpha_worker_result" }) },
  { name: "recordWorkerMessage", run: ledger => ledger.recordWorkerMessage({ id: "11111111-2222-4333-8444-555555555555", taskId: ledger.state.id, fromAgentId: "agent-1", fromRunId: "attempt-worker", toAgentId: null, kind: "request", body: "Need a capability to continue", evidence: [], contractVersion: ledger.state.contractVersion ?? 1, baseRevision: ledger.state.revision, recordedAt }) },
  { name: "acknowledgeWorkerMessage", run: ledger => ledger.acknowledgeWorkerMessage("11111111-2222-4333-8444-555555555555", null) },
  { name: "updateWorker:missing", run: ledger => ledger.updateWorker("attempt-missing", "completed") },
  { name: "finishDispatch", run: ledger => ledger.finishDispatch("attempt-coordinator", "completed", ["Coordinator inspection recorded"]) },
  { name: "finishDispatch:finished", run: ledger => ledger.finishDispatch("attempt-coordinator", "failed") },
  { name: "recordWorkerOutcome", run: ledger => ledger.recordWorkerOutcome({ status: "completed", findings: ["Cart total rounds to cents"], reviewVerdict: "pass" }) },
  { name: "recordDevelopmentReview:changes-requested", run: ledger => ledger.recordDevelopmentReview({ verdict: "changes-requested", findings: ["Missing edge case test"], instanceId: "attempt-worker" }) },
  { name: "recordRepairAttempt", run: ledger => ledger.recordRepairAttempt() },
  { name: "recordDevelopmentReview:pass", run: ledger => ledger.recordDevelopmentReview({ verdict: "pass", findings: [], instanceId: "attempt-worker", expectedRevision: ledger.state.revision ?? undefined, expectedContractVersion: ledger.state.contractVersion ?? 1 }) },
  { name: "refreshRevision", run: ledger => ledger.refreshRevision() },
  { name: "recordPreview:remote-url", run: ledger => ledger.recordPreview({ id: "preview-remote", revision: ledger.state.revision!, path: join(ledger.state.projectRoot, "preview"), url: "https://example.com/" }) },
  { name: "recordPreview", run: (ledger, context) => ledger.recordPreview({ id: "preview-1", revision: ledger.state.revision!, path: join(context.root, "preview-1"), url: "http://127.0.0.1:8123/" }) },
  { name: "setCriteria", run: ledger => ledger.setCriteria([{ id: "answer", description: "Answers the question", kind: "artifact" }]) },
  { name: "recordEvidence:stale-revision", run: ledger => ledger.recordEvidence({ criterionId: ledger.state.criteria[0]?.id ?? "missing", kind: ledger.state.criteria[0]?.kind ?? "build", passed: true, revision: "0".repeat(64), source: "stale.log" }) },
  { name: "recordEvidence:unknown-criterion", run: ledger => ledger.recordEvidence({ criterionId: "missing", kind: "build", passed: true, revision: ledger.state.revision!, source: "unknown.log" }) },
  { name: "recordEvidence:every-criterion", run: async ledger => {
    for (const criterion of ledger.state.criteria) {
      await ledger.recordEvidence({
        criterionId: criterion.id, kind: criterion.kind, passed: true, revision: ledger.state.revision!,
        ...(criterion.kind === "browser" ? { previewId: ledger.state.preview?.id } : {}),
        ...(criterion.kind === "source" || criterion.kind === "artifact" ? { contentHash: "a".repeat(64) } : {}),
        source: `evidence/${criterion.id}.log`,
      });
    }
  } },
  { name: "addInputs", run: (ledger, context) => ledger.addInputs([{ id: "input-1", name: "notes.txt", path: join(context.root, "inputs", "notes.txt"), mimeType: "text/plain", size: 12, sha256: "c".repeat(64), uploadedAt: recordedAt }]) },
  { name: "setCapabilities", run: ledger => ledger.setCapabilities({ plugins: [{ id: "comfyui", revision: "d".repeat(64) }], skills: [{ id: "csv-fixtures", hash: "e".repeat(64), revision: "f".repeat(40) }] }) },
  { name: "confirmProjectVersion", run: ledger => ledger.confirmProjectVersion(2) },
  { name: "recordRun", run: ledger => ledger.recordRun({ model: "test/model", stage: "coordinator", toolCalls: 4, maxToolCalls: 40, wallTimeMs: 60_000, elapsedMs: 5_000, outcome: "returned" }) },
  { name: "recordFailure", run: ledger => ledger.recordFailure("Browser verification stopped at step 3") },
  { name: "recordFailure:blank", run: ledger => ledger.recordFailure("  ") },
  { name: "clearFailure", run: ledger => ledger.clearFailure() },
  { name: "recordCheckpointStart", run: ledger => ledger.recordCheckpointStart() },
  { name: "recordCheckpoint", run: ledger => ledger.recordCheckpoint({ runId: "run-checkpoint", codeCommits: [{ root: "project", commit: "0".repeat(40) }], memoryCommit: "1".repeat(40), recordedAt }) },
  { name: "recordCheckpointFailure", run: ledger => ledger.recordCheckpointFailure("git commit rejected: nothing staged") },
  { name: "reconcileRunningInstances", run: ledger => ledger.reconcileRunningInstances("Probe reconciled leftover attempts") },
  { name: "prepareWorkerRun", run: ledger => ledger.prepareWorkerRun() },
  { name: "complete", run: ledger => ledger.complete() },
  { name: "complete:again", run: ledger => ledger.complete() },
  { name: "reopen", run: ledger => ledger.reopen("Preview republished and needs verification") },
  { name: "reopen:not-complete", run: ledger => ledger.reopen("Already active") },
  { name: "needInput", run: ledger => ledger.needInput("Approve `bun test src/cart.test.ts`?", "approval") },
  { name: "needInput:blank", run: ledger => ledger.needInput("   ") },
  { name: "resume", run: ledger => ledger.resume("Approved; continue with the regression test") },
  { name: "resume:active", run: ledger => ledger.resume("Nothing to resume") },
  { name: "stop", run: ledger => ledger.stop("error", "Browser verification stopped at step 3") },
  { name: "stop:again", run: ledger => ledger.stop("user") },
  { name: "reviseObjective", run: ledger => ledger.reviseObjective("Fix cart rounding and handle empty carts") },
  { name: "reviseObjective:unchanged", run: ledger => ledger.reviseObjective("Fix cart rounding and handle empty carts") },
  { name: "setGoal:disabled", run: ledger => ledger.setGoal(false) },
  { name: "setGoalProgress:stop", run: ledger => ledger.setGoalProgress(3, "no-progress") },
];

/**
 * Frozen clock. Real time is not reproducible: two writes landing in the same millisecond intern to one token, so the
 * recorded baseline would drift between runs. Each `new Date()` advances exactly one second from a fixed epoch.
 */
const CLOCK_START = Date.parse("2026-09-28T09:00:00.000Z");
const CLOCK_STEP_MS = 1_000;
let clockDepth = 0;

function installProbeClock(): () => void {
  if (clockDepth++ > 0) return () => { clockDepth--; };
  const RealDate = Date;
  let current = CLOCK_START;
  class ProbeDate extends RealDate {
    constructor(value?: string | number | Date) {
      if (value === undefined) { super(current); current += CLOCK_STEP_MS; } else super(value);
    }
    static now(): number { const value = current; current += CLOCK_STEP_MS; return value; }
  }
  globalThis.Date = ProbeDate as unknown as DateConstructor;
  return () => { globalThis.Date = RealDate; clockDepth--; };
}

/** Runs the probe against one ledger and records each step's normalized effect. */
export async function characterizeLedger(scenario: string, ledger: TaskLedger, context: ProbeContext): Promise<Characterization> {
  const restore = installProbeClock();
  try {
    const normalizer = createNormalizer([context.root, ledger.state.projectRoot, ledger.file]);
    const snapshot = () => flatten(normalizer.normalize(JSON.parse(JSON.stringify(ledger.state))));
    const steps: StepRecord[] = [];
    for (const step of probeSteps) {
      const before = snapshot();
      let error: string | undefined;
      try { await step.run(ledger, context); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      steps.push({ name: step.name, ...(error === undefined ? { outcome: "ok" as const } : { outcome: "error" as const, error }), changed: diffStates(before, snapshot()) });
    }
    return { scenario, steps, finalState: normalizer.normalize(JSON.parse(JSON.stringify(ledger.state))) };
  } finally { restore(); }
}

export interface Scenario { name: string; create(root: string): Promise<{ ledger: TaskLedger; context: ProbeContext }> }

async function project(root: string, name: string, files: Record<string, string>) {
  const dir = join(root, name, "project");
  for (const [file, contents] of Object.entries(files)) await Bun.write(join(dir, file), contents);
  return dir;
}

/** The three task shapes that matter: a web product with browser acceptance, a code task that plans first, a general task. */
export const scenarios: Scenario[] = [
  {
    name: "web-product",
    async create(root) {
      const projectRoot = await project(root, "web-product", { "index.html": "<h1>Cart</h1>" });
      const ledger = await TaskLedger.create(join(root, "web-product", "data"), {
        objective: "Build a cart page that shows totals in cents", projectRoot, taskType: "web-product",
        criteria: [{ id: "build", description: "Build succeeds", kind: "build" }, { id: "user-path", description: "Total visible", kind: "browser" }],
        continueUntilAccepted: true, goalBudget: budget,
      });
      return { ledger, context: { root } };
    },
  },
  {
    name: "code-change-plan",
    async create(root) {
      const projectRoot = await project(root, "code-change-plan", { "src/cart.ts": "export const total = (items: number[]) => items.reduce((sum, item) => sum + item, 0);\n" });
      const ledger = await TaskLedger.create(join(root, "code-change-plan", "data"), {
        objective: "Fix cart rounding", projectRoot, taskType: "code-change", startMode: "plan",
        criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }],
        workspaceOrigin: { kind: "copy", checks: [{ name: "test", command: "bun test" }] },
      });
      return { ledger, context: { root } };
    },
  },
  {
    name: "general-needs-input",
    async create(root) {
      const projectRoot = await project(root, "general-needs-input", { "sales.csv": "region,total\nnorth,10\n" });
      const ledger = await TaskLedger.create(join(root, "general-needs-input", "data"), {
        objective: "Summarize the sales CSV", projectRoot, taskType: "general", criteria: [],
        designatedExpertId: "data-analyst",
      });
      await ledger.needInput("Should the summary be a file or an answer?", "question");
      return { ledger, context: { root } };
    },
  },
];

/** Builds a scenario and probes it under one frozen clock, so setup timestamps are reproducible too. */
export async function characterizeScenario(scenario: Scenario, root: string): Promise<Characterization> {
  const restore = installProbeClock();
  try {
    const { ledger, context } = await scenario.create(root);
    return await characterizeLedger(scenario.name, ledger, context);
  } finally { restore(); }
}

/** Copies a real ledger into a scratch directory so the probe never writes to `.alpha`. */
export async function loadLedgerCopy(file: string, scratch: string): Promise<TaskLedger> {
  const state = JSON.parse(await readFile(file, "utf8")) as TaskState;
  const target = join(scratch, "tasks", `${state.id}.json`);
  await mkdir(join(scratch, "tasks"), { recursive: true });
  await copyFile(file, target);
  return TaskLedger.load(target);
}

/** Runs a characterization in a scratch directory and removes it afterwards; callers never touch `.alpha`. */
export async function withScratch<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
