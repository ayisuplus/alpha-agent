import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { SkillPluginStore, skillCatalog } from "../src/plugins/third-party";
import { ompRegistry } from "../src/runtime/models";

const workspace = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? process.cwd());
const fixture = join(workspace, ".alpha", "plugin-tests", "cocoindex-smoke");
const project = join(fixture, "project");
const store = new SkillPluginStore(join(workspace, ".alpha"));
const id = "cocoindex-code";
const marker = `verifyPluginHookRefresh${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const editMarker = `verifyPluginEditRefresh${randomUUID().replaceAll("-", "").slice(0, 8)}`;

async function search(query: string): Promise<string> {
  const child = Bun.spawn(["ccc", "search", query, "--json"], { cwd: project, env: process.env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  return output;
}

await store.setHooksEnabled(id, true);
await store.setMCPEnabled(id, true);
let mcp: Awaited<ReturnType<SkillPluginStore["loadMCP"]>> | undefined;
let authStorage: Awaited<ReturnType<typeof ompRegistry>>["authStorage"] | undefined;
try {
  const skill = (await store.loadSkills()).find(item => item.name === `${id}:ccc`);
  if (!skill || !(await readFile(skill.filePath, "utf8")).includes("ccc")) throw new Error("CocoIndex Skill was not loaded");
  mcp = await store.loadMCP(project, id);
  if (mcp.errors.length || !mcp.tools.length) throw new Error(`CocoIndex MCP failed: ${mcp.errors.join("; ")}`);
  const tool = mcp.tools.find(item => item.mcpToolName === "search") ?? mcp.tools.find(item => item.name.includes("search"));
  if (!tool) throw new Error(`CocoIndex search tool unavailable: ${mcp.tools.map(item => item.name).join(", ")}`);

  const hook = (await store.loadHooks()).find(item => item.path.includes(id));
  if (!hook?.factory) throw new Error("CocoIndex Hook was not loaded");
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: { cwd: string }) => Promise<void>>();
  hook.factory({ on: (name: string, handler: (event: Record<string, unknown>, ctx: { cwd: string }) => Promise<void>) => handlers.set(name, handler) } as never);
  if (!handlers.has("session_start") || !handlers.has("tool_result")) throw new Error("CocoIndex Hook events were not registered");
  if ((await search(marker)).includes(marker)) throw new Error("Hook marker was already indexed");
  await writeFile(join(project, "hook-check.ts"), `export function ${marker}(): string { return "indexed by Alpha hook"; }\n`);
  await handlers.get("session_start")!({}, { cwd: project });
  if (!(await search(marker)).includes(marker)) throw new Error("Hook did not refresh the index");
  if ((await search(editMarker)).includes(editMarker)) throw new Error("Edit marker was already indexed");
  await writeFile(join(project, "tool-result-check.ts"), `export function ${editMarker}(): string { return "indexed after write"; }\n`);
  await handlers.get("tool_result")!({ toolName: "write", isError: false }, { cwd: project });
  if (!(await search(editMarker)).includes(editMarker)) throw new Error("Edit Hook did not refresh the index");

  const registry = await ompRegistry();
  authStorage = registry.authStorage;
  const model = registry.modelRegistry.getAvailable().find(item => `${item.provider}/${item.id}` === "deepseek/deepseek-flash");
  if (!model) throw new Error("DeepSeek Flash is unavailable");
  const { session } = await createAgentSession({
    cwd: project, agentDir: join(fixture, "omp"), authStorage, modelRegistry: registry.modelRegistry, model,
    sessionManager: SessionManager.inMemory(project),
    systemPrompt: ["Test the installed CocoIndex plugin. Read its Skill, search the current project with its MCP tool, and report the actual file found. Do not edit files.", ...skillCatalog([skill])],
    toolNames: ["read", tool.name], restrictToolNames: true, allowRestrictedCustomTools: true,
    customTools: [tool], autoApprove: true, disableExtensionDiscovery: true,
    preloadedPreparedExtensions: [hook], enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    skills: [skill], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  const calls: string[] = [];
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start") calls.push(`${event.toolName}:${JSON.stringify(event.args)}`);
  });
  const timer = setTimeout(() => void session.abort(), 120_000);
  try {
    await session.prompt(`Read skill://cocoindex-code:ccc, then call ${tool.name} to find the function ${marker} in this project. Reply with its file name.`);
    const last = session.getLastAssistantMessage();
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.errorMessage ?? "Model did not finish");
    if (!calls.some(call => call.includes("skill://cocoindex-code:ccc"))) throw new Error(`Model did not read Skill: ${calls.join("; ")}`);
    if (!calls.some(call => call.startsWith(`${tool.name}:`))) throw new Error(`Model did not call MCP: ${calls.join("; ")}`);
    const answer = last.content.filter(part => part.type === "text").map(part => part.text).join("");
    if (!answer.includes("hook-check.ts")) throw new Error(`MCP result missing in answer: ${answer}`);
    console.log(JSON.stringify({ plugin: id, skill: skill.name, sessionHookRefresh: true, editHookRefresh: true, mcpTool: tool.name, model: "deepseek/deepseek-flash", calls, answer }));
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await session.dispose();
  }
} catch (error) {
  await store.setHooksEnabled(id, false);
  await store.setMCPEnabled(id, false);
  throw error;
} finally {
  await mcp?.manager.disconnectAll();
  authStorage?.close();
}
