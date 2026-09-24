import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { SkillPluginStore } from "../src/plugins/third-party";
import { ompRegistry } from "../src/runtime/models";

const selector = "deepseek/deepseek-flash";
const root = resolve("release", `mcp-probe-${randomUUID()}`);
const pack = join(root, ".alpha", "plugin-packs", "echo");
await mkdir(pack, { recursive: true });
await writeFile(join(pack, ".mcp.json"), JSON.stringify({ mcpServers: { local: {
  command: process.execPath, args: [resolve("test", "fixtures", "echo-mcp.ts")], timeout: 5_000,
} } }));
await writeFile(join(root, ".alpha", "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{
  id: "echo", name: "echo", source: "https://github.com/example/echo.git", revision: "a".repeat(40),
  enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 1, mcpEnabled: true,
}] }));
const store = new SkillPluginStore(join(root, ".alpha"));
const mcp = await store.loadMCP(root);
const { authStorage, modelRegistry } = await ompRegistry();
try {
  if (mcp.errors.length || mcp.tools.length !== 1) throw new Error(`MCP did not load: ${mcp.errors.join("; ")}`);
  const model = modelRegistry.getAvailable().find(item => `${item.provider}/${item.id}` === selector);
  if (!model) throw new Error(`${selector} is unavailable`);
  const tool = mcp.tools[0];
  const { session } = await createAgentSession({
    cwd: root, agentDir: join(root, ".alpha", "omp"), authStorage, modelRegistry, model,
    sessionManager: SessionManager.inMemory(root),
    systemPrompt: "You are checking one MCP integration. Call the named tool exactly once, then report its result briefly.",
    toolNames: [tool.name], restrictToolNames: true, allowRestrictedCustomTools: true,
    customTools: [tool], autoApprove: true, disableExtensionDiscovery: true,
    enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  const calls: string[] = [];
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start") calls.push(event.toolName);
  });
  const timer = setTimeout(() => void session.abort(), 90_000);
  try {
    if (!session.agent.state.tools.some(item => item.name === tool.name)) throw new Error("Restricted session did not expose the MCP tool");
    await session.prompt(`Call ${tool.name} with {"message":"ALPHA_MCP_PROBE"}. Then repeat the tool's answer.`);
    const last = session.getLastAssistantMessage();
    if (last?.stopReason === "error" || last?.stopReason === "aborted") throw new Error(last.errorMessage ?? last.stopReason);
    if (!calls.includes(tool.name)) throw new Error(`Model did not call MCP tool: ${calls.join(", ")}`);
    const answer = last?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
    if (!answer.includes("echo:ALPHA_MCP_PROBE")) throw new Error(`MCP result was not reported: ${answer}`);
    console.log(JSON.stringify({ model: selector, tool: tool.name, calls, answer }));
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await session.dispose();
  }
} finally {
  await mcp.manager.disconnectAll();
  authStorage.close();
}
