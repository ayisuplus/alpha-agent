// Builds a restricted OMP session the way Alpha does (no model call) and prints how the system prompt is composed:
// OMP's own prompt, the project's context files, then Alpha's runtime contract, plus what the coordinator would load
// by default: Skill 数、MCP 数与提示词 token. Run: bun run scripts/probe-session-prompt.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { SkillPluginStore } from "../src/plugins/third-party";
import { capabilityPool } from "../src/runtime/capability-pool";
import { projectContextFiles } from "../src/runtime/context-files";
import { ompRegistry } from "../src/runtime/models";
import { DEFAULT_MODEL } from "../src/runtime/model-policy";
import { ompSessionSettings, sessionEditMode } from "../src/runtime/omp-settings";
import { promptFootprint } from "../src/runtime/prompt-budget";
import { alphaContract, isCodeWork, sessionToolNames, type SessionFacts } from "../src/runtime/session-profile";
import { TaskLedger } from "../src/runtime/task-ledger";

const root = await mkdtemp(join(tmpdir(), "alpha-session-prompt-"));
const project = join(root, "project");
await Bun.write(join(project, "AGENTS.md"), "Use pnpm for every script in this project.");
try {
  const ledger = await TaskLedger.create(join(root, "data"), { objective: "Fix the cart total", projectRoot: project, taskType: "code-change", criteria: [{ id: "check", description: "Configured project checks pass", kind: "test" }] });
  const { authStorage, modelRegistry } = await ompRegistry();
  const model = modelRegistry.getAvailable().find(item => `${item.provider}/${item.id}` === DEFAULT_MODEL) ?? modelRegistry.getAvailable()[0];
  if (!model) throw new Error("No authenticated model");
  const selector = `${model.provider}/${model.id}`;
  // §4.2: a task with no explicit selection loads nothing; the user's enabled Skills stay available for
  // alpha_capability_search and alpha_skill_read. The catalog count and the expert-packaged share are the P1 metric.
  const dataRoot = join(process.env.ALPHA_WORKSPACE_ROOT ?? resolve(import.meta.dir, ".."), ".alpha");
  const defaultSkills = await new SkillPluginStore(dataRoot).loadSkills([]);
  const pool = await capabilityPool(dataRoot);
  const byKind = new Map<string, number>();
  for (const item of pool) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  const expertPackaged = pool.filter(item => item.kind === "skill" && item.id.startsWith("expert-")).length;
  console.log(`catalog from ${dataRoot}: ${pool.length} entries (${[...byKind].map(([kind, count]) => `${kind} ${count}`).join(", ")}), expert-packaged skills ${expertPackaged}`);
  console.log(`task default load (no explicit selection): ${defaultSkills.length} skills${defaultSkills.length ? ` (${defaultSkills.map(skill => skill.name).join(", ")})` : ""}, 0 MCP servers`);
  for (const role of ["coordinator", "answer"] as const) {
    const facts: SessionFacts = { role, ledger, direct: false, experts: [], skills: defaultSkills, pluginToolNames: [], pluginInstructions: [], mcpToolNames: [], hooksLoaded: false, officeReadToolNames: [], canDispatch: true, browserConnected: false };
    const settings = await ompSessionSettings(project, join(root, "omp"), { pinHashline: isCodeWork(ledger.state.taskType) });
    const toolNames = sessionToolNames(facts).filter(name => ["read", "grep", "edit", "write", "ast_grep", "lsp"].includes(name));
    const { session } = await createAgentSession({
      cwd: project, agentDir: join(root, "omp"), authStorage, modelRegistry, model, settings,
      sessionManager: SessionManager.inMemory(project), appendSystemPrompt: alphaContract(facts), toolNames,
      restrictToolNames: true, allowRestrictedCustomTools: true, autoApprove: true, disableExtensionDiscovery: true,
      enableMCP: false, enableLsp: false, skipPythonPreflight: true, skills: [], rules: [],
      contextFiles: await projectContextFiles(project), promptTemplates: [], slashCommands: [],
    });
    try {
      const prompt = session.agent.state.systemPrompt.join("\n\n");
      const footprint = promptFootprint(session.agent.state, model);
      const at = (text: string) => prompt.indexOf(text);
      console.log(`\n=== ${role} · model ${selector} · edit mode ${sessionEditMode(settings, selector)} · ${prompt.length} chars`);
      console.log(`prompt tokens: ${footprint.systemTokens} system + ${footprint.toolTokens} tools (${footprint.tools} tools, exact=${footprint.exact})`);
      console.log("tools:", session.agent.state.tools.map(tool => tool.name).join(", "));
      console.log("omp role line at", at("Oh My Pi coding harness"), "· context file at", at("Use pnpm for every script"), "· Alpha contract at", at("ALPHA RUNTIME CONTRACT"));
      console.log("contract ends the prompt:", prompt.trimEnd().endsWith(alphaContract(facts).trimEnd().slice(-80)));
    } finally { await session.dispose(); }
  }
  authStorage.close();
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}
process.exit(0);
