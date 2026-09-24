import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { ompRegistry } from "./models";
import { TaskLedger } from "./task-ledger";
import { createBrowserTool } from "./browser-tool";
import { createBuildTool } from "./build-tool";
import { createCodeCheckTool } from "./code-check";
import { commandApprovalStore, createCommandTool } from "./command-approval";
import { guardMCPTools, MCPPermissionStore } from "./mcp-permissions";
import { createResearchSourceTool } from "./research-source";
import { createDocumentTool } from "./document-tool";
import { assertFileToolGuardLoaded, fileToolGuard } from "./file-tool-guard";
import { createDirectFileTools } from "./direct-file-tools";
import { independentCommandReviewer } from "./auto-reviewer";
import { ProjectStore } from "./projects";
import { verifySandbox } from "./sandbox-exec";
import { createWorkOrderTool } from "./work-order-tool";
import { AgentPresetStore, verifyPresetSnapshot, type AgentPresetSnapshot } from "./agent-presets";
import { loadBuiltinPlugins } from "../plugins";
import { SkillPluginStore, skillCatalog } from "../plugins/third-party";
import { recoverIncompleteMerges, type WorkOrder } from "./work-orders";
import type { VisibleBrowser } from "./visible-browser";

export interface RunOptions {
  projectRoot: string;
  objective: string;
  dataRoot: string;
  modelSelector?: string;
  onEvent?: (event: RunEvent) => void;
  onLedger?: (ledger: TaskLedger) => Promise<void> | void;
  onSessionReady?: (steer: (text: string) => Promise<void>) => Promise<void> | void;
  onSessionEnd?: (queuedSteering: readonly string[], completed: boolean) => Promise<void> | void;
  signal?: AbortSignal;
  browser?: VisibleBrowser;
  browserUrl?: string;
  browserAccess?: () => boolean;
  onNeedsInput?: (reason: string) => void;
  existingLedger?: TaskLedger;
  maxToolCalls?: number;
  wallTimeMs?: number;
  maxTotalToolCalls?: number;
  totalWallTimeMs?: number;
  workOrder?: WorkOrder;
  workerPreset?: AgentPresetSnapshot;
  /** Local ComfyUI endpoint for the media tools; the tools' own default applies when omitted. */
  comfyUrl?: string;
  /** Recorded on a newly created task so later runs keep using it; omitted means the task follows the default. */
  taskModel?: string;
  /** Which generation tools the model is offered; all are offered when omitted. */
  generation?: { image: boolean; voice: boolean; video: boolean };
  /** Built-in plugins enabled for this run; omitted keeps the current default. */
  plugins?: { comfyui: boolean };
}

export const DEFAULT_MODEL = "alibaba-token-plan/qwen3.6-flash";
export class NeedsInputError extends Error {}

export interface RunEvent {
  type: "text" | "tool-start" | "tool-end" | "status";
  value: string;
  error?: boolean;
  callId?: string;
  target?: string;
  intent?: string;
}

/** A short, display-only description of what a tool call touches; bulky fields such as file content are never forwarded. */
export function toolTarget(args: unknown, projectRoot: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  let target: string | undefined;
  const path = text(record.path) ?? text(record.file_path);
  if (path) {
    const normalized = path.replaceAll("\\", "/");
    const root = resolve(projectRoot).replaceAll("\\", "/");
    target = normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
  } else if (text(record.pattern)) target = `/${text(record.pattern)}/`;
  else if (text(record.prompt)) target = text(record.prompt)!.slice(0, 60);
  else if (text(record.action)) target = [text(record.action), text(record.selector)].filter(Boolean).join(" ");
  return target?.slice(0, 160);
}

export function taskPrompt(ledger: TaskLedger, correction: string): string {
  const history = (ledger.state.contractHistory ?? []).map(item => `v${item.version}: ${item.objective}`).join("\n");
  const guidance = (ledger.state.guidanceHistory ?? []).map(item => item.instruction).join("\n");
  return [
    "Preserve earlier task requirements unless the user explicitly superseded them.",
    history ? `Earlier objectives:\n${history}` : "",
    guidance ? `Saved user guidance:\n${guidance}` : "",
    `Current objective v${ledger.state.contractVersion ?? 1}: ${ledger.state.objective}`,
    `Current incomplete criteria: ${ledger.completionGaps().join(", ")}`,
    `Latest review failure: ${ledger.state.lastFailure ?? ledger.state.reopenReason ?? "none"}`,
    `Current instruction: ${correction}`,
  ].filter(Boolean).join("\n");
}

