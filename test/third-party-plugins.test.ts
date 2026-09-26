import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillPluginStore, scanSkillPack, skillCatalog } from "../src/plugins/third-party";
import { readPluginMCP } from "../src/plugins/mcp";

test("a Skills pack is namespaced, readable, and absent after disabling", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-skill-pack-"));
  const pack = join(root, "plugin-packs", "sample");
  await mkdir(join(pack, "skills", "proof"), { recursive: true });
  await writeFile(join(pack, "skills", "proof", "SKILL.md"), "---\nname: proof\ndescription: Check evidence\n---\n\nCheck the result.\n");
  await writeFile(join(pack, "skills", "proof", "reference.txt"), "reference");
  const store = new SkillPluginStore(root);
  await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "sample", name: "sample", source: "https://github.com/a/sample.git", revision: "a".repeat(40), enabled: true, skillCount: 1 }] }));

  const skills = await store.loadSkills();
  expect(skills.map(skill => skill.name)).toEqual(["sample:proof"]);
  expect(skills[0].containRoot).toBe(await import("node:fs/promises").then(fs => fs.realpath(pack)));
  expect((await readFile(skills[0].filePath, "utf8"))).toContain("Check the result.");
  expect(skillCatalog(skills).join("\n")).toContain("skill://<name>");

  await store.setEnabled("sample", false);
  expect(await store.loadSkills()).toEqual([]);
  expect(await scanSkillPack(pack, "sample")).toHaveLength(1);
});

test("task capability filters do not load another task's Skills or Hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-task-capabilities-"));
  for (const id of ["first", "second"]) {
    const pack = join(root, "plugin-packs", id);
    await mkdir(join(pack, "skills", "proof"), { recursive: true });
    await mkdir(join(pack, "extensions"), { recursive: true });
    await writeFile(join(pack, "skills", "proof", "SKILL.md"), `---\nname: proof\ndescription: ${id} task\n---\n\n${id}\n`);
    await writeFile(join(pack, "extensions", "hook.js"), "export default function () {}\n");
    await writeFile(join(pack, "package.json"), JSON.stringify({ omp: { extensions: ["./extensions/hook.js"] } }));
  }
  await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: ["first", "second"].map(id => ({
    id, name: id, source: `https://github.com/a/${id}.git`, revision: "a".repeat(40), enabled: true, skillCount: 1, hooksEnabled: true,
  })) }));
  const store = new SkillPluginStore(root);
  expect((await store.loadSkills(["first:proof"])).map(skill => skill.name)).toEqual(["first:proof"]);
  expect((await store.loadSkills([]))).toEqual([]);
  expect((await store.loadHooks(["first"])).map(hook => hook.path.includes("first"))).toEqual([true]);
  expect(await store.loadHooks([])).toEqual([]);
});

test("plugin installer rejects non-GitHub and non-HTTPS sources before cloning", async () => {
  const store = new SkillPluginStore(join(tmpdir(), "alpha-source-validation"));
  await expect(store.install("http://127.0.0.1/repo.git")).rejects.toThrow("GitHub");
  await expect(store.install("https://github.com/owner/repo.git/other")).rejects.toThrow("GitHub");
});

test("Pi hooks need a separate switch and cannot add tools through the Skills switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-plugin-hooks-"));
  const pack = join(root, "plugin-packs", "sample");
  await mkdir(join(pack, ".pi", "extensions"), { recursive: true });
  await writeFile(join(pack, "package.json"), JSON.stringify({ pi: { extensions: ["./.pi/extensions/sample.js"] } }));
  await writeFile(join(pack, ".pi", "extensions", "sample.js"), "export default function (pi) { pi.on('context', event => ({ messages: [...event.messages, { role: 'user', content: [{ type: 'text', text: 'hook ran' }], timestamp: 1 }] })); }\n");
  await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "sample", name: "sample", source: "https://github.com/a/sample.git", revision: "a".repeat(40), enabled: true, skillCount: 1 }] }));
  const store = new SkillPluginStore(root);
  expect((await store.list())[0]).toMatchObject({ hookCount: 1, hooksEnabled: false });
  expect(await store.loadHooks()).toHaveLength(0);
  await store.setHooksEnabled("sample", true);
  const hooks = await store.loadHooks();
  expect(hooks).toHaveLength(1);
  const handlers = new Map<string, (event: { messages: unknown[] }) => { messages: unknown[] }>();
  hooks[0].factory!({ on: (name: string, handler: (event: { messages: unknown[] }) => { messages: unknown[] }) => handlers.set(name, handler) } as never);
  expect(handlers.get("context")!({ messages: [] }).messages).toHaveLength(1);
  await store.setEnabled("sample", false);
  expect(await store.loadHooks()).toHaveLength(0);
});

