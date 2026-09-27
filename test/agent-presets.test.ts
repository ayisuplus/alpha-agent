import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPresetStore, presetSnapshot, verifyPresetSnapshot } from "../src/runtime/agent-presets";
import { initialExpertCandidates, searchExpertCandidates } from "../src/runtime/expert-selection";
import { createSkillResourceTool } from "../src/runtime/skill-resource-tool";
import { TaskLedger } from "../src/runtime/task-ledger";
import { workerSystemPrompt } from "../src/runtime/omp-runner";
import { resolveWorkOrders } from "../src/runtime/work-order-tool";
import { fingerprintSource } from "../src/runtime/task-ledger";
import { executeWorkOrders, type WorkOrder } from "../src/runtime/work-orders";
import { SkillPluginStore } from "../src/plugins/third-party";
import { snapshotSkills } from "../src/runtime/model-workers";
import { loadWorkerSkillSnapshots } from "../src/runtime/skill-snapshot";

test("every core specialty is discoverable and dispatches a readable immutable Skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-core-dispatch-"));
  try {
    const store = new AgentPresetStore(root);
    const core = await store.installCoreExperts([]);
    const queries: Record<string, string> = {
      "solution-architect": "模块职责 接口契约 architecture system design",
      "ui-designer": "界面状态 用户流程 UI UX accessibility",
      frontend: "前端 页面逻辑 组件 状态 frontend React TypeScript",
      backend: "后端 数据库 事务 backend database SQL",
      "test-automation": "回归测试 代码审查 testing regression debugging",
      "release-engineer": "部署 健康检查 回滚 deployment release DevOps",
      "literature-researcher": "文献 论文检索 引用核验 literature citations",
      "experiment-designer": "实验设计 消融 数据划分 experiment ablation reproducibility",
      "data-analyst": "统计单位 效应量 置信区间 statistics uncertainty",
      "paper-writer": "论文写作 审稿意见 scientific writing manuscript",
      "content-strategist": "内容策划 平台改编 content strategy copywriting",
      "story-writer": "故事人物 剧本 对白 story screenplay narrative",
      "visual-director": "分镜 音画 视频生成包 visual storyboard video audio",
    };
    expect(core).toHaveLength(Object.keys(queries).length);
    const snapshots = core.map(presetSnapshot);
    for (const [templateId, query] of Object.entries(queries)) {
      const expert = snapshots.find(item => item.id === `core-${templateId}`)!;
      verifyPresetSnapshot(expert);
      expect(searchExpertCandidates(query, snapshots, 1)[0]?.id).toBe(expert.id);
      expect(initialExpertCandidates(query, snapshots)).toContain(expert.id);
      const [order] = resolveWorkOrders([{ id: templateId, objective: query, mode: "investigate", ownedPaths: [], readPaths: ["source.txt"], resources: [], expertId: expert.id }], snapshots);
      const isolated = join(root, "workers", templateId);
      const dispatched = await snapshotSkills(root, isolated, order);
      const skills = await loadWorkerSkillSnapshots(isolated, dispatched);
      expect(skills.map(item => item.name)).toEqual(expert.skillIds!);
      const read = await createSkillResourceTool(skills).execute("probe", { id: skills[0].name, path: "SKILL.md" }, undefined as never, undefined as never, undefined as never);
      expect(read.isError).not.toBe(true);
      expect(read.content).toEqual([{ type: "text", text: await readFile(skills[0].filePath, "utf8") }]);
      expect(workerSystemPrompt(order, expert).join("\n")).toContain(expert.instructions);
    }
    expect(await new SkillPluginStore(root).loadSkills()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("curation retires selected legacy experts without deleting snapshots or overriding edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-core-curation-"));
  try {
    const store = new AgentPresetStore(root);
    const legacy = await store.copy("backend");
    const personal = await store.copy("frontend");
    const frozen = presetSnapshot(legacy);
    const core = await store.installCoreExperts([legacy.id]);
    expect((await store.enabled()).map(item => item.id)).toEqual([personal.id, ...core.map(item => item.id)]);
    expect((await store.get(legacy.id)).enabled).toBe(false);
    expect(presetSnapshot(await store.get(legacy.id))).toEqual(frozen);
    expect(await store.loadBundledSkills(frozen)).toHaveLength(1);
    const edited = await store.update("core-frontend", { name: "我的前端专家" });
    await store.setEnabled(edited.id, false);
    await store.installCoreExperts([]);
    expect(await store.get(edited.id)).toMatchObject({ name: edited.name, hash: edited.hash, enabled: false });
    expect(await store.list()).toHaveLength(15);
    await store.delete(legacy.id);
    expect(await store.loadBundledSkills(frozen)).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a core ID collision cannot partially retire or overwrite the expert library", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-core-conflict-"));
  try {
    const store = new AgentPresetStore(root);
    const legacy = await store.copy("frontend");
    await store.importLocalBatch([{ id: "core-frontend", name: "My unrelated expert", description: "Do not overwrite", instructions: "Preserve me", skills: [], source: { url: "local", revision: "1", path: "mine" } }]);
    const before = await readFile(join(root, "agent-presets.json"), "utf8");
    await expect(store.installCoreExperts([legacy.id])).rejects.toThrow("ID 冲突");
    expect(await readFile(join(root, "agent-presets.json"), "utf8")).toBe(before);
    expect((await store.get(legacy.id)).enabled).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("templates are optional, user experts persist, and deleted experts leave frozen snapshots intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-presets-"));
  try {
    const store = new AgentPresetStore(root);
    const initial = await store.list();
    expect(initial).toEqual([]);
    expect(await store.templates()).toHaveLength(13);
    expect((await store.get("frontend")).skillIds).toEqual(["alpha-core:implement-frontend"]);
    const original = await store.get("frontend");
    const copy = await store.copy("frontend");
    expect(copy.hash).not.toBe(original.hash);
    const frozen = (await store.enabled()).find(item => item.id === copy.id)!;
    const renamed = await store.update(copy.id, { name: "项目前端" });
    expect(renamed.hash).not.toBe(frozen.hash);
    const changed = await store.update(copy.id, { name: "项目前端", description: "负责组件", instructions: "只做分配的组件改动。" });
    expect(changed.hash).not.toBe(frozen.hash);
    expect(frozen.instructions).toBe(original.instructions);
    expect((await store.get("frontend")).hash).toBe(original.hash);
    expect((await new AgentPresetStore(root).get(copy.id)).name).toBe("项目前端");
    await store.setEnabled(copy.id, false);
    expect((await new AgentPresetStore(root).enabled())).toEqual([]);
    const created = await store.create({ name: "审查", description: "复核源码", instructions: "检查实际差异。", skillIds: [] });
    expect((await store.enabled()).map(item => item.id)).toEqual([created.id]);
    await store.delete(created.id);
    expect((await store.list()).map(item => item.id)).toEqual([copy.id]);
    expect(frozen.hash).not.toBe(changed.hash);
    await expect(store.update("frontend", { instructions: "改掉内置内容" })).rejects.toThrow("先复制");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker receives only its selected full role and merge records the frozen version", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-preset-workers-"));
  try {
    const product = join(root, "product");
    await mkdir(join(product, "src"), { recursive: true });
    await writeFile(join(product, "src", "front.txt"), "old");
    await writeFile(join(product, "src", "back.txt"), "old");
    const store = new AgentPresetStore(join(root, "state"));
    const front = await store.copy("frontend");
    const back = await store.copy("backend");
    const presets = await store.enabled();
    const orders: WorkOrder[] = resolveWorkOrders([
      { id: "front", objective: "Edit frontend", ownedPaths: ["src/front.txt"], resources: ["front"], expertId: front.id },
      { id: "back", objective: "Edit backend", ownedPaths: ["src/back.txt"], resources: ["back"], expertId: back.id },
    ], presets).map(order => ({ ...order, fullAccess: true }));
    const frontPrompt = workerSystemPrompt(orders[0], orders[0].preset).join("\n");
    expect(frontPrompt).toContain(orders[0].preset!.instructions);
    expect(frontPrompt).not.toContain(orders[1].preset!.instructions);
    expect(frontPrompt).toContain("src/front.txt");
    expect(frontPrompt).toContain("task hints, not access limits");
    expect(() => resolveWorkOrders([{ ...orders[0], expertId: "missing" }], presets)).toThrow("不存在或未启用");
    expect(() => workerSystemPrompt(orders[0])).toThrow("快照缺失");
    const report = await executeWorkOrders({
      projectRoot: product, dataRoot: join(root, "state"), taskId: "11111111-1111-4111-8111-111111111111", baseRevision: await fingerprintSource(product), orders,
      async runWorker(order, directory) {
        await writeFile(join(directory, order.ownedPaths[0]), order.preset!.name);
        return { evidence: [], unresolved: [] };
      },
    });
    expect(report.status).toBe("merged");
    expect(report.presets?.front.hash).toBe(orders[0].preset!.hash);
    expect(report.presets?.back.id).toBe(back.id);
    expect(await readFile(join(product, "src", "front.txt"), "utf8")).toBe(front.name);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expert package keeps a persona file and private Skill snapshot without global loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-expert-package-"));
  try {
    const pack = join(root, "plugin-packs", "sample");
    await mkdir(join(pack, "skills", "proof"), { recursive: true });
    await writeFile(join(pack, "skills", "proof", "SKILL.md"), "---\nname: proof\ndescription: Check evidence\n---\n\nVerify the claim.\n");
    await writeFile(join(pack, "skills", "proof", "reference.txt"), "fixed reference");
    await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "sample", name: "sample", source: "https://github.com/a/sample.git", revision: "a".repeat(40), enabled: true, skillCount: 1 }] }));
    const experts = new AgentPresetStore(root);
    const created = await experts.create({ name: "Evidence reviewer", description: "Review changes", instructions: "Check concrete evidence.", skillIds: ["sample:proof"] });
    const frozen = (await experts.enabled())[0];
    const packageRoot = join(root, "expert-packs", created.id, created.package!.revision);
    expect(await readFile(join(packageRoot, "PERSONA.md"), "utf8")).toContain("Check concrete evidence.");
    expect(await readFile(join(packageRoot, "skills", "sample", "proof", "reference.txt"), "utf8")).toBe("fixed reference");
    await new SkillPluginStore(root).setEnabled("sample", false);
    expect(await new SkillPluginStore(root).loadSkills()).toEqual([]);
    expect((await experts.loadBundledSkills(frozen)).map(item => item.name)).toEqual(["sample:proof"]);
    const [order] = resolveWorkOrders([{ id: "review", objective: "Review proof", mode: "review", ownedPaths: [], readPaths: ["app.ts"], resources: [], expertId: created.id }], [frozen]);
    const isolated = join(root, "isolated-worker");
    const dispatched = await snapshotSkills(root, isolated, order);
    expect(dispatched.skillSnapshots).toMatchObject([{ id: "sample:proof", hash: created.package!.skills[0].hash }]);
    expect((await new SkillPluginStore(isolated).loadSkills()).map(item => item.name)).toEqual(["sample:proof"]);
    const updated = await experts.update(created.id, { instructions: "Inspect actual diffs." });
    expect(updated.package?.revision).not.toBe(frozen.package?.revision);
    expect((await experts.loadBundledSkills(frozen)).map(item => item.name)).toEqual(["sample:proof"]);
    await experts.delete(created.id);
    expect((await experts.loadBundledSkills(frozen)).map(item => item.name)).toEqual(["sample:proof"]);
    await writeFile(join(packageRoot, "PERSONA.md"), "tampered");
    await expect(experts.loadBundledSkills(frozen)).rejects.toThrow("人设文件与快照不一致");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local expert import keeps bundled Skills private and worker reads its exact snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-local-expert-"));
  try {
    const source = join(root, "source-skill");
    const state = join(root, "state");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: A WorkBuddy name with spaces\ndescription: Check the result\n---\n\nCheck actual output.\n");
    const store = new AgentPresetStore(state);
    const record = { id: "wb-local-review", name: "Local reviewer", description: "Review source", instructions: "Inspect concrete changes.", source: { url: root, revision: "source-v1", path: "review/agents/reviewer.md" }, skills: [{ id: "wb-pack:proof", source }] };
    const [expert] = await store.importLocalBatch([record]);
    expect((await new SkillPluginStore(state).loadSkills())).toEqual([]);
    expect((await store.loadBundledSkills(expert)).map(item => item.name)).toEqual(["wb-pack:proof"]);
    const [order] = resolveWorkOrders([{ id: "review", objective: "Review", mode: "review", ownedPaths: [], readPaths: ["app.ts"], resources: [], expertId: expert.id }], [expert]);
    const isolated = join(root, "worker-state");
    const dispatched = await snapshotSkills(state, isolated, order);
    expect((await loadWorkerSkillSnapshots(isolated, dispatched)).map(item => item.name)).toEqual(["wb-pack:proof"]);
    await store.update(expert.id, { name: "Edited reviewer" });
    const [reimported] = await store.importLocalBatch([record]);
    expect(reimported.name).toBe("Edited reviewer");
    await writeFile(join(isolated, "plugin-packs", "wb-pack", "skills", "proof", "SKILL.md"), "changed");
    await expect(loadWorkerSkillSnapshots(isolated, dispatched)).rejects.toThrow("snapshot changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workbench API lists, copies and edits roles while rejecting another origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-presets-api-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "server.ts")], {
      cwd: root, env: { ...process.env, ALPHA_WORKSPACE_ROOT: root }, stdout: "pipe", stderr: "pipe",
    });
    if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output unavailable");
    const reader = child.stdout.getReader();
    const timeout = setTimeout(() => child?.kill(), 15_000);
    let output = "";
    let port: string | undefined;
    try {
      while (!port) {
        const next = await reader.read();
        if (next.done) break;
        output += new TextDecoder().decode(next.value);
        port = /ALPHA_SERVER_READY (\d+)/.exec(output)?.[1];
      }
    } finally { clearTimeout(timeout); }
    if (!port) throw new Error(`Server did not start: ${output}`);
    const base = `http://127.0.0.1:${port}`;
    const json = { "content-type": "application/json", origin: base };
    const listed = await fetch(`${base}/api/agent-presets`).then(response => response.json()) as { presets: Array<{ id: string; instructions?: string }> };
    expect(listed.presets).toEqual([]);
    const templates = await fetch(`${base}/api/agent-presets/templates`).then(response => response.json()) as { presets: Array<{ id: string; instructions?: string }> };
    expect(templates.presets.find(item => item.id === "frontend")?.instructions).toBeUndefined();
    const detail = await fetch(`${base}/api/agent-presets/frontend`).then(response => response.json()) as { preset: { instructions: string } };
    expect(detail.preset.instructions).toContain("页面逻辑");
    const copied = await fetch(`${base}/api/agent-presets/frontend/copy`, { method: "POST", headers: json, body: "{}" }).then(response => response.json()) as { preset: { id: string } };
    const id = copied.preset.id;
    const forbidden = await fetch(`${base}/api/agent-presets/${id}`, { method: "PUT", headers: { ...json, origin: "http://other.invalid" }, body: "{}" });
    expect(forbidden.status).toBe(403);
    const saved = await fetch(`${base}/api/agent-presets/${id}`, { method: "PUT", headers: json, body: JSON.stringify({ name: "产品前端", description: "实现页面", instructions: "详细的项目角色要求" }) });
    expect(saved.status).toBe(200);
    const toggled = await fetch(`${base}/api/agent-presets/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ enabled: false }) });
    expect(toggled.status).toBe(200);
    const restored = await new AgentPresetStore(join(root, ".alpha")).get(id);
    expect(restored).toMatchObject({ name: "产品前端", enabled: false, instructions: "详细的项目角色要求" });
    const removed = await fetch(`${base}/api/agent-presets/${id}`, { method: "DELETE", headers: json });
    expect(removed.status).toBe(200);
    expect((await new AgentPresetStore(join(root, ".alpha")).list())).toEqual([]);
    const projectRoot = join(root, "products", "skill-task");
    await mkdir(projectRoot, { recursive: true });
    const ledger = await TaskLedger.create(join(root, ".alpha"), { objective: "Inspect a Skill proposal", projectRoot, taskType: "code-change", criteria: [{ id: "check", description: "Check", kind: "test" }] });
    await ledger.recordCapabilityGap("method", "Need a testing method");
    await ledger.recordSkillSearch({ key: "testing", gapDescription: "Need a testing method", query: "testing", proposals: [{ name: "testing", description: "Testing method", source: "https://github.com/example/skills", revision: "a".repeat(40), path: "skills/testing/SKILL.md", installs: 1 }] });
    const proposalId = ledger.state.cognition!.skillProposals![0].id;
    const decisionPath = `${base}/api/tasks/${ledger.state.id}/skills/${proposalId}/decision`;
    expect((await fetch(decisionPath, { method: "POST", headers: { ...json, origin: "http://other.invalid" }, body: JSON.stringify({ decision: "reject" }) })).status).toBe(403);
    const decided = await fetch(decisionPath, { method: "POST", headers: json, body: JSON.stringify({ decision: "reject" }) });
    expect(decided.status).toBe(200);
    const view = await decided.json() as { task: { cognition: { skillProposals: Array<{ status: string }> }; pending: string[] } };
    expect(view.task.cognition.skillProposals[0].status).toBe("rejected");
    expect(view.task.pending).toContain("capability-gap");
    expect((await TaskLedger.load(ledger.file)).state.cognition?.skillProposals?.[0].status).toBe("rejected");
    expect((await fetch(decisionPath, { method: "POST", headers: json, body: JSON.stringify({ decision: "reject" }) })).status).toBe(400);
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
