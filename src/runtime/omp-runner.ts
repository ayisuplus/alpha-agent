import { join, resolve } from "node:path";
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { TaskLedger } from "./task-ledger";
import { createBrowserTool } from "./browser-tool";
import { createBuildTool } from "./build-tool";
import { createWorkOrderTool } from "./work-order-tool";
import { createImageTool } from "./image-tool";
import { createVoiceTool } from "./voice-tool";
import { createVideoTool } from "./video-tool";
import type { WorkOrder } from "./work-orders";
import type { VisibleBrowser } from "./visible-browser";

export interface RunOptions {
  projectRoot: string;
  objective: string;
  dataRoot: string;
  modelSelector?: string;
  onEvent?: (event: RunEvent) => void;
  onLedger?: (ledger: TaskLedger) => void;
  onSessionReady?: (steer: (text: string) => Promise<void>) => Promise<void> | void;
  onSessionEnd?: (queuedSteering: readonly string[], completed: boolean) => Promise<void> | void;
  signal?: AbortSignal;
  browser?: VisibleBrowser;
  existingLedger?: TaskLedger;
  maxToolCalls?: number;
  wallTimeMs?: number;
  workOrder?: WorkOrder;
  /** Local ComfyUI endpoint for the media tools; the tools' own default applies when omitted. */
  comfyUrl?: string;
  /** Which generation tools the model is offered; all are offered when omitted. */
  generation?: { image: boolean; voice: boolean; video: boolean };
}

export const DEFAULT_MODEL = "alibaba-token-plan/qwen3.6-flash";