test("OMP extension manifests provide Pi-compatible hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-omp-hooks-"));
  const pack = join(root, "plugin-packs", "sample");
  await mkdir(join(pack, "extensions"), { recursive: true });
  await writeFile(join(pack, "package.json"), JSON.stringify({ omp: { extensions: ["./extensions/hook.js"] } }));
  await writeFile(join(pack, "extensions", "hook.js"), "export default function (pi) { pi.on('session_start', () => {}); }\n");
  await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{
    id: "sample", name: "sample", source: "https://github.com/a/sample.git", revision: "a".repeat(40),
    enabled: true, skillCount: 0, hooksEnabled: true,
  }] }));
  const store = new SkillPluginStore(root);
  expect((await store.list())[0].hookCount).toBe(1);
  expect(await store.loadHooks()).toHaveLength(1);
});

test("MCP plugin is opt-in, namespaced, callable, and disconnected when disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-plugin-mcp-"));
  const project = join(root, "project");
  await mkdir(project);
  const pack = join(root, "plugin-packs", "sample");
  await mkdir(pack, { recursive: true });
  await copyFile(join(import.meta.dir, "fixtures", "echo-mcp.ts"), join(pack, "echo-mcp.ts"));
  await writeFile(join(pack, ".mcp.json"), JSON.stringify({ mcpServers: { echo: {
    command: process.execPath,
    args: ["${PLUGIN_ROOT}/echo-mcp.ts"],
    timeout: 5_000,
  } } }));
  await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{
    id: "sample", name: "sample", source: "https://github.com/a/sample.git", revision: "a".repeat(40),
    enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false,
  }] }));
  const store = new SkillPluginStore(root);
  expect((await store.list())[0]).toMatchObject({ mcpCount: 1, mcpEnabled: false });
  const before = await store.loadMCP(project);
  try { expect(before.tools).toEqual([]); }
  finally { await before.manager.disconnectAll(); }

  await store.setMCPEnabled("sample", true);
  const connected = await store.loadMCP(project);
  try {
    expect(connected.errors).toEqual([]);
    expect(connected.tools).toHaveLength(1);
    expect(connected.tools[0].name).toContain("alpha_sample_echo");
    expect(connected.manager.getConnection("alpha_sample_echo")).toBeDefined();
    const config = connected.manager.getConnection("alpha_sample_echo")?.config;
    expect(config && "cwd" in config ? config.cwd : undefined).toBe(project);
    const result = await connected.tools[0].execute("test-call", { message: "hello" }, undefined, {} as never);
    expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
  } finally { await connected.manager.disconnectAll(); }

  await store.setEnabled("sample", false);
  const disabled = await store.loadMCP(project);
  try { expect(disabled.tools).toEqual([]); }
  finally { await disabled.manager.disconnectAll(); }
});

test("MCP config rejects invalid server definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-invalid-mcp-"));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { broken: { type: "stdio" } } }));
  await expect(readPluginMCP(root, "broken")).rejects.toThrow("requires \"command\"");
});

test("flat MCP plugin manifests and disabled servers are handled", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-flat-mcp-"));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({
    "$schema": "https://example.invalid/schema.json",
    off: { command: "unused", enabled: false },
    on: { command: "bun", args: ["${PLUGIN_ROOT}/server.ts"] },
  }));
  const configs = (await readPluginMCP(root, "sample")).servers;
  expect(Object.keys(configs)).toEqual(["alpha_sample_on"]);
  expect(configs.alpha_sample_on).toMatchObject({ args: [`${root}/server.ts`] });
});

test("unavailable MCP service reports an error without exposing tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-missing-mcp-"));
  const pack = join(root, "plugin-packs", "sample");
  await mkdir(pack, { recursive: true });
  await writeFile(join(pack, ".mcp.json"), JSON.stringify({ mcpServers: {
    missing: { command: join(pack, "missing-program.exe"), timeout: 1_000 },
  } }));
  await writeFile(join(root, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{
    id: "sample", name: "sample", source: "https://github.com/a/sample.git", revision: "a".repeat(40),
    enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 1, mcpEnabled: true,
  }] }));
  const result = await new SkillPluginStore(root).loadMCP(root);
  try {
    expect(result.tools).toEqual([]);
    expect(result.errors.some(error => error.includes("alpha_sample_missing"))).toBe(true);
  } finally { await result.manager.disconnectAll(); }
});
