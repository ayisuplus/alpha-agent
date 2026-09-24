import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { loadBuiltinPlugins } from "../src/plugins";
import { ompRegistry } from "../src/runtime/models";

const selector = "deepseek/deepseek-flash";
const root = resolve(process.env.ALPHA_PLUGIN_PROBE_ROOT ?? join(process.cwd(), "release", `plugin-probe-${randomUUID()}`));
const projectRoot = join(root, "product");
const dataRoot = join(root, "data");
await mkdir(projectRoot, { recursive: true });
await mkdir(dataRoot, { recursive: true });

const { authStorage, modelRegistry } = await ompRegistry();
try {
  const model = modelRegistry.getAvailable().find(item => `${item.provider}/${item.id}` === selector);
  if (!model) throw new Error(`${selector} is unavailable; set DEEPSEEK_API_KEY in this process`);
  const plugin = loadBuiltinPlugins({ projectRoot, dataRoot, generation: { image: true, voice: false, video: false } });
  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: join(dataRoot, "omp"),
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory(projectRoot),
    systemPrompt: ["You are checking Alpha's built-in ComfyUI plugin. Call the available tools as instructed, then summarize the result in one sentence.", ...plugin.instructions],
    toolNames: plugin.tools.map(tool => tool.name),
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    customTools: plugin.tools,
    autoApprove: true,
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  const calls: string[] = [];
  const unsub = session.subscribe(event => {
    if (event.type === "tool_execution_start") calls.push(event.toolName);
  });
  const timer = setTimeout(() => void session.abort(), 300_000);
  try {
    await session.prompt("Call alpha_comfy_status. If it says online, call alpha_generate_image exactly once with prompt: 'A small blue ceramic cup on a clean ivory background, soft studio light, no text'. Then say what happened. Do not use any other service.");
    const last = session.getLastAssistantMessage();
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.errorMessage ?? "DeepSeek probe did not finish");
    if (!calls.includes("alpha_comfy_status") || !calls.includes("alpha_generate_image")) throw new Error(`DeepSeek did not invoke both plugin tools: ${calls.join(", ")}`);
    const records = (await readdir(join(dataRoot, "comfy-jobs"))).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
    const jobs = await Promise.all(records.map(name => readFile(join(dataRoot, "comfy-jobs", name), "utf8").then(text => JSON.parse(text) as { state: string; asset?: string; imageSha256?: string; promptId: string })));
    const completed = jobs.find(job => job.state === "completed" && job.asset && job.imageSha256);
    if (!completed) throw new Error(`ComfyUI image did not complete; records: ${jobs.map(job => `${job.promptId}:${job.state}`).join(", ")}`);
    console.log(JSON.stringify({ model: selector, toolsCalled: calls, image: completed.asset, sha256: completed.imageSha256, promptId: completed.promptId, root }));
  } finally {
    clearTimeout(timer);
    unsub();
    await session.dispose();
  }
} finally {
  authStorage.close();
}
