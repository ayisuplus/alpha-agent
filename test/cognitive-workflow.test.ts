import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../src/runtime/task-ledger";
import { bindWorkOrders } from "../src/runtime/worker-binding";
import { executeWorkOrders } from "../src/runtime/work-orders";
import { publicSkillQuery, discoverForGap } from "../src/runtime/skill-discovery";
import { validateSkillBindings } from "../src/runtime/skill-binding";
import { checkFileToolCall } from "../src/runtime/file-tool-guard";
import { initialExpertCandidates, searchExpertCandidates } from "../src/runtime/expert-selection";
import { SkillPluginStore, hashSkillDirectory } from "../src/plugins/third-party";
import { ExpertStore } from "../src/runtime/experts";
import { createCognitionTools } from "../src/runtime/cognition-tool";
import { createWorkerCapabilityTool } from "../src/runtime/worker-capability-tool";
import { createWorkerResultTool } from "../src/runtime/worker-result-tool";
import { recordApprovedPlan } from "./support/approved-plan";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alpha-cvm-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, "app.ts"), "export const value = 1;\n");
  const ledger = await TaskLedger.create(join(root, "state"), { objective: "Update app", projectRoot, taskType: "code-change", criteria: [{ id: "build", description: "Build passed", kind: "build" }] });
  return { root, projectRoot, ledger };
}