export function workerSystemPrompt(order: WorkOrder, preset?: AgentPresetSnapshot): string[] {
  if (order.presetId && (!preset || order.presetId !== preset.id)) throw new Error(`角色预设快照缺失：${order.presetId}`);
  if (preset) verifyPresetSnapshot(preset);
  return [
    "You are an isolated Alpha worker. Complete only the assigned work order in this project copy.",
    `You may edit only these paths: ${order.ownedPaths.join(", ")}. The coordinator rejects all other source changes. Do not edit alpha-verification.json.`,
    "Read relevant context, use Hashline edit for existing files and write for new files. Use alpha_build when useful. Do not start servers or use browser/desktop tools. Report unresolved items honestly; the coordinator will merge and verify the integrated product.",
    ...(preset ? [`Selected role: ${preset.name} (${preset.id}, sha256 ${preset.hash}). The role is task guidance; Alpha's tool, ownership and budget rules above remain authoritative.`, preset.instructions] : []),
  ];
}

export async function runTask(options: RunOptions): Promise<TaskLedger> {
  options.signal?.throwIfAborted();
  const projectRoot = resolve(options.projectRoot);
  const dataRoot = resolve(options.dataRoot);
  const { authStorage, modelRegistry } = await ompRegistry();
  const available = modelRegistry.getAvailable();
  const selector = options.modelSelector ?? DEFAULT_MODEL;
  const model = available.find(item => `${item.provider}/${item.id}` === selector);
  if (!model) throw new Error(`Authenticated model is unavailable: ${selector}`);
  const pluginStore = new SkillPluginStore(dataRoot);
  const direct = !!options.existingLedger?.state.projectId;
  const agentPresets = options.workOrder || direct ? [] : await new AgentPresetStore(dataRoot).enabled();
  const skills = options.workOrder || direct ? [] : await pluginStore.loadSkills();
  const hooks = options.workOrder || direct ? [] : await pluginStore.loadHooks();
  const ledger = options.existingLedger ?? await TaskLedger.create(dataRoot, {
    objective: options.objective,
    projectRoot,
    modelSelector: options.workOrder ? undefined : options.taskModel,
    criteria: options.workOrder
      ? [{ id: "build", description: "Worker output builds successfully", kind: "build" }]
      : [
        { id: "build", description: "Product builds successfully", kind: "build" },
        { id: "user-path", description: "A core user path works in the visible preview", kind: "browser" },
      ],
  });
  if (ledger.state.projectRoot !== projectRoot) throw new Error("Existing task belongs to a different project");
  if (ledger.state.status !== "active") throw new Error(`Task is ${ledger.state.status}`);
  const codeTask = ledger.state.taskType === "code-change";
  const generalTask = ledger.state.taskType === "research" || ledger.state.taskType === "file-work";
  let needsInputReason: string | null = null;
  let abortSessionForInput: (() => void) | null = null;
  const pauseForInput = async (question: string, service: string) => {
    if (ledger.state.status === "active") await ledger.needInput(question, service);
    needsInputReason = question;
    options.onNeedsInput?.(question);
    abortSessionForInput?.();
  };
  if (options.existingLedger && !options.workOrder) {
    try {
      await recoverIncompleteMerges(projectRoot, dataRoot, ledger.state.id);
      await ledger.refreshRevision();
    } catch (error) {
      await ledger.recordFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  options.signal?.throwIfAborted();
  const usedCalls = (ledger.state.runs ?? []).reduce((sum, run) => sum + run.toolCalls, 0);
  const usedTime = (ledger.state.runs ?? []).reduce((sum, run) => sum + run.elapsedMs, 0);
  const remainingCalls = (options.maxTotalToolCalls ?? 1200) - usedCalls;
  const remainingTime = (options.totalWallTimeMs ?? 7_200_000) - usedTime;
  if (!options.workOrder && (remainingCalls <= 0 || remainingTime < 1_000)) {
    await ledger.recordFailure("Task-wide model budget exhausted; increase the task budget before resuming");
    await ledger.stop();
    throw new Error("Task-wide model budget exhausted");
  }
  const maxToolCalls = Math.min(options.maxToolCalls ?? 120, remainingCalls);
  const wallTimeMs = Math.min(options.wallTimeMs ?? 900_000, remainingTime);
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || !Number.isInteger(wallTimeMs) || wallTimeMs < 1_000) throw new Error("Invalid task budget");
  await options.onLedger?.(ledger);

  const permission = direct && ledger.state.projectId
    ? { mode: ledger.state.permissionMode ?? "ask", roots: await new ProjectStore(dataRoot).roots(ledger.state.projectId, ledger.state.projectVersion ?? 0) }
    : undefined;
  if (permission && permission.mode !== "full") {
    try { await verifySandbox({ cwd: projectRoot, roots: permission.roots, dataRoot, signal: options.signal }); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      const reason = `Windows sandbox is unavailable: ${error instanceof Error ? error.message : String(error)}`;
      await ledger.needInput(reason, "windows-sandbox");
      throw new NeedsInputError(reason);
    }
  }
  const directFileTools = permission && ledger.state.projectId
    ? await createDirectFileTools({ taskId: ledger.state.id, projectId: ledger.state.projectId, projectVersion: ledger.state.projectVersion ?? 0, projectRoot, dataRoot, mode: permission.mode, onNeedsInput: reason => pauseForInput(reason, "approval") })
    : [];

  const plugins = options.workOrder
    ? { tools: [], instructions: [] }
    : direct ? { tools: [], instructions: [] }
    : loadBuiltinPlugins({ projectRoot, dataRoot, url: options.comfyUrl, enabled: options.plugins, generation: options.generation });
  let mcp: Awaited<ReturnType<SkillPluginStore["loadMCP"]>> | null = null;
  try { if (!options.workOrder && !direct) mcp = await pluginStore.loadMCP(projectRoot); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await ledger.needInput(`已指定的 MCP 工具无法加载：${reason}。请修复服务或说明如何继续。`, "MCP");
    throw new NeedsInputError(reason);
  }
  if (mcp?.errors.length) {
    const reason = mcp.errors.join("; ");
    await mcp.manager.disconnectAll();
    await ledger.needInput(`已指定的 MCP 服务不可用：${reason}。请修复服务或说明如何继续。`, "MCP");
    throw new NeedsInputError(reason);
  }
  const mcpTools = guardMCPTools(mcp?.tools ?? [], new MCPPermissionStore(dataRoot), ledger.state.id, question => pauseForInput(question, "MCP"));
  const toolNames = ["read", "grep", "edit", "write", "alpha_build", "alpha_check", "alpha_command", "alpha_source", "alpha_document", "alpha_delegate", "alpha_browser", ...plugins.tools.map(tool => tool.name)];
  if (mcpTools.some(tool => toolNames.includes(tool.name))) {
    await mcp?.manager.disconnectAll();
    const error = new Error("MCP 工具与 Alpha 内置工具重名");
    await ledger.recordFailure(error.message);
    await ledger.stop();
    throw error;
  }

  process.env.PI_EDIT_VARIANT = "hashline";
  process.env.PI_STRICT_EDIT_MODE = "1";
  const sessionsDir = join(dataRoot, "sessions");
  if (!options.workOrder) await mkdir(sessionsDir, { recursive: true });
  const sessionManager = options.workOrder ? SessionManager.inMemory(projectRoot) : await SessionManager.open(join(sessionsDir, `${ledger.state.id}.jsonl`), sessionsDir, undefined, { initialCwd: projectRoot });
  const usageBefore = sessionManager.getUsageStatistics();
  let created: Awaited<ReturnType<typeof createAgentSession>>;
  try { created = await createAgentSession({
    cwd: projectRoot,
    agentDir: join(dataRoot, "omp"),
    authStorage,
    modelRegistry,
    model,
    sessionManager,
    systemPrompt: options.workOrder ? workerSystemPrompt(options.workOrder, options.workerPreset) : [
      "You are Alpha, a local work agent. Complete the task in the assigned project directory.",
      `Current task objective v${ledger.state.contractVersion ?? 1}: ${ledger.state.objective}`,
      `Saved user guidance: ${(ledger.state.guidanceHistory ?? []).map(item => item.instruction).join(" | ") || "none"}`,
      `Required acceptance criteria: ${ledger.state.criteria.map(item => `${item.id}: ${item.description}`).join(" | ")}`,
      "Use read and Hashline edit for existing files. Use write for new files. Keep changes within the assigned project directory.",
      ...(generalTask ? [
        `This is a ${ledger.state.taskType} task. Uploaded inputs: ${(ledger.state.inputs ?? []).map(item => `${item.name} (sha256 ${item.sha256})`).join(", ") || "none"}. Do not modify uploaded inputs.`,
        "For web research, use alpha_source for each cited public page; the tool archives URL, access date and source hash. If a specified source is unavailable, stop and ask the user. Do not silently replace it.",
        "Use alpha_document to create PDF, DOCX or XLSX when requested. Write alpha-deliverable.json with {\"outputs\":[{\"path\":\"outputs/name.ext\",\"sourceIds\":[\"archived-source-id\"]}]}. Research outputs must cite archived source IDs; file-work outputs must be PDF, DOCX or XLSX. Report what remains unverified.",
      ] : codeTask ? [
        direct ? "This task edits the selected project folder directly. Mounted folders are the writable roots; all changes are immediately visible there." : "This is an imported code-change task. Work only in the managed project copy; the original source is applied separately after user review.",
        `Configured checks: ${(ledger.state.workspaceOrigin?.checks ?? []).map(item => item.name).join(", ") || "none"}. Use alpha_check to run these exact checks. Use alpha_command with purpose 'check' to request a missing test command, or 'other' for other work.`,
        ...(direct ? [`This task's permission mode is ${permission?.mode}. Unconfigured commands and protected file actions follow the task's approval policy. Set alpha_command.network=true only when the command really needs network; it requires user approval in restricted modes. Do not try another path or service after denial.`] : ["Unconfigured commands require exact-argv workbench approval."]),
        "Technical completion requires a reviewable source change and passing configured checks. A web preview is not required for this task.",
      ] : ["Use alpha_build to build the assigned product. Alpha's runtime then publishes a local preview and runs the browser verification plan. Do not start servers, manage ports or processes, or run browser checks through the terminal. Report what is actually verified and what remains unverified."]),
      "Never claim the product is complete solely because code was written or a command exited successfully.",
      ...plugins.instructions,
      ...skillCatalog(skills),
      ...(mcpTools.length ? ["Third-party MCP tools are available only under their listed mcp__ names. Use them for the user's task; do not assume an unavailable service is running."] : []),
      ...(hooks.length ? ["Third-party Pi hooks may include tool guidance for other hosts. In Alpha, use only the tools listed in this session; do not invent bash, Skill, or subagent calls."] : []),
      `Available subagent role presets (choose presetId for each work order; omit it for general): ${agentPresets.map(item => `${item.id}=${item.name}: ${item.description}`).join(" | ")}. Choose a specialist only when its work matches the order.`,
      ...(!generalTask && !direct ? ["If two substantial source changes are independent, you may use alpha_delegate with exactly two work orders, a presetId for each specialist, and non-overlapping owned paths and resources. You remain responsible for the integrated build and alpha-verification.json; re-read merged files before editing them."] : []),
      ...(ledger.state.contractVersion && ledger.state.contractVersion > 1 ? ["The user revised this task. Preserve earlier requirements unless explicitly superseded, and update alpha-verification.json so the browser checks the revised behavior, even if the existing app still builds."] : []),
      ...(!codeTask && !generalTask ? ["For a web product, write alpha-verification.json in the project root with a repeatable core user path. Use {\"steps\":[...]} with flat step objects: fill/select {action,selector,value}, click {action,selector}, expectText/expectAbsentText {action,text,selector?}, expectValue {action,selector,value} for an input/textarea/select value, video {action,selector} for a decoded video frame check, viewport {action,width,height}, contrast {action,selector,minRatio:4.5}, wait {action,ms<=3000}, or reload {action}. No comment-only steps or unsupported fields. Use {{nonce}} only in free-text fields, not numeric/date/select values. Include a click, two outcome assertions, a viewport at most 400px wide, a contrast check, a video step when video is required, and reload when persistence is required. Use fill/select only when the product has those controls. The runtime will execute the plan against the deployed preview; never mark it passed yourself."] : []),
      options.browser ? "The alpha_browser tool controls the visible local preview. Use it to check real user paths and inspect console/network failures." : "No visible browser is connected; report browser verification as pending.",
    ],
    toolNames: [
      "read", "grep", "edit", "write", ...(generalTask ? ["alpha_document", ...(ledger.state.taskType === "research" ? ["alpha_source"] : [])] : [codeTask ? "alpha_check" : "alpha_build"]),
      ...(codeTask ? ["alpha_command"] : []),
      ...(!options.workOrder && !generalTask && !direct ? ["alpha_delegate"] : []),
      ...plugins.tools.map(tool => tool.name),
      ...mcpTools.map(tool => tool.name),
      ...(options.browser ? ["alpha_browser"] : []),
    ],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    customTools: [
      ...directFileTools,
      ...(generalTask ? [createDocumentTool(projectRoot, dataRoot, ledger.state.id), ...(ledger.state.taskType === "research" ? [createResearchSourceTool(dataRoot, ledger.state.id, reason => pauseForInput(reason, "web-source"))] : [])] : [codeTask ? createCodeCheckTool(projectRoot, dataRoot, ledger.state.id, ledger.state.workspaceOrigin?.checks ?? [], permission, reason => pauseForInput(reason, "windows-sandbox")) : createBuildTool(projectRoot)]),
      ...(codeTask ? [createCommandTool(commandApprovalStore(dataRoot), ledger.state.id, projectRoot, permission,
        permission?.mode === "auto" ? independentCommandReviewer(dataRoot, selector) : undefined,
        reason => pauseForInput(reason, "approval"))] : []),
      ...(!options.workOrder && !generalTask && !direct ? [createWorkOrderTool(ledger, dataRoot, options.signal, selector, agentPresets, value => options.onEvent?.({ type: "status", value }))] : []),
      ...plugins.tools,
      ...mcpTools,
      ...(options.browser ? [createBrowserTool(() => options.browserAccess?.() === false ? null : options.browser ?? null, dataRoot, options.browserUrl)] : []),
    ],
    autoApprove: true,
    disableExtensionDiscovery: true,
    preloadedPreparedExtensions: [fileToolGuard(projectRoot, options.workOrder, generalTask ? ["inputs"] : [], direct), ...hooks],
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    skills,
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  }); } catch (error) {
    await mcp?.manager.disconnectAll();
    await ledger.recordFailure(error instanceof Error ? error.message : String(error));
    await ledger.stop();
    throw error;
  }
  try {
    assertFileToolGuardLoaded(created.extensionsResult.extensions);
    if (direct && ["read", "grep", "edit", "write"].some(name => !created.session.agent.state.tools.find(tool => tool.name === name)?.description.startsWith("Alpha sandbox proxy."))) {
      throw new Error("A native file tool bypassed the sandbox proxy; refusing to start the model");
    }
  }
  catch (error) {
    await created.session.dispose();
    await mcp?.manager.disconnectAll();
    await ledger.recordFailure(error instanceof Error ? error.message : String(error));
    await ledger.stop();
    throw error;
  }
  const { session } = created;
  abortSessionForInput = () => { void session.abort(); };
  session.setAutoRetryEnabled(false);
  session.setAutoCompactionEnabled(true);
  let toolCalls = 0;
  let compactions = 0;
  let compactionFailures = 0;
  let budgetReason: string | null = null;
  let stalledReason: string | null = null;
  let outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input" = "returned";
  let failureReason: string | undefined;
  const started = performance.now();
  const timeout = setTimeout(() => {
    if (stalledReason) return;
    budgetReason = `Model run exceeded ${wallTimeMs} ms`;
    void session.abort();
  }, wallTimeMs);
  const firstResponseMs = Math.min(45_000, Math.max(1_000, Math.floor(wallTimeMs / 2)));
  const firstResponseTimer = setTimeout(() => {
    stalledReason = `Model produced no response within ${firstResponseMs} ms; check network or provider availability`;
    void session.abort();
  }, firstResponseMs);
  const unsubscribe = session.subscribe(event => {
    if (event.type === "auto_compaction_end" && !event.skipped) {
      if (event.aborted || event.errorMessage) compactionFailures++;
      else compactions++;
    }
    if ((event.type === "message_update" && event.assistantMessageEvent.type !== "start") || event.type === "tool_execution_start") clearTimeout(firstResponseTimer);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      options.onEvent?.({ type: "text", value: event.assistantMessageEvent.delta });
    } else if (event.type === "tool_execution_start") {
      toolCalls++;
      if (toolCalls > maxToolCalls && !budgetReason) {
        budgetReason = `Model run exceeded ${maxToolCalls} tool calls`;
        void session.abort();
      }
      options.onEvent?.({ type: "tool-start", value: event.toolName, callId: event.toolCallId, target: toolTarget(event.args, projectRoot), intent: event.intent?.slice(0, 160) });
    } else if (event.type === "tool_execution_end") {
      options.onEvent?.({ type: "tool-end", value: event.toolName, error: event.isError, callId: event.toolCallId });
    }
  });
  const onAbort = () => { clearTimeout(firstResponseTimer); void session.abort(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const prompt = options.existingLedger ? taskPrompt(ledger, options.objective) : options.objective;
    options.signal?.throwIfAborted();
    await options.onSessionReady?.(text => session.steer(text));
    options.signal?.throwIfAborted();
    await session.prompt(prompt);
    if (String(ledger.state.status) === "needs-input") throw new NeedsInputError(needsInputReason ?? ledger.state.pendingQuestion ?? "User input required");
    if (stalledReason) throw new Error(stalledReason);
    if (budgetReason) throw new Error(budgetReason);
    const lastMessage = session.getLastAssistantMessage();
    if (lastMessage?.stopReason === "error" || lastMessage?.stopReason === "length") {
      throw new Error(lastMessage.errorMessage ?? `Model response ended with ${lastMessage.stopReason}`);
    }
    await ledger.refreshRevision();
    if (options.signal?.aborted) {
      outcome = "cancelled";
      failureReason = options.signal.reason instanceof Error ? options.signal.reason.message : "Task cancelled";
      await ledger.stop();
    } else await ledger.clearFailure();
    return ledger;
  } catch (error) {
    outcome = String(ledger.state.status) === "needs-input" ? "needs-input" : stalledReason ? "error" : budgetReason ? "budget" : options.signal?.aborted ? "cancelled" : "error";
    failureReason = needsInputReason ?? stalledReason ?? budgetReason ?? (error instanceof Error ? error.message : String(error));
    if (outcome === "needs-input") throw new NeedsInputError(failureReason);
    if (ledger.state.status === "active") {
      await ledger.refreshRevision();
      await ledger.recordFailure(failureReason);
      await ledger.stop();
    }
    throw stalledReason ? new Error(stalledReason) : budgetReason ? new Error(budgetReason) : error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(firstResponseTimer);
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    await options.onSessionEnd?.(session.getQueuedMessages().steering, outcome === "returned");
    const usageAfter = sessionManager.getUsageStatistics();
    const usage = {
      input: Math.max(0, usageAfter.input - usageBefore.input),
      output: Math.max(0, usageAfter.output - usageBefore.output),
      cacheRead: Math.max(0, usageAfter.cacheRead - usageBefore.cacheRead),
      cacheWrite: Math.max(0, usageAfter.cacheWrite - usageBefore.cacheWrite),
      totalTokens: Math.max(0, usageAfter.totalTokens - usageBefore.totalTokens),
      cost: Math.max(0, usageAfter.cost - usageBefore.cost),
    };
    await ledger.recordRun({ model: selector, toolCalls, compactions, compactionFailures, maxToolCalls, wallTimeMs, elapsedMs: Math.round(performance.now() - started), usage, outcome, failureReason });
    try { await session.dispose(); }
    finally { await mcp?.manager.disconnectAll(); }
  }
}
