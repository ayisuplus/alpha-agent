import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { NativeConfiguration } from "../src/native/configuration";
import { RpcProcess } from "../src/native/rpc-process";

test("native provider validation, masked secrets, scoped settings and concurrent edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-config-parity-")), agent = join(root, "profile"), cwd = join(root, "project");
  await mkdir(agent); await mkdir(cwd); await mkdir(join(cwd, ".omp"));
  const modelsPath = join(agent, "models.yml");
  await writeFile(modelsPath, JSON.stringify({ providers: { local: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-secret-only", models: [{ id: "model" }] } } }));
  await writeFile(join(agent, "config.yml"), "startup:\n  checkUpdate: false\n");
  await writeFile(join(cwd, ".omp/config.yml"), "customUnknown:\n  preserve: true\nretry:\n  maxRetries: 7\n");
  let settings: Settings | undefined;
  try {
    const config = new NativeConfiguration(agent);
    settings = await Settings.loadIsolated({ cwd, agentDir: agent });
    const providers = await config.providers();
    expect(JSON.stringify(providers)).not.toContain("fixture-secret-only");
    const value = structuredClone(providers.config) as { providers: { local: { baseUrl: string; models: Array<{ id: string; maxTokens?: number }> } } };
    value.providers.local.baseUrl = "http://127.0.0.1:2/v1";
    await config.providers({ revision: providers.revision, config: value });
    expect(await readFile(modelsPath, "utf8")).toContain("fixture-secret-only");
    expect(await readFile(modelsPath, "utf8")).toContain("127.0.0.1:2");
    await expect(config.providers({ revision: providers.revision, config: value })).rejects.toThrow("changed");
    const beforeInvalid = await readFile(modelsPath, "utf8");
    value.providers.local.models[0]!.maxTokens = -1;
    await expect(config.providers({ revision: (await config.providers()).revision, config: value })).rejects.toThrow();
    expect(await readFile(modelsPath, "utf8")).toBe(beforeInvalid);
    const current = await config.read(settings);
    expect(current.settings.find(item => item.id === "retry.maxRetries")?.provenance).toBe("project");
    const projectRevision = await config.projectRevision(cwd);
    await config.update({ scope: "project", id: "tools.approval", value: { write: "deny", read: "allow", bash: "prompt" }, revision: projectRevision }, settings, cwd);
    expect((await config.read(settings)).settings.find(item => item.id === "tools.approval")?.value).toEqual({ write: "deny", read: "allow", bash: "prompt" });
    expect(await readFile(join(cwd, ".omp/config.yml"), "utf8")).toContain("preserve: true");
    await expect(config.update({ scope: "project", id: "tools.approval", value: { write: "ask" }, revision: await config.projectRevision(cwd) }, settings, cwd)).rejects.toThrow();
    await expect(config.update({ scope: "project", id: "retry.maxRetries", value: 2, revision: projectRevision }, settings, cwd)).rejects.toThrow("Reload");
    expect((await config.catalog(settings)).roles.some(role => role.id === "plan")).toBe(true);
    await config.update({ scope: "project", role: "plan", model: "local/model" }, settings, cwd);
    expect(settings.getModelRoleProvenance("plan")).toBe("project");
    const cold = await Settings.loadReadOnly({ cwd, agentDir: agent });
    expect(cold.getModelRoles().plan).toBe("local/model");
    expect(cold.getModelRoles().default).toBeUndefined();
    await config.update({ scope: "project", role: "plan", model: "" }, settings, cwd);
    expect(settings.getModelRoleProvenance("plan")).toBe("default");
  } finally { settings?.cancelPendingSaves(); AgentStorage.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("same native host edits definitions, exposes loaded commands and enforces tool denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-definitions-parity-")), agent = join(root, "profile"), cwd = join(root, "project");
  await mkdir(agent); await mkdir(cwd);
  let attemptedWrite = false;
  let calls = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }> };
    const lastTool = ++calls > 1;
    const delta = lastTool ? { content: "DENIAL_TEST_FINISHED" } : { tool_calls: [{ index: 0, id: "denial", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "must-not-exist.txt", content: "denied" }) } }] };
    attemptedWrite ||= !lastTool;
    return new Response(`data: ${JSON.stringify({ id: "fixture", model: "fixture", choices: [{ index: 0, delta, finish_reason: lastTool ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", auth: "none", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: "model", contextWindow: 100000, maxTokens: 1000 }] } } }));
  await writeFile(join(agent, "config.yml"), "modelRoles:\n  default: fixture/model\ndefaultThinkingLevel: off\nretry:\n  enabled: false\nlsp:\n  enabled: false\nstartup:\n  checkUpdate: false\n  quiet: true\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") } as Record<string, string>;
  const launch = () => new RpcProcess({ cwd, env, argv: [resolve("src/native/omp-host.ts"), "--mode", "rpc-ui"] });
  let child = launch();
  try {
    await child.ready;
    const config = await child.hostCommand("configuration") as { projectRevision: string; settings: Array<{ id: string; value: unknown; provenance: string }> };
    await child.hostCommand("configuration", { action: "save", scope: "project", id: "tools.approval", value: { write: "deny" }, revision: config.projectRevision });
    const updated = await child.hostCommand("configuration") as typeof config;
    expect(updated.settings.find(item => item.id === "tools.approval")?.provenance).toBe("project");
    await child.hostCommand("definitions", { action: "save", kind: "command", name: "parity-command", scope: "project", content: "---\ndescription: Native command proof\n---\nCOMMAND_PROOF $ARGUMENTS\n" });
    await child.hostCommand("definitions", { action: "save", kind: "rule", name: "parity-rule", scope: "project", content: "---\nalwaysApply: true\n---\nRULE_PROOF_PRESERVED\n" });
    await child.hostCommand("definitions", { action: "save", kind: "task", name: "parity-task", scope: "project", content: "---\nname: parity-task\ndescription: Native task proof\ntools: [read, grep]\n---\nTASK_PROOF\n" });
    const invalid = await child.hostCommand("definitions", { action: "save", kind: "task", name: "bad-task", scope: "project", content: "---\nname: invalid\n---\n" }).catch(error => String(error));
    expect(invalid).toContain("Invalid agent field");
    const escape = await child.hostCommand("definitions", { action: "save", kind: "command", name: "../escape", content: "escape" }).catch(error => String(error));
    expect(escape).toContain("Invalid definition operation");
    await child.stop(); child = launch(); await child.ready;
    const available = await child.command({ type: "get_available_commands" });
    expect(JSON.stringify(available)).toContain("parity-command");
    const definitions = await child.hostCommand("definitions", { action: "list" }) as { entries: Array<{ name: string; loaded: boolean; kind: string }> };
    expect(definitions.entries.find(item => item.name === "parity-command")?.loaded).toBe(true);
    expect(definitions.entries.find(item => item.name === "parity-rule")?.loaded).toBe(true);
    expect(definitions.entries.some(item => item.name === "parity-task" && item.kind === "task")).toBe(true);
    const result = await child.promptAndWait("/parity-command test");
    expect(result.status).toBe("completed");
    expect(attemptedWrite).toBe(true);
    expect(await Bun.file(join(cwd, "must-not-exist.txt")).exists()).toBe(false);
    expect(JSON.stringify(await child.command({ type: "get_messages" }))).toContain("denied");
  } finally { await child.stop(); model.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60_000);
