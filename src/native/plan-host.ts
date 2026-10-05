import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { prompt } from "@oh-my-pi/pi-utils";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { cfgCycleOrder, cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resolvePlanModelTransition } from "@oh-my-pi/pi-coding-agent/plan-mode/model-transition";
import { readPlanFile, listPlanFiles, resolvePlanFilePath } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import { humanizePlanTitle, resolvePlanTitle, type PlanApprovalDetails } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { autosaveApprovedPlan } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave";
import { copyLocalArtifacts, resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { isMCPToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { writeDeviceDispatch } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import type { PlanView } from "./host-types";

const templates = join(dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))), "prompts/system");
const approvedPrompt = readFileSync(join(templates, "plan-mode-approved.md"), "utf8");
const compactPrompt = readFileSync(join(templates, "plan-mode-compact-instructions.md"), "utf8");

type PreviousModel = { provider: string; id: string; thinking?: ConfiguredThinkingLevel };
type Presentation = { enabled: string[]; mounted: string[] };

/** Desktop review transport for OMP's public plan/session primitives. No execution or write guards live here. */
export class NativePlanHost {
  private phase: PlanView["phase"] = "off";
  private path = "local://PLAN.md";
  private title = "plan";
  private entered = false;
  private previousModel?: PreviousModel;
  private previousTools?: Presentation;
  private pendingModel?: () => Promise<void>;
  private reviewing = false;
  private failure?: string;
  private feedback: Record<string, string> = {};
  constructor(private session: AgentSession, private emit: (frame: Record<string, unknown>) => void) {
    session.subscribe(event => this.observe(event));
    session.setSessionSwitchReconciler(() => this.restore());
    cfgModelRoles.listen(session.settings, () => {
      if (session.getPlanModeState()?.enabled) void this.applyPlanModel().then(() => this.persist()).catch(error => this.fail(error));
    });
  }
  private get options() { return { cwd: this.session.sessionManager.getCwd(), localProtocolOptions: { getArtifactsDir: () => this.session.sessionManager.getArtifactsDir(), getSessionId: () => this.session.sessionManager.getSessionId() } }; }
  private notify() { this.emit({ type: "alpha_plan", phase: this.phase, planFilePath: this.path, error: this.failure, sessionId: this.session.sessionId, title: this.session.sessionName }); }
  private async persist() {
    this.session.sessionManager.appendModeChange(this.phase === "paused" ? "plan_paused" : this.phase === "active" || this.phase === "review" ? "plan" : "none", {
      planFilePath: this.path, alphaPlan: { previousModel: this.previousModel, previousTools: this.previousTools, review: this.phase === "review", title: this.title, feedback: this.feedback, entered: this.entered },
    });
    await this.session.sessionManager.ensureOnDisk();
    await this.session.sessionManager.flush();
    this.notify();
  }
  async restore() {
    const context = this.session.sessionManager.buildSessionContext();
    this.phase = "off"; this.previousModel = undefined; this.previousTools = undefined; this.pendingModel = undefined;
    this.session.setPlanModeState(undefined); this.session.setPlanProposalHandler(null);
    const data = context.modeData?.alphaPlan as { previousModel?: PreviousModel; previousTools?: Presentation; review?: boolean; title?: string; feedback?: Record<string, string>; entered?: boolean } | undefined;
    this.path = typeof context.modeData?.planFilePath === "string" ? context.modeData.planFilePath : this.session.getPlanReferencePath();
    const approved = [...this.session.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "alpha-approved-plan");
    if (context.mode !== "plan" && context.mode !== "plan_paused" && approved?.type === "custom") {
      const saved = approved.data as { path?: string };
      if (saved?.path) { this.path = saved.path; this.session.setPlanReferencePath(saved.path); }
    }
    this.title = data?.title ?? "plan"; this.feedback = data?.feedback ?? {}; this.entered = data?.entered ?? context.mode === "plan_paused";
    if ((context.mode === "plan" || context.mode === "plan_paused") && lookup("plan.enabled")?.get(this.session.settings) !== false) {
      if (context.mode === "plan") {
        await this.enter(true);
        this.previousModel = data?.previousModel ?? this.previousModel;
        this.previousTools = data?.previousTools ?? this.previousTools;
        this.phase = data?.review ? "review" : "active";
      } else this.phase = "paused";
    } else if (lookup("plan.defaultOnStartup")?.get(this.session.settings) === true && !context.mode && this.session.messages.length === 0) await this.enter();
    this.notify();
  }
  async view(): Promise<PlanView> {
    const path = this.path, phase = this.phase, sessionId = this.session.sessionId;
    const content = await readPlanFile(path, this.options);
    if (path !== this.path || phase !== this.phase || sessionId !== this.session.sessionId) return this.view();
    const previous = this.previousModel && this.session.modelRegistry.find(this.previousModel.provider, this.previousModel.id);
    const usage = this.session.getContextUsage(previous?.contextWindow ? { contextWindow: previous.contextWindow } : undefined);
    const cycle = this.session.getRoleModelCycle(cfgCycleOrder.get(this.session.settings));
    return { phase: this.phase, planFilePath: this.path, physicalPath: resolvePlanFilePath(this.path, this.options), title: this.title, content: content ?? "", feedback: this.feedback, error: this.failure,
      contextUsage: usage, keepContextDisabled: (usage?.percent ?? 0) > 95, models: cycle?.models.map(entry => ({ role: entry.role, provider: entry.model.provider, id: entry.model.id, thinking: entry.thinkingLevel })) ?? [] };
  }
  private observe(event: AgentSessionEvent) {
    if (event.type === "agent_end" && this.pendingModel) { const pending = this.pendingModel; this.pendingModel = undefined; void pending().then(() => this.persist()).catch(error => this.fail(error)); }
    if (event.type !== "tool_execution_end" || event.isError) return;
    const dispatch = writeDeviceDispatch(event.toolName, event.result);
    if (dispatch?.tool === "propose" && dispatch.mode === "execute" && dispatch.inner) void this.review(dispatch.inner as PlanApprovalDetails).catch(error => this.fail(error));
  }
  private fail(error: unknown) { this.failure = error instanceof Error ? error.message : String(error); this.notify(); }
  private snapshot() { return { enabled: this.session.getEnabledToolNames().filter(name => !isMCPToolName(name)), mounted: this.session.getMountedXdevToolNames().filter(name => !isMCPToolName(name)) }; }
  private async enter(restored = false) {
    const mode = this.session.sessionManager.buildSessionContext().mode;
    if (this.session.getGoalModeState() || this.session.getVibeModeState()?.enabled || mode === "goal" || mode === "goal_paused" || mode === "vibe") throw new Error("Exit goal/vibe mode before entering plan mode");
    if (lookup("plan.enabled")?.get(this.session.settings) === false) throw new Error("Plan mode is disabled in native settings");
    const prior = this.session.getPlanModeState();
    this.previousTools = this.snapshot();
    this.previousModel = this.session.model ? { provider: this.session.model.provider, id: this.session.model.id, thinking: this.session.configuredThinkingLevel() } : undefined;
    const tools = this.session.getEnabledToolNames();
    this.session.setPlanModeState({ enabled: true, planFilePath: this.path, workflow: "parallel", reentry: this.entered });
    try { await this.session.setActiveToolsByName([...new Set([...tools, ...(this.session.hasBuiltInTool("write") ? ["write"] : [])])]); }
    catch (error) { this.session.setPlanModeState(prior); throw error; }
    this.session.setPlanProposalHandler(title => this.session.preparePlanForReview(title));
    this.phase = "active";
    if (this.session.isStreaming) await this.session.sendPlanModeContext({ deliverAs: "steer" });
    if (!restored) await this.applyPlanModel();
    this.entered = true;
    if (!restored) await this.persist();
  }
  private async applyPlanModel() {
    const transition = resolvePlanModelTransition(this.session.model, this.session.resolveRoleModelWithThinking("plan"), this.session.isStreaming);
    if (transition.kind === "thinking") this.session.setThinkingLevel(transition.thinkingLevel);
    else if (transition.kind === "apply") {
      const apply = () => this.session.setModelTemporary(transition.model, transition.thinkingLevel);
      if (transition.deferred) this.pendingModel = apply; else await apply();
    }
  }
  private async restoreModel(previous = this.previousModel) {
    if (!previous) return;
    const model = this.session.modelRegistry.find(previous.provider, previous.id);
    if (!model) throw new Error("Pre-plan model is unavailable; restore its provider configuration");
    if (this.session.model?.provider === model.provider && this.session.model.id === model.id) this.session.setThinkingLevel(previous.thinking);
    else await this.session.setModelTemporary(model, previous.thinking);
  }
  private async exit(paused = false, deferModel = false) {
    const state = this.session.getPlanModeState(); const tools = this.snapshot(); const planModel = this.session.model;
    const planThinking = this.session.configuredThinkingLevel();
    this.session.setPlanModeState(undefined);
    try {
      if (this.previousTools) await this.session.restoreNonMCPToolPresentation(this.previousTools.enabled, this.previousTools.mounted);
      if (!deferModel) await this.restoreModel();
    } catch (error) {
      this.session.setPlanModeState(state);
      await this.session.restoreNonMCPToolPresentation(tools.enabled, tools.mounted);
      if (planModel) await this.session.setModelTemporary(planModel, planThinking);
      throw error;
    }
    this.pendingModel = undefined; this.session.setPlanProposalHandler(null); this.phase = paused ? "paused" : "off";
    if (!deferModel) this.previousModel = undefined;
    this.previousTools = undefined; await this.persist();
  }
  private async abortInternal() {
    this.session.markPlanInternalAbortPending();
    this.emit({ type: "alpha_plan_stop", reason: "review", interrupting: this.session.isStreaming });
    try { await this.session.abort({ goalReason: "internal" }); } finally { this.session.clearPlanInternalAbortPending(); }
  }
  private async review(details?: PlanApprovalDetails) {
    if (this.reviewing || !this.session.getPlanModeState()?.enabled) return;
    this.reviewing = true;
    try {
      await this.session.runModeExitTeardown(() => this.abortInternal());
      const path = details?.planFilePath ?? (await listPlanFiles(this.options))[0];
      if (!path) throw new Error("Write a local://<slug>-plan.md file before reviewing");
      const content = await readPlanFile(path, this.options); if (!content?.trim()) throw new Error("Plan file is empty or missing");
      this.path = path; this.title = resolvePlanTitle({ planContent: content, planFilePath: path, suppliedTitle: details?.title }).title;
      this.session.setPlanModeState({ ...this.session.getPlanModeState()!, planFilePath: path });
      this.phase = "review"; await this.persist();
    } finally { this.reviewing = false; }
  }
  private dispatch(text: string, synthetic = false) {
    const send = this.session.isStreaming ? this.session.followUp(text, undefined, { synthetic }) : this.session.prompt(text, { synthetic });
    void send.catch(async error => { if (error instanceof AgentBusyError) await this.session.followUp(text, undefined, { synthetic }); else this.fail(error); });
  }
  async request(input: Record<string, unknown>) {
    const action = String(input.action ?? "view"); this.failure = undefined;
    if (action === "cancel-compaction") { this.session.abortCompaction(); return this.view(); }
    if (this.phase === "compacting") throw new Error("Plan approval is compacting; wait or cancel compaction");
    if (action === "view") return this.view();
    if (action === "toggle" || action === "resume") {
      if ((this.phase === "active" || this.phase === "review") && action === "resume") return this.view();
      if (this.phase === "active" || this.phase === "review") await this.session.runModeExitTeardown(async () => { await this.session.abort({ reason: "User interrupted" }); await this.exit(true); });
      else if (this.phase === "paused" && action === "toggle") { this.phase = "off"; this.entered = false; await this.persist(); }
      else await this.enter();
    } else if (action === "review") await this.review();
    else if (action === "dismiss") { if (this.phase === "review") { this.phase = "active"; await this.persist(); } }
    else {
      if (this.phase !== "review") throw new Error("Open plan review before editing or approving");
      const current = await readPlanFile(this.path, this.options); if (!current) throw new Error("Plan file missing");
      if (typeof input.content === "string" && input.content !== current) {
        if (input.previous !== current) throw new Error("Plan changed since opening; reload before saving");
        await writeFile(resolvePlanFilePath(this.path, this.options), input.content, "utf8");
      }
      if (input.feedback && typeof input.feedback === "object") this.feedback = Object.fromEntries(Object.entries(input.feedback).filter(([, value]) => typeof value === "string")) as Record<string, string>;
      if (action === "edit") await this.persist();
      else if (action === "refine") {
        this.phase = "active"; await this.persist();
        const feedback = Object.entries(this.feedback).filter(([, value]) => value.trim()).map(([section, value]) => `## ${section}\n${value}`).join("\n\n");
        if (feedback) this.dispatch(feedback);
      } else if (action === "save-new") {
        if (input.saved !== true) throw new Error("Save dialog must complete before starting a new session");
        await this.exit(); if (!await this.session.newSession()) throw new Error("New session cancelled by native hook"); this.notify();
      } else if (["approve-clear", "approve-compact", "approve-keep"].includes(action)) await this.approve(action, String(input.role ?? ""));
      else throw new Error("Unsupported plan operation");
    }
    return this.view();
  }
  private async approve(action: string, role: string) {
    const content = await readPlanFile(this.path, this.options); if (!content?.trim()) throw new Error("Plan is empty");
    const view = await this.view(); if (action === "approve-keep" && view.keepContextDisabled) throw new Error("Execution context exceeds native plan keep-context limit (95%)");
    const execution = role ? this.session.getRoleModelCycle(cfgCycleOrder.get(this.session.settings))?.models.find(entry => entry.role === role) : undefined;
    if (role && !execution) throw new Error("Execution model role unavailable");
    const previous = this.previousModel, presentation = this.previousTools ?? this.snapshot();
    const compaction = { outcome: "ok" as "ok" | "cancelled" | "failed" };
    await this.session.runModeExitTeardown(async () => {
      if (action === "approve-compact") this.session.markPlanInternalAbortPending();
      try {
        await this.exit(false, action === "approve-compact");
        if (action === "approve-clear") {
          const oldRoot = resolveLocalRoot(this.options.localProtocolOptions);
          if (!await this.session.newSession()) throw new Error("New session cancelled by native hook; execution not started");
          await copyLocalArtifacts(oldRoot, resolveLocalRoot(this.options.localProtocolOptions));
          const destination = resolvePlanFilePath(this.path, this.options); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content);
        } else if (action === "approve-compact") {
          this.phase = "compacting"; this.notify(); this.session.setPlanReferencePath(this.path);
          try { await this.session.compact(undefined, { internalGuidance: prompt.render(compactPrompt, { planFilePath: this.path }), suppressContinuation: true }); }
          catch (error) { compaction.outcome = error instanceof CompactionCancelledError ? "cancelled" : "failed"; this.fail(error); }
        }
        if (compaction.outcome === "ok" && execution) await this.session.applyRoleModel(execution); else await this.restoreModel(previous);
        await this.session.restoreNonMCPToolPresentation([...new Set([...presentation.enabled, "read"])], presentation.mounted);
        this.session.setPlanReferencePath(this.path); this.previousModel = undefined; this.phase = "off";
        this.session.sessionManager.appendCustomEntry("alpha-approved-plan", { path: this.path, title: this.title, outcome: compaction.outcome });
        try { await autosaveApprovedPlan({ settings: this.session.settings, cwd: this.options.cwd, title: this.title, planContent: content }); } catch (error) { this.fail(error); }
      } finally { this.session.clearPlanInternalAbortPending(); }
    });
    if (compaction.outcome === "cancelled") { this.failure = "Compaction cancelled; execution was not started. Submit a turn to continue."; this.notify(); return; }
    if (compaction.outcome === "failed") { this.failure = "Compaction failed; execution was not started. " + (this.failure ?? ""); this.notify(); return; }
    if (!this.session.sessionName) await this.session.sessionManager.setSessionName(humanizePlanTitle(this.title), "auto");
    this.session.markPlanReferenceSent(); this.notify();
    this.dispatch(prompt.render(approvedPrompt, { planFilePath: this.path, planContent: content, contextPreserved: action !== "approve-clear" }), true);
  }
}
