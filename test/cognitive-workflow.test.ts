import { expect, test } from "bun:test";
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
    await ledger.enableDevelopmentWorkflow();
    await ledger.recordEvidence({ criterionId: "build", kind: "build", revision: ledger.state.revision!, passed: true, source: "actual-build-log" });
    await expect(ledger.complete()).rejects.toThrow("development-review");
    await ledger.recordCapabilityGap("method", "Need an accessibility testing method");
    await ledger.recordDevelopmentReview({ verdict: "pass", findings: [], instanceId: "review-1" });
    expect(ledger.completionGaps()).toContain("capability-gap");
    await ledger.resolveCapabilityGap("method", "Need an accessibility testing method", "Existing suite covers this path");
    expect(ledger.completionGaps()).toEqual([]);
    await writeFile(join(projectRoot, "app.ts"), "export const value = 2;\n");
    await ledger.refreshRevision();
    expect(ledger.completionGaps()).toEqual(expect.arrayContaining(["build", "development-review"]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cognition rejects dependency cycles and keeps dispatched expert snapshots", async () => {
  const { root, ledger } = await fixture();
  try {
    await ledger.reviseCognition({ summary: "Change then review", reason: "Analysis", scope: ["app.ts"], constraints: ["Keep existing API"], openQuestions: ["Check callers"], candidates: [], steps: [
      { id: "change", objective: "Change app", mode: "implement", dependsOn: [], skillIds: [], status: "planned" },
      { id: "check", objective: "Review app", mode: "review", dependsOn: ["change"], skillIds: [], status: "planned" },
    ] });
    await expect(ledger.reviseCognition({ summary: "Cycle", reason: "Invalid", candidates: [], steps: [
      { id: "change", objective: "Change", mode: "implement", dependsOn: ["check"], skillIds: [], status: "planned" },
      { id: "check", objective: "Review", mode: "review", dependsOn: ["change"], skillIds: [], status: "planned" },
    ] })).rejects.toThrow("循环依赖");
    await ledger.recordDispatch({ id: "instance-1", orderId: "change", mode: "implement", expert: { id: "expert-a", name: "Expert A", hash: "abc" }, skills: [{ id: "plugin:skill", hash: "123", revision: "rev" }] });
    await ledger.finishDispatch("instance-1", "completed");
    await ledger.reviseCognition({ summary: "Change complete, add inspection", reason: "Implementation returned", candidates: [], steps: [
      { id: "change", objective: "Change app", mode: "implement", dependsOn: [], skillIds: [], status: "planned" },
      { id: "inspect", objective: "Inspect result", mode: "review", dependsOn: ["change"], skillIds: [], status: "planned" },
    ] });
    expect(ledger.state.cognition?.steps[0].status).toBe("complete");
    expect(ledger.state.cognition?.constraints).toEqual(["Keep existing API"]);
    expect(ledger.state.cognition?.openQuestions).toEqual(["Check callers"]);
    await expect(ledger.reviseCognition({ summary: "Rewrite old work", reason: "Invalid", candidates: [], steps: [
      { id: "change", objective: "Different change", mode: "implement", dependsOn: [], skillIds: [], status: "planned" },
    ] })).rejects.toThrow("不可改写");
    const restored = await TaskLedger.load(ledger.file);
    expect(restored.state.cognition?.steps[0].status).toBe("complete");
    expect(restored.state.cognition?.instances?.[0]).toMatchObject({ expert: { id: "expert-a", hash: "abc" }, skills: [{ id: "plugin:skill", hash: "123" }], status: "completed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a newly created expert can be selected in the same task turn", async () => {
  const { root, ledger } = await fixture();
  try {
    const dataRoot = join(root, "state");
    const [plan] = createCognitionTools(ledger, dataRoot);
    const expert = await new ExpertStore(dataRoot).create({ name: "代码审查", description: "检查代码差异", instructions: "检查具体缺陷。", skillIds: [] });
    const result = await plan.execute("plan", { summary: "Use a reviewer", reason: "User requested review", candidates: [expert.id], steps: [{ id: "review", objective: "Check changes", mode: "review", dependsOn: [], expertId: expert.id, skillIds: [] }] }, undefined, undefined as never);
    expect(result.isError).toBeUndefined();
    expect(ledger.state.cognition?.candidates).toEqual([expert.id]);
    await new ExpertStore(dataRoot).setEnabled(expert.id, false);
    const disabled = await plan.execute("plan", { summary: "Use disabled reviewer", reason: "Invalid", candidates: [expert.id], steps: [] }, undefined, undefined as never);
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
    await expect(ledger.reviseCognition({ summary: "New plan", reason: "Model suggestion", candidates: [], steps: [] })).rejects.toThrow("用户指定专家");
    await ledger.reviseCognition({ summary: "Use selected expert", reason: "User selection", candidates: ["expert-chosen"], steps: [{ id: "review", objective: "Review app", mode: "review", dependsOn: [], expertId: "expert-chosen", skillIds: [], status: "planned" }] });
    await ledger.recordEvidence({ criterionId: "check", kind: "test", revision: ledger.state.revision!, passed: true, source: "check.log" });
    expect(ledger.completionGaps()).toContain("designated-expert");
    await ledger.recordDispatch({ id: "instance-1", orderId: "review", mode: "review", expert: { id: "expert-chosen", name: "Chosen", hash: "snapshot" }, skills: [] });
    await ledger.finishDispatch("instance-1", "completed");
    expect(ledger.completionGaps()).toEqual([]);
    await ledger.reviseObjective("Review app and update contract");
    expect(ledger.completionGaps()).toContain("designated-expert");
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
    const [order] = bindWorkOrders([{ id: "inspect", objective: "Inspect app", mode: "investigate", ownedPaths: [], resources: [] }], []);
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
    const [order] = bindWorkOrders([{ id: "review", objective: "Review app", mode: "review", ownedPaths: [], readPaths: ["app.ts"], resources: [] }], []);
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
    const order = { id: "inspect", objective: "Inspect", mode: "review" as const, ownedPaths: [], resources: [] };
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
    const order = { id: "edit", objective: "Edit app", mode: "implement" as const, ownedPaths: ["app.ts"], readPaths: ["app.test.ts"], resources: [] };
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
    const order = { id: "inspect", objective: "Review", mode: "review" as const, ownedPaths: [], resources: [], skillIds: [skill.name] };
    await expect(validateSkillBindings([order], [skill])).rejects.toThrow("未获此工具");
    await validateSkillBindings([{ ...order, mode: "implement", ownedPaths: ["app.ts"] }], [skill]);
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
    expect(stale.eventSeq).toBe(3);
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