test("review and capability gaps gate completion against the current contract and source", async () => {
  const { root, projectRoot, ledger } = await fixture();
  try {
    await recordApprovedPlan(ledger);
    await ledger.enableDevelopmentWorkflow();
    await ledger.recordEvidence({ criterionId: "build", kind: "build", revision: ledger.state.revision!, passed: true, source: "actual-build-log" });
    await expect(ledger.complete()).rejects.toThrow("gate");
    await ledger.recordCapabilityGap("method", "Need an accessibility testing method");
    await ledger.recordDevelopmentReview({ verdict: "pass", findings: [], instanceId: "review-1" });
    expect(ledger.completionGaps()).toContain("capability-gap");
    await ledger.resolveCapabilityGap("method", "Need an accessibility testing method", "Existing suite covers this path");
    expect(ledger.completionGaps()).toEqual([]);
    await writeFile(join(projectRoot, "app.ts"), "export const value = 2;\n");
    await ledger.refreshRevision();
    expect(ledger.completionGaps()).toEqual(expect.arrayContaining(["build", "gate"]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cognition rejects dependency cycles and keeps dispatched expert snapshots", async () => {
  const { root, ledger } = await fixture();
  try {
    await ledger.reviseCognition({ summary: "Change then review", reason: "Analysis", scope: ["app.ts"], constraints: ["Keep existing API"], openQuestions: ["Check callers"], candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator scans itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "change", objective: "Change app", kind: "execute", phase: "execute", dependsOn: ["scan"], expertDecision: { reason: "the coordinator changes it itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "check", objective: "Review app", kind: "review", phase: "review", dependsOn: ["change"], expertDecision: { reason: "the coordinator reviews itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ] });
    // A cycle needs the same stage now that backwards stage order is rejected on its own terms.
    await expect(ledger.reviseCognition({ summary: "Cycle", reason: "Invalid", candidates: [], nodes: [
      { id: "change", objective: "Change", kind: "execute", phase: "execute", dependsOn: ["check"], expertDecision: { reason: "the coordinator changes it itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "check", objective: "Check", kind: "execute", phase: "execute", dependsOn: ["change"], expertDecision: { reason: "the coordinator checks it itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ] })).rejects.toThrow("循环依赖");
    // An execute node that depends on a review node is the backwards ordering §3.2 forbids.
    await expect(ledger.reviseCognition({ summary: "Backwards", reason: "Invalid", candidates: [], nodes: [
      { id: "change", objective: "Change", kind: "execute", phase: "execute", dependsOn: ["check"], expertDecision: { reason: "the coordinator changes it itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "check", objective: "Review", kind: "review", phase: "review", dependsOn: [], expertDecision: { reason: "the coordinator reviews itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ] })).rejects.toThrow("跨阶段倒挂");
    await ledger.recordDispatch({ id: "instance-1", orderId: "change", kind: "execute", expert: { id: "expert-a", name: "Expert A", hash: "abc" }, skills: [{ id: "plugin:skill", hash: "123", revision: "rev" }] });
    await ledger.finishDispatch("instance-1", "completed");
    await ledger.reviseCognition({ summary: "Change complete, add inspection", reason: "Implementation returned", candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator scans itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "change", objective: "Change app", kind: "execute", phase: "execute", dependsOn: ["scan"], expertDecision: { reason: "the coordinator changes it itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "inspect", objective: "Inspect result", kind: "review", phase: "review", dependsOn: ["change"], expertDecision: { reason: "the coordinator inspects itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ] });
    expect(ledger.state.cognition?.nodes.find(node => node.id === "change")!.status).toBe("done");
    expect(ledger.state.cognition?.constraints).toEqual(["Keep existing API"]);
    expect(ledger.state.cognition?.openQuestions).toEqual(["Check callers"]);
    await expect(ledger.reviseCognition({ summary: "Rewrite old work", reason: "Invalid", candidates: [], nodes: [
      { id: "change", objective: "Different change", kind: "execute", phase: "execute", dependsOn: [], expertDecision: { reason: "the coordinator changes it itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ] })).rejects.toThrow("不可改写");
    const restored = await TaskLedger.load(ledger.file);
    expect(restored.state.cognition?.nodes.find(node => node.id === "change")!.status).toBe("done");
    expect(restored.state.cognition?.instances?.[0]).toMatchObject({ expert: { id: "expert-a", hash: "abc" }, skills: [{ id: "plugin:skill", hash: "123" }], status: "completed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a newly created expert can be selected in the same task turn", async () => {
  const { root, ledger } = await fixture();
  try {
    const dataRoot = join(root, "state");
    const [plan] = createCognitionTools(ledger, dataRoot);
    const expert = await new ExpertStore(dataRoot).create({ name: "代码审查", description: "检查代码差异", instructions: "检查具体缺陷。", skillIds: [] });
    const result = await plan.execute("plan", { summary: "Use a reviewer", reason: "User requested review", candidates: [expert.id], nodes: [
      { id: "scan", objective: "Check the changes", kind: "investigate", phase: "investigate", dependsOn: [], host: "coordinator", expertDecision: { reason: "the coordinator checks itself" }, skillIds: [] },
      { id: "work", objective: "Apply the changes", kind: "execute", phase: "execute", dependsOn: ["scan"], host: "coordinator", expertDecision: { reason: "the coordinator applies them itself" }, skillIds: [] },
      { id: "review", objective: "Check changes", kind: "review", phase: "review", dependsOn: ["work"], host: "coordinator", expertDecision: { expertId: expert.id, reason: "User requested review" }, gateRole: "code-review", skillIds: [] },
    ] }, undefined, undefined as never);
    expect(result.isError).toBeUndefined();
    expect(ledger.state.cognition?.candidates).toEqual([expert.id]);
    await new ExpertStore(dataRoot).setEnabled(expert.id, false);
    const disabled = await plan.execute("plan", { summary: "Use disabled reviewer", reason: "Invalid", candidates: [expert.id], nodes: [] }, undefined, undefined as never);
    expect(disabled.isError).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a user-designated expert stays in the plan and must actually participate", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-pinned-expert-"));
  try {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Review app", projectRoot, taskType: "code-change", designatedExpertId: "expert-chosen", criteria: [{ id: "check", description: "Check", kind: "test" }] });
    await ledger.setInitialCandidates([]);
    expect(ledger.state.cognition?.candidates).toEqual(["expert-chosen"]);
    await expect(ledger.reviseCognition({ summary: "New plan", reason: "Model suggestion", candidates: [], nodes: [] })).rejects.toThrow("用户指定专家");
    await ledger.reviseCognition({ summary: "Use selected expert", reason: "User selection", candidates: ["expert-chosen"], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator scans itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "build", objective: "Prepare review material", kind: "execute", phase: "execute", dependsOn: ["scan"], expertDecision: { reason: "the coordinator prepares it itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "review", objective: "Review app", kind: "review", phase: "review", dependsOn: ["build"], expertDecision: { expertId: "expert-chosen", reason: "User selection" }, host: "coordinator", skillIds: [], status: "planned" },
    ] });
    await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "run-1" });
    await ledger.exitNode({ nodeId: "scan", runId: "run-1", artifacts: [], findings: [{ claim: "App scanned", source: "app.ts" }], note: "Scanned the app", unresolved: [] });
    await ledger.enterNode({ nodeId: "build", host: "coordinator", runId: "run-1" });
    await ledger.exitNode({ nodeId: "build", runId: "run-1", artifacts: [], note: "Prepared the review material", unresolved: [] });
    await ledger.recordEvidence({ criterionId: "check", kind: "test", revision: ledger.state.revision!, passed: true, source: "check.log" });
    expect(ledger.completionGaps()).toContain("plan-graph");
    await ledger.recordDispatch({ id: "instance-1", orderId: "review", kind: "review", expert: { id: "expert-chosen", name: "Chosen", hash: "snapshot" }, skills: [] });
    await ledger.finishDispatch("instance-1", "completed");
    expect(ledger.completionGaps()).toEqual([]);
    await ledger.reviseObjective("Review app and update contract");
    expect(ledger.completionGaps()).toContain("plan-graph");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("general work takes the designated expert's perspective without waiting for a subagent", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-general-expert-"));
  try {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Write notes", projectRoot, taskType: "general", designatedExpertId: "expert-chosen", criteria: [] });
    expect(ledger.state.designatedExpertId).toBe("expert-chosen");
    expect(ledger.completionGaps()).not.toContain("designated-expert");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("neutral read-only work succeeds without edits; reviewer file access is limited", async () => {
  const { root, projectRoot, ledger } = await fixture();
  try {
    const [order] = await bindWorkOrders([{ id: "inspect", objective: "Inspect app", kind: "investigate", ownedPaths: [], resources: [] }], [], [], join(root, "state"));
    expect(order.expert).toBeUndefined();
    const report = await executeWorkOrders({ projectRoot, dataRoot: join(root, "state"), taskId: ledger.state.id, baseRevision: ledger.state.revision!, orders: [order], async runWorker() { return { status: "completed", findings: ["app.ts exports value"], evidence: ["read app.ts"], unresolved: [] }; } });
    expect(report.status).toBe("merged");
    expect(report.committed).toEqual([]);
    await expect(checkFileToolCall("write", { path: "app.ts" }, projectRoot, undefined, [], true)).rejects.toThrow("read-only");
    await expect(checkFileToolCall("grep", { path: "." }, projectRoot, undefined, [], true)).rejects.toThrow("explicit file");
    await writeFile(join(projectRoot, ".env"), "secret");
    await expect(checkFileToolCall("read", { path: ".env" }, projectRoot, undefined, [], true)).rejects.toThrow("protected file");
    for (const suffix of [":10", ":1,2", ":5-", ":-3", ":raw:1-2", ":2-4:raw", ":img"]) {
      await expect(checkFileToolCall("read", { path: `.env${suffix}` }, projectRoot, undefined, [], true)).rejects.toThrow("protected file");
      await expect(checkFileToolCall("grep", { path: `.env${suffix}`, pattern: "secret" }, projectRoot, undefined, [], true)).rejects.toThrow("protected file");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review orders can inspect project source but cannot read secrets or write", async () => {
  const { root, projectRoot } = await fixture();
  try {
    await writeFile(join(projectRoot, "app.test.ts"), "test source\n");
    await writeFile(join(projectRoot, ".env"), "secret\n");
    const [order] = await bindWorkOrders([{ id: "review", objective: "Review app", kind: "review", ownedPaths: [], readPaths: ["app.ts"], resources: [] }], [], [], join(root, "state"));
    expect(order.readPaths).toContain(".");
    await checkFileToolCall("read", { path: "app.test.ts" }, projectRoot, order, [], true);
    await expect(checkFileToolCall("read", { path: ".env" }, projectRoot, order, [], true)).rejects.toThrow("protected file");
    await expect(checkFileToolCall("write", { path: "app.ts" }, projectRoot, order, [], true)).rejects.toThrow("read-only");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker capability requests are persisted and prevent a false completed result", async () => {
  const { root, ledger } = await fixture();
  try {
    const request = createWorkerCapabilityTool(ledger);
    const result = await request.execute("request", { capability: "browser", reason: "Need visual evidence", details: "Inspect the local preview after build" }, undefined, undefined as never);
    expect(result.isError).toBeUndefined();
    const restored = await TaskLedger.load(ledger.file);
    expect(restored.state.workerOutcome?.requests).toMatchObject([{ capability: "browser" }]);
    const order = { id: "inspect", objective: "Inspect", kind: "review" as const, ownedPaths: [], resources: [] };
    const submit = await createWorkerResultTool(restored, order).execute("result", { status: "completed", findings: [], reviewVerdict: "pass" }, undefined, undefined as never);
    expect(submit.isError).toBe(true);
    expect(restored.state.workerOutcome?.status).toBe("needs-context");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker reads only owned or explicitly assigned source paths", async () => {
  const { root, projectRoot } = await fixture();
  try {
    await writeFile(join(projectRoot, "app.test.ts"), "test source\n");
    await writeFile(join(projectRoot, "private.ts"), "private source\n");
    const order = { id: "edit", objective: "Edit app", kind: "execute" as const, ownedPaths: ["app.ts"], readPaths: ["app.test.ts"], resources: [] };
    await checkFileToolCall("read", { path: "app.ts" }, projectRoot, order);
    await checkFileToolCall("grep", { path: "app.test.ts", pattern: "test" }, projectRoot, order);
    const reads: string[] = [];
    await checkFileToolCall("read", { path: "app.test.ts:-40" }, projectRoot, { ...order, fullAccess: true }, [], false, undefined, path => reads.push(path));
    expect(reads).toEqual(["app.test.ts"]);
    await expect(checkFileToolCall("read", { path: "private.ts" }, projectRoot, order)).rejects.toThrow("unassigned file");
    await expect(checkFileToolCall("grep", { path: ".", pattern: "test" }, projectRoot, order)).rejects.toThrow("unassigned file");
    await expect(checkFileToolCall("glob", { pattern: "**/*" }, projectRoot, order)).rejects.toThrow("cannot enumerate");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selected Skill requirements are checked against worker mode", async () => {
  const { root } = await fixture();
  try {
    const directory = join(root, "skill");
    await mkdir(directory);
    const filePath = join(directory, "SKILL.md");
    await writeFile(filePath, "---\nname: sample\nrequires-tools: [edit]\n---\nUse edit.\n");
    const skill = { name: "pack:sample", description: "Sample", filePath, baseDir: directory, source: "test" };
    const order = { id: "inspect", objective: "Review", kind: "review" as const, ownedPaths: [], resources: [], skillIds: [skill.name] };
    await expect(validateSkillBindings([order], [skill])).rejects.toThrow("未获此工具");
    await validateSkillBindings([{ ...order, kind: "execute", ownedPaths: ["app.ts"] }], [skill]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public Skill discovery pins an exact GitHub path and caches the same gap", async () => {
  const { root, ledger } = await fixture();
  try {
    await ledger.recordCapabilityGap("method", "Need React method");
    expect(() => publicSkillQuery("private-product-token react")).toThrow("公开技术词");
    const commit = "a".repeat(40);
    let calls = 0;
    const fetcher = (async (input: string | URL | Request) => {
      calls++;
      const url = String(input);
      if (url.startsWith("https://skills.sh/api/search")) return Response.json({ skills: [{ name: "react", source: "sample/skills", installs: 42 }] });
      if (url.endsWith("/commits/HEAD")) return Response.json({ sha: commit, commit: { tree: { sha: "b".repeat(40) } } });
      if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ type: "blob", path: "skills/react/SKILL.md" }] });
      return new Response("---\nname: react\ndescription: React method\n---\nInstructions");
    }) as typeof fetch;
    const first = await discoverForGap(ledger, "Need React method", "react", fetcher);
    expect(first.candidates).toEqual([{ name: "react", description: "React method", source: "https://github.com/sample/skills", revision: commit, path: "skills/react/SKILL.md", installs: 42, requirements: { tools: [], services: [], conflicts: [] } }]);
    const count = calls;
    expect((await discoverForGap(ledger, "Need React method", "react", fetcher)).cached).toBe(true);
    expect(calls).toBe(count);
    const proposal = ledger.state.cognition?.skillProposals?.[0];
    await ledger.decideSkillProposal(proposal!.id, "rejected");
    expect(ledger.completionGaps()).toContain("capability-gap");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an installed Skill with an external service requirement does not hide the gap", async () => {
  const { root, ledger } = await fixture();
  try {
    await ledger.recordCapabilityGap("method", "Need browser automation method");
    await ledger.recordSkillSearch({ key: "browser", gapDescription: "Need browser automation method", query: "playwright", proposals: [{ name: "browser-method", description: "Browser method", source: "https://github.com/example/skills", revision: "a".repeat(40), path: "skills/browser-method/SKILL.md", installs: 1, requirements: { tools: ["read"], services: ["remote-browser"], conflicts: [] } }] });
    await ledger.decideSkillProposal(ledger.state.cognition!.skillProposals![0].id, "installed", "skill-browser:browser-method");
    expect(ledger.state.cognition?.taskSkillIds).toContain("skill-browser:browser-method");
    expect(ledger.completionGaps()).toContain("capability-gap");
    expect(ledger.state.cognition?.gaps[0].blockingReason).toContain("remote-browser");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a stale ledger handle re-folds instead of overwriting another operation's guidance", async () => {
  const { root, ledger } = await fixture();
  try {
    const first = await TaskLedger.load(ledger.file);
    const stale = await TaskLedger.load(ledger.file);
    await first.recordGuidance("first guidance");
    // The sequence compare-and-swap fails, the stale handle re-folds the winner's event and retries its own append.
    await stale.recordGuidance("stale guidance");
    expect((await TaskLedger.load(ledger.file)).state.guidanceHistory?.map(item => item.instruction)).toEqual(["first guidance", "stale guidance"]);
    expect(stale.state.guidanceHistory?.map(item => item.instruction)).toEqual(["first guidance", "stale guidance"]);
    // The stale handle re-folded up to the log's end; the absolute count is wiring, the equality is the contract.
    expect(stale.eventSeq).toBe((await TaskLedger.load(ledger.file)).eventSeq);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("initial expert matching shortlists without starting instances; legacy Superpowers is inert", async () => {
  const { root } = await fixture();
  try {
    expect(initialExpertCandidates("Fix React frontend component", [
      { id: "front", name: "Frontend", description: "React frontend components", instructions: "Review components", hash: "x", package: { revision: "r", skills: [{ id: "front:react", hash: "h" }] } },
      { id: "data", name: "Database", description: "SQL schema", instructions: "Review schema", hash: "y" },
    ])).toEqual(["front"]);
    expect(searchExpertCandidates("Python SymPy Permutation subclassing source code", [
      { id: "source-radar", name: "Source radar", description: "Content source analysis", instructions: "Content", hash: "x", package: { revision: "r", skills: [{ id: "radar:content", hash: "h" }] } },
      { id: "code-review", name: "Code review", description: "Review source changes", instructions: "Review", hash: "y", package: { revision: "r", skills: [{ id: "review:code", hash: "h" }] } },
    ])).toEqual([]);
    const dataRoot = join(root, "state");
    const skillDir = join(dataRoot, "plugin-packs", "superpowers", "skills", "sample");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: sample\ndescription: Sample\n---\nUse sample.\n");
    await writeFile(join(dataRoot, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "superpowers", name: "Superpowers", source: "https://github.com/obra/superpowers.git", revision: "a".repeat(40), enabled: true, skillCount: 1, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false }] }));
    const store = new SkillPluginStore(dataRoot);
    expect((await store.list())[0].internalized).toBe(true);
    expect(await store.loadSkills()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reapproving an exact installed Skill enables only that valid Skill", async () => {
  const { root } = await fixture();
  try {
    const dataRoot = join(root, "state");
    const revision = "b".repeat(40);
    const id = `skill-testing-${revision.slice(0, 8)}`;
    const skillDir = join(dataRoot, "plugin-packs", id, "skills", "testing");
    await mkdir(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    await writeFile(skillFile, "---\nname: testing\ndescription: Test method\n---\nRun focused checks.\n");
    await writeFile(join(dataRoot, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id, name: "testing", source: "https://github.com/example/skills.git", revision, selectedPath: "skills/testing/SKILL.md", selectedHash: await hashSkillDirectory(skillDir), enabled: false, skillCount: 1, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false }] }));
    const store = new SkillPluginStore(dataRoot);
    const approved = { source: "https://github.com/example/skills", revision, path: "skills/testing/SKILL.md", name: "testing" };
    expect((await store.installSelectedSkill(approved)).skillId).toBe(`${id}:testing`);
    expect((await store.list())[0].enabled).toBe(true);
    await writeFile(skillFile, "invalid Skill contents");
    await expect(store.installSelectedSkill(approved)).rejects.toThrow("内容已变化");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("alpha_step hashes declared artifacts itself instead of asking the model to shell out", async () => {
  const { root, projectRoot, ledger } = await fixture();
  try {
    const tools = createCognitionTools(ledger, join(root, "state"));
    const step = tools.find(tool => tool.name === "alpha_step");
    if (!step) throw new Error("alpha_step tool is missing");
    await ledger.reviseCognition({ summary: "Write the summary", reason: "task start", candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator scans itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "write", objective: "Write the summary", kind: "execute", phase: "execute", dependsOn: ["scan"], produces: ["report"], expertDecision: { reason: "the coordinator writes it itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "inspect", objective: "Inspect the summary", kind: "review", phase: "review", dependsOn: ["write"], expertDecision: { reason: "the coordinator inspects itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ] });
    await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "run-1" });
    await ledger.exitNode({ nodeId: "scan", runId: "run-1", artifacts: [], findings: [{ claim: "Scanned", source: "app.ts" }], note: "Scanned", unresolved: [] });
    await ledger.enterNode({ nodeId: "write", host: "coordinator", runId: "run-1" });
    await Bun.write(join(projectRoot, "report.md"), "# Report\n");
    const result = await step.execute("step-1", { nodeId: "write", artifacts: [{ path: "report.md", kind: "report" }], findings: [], note: "Wrote the summary", unresolved: [] } as never, undefined, undefined as never);
    expect(result.isError).toBeUndefined();
    const handoff = ledger.state.cognition?.nodes.find(node => node.id === "write")!.handoff;
    expect(handoff?.artifacts[0]).toMatchObject({ path: "report.md", kind: "report" });
    expect(handoff?.artifacts[0].hash).toBe(createHash("sha256").update(await Bun.file(join(projectRoot, "report.md")).arrayBuffer().then(bytes => Buffer.from(bytes))).digest("hex"));
    // A missing artifact still fails the exit instead of recording a phantom handoff.
    const missing = await step.execute("step-2", { nodeId: "inspect", artifacts: [{ path: "absent.md", kind: "report" }], findings: [{ claim: "x", source: "y" }], verdict: "pass", note: "n", unresolved: [] } as never, undefined, undefined as never);
    expect(missing.isError).toBe(true);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("alpha_plan rejects a gate role nobody can perform while the plan is still editable", async () => {
  const { root, ledger } = await fixture();
  try {
    const [plan] = createCognitionTools(ledger, join(root, "state"));
    const rejected = await plan.execute("plan", { summary: "Do the task", reason: "task start", candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], host: "coordinator", expertDecision: { reason: "the coordinator scans itself" }, skillIds: [] },
      { id: "work", objective: "Change app", kind: "execute", phase: "execute", dependsOn: ["scan"], host: "coordinator", expertDecision: { reason: "the coordinator changes it itself" }, skillIds: [] },
      { id: "self-check", objective: "Check itself", kind: "review", phase: "review", dependsOn: ["work"], host: "coordinator", expertDecision: { reason: "the coordinator checks itself" }, skillIds: [], gateRole: "self-check" },
      { id: "review", objective: "Check the change", kind: "review", phase: "review", dependsOn: ["work"], host: "coordinator", expertDecision: { reason: "the coordinator checks itself" }, skillIds: [], gateRole: "code-review" },
    ] } as never, undefined, undefined as never);
    expect(rejected.isError).toBe(true);
    expect(String(rejected.content[0].type === "text" ? rejected.content[0].text : "")).toContain("没有已启用专家能承担 gate");
    // The task type's own gate stays acceptable: code-review has the neutral reviewer.
    const accepted = await plan.execute("plan-2", { summary: "Do the task", reason: "task start", candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], host: "coordinator", expertDecision: { reason: "the coordinator scans itself" }, skillIds: [] },
      { id: "work", objective: "Change app", kind: "execute", phase: "execute", dependsOn: ["scan"], host: "coordinator", expertDecision: { reason: "the coordinator changes it itself" }, skillIds: [] },
      { id: "review", objective: "Check the change", kind: "review", phase: "review", dependsOn: ["work"], host: "coordinator", expertDecision: { reason: "the coordinator checks itself" }, skillIds: [], gateRole: "code-review" },
    ] } as never, undefined, undefined as never);
    expect(accepted.isError).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("alpha_plan rejects a worker-hosted node when the task type cannot dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-host-check-"));
  try {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Write a summary", projectRoot, taskType: "general", criteria: [] });
    const [plan] = createCognitionTools(ledger, join(root, "state"));
    const workOrderNode = { id: "draft", objective: "Draft the summary", kind: "execute", phase: "execute", dependsOn: [], host: "worker", expertDecision: { reason: "a specialist writes it" }, skillIds: [] };
    const rejected = await plan.execute("plan", { summary: "Do the task", reason: "task start", candidates: [], nodes: [
      { id: "scan", objective: "Read the material", kind: "investigate", phase: "investigate", dependsOn: [], host: "coordinator", expertDecision: { reason: "the coordinator reads it" }, skillIds: [] },
      { ...workOrderNode, id: "work" },
      { id: "review", objective: "Check the summary", kind: "review", phase: "review", dependsOn: ["work"], host: "coordinator", expertDecision: { reason: "the coordinator checks it" }, skillIds: [] },
    ] } as never, undefined, undefined as never);
    expect(rejected.isError).toBe(true);
    expect(String(rejected.content[0].type === "text" ? rejected.content[0].text : "")).toContain("不派发子代理");
    const accepted = await plan.execute("plan-2", { summary: "Do the task", reason: "task start", candidates: [], nodes: [
      { id: "scan", objective: "Read the material", kind: "investigate", phase: "investigate", dependsOn: [], host: "coordinator", expertDecision: { reason: "the coordinator reads it" }, skillIds: [] },
      { id: "work", objective: "Draft the summary", kind: "execute", phase: "execute", dependsOn: ["scan"], host: "coordinator", expertDecision: { reason: "the coordinator drafts it" }, skillIds: [] },
      { id: "review", objective: "Check the summary", kind: "review", phase: "review", dependsOn: ["work"], host: "coordinator", expertDecision: { reason: "the coordinator checks it" }, skillIds: [] },
    ] } as never, undefined, undefined as never);
    expect(accepted.isError).toBeUndefined();
    expect(ledger.state.cognition?.nodes.every(node => node.host === "coordinator")).toBe(true);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("a plan cannot order stages backwards", async () => {
  const { root, ledger } = await fixture();
  try {
    const [plan] = createCognitionTools(ledger, join(root, "state"));
    const rejected = await plan.execute("plan", { summary: "Do the task", reason: "task start", candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], host: "coordinator", expertDecision: { reason: "the coordinator scans itself" }, skillIds: [] },
      { id: "review", objective: "Check the plan", kind: "review", phase: "review", dependsOn: ["scan"], host: "coordinator", expertDecision: { reason: "the coordinator checks itself" }, skillIds: [] },
      { id: "work", objective: "Change app", kind: "execute", phase: "execute", dependsOn: ["review"], host: "coordinator", expertDecision: { reason: "the coordinator changes it itself" }, skillIds: [] },
    ] } as never, undefined, undefined as never);
    expect(rejected.isError).toBe(true);
    expect(String(rejected.content[0].type === "text" ? rejected.content[0].text : "")).toContain("跨阶段倒挂");
    // The same rule holds for the ledger itself (legacy callers): the reducer refuses the ordering too.
    await expect(ledger.reviseCognition({ summary: "Backwards", reason: "invalid", candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator scans itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "check", objective: "Check", kind: "review", phase: "review", dependsOn: ["scan"], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "work", objective: "Change app", kind: "execute", phase: "execute", dependsOn: ["check"], expertDecision: { reason: "the coordinator changes it itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ] })).rejects.toThrow("跨阶段倒挂");
    // A conforming order — the review stage last — records fine.
    const accepted = await plan.execute("plan-2", { summary: "Do the task", reason: "task start", candidates: [], nodes: [
      { id: "scan", objective: "Scan app", kind: "investigate", phase: "investigate", dependsOn: [], host: "coordinator", expertDecision: { reason: "the coordinator scans itself" }, skillIds: [] },
      { id: "work", objective: "Change app", kind: "execute", phase: "execute", dependsOn: ["scan"], host: "coordinator", expertDecision: { reason: "the coordinator changes it itself" }, skillIds: [] },
      { id: "review", objective: "Check the change", kind: "review", phase: "review", dependsOn: ["work"], host: "coordinator", expertDecision: { reason: "the coordinator checks itself" }, skillIds: [], gateRole: "code-review" },
    ] } as never, undefined, undefined as never);
    expect(accepted.isError).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
