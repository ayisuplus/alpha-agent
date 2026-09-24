import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentSession, SessionManager, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { SkillPluginStore, skillCatalog } from "../src/plugins/third-party";
import { ompRegistry } from "../src/runtime/models";

const selector = "deepseek/deepseek-flash";
const dataRoot = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? process.cwd(), ".alpha");
const projectRoot = resolve("release", `third-party-probe-${randomUUID()}`);
await mkdir(projectRoot, { recursive: true });
const pluginStore = new SkillPluginStore(dataRoot);
const skills = await pluginStore.loadSkills();
const hooks = await pluginStore.loadHooks();
if (!skills.some(skill => skill.name === "superpowers:verification-before-completion")) throw new Error("Superpowers skill is not enabled");
if (hooks.length !== 1) throw new Error("Superpowers Pi hook is not enabled");
const handlers = new Map<string, (event: { messages: unknown[] }) => Promise<{ messages: unknown[] } | undefined>>();
hooks[0].factory!({ on: (name: string, handler: (event: { messages: unknown[] }) => Promise<{ messages: unknown[] } | undefined>) => handlers.set(name, handler) } as never);
const marker = "superpowers:using-superpowers bootstrap for pi";
await handlers.get("session_start")!({ messages: [] });
const firstContext = await handlers.get("context")!({ messages: [] });
if (!firstContext?.messages.some(message => JSON.stringify(message).includes(marker))) throw new Error("Session-start bootstrap was not injected");
if (await handlers.get("context")!({ messages: firstContext.messages })) throw new Error("Bootstrap duplicated inside one context");
await handlers.get("agent_end")!({ messages: [] });
if (await handlers.get("context")!({ messages: [] })) throw new Error("Bootstrap remained active after agent end");
await handlers.get("session_compact")!({ messages: [] });
const compactContext = await handlers.get("context")!({ messages: [] });
if (!compactContext?.messages.some(message => JSON.stringify(message).includes(marker))) throw new Error("Bootstrap was not restored after compaction");
let sawBootstrap = false;
const observer: ExtensionFactory = pi => {
  pi.on("context", event => { sawBootstrap ||= event.messages.some(message => JSON.stringify(message).includes(marker)); });
};
const { authStorage, modelRegistry } = await ompRegistry();
try {
  const model = modelRegistry.getAvailable().find(item => `${item.provider}/${item.id}` === selector);
  if (!model) throw new Error(`${selector} is unavailable`);
  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: join(projectRoot, "omp"),
    authStorage, modelRegistry, model,
    sessionManager: SessionManager.inMemory(projectRoot),
    systemPrompt: ["You are testing Alpha's installed Skills plugin. Use the read tool as requested and answer briefly. Do not edit files.", ...skillCatalog(skills)],
    toolNames: ["read"], restrictToolNames: true, autoApprove: true,
    disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    preloadedPreparedExtensions: [...hooks, { path: "<probe-observer>", resolvedPath: "<probe-observer>", factory: observer, error: null }],
    skills, rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  const reads: Array<{ path: string; failed?: boolean }> = [];
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start" && event.toolName === "read") reads.push({ path: String((event.args as { path?: unknown }).path ?? "") });
    if (event.type === "tool_execution_end" && event.toolName === "read" && reads.length) reads[reads.length - 1].failed = event.isError;
  });
  const timer = setTimeout(() => void session.abort(), 90_000);
  try {
    await session.prompt("Read skill://superpowers:verification-before-completion and state its main verification rule in one Chinese sentence.");
    const last = session.getLastAssistantMessage();
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.errorMessage ?? "DeepSeek probe did not finish");
    if (!sawBootstrap) throw new Error("Superpowers context hook did not inject its bootstrap");
    if (!reads.some(read => read.path === "skill://superpowers:verification-before-completion" && read.failed === false)) throw new Error(`Skill was not successfully read: ${JSON.stringify(reads)}`);
    console.log(JSON.stringify({ model: selector, bootstrapInjected: sawBootstrap, compactHookRestoresBootstrap: true, skill: "superpowers:verification-before-completion", reads, response: last.content.filter(part => part.type === "text").map(part => part.text).join("").slice(0, 400) }));
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await session.dispose();
  }
} finally { authStorage.close(); }
