import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_EDIT_VARIANT = "hashline";
process.env.PI_STRICT_EDIT_MODE = "1";

const { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const model = modelRegistry.getAvailable().find(item => item.provider === "xiaomi-token-plan-cn" && item.id === "mimo-v2.6-flash");
if (!model) throw new Error("Probe model is unavailable");

const workspace = await mkdtemp(join(tmpdir(), "alpha-agent-probe-"));
try {
  const sample = join(workspace, "sample.txt");
  await writeFile(sample, "one\ntwo\nthree\n");
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: join(process.cwd(), ".alpha", "omp-probe"),
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory(workspace),
    systemPrompt: "You are Alpha's editing probe. Only use read and edit. You must read the file before editing. Use the edit tool's Hashline syntax. Keep all other lines unchanged. Reply briefly after making the change.",
    toolNames: ["read", "edit"],
    restrictToolNames: true,
    autoApprove: true,
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  });
  const calls: string[] = [];
  const trace: Array<{ kind: string; tool: string; detail: string }> = [];
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start") {
      calls.push(event.toolName);
      trace.push({ kind: "start", tool: event.toolName, detail: JSON.stringify(event.args).slice(0, 300) });
    }
    if (event.type === "tool_execution_end") {
      trace.push({ kind: "end", tool: event.toolName, detail: JSON.stringify(event.result.content).slice(0, 400) });
    }
  });
  try {
    await session.prompt("In sample.txt, change only line 2 from `two` to `TWO`.");
    const contents = await readFile(sample, "utf8");
    if (contents !== "one\nTWO\nthree\n") {
      const messages = session.state.messages.filter(message => message.role === "assistant").flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text)).join("\n");
      console.error(JSON.stringify({ cwd: session.sessionManager.getCwd(), active: session.getActiveToolNames(), calls, trace, assistant: messages.slice(-1200) }));
    }
    if (contents !== "one\nTWO\nthree\n") throw new Error(`Wrong edit: ${JSON.stringify(contents)}`);
    if (calls.join(",") !== "read,edit") throw new Error(`Unexpected tool path: ${calls.join(",")}`);
    console.log(JSON.stringify({ model: `${model.provider}/${model.id}`, calls, editMode: "hashline", outcome: "ok" }));
  } finally {
    unsubscribe();
    await session.dispose();
  }
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