export interface RunEvent {
  type: "text" | "tool-start" | "tool-end";
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

export async function runTask(options: RunOptions): Promise<TaskLedger> {
  const projectRoot = resolve(options.projectRoot);
  const dataRoot = resolve(options.dataRoot);
  const authStorage = await discoverAuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);
  const available = modelRegistry.getAvailable();
  const selector = options.modelSelector ?? DEFAULT_MODEL;
  const model = available.find(item => `${item.provider}/${item.id}` === selector);
  if (!model) throw new Error(`Authenticated model is unavailable: ${selector}`);
  const ledger = options.existingLedger ?? await TaskLedger.create(dataRoot, {
    objective: options.objective,
    projectRoot,
    criteria: options.workOrder
      ? [{ id: "build", description: "Worker output builds successfully", kind: "build" }]
      : [
        { id: "build", description: "Product builds successfully", kind: "build" },
        { id: "user-path", description: "A core user path works in the visible preview", kind: "browser" },
      ],
  });
  if (ledger.state.projectRoot !== projectRoot) throw new Error("Existing task belongs to a different project");
  if (ledger.state.status !== "active") throw new Error(`Task is ${ledger.state.status}`);
  const maxToolCalls = options.maxToolCalls ?? 120;
  const wallTimeMs = options.wallTimeMs ?? 900_000;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || !Number.isInteger(wallTimeMs) || wallTimeMs < 1_000) throw new Error("Invalid task budget");
  options.onLedger?.(ledger);

  // Video generation starts from a generated reference image, so it is only offered alongside image generation.
  const media = options.workOrder
    ? { image: false, voice: false, video: false }
    : { image: options.generation?.image ?? true, voice: options.generation?.voice ?? true, video: (options.generation?.video ?? true) && (options.generation?.image ?? true) };
  const presets = resolve(import.meta.dir, "..", "..", "presets");

  process.env.PI_EDIT_VARIANT = "hashline";
  process.env.PI_STRICT_EDIT_MODE = "1";
  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: join(dataRoot, "omp"),
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory(projectRoot),
    systemPrompt: options.workOrder ? [
      "You are an isolated Alpha worker. Complete only the assigned work order in this project copy.",
      `You may edit only these paths: ${options.workOrder.ownedPaths.join(", ")}. The coordinator rejects all other source changes. Do not edit alpha-verification.json.`,
      "Read relevant context, use Hashline edit for existing files and write for new files. Use alpha_build when useful. Do not start servers or use browser/desktop tools. Report unresolved items honestly; the coordinator will merge and verify the integrated product.",
    ] : [
      "You are Alpha, a building agent. Construct a working software product in the current project directory.",
      `Current task objective v${ledger.state.contractVersion ?? 1}: ${ledger.state.objective}`,
      `Saved user guidance: ${(ledger.state.guidanceHistory ?? []).map(item => item.instruction).join(" | ") || "none"}`,
      `Required acceptance criteria: ${ledger.state.criteria.map(item => `${item.id}: ${item.description}`).join(" | ")}`,
      "Use read and Hashline edit for existing files. Use write for new files. Keep changes within the assigned project directory.",
      "Use alpha_build to build the assigned product. Alpha's runtime then publishes a local preview and runs the browser verification plan. Do not start servers, manage ports or processes, or run browser checks through the terminal. Report what is actually verified and what remains unverified.",
      "Never claim the product is complete solely because code was written or a command exited successfully.",
      ...(media.image ? ["When the product needs an original illustration or other generated image, call alpha_generate_image with a product-specific visual prompt, then reference its returned asset URL exactly in the product and check it in the browser. Do not rename, copy, or recreate the returned binary asset with the write tool. The user need not name ComfyUI. If the user says not to generate new images, do not call it. If the local service is unavailable, report that honestly; do not switch services."] : []),
      ...(media.voice ? ["When the product needs spoken narration or voice audio, call alpha_generate_voice with the exact words and a brief voice description, then reference its returned FLAC URL exactly. Do not call it when the user forbids generation. Browser loading and format checks do not prove listening quality; report listening review as pending unless it was actually performed."] : []),
      ...(media.video ? ["When the product needs original video, first call alpha_generate_image with aspect=landscape if no suitable 16:9 PNG exists. Pass the exact returned /alpha-assets/...png URL to alpha_generate_video with a precise motion prompt; never create a placeholder reference.png or rewrite the generated binary. ComfyUI runs locally. Treat the result as a candidate. The verification plan must include a video step targeting the page's video element; the runtime checks decoded start, middle and end frames after publication. Do not claim subjective visual approval unless those frames were actually reviewed. Do not generate video when the user forbids new media."] : []),
      ...(!media.image || !media.voice || !media.video ? [`These media generation tools are turned off in Alpha's settings: ${[!media.image && "image", !media.voice && "voice", !media.video && "video"].filter(Boolean).join(", ")}. If the product needs such media, use existing assets or CSS/SVG made in code, and tell the user that generation is off.`] : []),
      "If two substantial source changes are independent, you may use alpha_delegate with exactly two work orders and non-overlapping owned paths and resources. You remain responsible for the integrated build and alpha-verification.json; re-read merged files before editing them.",
      ...(ledger.state.contractVersion && ledger.state.contractVersion > 1 ? ["The user revised this task. Preserve earlier requirements unless explicitly superseded, and update alpha-verification.json so the browser checks the revised behavior, even if the existing app still builds."] : []),
      "For a web product, write alpha-verification.json in the project root with a repeatable core user path. Use {\"steps\":[...]} with flat step objects: fill/select {action,selector,value}, click {action,selector}, expectText/expectAbsentText {action,text,selector?}, expectValue {action,selector,value} for an input/textarea/select value, video {action,selector} for a decoded video frame check, viewport {action,width,height}, contrast {action,selector,minRatio:4.5}, wait {action,ms<=3000}, or reload {action}. No comment-only steps or unsupported fields. Use {{nonce}} only in free-text fields, not numeric/date/select values. Include a click, two outcome assertions, a viewport at most 400px wide, a contrast check, a video step when video is required, and reload when persistence is required. Use fill/select only when the product has those controls. The runtime will execute the plan against the deployed preview; never mark it passed yourself.",
      options.browser ? "The alpha_browser tool controls the visible local preview. Use it to check real user paths and inspect console/network failures." : "No visible browser is connected; report browser verification as pending.",
    ],
    toolNames: [
      "read", "grep", "edit", "write", "alpha_build",
      ...(!options.workOrder ? ["alpha_delegate"] : []),
      ...(media.image ? ["alpha_generate_image"] : []),
      ...(media.voice ? ["alpha_generate_voice"] : []),
      ...(media.video ? ["alpha_generate_video"] : []),
      ...(options.browser ? ["alpha_browser"] : []),
    ],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    customTools: [
      createBuildTool(projectRoot),
      ...(!options.workOrder ? [createWorkOrderTool(ledger, dataRoot, options.signal)] : []),
      ...(media.image ? [createImageTool(projectRoot, dataRoot, join(presets, "flux2-image.api.json"), options.comfyUrl)] : []),
      ...(media.voice ? [createVoiceTool(projectRoot, dataRoot, join(presets, "voxcpm2-voice.api.json"), options.comfyUrl)] : []),
      ...(media.video ? [createVideoTool(projectRoot, dataRoot, join(presets, "h3-video.api.json"), options.comfyUrl)] : []),
      ...(options.browser ? [createBrowserTool(() => options.browser ?? null, dataRoot)] : []),
    ],
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
  session.setAutoRetryEnabled(false);
  session.setAutoCompactionEnabled(true);
  let toolCalls = 0;
  let compactions = 0;
  let compactionFailures = 0;
  let budgetReason: string | null = null;
  let stalledReason: string | null = null;
  let outcome: "returned" | "cancelled" | "budget" | "error" = "returned";
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
    await options.onSessionReady?.(text => session.steer(text));
    await session.prompt(prompt);
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
    outcome = stalledReason ? "error" : budgetReason ? "budget" : options.signal?.aborted ? "cancelled" : "error";
    failureReason = stalledReason ?? budgetReason ?? (error instanceof Error ? error.message : String(error));
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
    await ledger.recordRun({ model: selector, toolCalls, compactions, compactionFailures, maxToolCalls, wallTimeMs, elapsedMs: Math.round(performance.now() - started), outcome, failureReason });
    await session.dispose();
  }
}
