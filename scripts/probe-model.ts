import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} = await import("@oh-my-pi/pi-coding-agent");

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const available = modelRegistry.getAvailable();
const model = available.find(item => item.provider === "alibaba-token-plan" && item.id === "qwen3.6-flash") ?? available[0];
if (!model) throw new Error("No authenticated OMP model is available");

const workspace = await mkdtemp(join(tmpdir(), "alpha-model-probe-"));
try {
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: join(process.cwd(), ".alpha", "omp-probe"),
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory(workspace),
    systemPrompt: "You are a model connectivity probe. Respond with exactly ALPHA_OK.",
    toolNames: [],
    restrictToolNames: true,
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
  try {
    await session.prompt("Respond with exactly ALPHA_OK.");
    const responses = session.state.messages.filter(message => message.role === "assistant");
    const text = responses.flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text)).join("\n").trim();
    if (!text.includes("ALPHA_OK")) throw new Error(`Unexpected model response: ${text.slice(0, 200)}`);
    console.log(JSON.stringify({ model: `${model.provider}/${model.id}`, response: "ALPHA_OK", sdk: "ok" }));
  } finally {
    await session.dispose();
  }
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
