import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExpertStore } from "../src/runtime/experts";
import { capabilityPool, expertSkillId, resolvePoolSkill } from "../src/runtime/capability-pool";
import { createSkillResourceTool } from "../src/runtime/skill-resource-tool";
import { createCapabilityMCPTool } from "../src/runtime/capability-mcp-tool";
import { MCPPermissionStore } from "../src/runtime/mcp-permissions";
import { createWorkerMCPProxyTools, parseWorkerMCPRequest, writeWorkerMCPResponse } from "../src/runtime/worker-mcp-proxy";
import { snapshotSkills } from "../src/runtime/model-workers";
import { loadWorkerSkillSnapshots } from "../src/runtime/skill-snapshot";
import { bindWorkOrders } from "../src/runtime/worker-binding";
import { TaskLedger } from "../src/runtime/task-ledger";
import { WorkerSupervisor } from "../src/runtime/worker-supervisor";
import { executeWorkOrders, type WorkOrder } from "../src/runtime/work-orders";
import { AgentMailbox, createWorkerMailboxTools } from "../src/runtime/agent-mailbox";
import { commandApprovalStore } from "../src/runtime/command-approval";

async function git(root: string, ...args: string[]) {
  const process = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (code) throw new Error(stderr);
}

test("expert Skills are distinct catalog entries and only selected versions reach workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-capability-pool-"));
  try {
    const source = join(root, "source");
    const data = join(root, "data");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: proof\ndescription: Verify evidence\n---\n\nUse the source.\n");
    const store = new ExpertStore(data);
    const records = ["first", "second"].map(id => ({ id, name: id, description: "Review", instructions: "Check evidence.", source: { url: root, revision: "v1", path: `${id}.md` }, skills: [{ id: "source:proof", source }] }));
    const [first, second] = await store.importLocalBatch(records);
    const plugin = join(data, "plugin-packs", "sample");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: ["-e", `await Bun.write('${join(root, "started.txt").replaceAll("\\", "/")}', 'started')`] } } }));
    await writeFile(join(data, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "sample", name: "sample", source: "https://github.com/example/sample.git", revision: "a".repeat(40), enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 1, mcpEnabled: true }] }));
    const catalog = await capabilityPool(data);
    const id = expertSkillId(first.id, "source:proof");
    expect(catalog.filter(item => item.name === "source:proof").map(item => item.id)).toEqual([id, expertSkillId(second.id, "source:proof")]);
    expect(catalog).toContainEqual(expect.objectContaining({ id: "alpha_sample_echo", kind: "mcp-server", enabled: true }));
    expect(await Bun.file(join(root, "started.txt")).exists()).toBe(false);
    const reader = createSkillResourceTool([], async skillId => (await resolvePoolSkill(data, skillId)).skill);
    expect((await reader.execute("read", { id, path: "SKILL.md" }, undefined, undefined as never)).content[0]).toMatchObject({ text: expect.stringContaining("Use the source") });
    const [unbound] = bindWorkOrders([{ id: "review", objective: "Review", mode: "review", ownedPaths: [], readPaths: ["."], resources: [], expertId: first.id }], await store.enabled(), []);
    expect(unbound.skillIds).toEqual([]);
    const bound = await snapshotSkills(data, join(root, "worker"), { ...unbound, capabilityIds: [id] });
    expect(bound.capabilitySnapshots).toMatchObject([{ id, kind: "skill" }]);
    expect((await loadWorkerSkillSnapshots(join(root, "worker"), bound)).map(item => item.name)).toEqual([id]);
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, "entry.txt"), "source");
    const ledger = await TaskLedger.create(data, { objective: "Read only", projectRoot: project, taskType: "code-change", criteria: [{ id: "review", description: "Review source", kind: "asset" }] });
    const supervisor = new WorkerSupervisor({ ledger, dataRoot: data, remainingCalls: () => 1000 });
    const readOnly: WorkOrder = { id: "review", objective: "Review", mode: "review", ownedPaths: [], readPaths: ["entry.txt"], resources: [], acceptance: ["Check entry"], fullAccess: true, agentId: crypto.randomUUID(), instanceId: crypto.randomUUID() };
    await expect(supervisor.spawn([{ ...readOnly, capabilityIds: ["alpha_sample_echo"] }])).rejects.toThrow("individual MCP tool bindings");
    const builtin = catalog.find(item => item.kind === "builtin-tool")!;
    await expect(supervisor.spawn([{ ...readOnly, capabilityIds: [builtin.id] }])).rejects.toThrow("Read-only worker cannot use");
    await supervisor.cancelAll();
    await ledger.queueWorker({ id: readOnly.instanceId!, order: readOnly });
    const stateRoot = join(data, "worker-agents", ledger.state.id, readOnly.agentId!, "state");
    const [send] = createWorkerMailboxTools(stateRoot, ledger.state.id, readOnly);
    expect((await send.execute("gap", { kind: "capability", body: "Need proof", request: { kind: "capability", blockedStep: "Read proof", capabilityIds: [id] } }, undefined, undefined as never)).isError).toBeUndefined();
    const mailbox = new AgentMailbox(data, ledger);
    await mailbox.collect();
    expect(ledger.state.workerRequests?.[0]).toMatchObject({ kind: "capability", capabilityIds: [id], status: "open" });
    await store.setEnabled(first.id, false);
    expect((await capabilityPool(data)).find(item => item.id === id)?.enabled).toBe(false);
    const continued = await snapshotSkills(data, join(root, "worker"), bound);
    expect(continued.skillSnapshots?.[0].hash).toBe(bound.skillSnapshots?.[0].hash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency approval resumes the same worker and includes manifest and lock changes in review", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-worker-install-"));
  const projectRoot = join(root, "project");
  const dataRoot = join(root, "data");
  await mkdir(projectRoot);
  try {
    await git(projectRoot, "init");
    await git(projectRoot, "config", "user.email", "test@example.com");
    await git(projectRoot, "config", "user.name", "Test");
    await mkdir(join(projectRoot, "vendor", "helper"), { recursive: true });
    await writeFile(join(projectRoot, "vendor", "helper", "package.json"), '{"name":"probe-helper","version":"1.0.0","main":"index.js"}');
    await writeFile(join(projectRoot, "vendor", "helper", "index.js"), "exports.value = 1;\n");
    await writeFile(join(projectRoot, "package.json"), '{"name":"probe","private":true,"dependencies":{}}');
    await git(projectRoot, "add", ".");
    await git(projectRoot, "commit", "-m", "base");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Use a dependency", projectRoot, taskType: "code-change", criteria: [{ id: "result", description: "Verified result", kind: "test" }] });
    const agentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const argv = [process.execPath, "add", "./vendor/helper"];
    let runs = 0;
    const makeSupervisor = (current: TaskLedger) => new WorkerSupervisor({ ledger: current, dataRoot, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
      async runWorker(order, directory) {
        await input.onWorkerEvent?.(order, "started");
        runs++;
        if (runs === 1) {
          const stateRoot = join(dataRoot, "worker-agents", ledger.state.id, agentId, "state");
          const [send] = createWorkerMailboxTools(stateRoot, ledger.state.id, order);
          const result = await send.execute("missing-dependency", { kind: "request", body: "Need added package", request: { kind: "dependency", blockedStep: "Run the feature check", proposedArgv: argv, targetEnvironment: "." } }, undefined, undefined as never);
          if (result.isError) throw new Error(JSON.stringify(result.content));
          return { status: "needs-context", findings: ["Need added package"], evidence: [], unresolved: ["Need added package"] };
        }
        const install = order.install!;
        const receipt = await commandApprovalStore(dataRoot).execute(ledger.state.id, directory, install.argv, "other", undefined, undefined, undefined, false, install.approvalId, install.requestId);
        const available = await Bun.file(join(directory, install.availabilityPath, "package.json")).exists();
        await input.onInstallReceipt?.(order, receipt, available);
        expect(receipt.status).toBe("complete");
        expect(receipt.result?.exitCode).toBe(0);
        expect(available).toBe(true);
        return { status: "completed", findings: ["Installed and checked"], evidence: [receipt.result!.logPath], unresolved: [] };
      },
    }) });
    let supervisor = makeSupervisor(ledger);
    const order: WorkOrder = { id: "build", objective: "Build feature", decisionReason: "Independent implementation", mode: "implement", ownedPaths: ["package.json", "bun.lock"], readPaths: [], resources: ["dependency"], acceptance: ["Change manifest and lock"], fullAccess: true, agentId, instanceId: runId };
    const [first] = await supervisor.spawn([order]);
    const firstResult = (await supervisor.wait([first], 10_000))[0];
    expect({ status: firstResult.instance.status, findings: firstResult.instance.findings, reason: firstResult.report?.reason }).toEqual({ status: "blocked", findings: ["Need added package"], reason: expect.any(String) });
    const [request] = ledger.state.workerRequests ?? [];
    expect(request).toMatchObject({ kind: "dependency", status: "open", runId: first });
    expect(ledger.completionGaps()).toContain("worker-request");
    const pending = await supervisor.resolveRequest(request.id, "install", "Add requested dependency", { argv, availabilityPath: "node_modules/probe-helper" });
    expect(pending.status).toBe("awaiting-approval");
    expect(runs).toBe(1);
    await supervisor.cancelAll();
    const restored = await TaskLedger.load(join(dataRoot, "tasks", `${ledger.state.id}.json`));
    expect(restored.state.workerRequests?.[0]).toMatchObject({ id: request.id, approvalId: pending.approvalId, status: "awaiting-approval" });
    supervisor = makeSupervisor(restored);
    await commandApprovalStore(dataRoot).decide(ledger.state.id, pending.approvalId!, true);
    await supervisor.resumeApprovedRequest(request.id);
    const second = restored.state.workerRequests![0].resolutionRunId!;
    const reviewed = (await supervisor.wait([second], 10_000))[0];
    expect(reviewed.instance.status).toBe("returned");
    expect(reviewed.diff).toContain("bun.lock");
    expect(reviewed.diff).toContain("package.json");
    expect(restored.state.workerRequests?.[0].status).toBe("applied");
    expect(restored.state.cognition?.agents?.[0].contextRevision).toBe(2);
    expect(await supervisor.resolveRequest(request.id, "install", "Duplicate call")).toMatchObject({ status: "applied", runId: second });
    expect(runs).toBe(2);
    expect((await supervisor.integrate(second, "Manifest and lock reviewed")).status).toBe("merged");
    expect(await readFile(join(projectRoot, "bun.lock"), "utf8")).toContain("probe-helper");
    expect(await readFile(join(projectRoot, "package.json"), "utf8")).toContain("probe-helper");
    expect(restored.completionGaps()).toContain("result");
    await supervisor.cancelAll();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed installation receipt cannot be replayed or shared across worker requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-install-receipt-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    const store = commandApprovalStore(root);
    const taskId = crypto.randomUUID();
    const argv = [process.execPath, "-e", "const n = Number(await Bun.file('count.txt').text().catch(() => '0')); await Bun.write('count.txt', String(n + 1)); process.exit(2)"];
    const first = await store.request(taskId, project, argv, "other", false, "request-one");
    const separate = await store.request(taskId, project, argv, "other", false, "request-two");
    expect(separate.id).not.toBe(first.id);
    await store.decide(taskId, first.id, true);
    const receipt = await store.execute(taskId, project, argv, "other", undefined, undefined, undefined, false, first.id, "request-one");
    expect(receipt).toMatchObject({ status: "complete", result: { exitCode: 2 } });
    expect((await store.execute(taskId, project, argv, "other", undefined, undefined, undefined, false, first.id, "request-one")).id).toBe(first.id);
    expect(await readFile(join(project, "count.txt"), "utf8")).toBe("1");
    await expect(store.execute(taskId, project, argv, "other", undefined, undefined, undefined, false, first.id, "request-two")).rejects.toThrow("does not match");
    await writeFile(join(project, "changed.txt"), "independent change");
    await expect(store.execute(taskId, project, argv, "other", undefined, undefined, undefined, false, first.id, "request-one")).rejects.toThrow("workspace changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the coordinator opens MCP only on demand and retains per-tool permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-on-demand-mcp-"));
  try {
    const project = join(root, "project");
    const pack = join(root, "plugin-packs", "sample");
    await mkdir(project);
    await mkdir(pack, { recursive: true });
    await copyFile(join(import.meta.dir, "fixtures", "echo-mcp.ts"), join(pack, "echo-mcp.ts"));
    await writeFile(join(pack, ".mcp.json"), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: ["${PLUGIN_ROOT}/echo-mcp.ts"], timeout: 5_000 } } }));
    await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "sample", name: "sample", source: "https://github.com/example/sample.git", revision: "a".repeat(40), enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 1, mcpEnabled: true }] }));
    const serverId = "alpha_sample_echo";
    expect((await capabilityPool(root)).find(item => item.id === serverId)).toMatchObject({ kind: "mcp-server", enabled: true });
    const approvals: string[] = [];
    const tool = createCapabilityMCPTool(root, project, crypto.randomUUID(), async reason => { approvals.push(reason); });
    const listed = await tool.execute("list", { serverId, action: "list" }, undefined, undefined as never);
    expect(listed.isError).toBeUndefined();
    const block = listed.content[0];
    if (block.type !== "text") throw new Error("Expected MCP tool metadata");
    const [descriptor] = JSON.parse(block.text) as Array<{ name: string }>;
    expect(descriptor.name).toContain(serverId);
    const denied = await tool.execute("call", { serverId, action: "call", toolName: descriptor.name, argsJson: '{"message":"hello"}', requestId: "echo-one" }, undefined, undefined as never);
    expect(denied.isError).toBe(true);
    expect(approvals).toHaveLength(1);
    await new MCPPermissionStore(root).set(descriptor.name, "read");
    const accepted = await tool.execute("call", { serverId, action: "call", toolName: descriptor.name, argsJson: '{"message":"hello"}', requestId: "echo-one" }, undefined, undefined as never);
    expect(accepted.content).toEqual([{ type: "text", text: "echo:hello" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker MCP proxy carries only a selected tool request and host response", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-worker-mcp-proxy-"));
  try {
    const name = "mcp__alpha_sample_echo__echo";
    const [proxy] = createWorkerMCPProxyTools(root, [{ name, label: "Echo", description: "Echo", parameters: {} as never, server: "alpha_sample_echo" }]);
    const pending = proxy.execute("stable-call", { message: "hello" }, undefined, undefined as never);
    let file = "";
    for (let i = 0; i < 100 && !file; i++) { file = (await readdir(root)).find(item => item.endsWith(".request.json")) ?? ""; if (!file) await Bun.sleep(10); }
    expect(file).toEndWith(".request.json");
    const id = file.slice(0, 36);
    const request = parseWorkerMCPRequest(JSON.parse(await readFile(join(root, file), "utf8")), id, new Set([name]));
    expect(request).toMatchObject({ name, callId: "stable-call", args: { message: "hello" } });
    expect(() => parseWorkerMCPRequest({ ...request, name: "mcp__other" }, id, new Set([name]))).toThrow("selected tool set");
    await writeWorkerMCPResponse(root, id, { content: [{ type: "text", text: "echo:hello" }] });
    expect((await pending).content).toEqual([{ type: "text", text: "echo:hello" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
