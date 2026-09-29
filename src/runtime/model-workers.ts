import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { executeWorkOrders, orderKind, type WorkBatchReport, type WorkOrder, type WorkerResult } from "./work-orders";
import { hashSkillDirectory, SkillPluginStore, type SkillPlugin } from "../plugins/third-party";
import { ExpertStore } from "./experts";
import { createBrowserTool } from "./browser-tool";
import type { BrowserSession } from "./visible-browser";
import { parseWorkerBrowserRequest } from "./worker-browser-tool";
import type { TaskState } from "./task-ledger";
import { capabilityPool, resolvePoolSkill } from "./capability-pool";
import { guardMCPTools, MCPPermissionStore } from "./mcp-permissions";
import { parseWorkerMCPRequest, writeWorkerMCPResponse, type WorkerMCPDescriptor } from "./worker-mcp-proxy";
import { commandApprovalStore, type CommandRequest } from "./command-approval";
import { independentCommandReviewer } from "./auto-reviewer";
import { readToolCatalog, writeToolCatalog } from "./mcp-tool-catalog";
import { copySkillDirectory } from "./skill-snapshot";
import { WorkerStopError, workerStopReason } from "./worker-stop";

const appRoot = resolve(import.meta.dir, "..", "..");

export async function snapshotSkills(dataRoot: string, stateRoot: string, order: WorkOrder): Promise<WorkOrder> {
  const pluginStore = new SkillPluginStore(dataRoot);
  const [available, installed, catalog] = await Promise.all([pluginStore.loadSkills(), pluginStore.list(), capabilityPool(dataRoot)]);
  const bundled = order.expert ? await new ExpertStore(dataRoot).loadBundledSkills(order.expert) : [];
  const selected: SkillPlugin[] = [];
  const skillSnapshots: NonNullable<WorkOrder["skillSnapshots"]> = [];
  const capabilitySnapshots: NonNullable<WorkOrder["capabilitySnapshots"]> = [];
  for (const id of order.capabilityIds ?? []) {
    const previous = order.capabilitySnapshots?.find(entry => entry.id === id);
    if (previous?.kind === "skill") { capabilitySnapshots.push(previous); continue; }
    const item = catalog.find(entry => entry.id === id && entry.enabled);
    if (!item) throw new Error(`Capability is unavailable: ${id}`);
    if (previous && (previous.revision !== item.revision || previous.hash !== item.hash)) throw new Error(`Capability changed since delegation: ${id}`);
    capabilitySnapshots.push({ id, kind: item.kind, revision: item.revision, ...(item.hash ? { hash: item.hash } : {}) });
  }
  const skillIds = [...new Set([...(order.skillIds ?? []), ...capabilitySnapshots.filter(item => item.kind === "skill").map(item => item.id)])];
  for (const id of skillIds) {
    const previous = order.skillSnapshots?.find(item => item.id === id);
    if (previous) {
      const match = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/.exec(id);
      if (!match) throw new Error(`Worker Skill snapshot is invalid: ${id}`);
      const existing = previous.path ? join(stateRoot, "plugin-packs", previous.path) : join(stateRoot, "plugin-packs", match[1], "skills", match[2]);
      if (await hashSkillDirectory(existing) !== previous.hash) throw new Error(`Worker Skill snapshot changed: ${id}`);
      skillSnapshots.push(previous);
      continue;
    }
    const bundledSkill = bundled.find(item => item.name === id);
    const pooled = bundledSkill ? undefined : await resolvePoolSkill(dataRoot, id, order.expert?.id);
    const skill = bundledSkill ?? pooled?.skill ?? available.find(item => item.name === id);
    const pluginId = id.split(":")[0];
    const plugin = bundledSkill
      ? { id: pluginId, name: pluginId, source: `expert:${order.expert!.id}`, revision: order.expert!.package!.revision, enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false }
      : installed.find(item => item.id === pluginId && item.enabled) ?? (pooled && id.startsWith("expert-") ? { id: pluginId, name: pluginId, source: `pool:${id}`, revision: pooled.revision, enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false } : undefined);
    const pathWithin = skill?.containRoot ? relative(await realpath(skill.containRoot), await realpath(skill.baseDir)) : "..";
    if (!skill || !plugin || !skill.containRoot || pathWithin === ".." || pathWithin.startsWith(`..${sep}`) || isAbsolute(pathWithin)) throw new Error(`Skill 不可用于 worker：${id}`);
    const path = id.startsWith("expert-") ? `selected/${pooled!.hash}` : undefined;
    const target = path ? join(stateRoot, "plugin-packs", path) : join(stateRoot, "plugin-packs", pluginId, "skills", id.slice(pluginId.length + 1));
    const hash = await copySkillDirectory(skill.baseDir, target);
    skillSnapshots.push({ id, hash, revision: plugin.revision, ...(path ? { path } : {}) });
    if (!selected.some(item => item.id === pluginId)) selected.push({ ...plugin, enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false });
    selected.find(item => item.id === pluginId)!.skillCount++;
  }
  await mkdir(join(stateRoot, "plugin-packs"), { recursive: true });
  // .alpha/plugin-packs/installed.json (plugin-packs store): same v1 document as SkillPluginStore.save; a version bump must migrate in SkillPluginStore.list().
  await writeFile(join(stateRoot, "plugin-packs", "installed.json"), JSON.stringify({ plugins: selected, format: "plugin-packs", version: 1 }));
  return { ...order, skillIds, skillSnapshots, capabilitySnapshots };
}

export function runModelWorkOrders(input: {
  projectRoot: string;
  dataRoot: string;
  taskId: string;
  baseRevision: string;
  orders: WorkOrder[];
  signal?: AbortSignal;
  deferMerge?: boolean;
  batchId?: string;
  isolate?: "copy" | "git-worktree";
  agentWorkspace?: string;
  mergeBaseRoot?: string;
  /** Default model inherited by workers without an order-specific selector. */
  modelSelector?: string;
  workerContext?: Pick<TaskState, "taskType" | "workspaceOrigin" | "capabilities" | "permissionMode">;
  plugins?: { comfyui: boolean };
  generation?: { image: boolean; voice: boolean; video: boolean };
  comfyUrl?: string;
  browser?: BrowserSession;
  browserUrl?: string;
  browserAccess?: () => boolean;
  browserLease?: { claim: (instanceId: string) => boolean; release: (instanceId: string) => void };
  onWorkerEvent?: (order: WorkOrder, state: "started" | "completed" | "failed") => void | Promise<void>;
  /** Fired once per child process with its pid, so the parent log can name the process to reap after a hard kill. */
  onWorkerStart?: (order: WorkOrder, info: { pid: number }) => void | Promise<void>;
  onWorkerUsage?: (order: WorkOrder, usage: NonNullable<WorkerResult["usage"]>) => void | Promise<void>;
  onInstallReceipt?: (order: WorkOrder, receipt: CommandRequest, available: boolean) => void | Promise<void>;
}): Promise<WorkBatchReport> {
  let browserQueue: Promise<unknown> = Promise.resolve();
  return executeWorkOrders({ ...input, async runWorker(order, directory, signal) {
    signal?.throwIfAborted();
    const modelSelector = order.modelSelector ?? input.modelSelector;
    if (order.install) {
      if (orderKind(order) !== "execute" || !order.agentId) throw new Error("Dependency installation requires an implementing persistent subagent");
      const cwd = resolve(directory, order.install.cwdRelative);
      const relativeCwd = relative(directory, cwd);
      if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) throw new Error("Dependency installation target escapes the worker workspace");
      const canonicalCwd = relative(await realpath(directory), await realpath(cwd));
      if (canonicalCwd.startsWith("..") || isAbsolute(canonicalCwd)) throw new Error("Dependency installation target escapes the worker workspace through a link");
      const receipt = await commandApprovalStore(input.dataRoot).execute(input.taskId, cwd, order.install.argv, "other", signal,
        input.workerContext?.permissionMode ? { mode: input.workerContext.permissionMode, roots: [directory] } : undefined,
        input.workerContext?.permissionMode === "auto" && input.modelSelector ? independentCommandReviewer(input.dataRoot, input.modelSelector) : undefined,
        order.install.network, order.install.approvalId, order.install.requestId);
      const artifact = resolve(cwd, order.install.availabilityPath);
      const relativeArtifact = relative(cwd, artifact);
      if (!relativeArtifact || relativeArtifact.startsWith("..") || isAbsolute(relativeArtifact)) throw new Error("Installation availability path escapes the worker workspace");
      let available = receipt.status === "complete" && receipt.result?.exitCode === 0 && await stat(artifact).then(() => true, () => false);
      if (available) {
        const canonicalArtifact = relative(await realpath(cwd), await realpath(artifact));
        available = !canonicalArtifact.startsWith("..") && !isAbsolute(canonicalArtifact);
      }
      await input.onInstallReceipt?.(order, receipt, available);
      if (!available) {
        const reason = receipt.status === "pending" ? `Installation approval required: ${receipt.id}` : receipt.status === "complete" && receipt.result?.exitCode === 0 ? `Installed dependency is unavailable at ${order.install.availabilityPath}` : `Installation ${receipt.status} (${receipt.result?.exitCode ?? "no exit code"}): ${receipt.id}`;
        return { status: "needs-context", findings: [reason], evidence: receipt.result?.logPath ? [receipt.result.logPath] : [], unresolved: [reason] };
      }
    }
    const localAbort = new AbortController();
    const workerSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
    const runDir = join(input.dataRoot, "worker-runs", input.taskId, order.instanceId ?? `${order.id}-${randomUUID()}`);
    await mkdir(runDir, { recursive: true });
    const requestFile = join(runDir, "request.json");
    const resultFile = join(runDir, "result.json");
    const browserDirectory = join(runDir, "browser-requests");
    await mkdir(browserDirectory, { recursive: true });
    const mcpDirectory = join(runDir, "mcp-requests");
    await mkdir(mcpDirectory, { recursive: true });
    const stateRoot = order.agentId ? join(input.dataRoot, "worker-agents", input.taskId, order.agentId, "state") : join(runDir, "state");
    const withSkills = await snapshotSkills(input.dataRoot, stateRoot, order);
    const mcpSelections = (withSkills.capabilitySnapshots ?? []).filter(item => item.kind === "mcp-server" || item.kind === "mcp-tool");
    const catalog = mcpSelections.length ? await capabilityPool(input.dataRoot) : [];
    const mcpPlugins = [...new Set(mcpSelections.map(item => catalog.find(entry => entry.id === item.id)?.source).filter((item): item is string => !!item))];
    const mcp = mcpPlugins.length ? await new SkillPluginStore(input.dataRoot).loadMCP(directory, mcpPlugins) : null;
    if (mcp?.errors.length) {
      await mcp.manager.disconnectAll();
      return { status: "needs-context", findings: mcp.errors, evidence: [], unresolved: mcp.errors };
    }
    const allowedMCP = (mcp?.tools ?? []).filter(tool => mcpSelections.some(item => item.kind === "mcp-tool" ? item.id === tool.name : item.id === tool.mcpServerName));
    const permissions = await new MCPPermissionStore(input.dataRoot).list();
    const selectedMCP = (orderKind(order) === "execute" ? allowedMCP : allowedMCP.filter(tool => permissions[tool.name] === "read"));
    const guardedMCP = guardMCPTools(selectedMCP, new MCPPermissionStore(input.dataRoot), input.taskId, async () => undefined);
    const descriptors: WorkerMCPDescriptor[] = selectedMCP.map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, server: tool.mcpServerName ?? "" }));
    if (descriptors.length) {
      const pluginRevisions = await new SkillPluginStore(input.dataRoot).list();
      const prior = await readToolCatalog(input.dataRoot);
      const current = descriptors.map(item => ({ name: item.name, server: item.server, description: item.description, revision: pluginRevisions.find(plugin => item.server.startsWith(`alpha_${plugin.id}_`))?.revision ?? "" }));
      await writeToolCatalog(input.dataRoot, [...prior.filter(item => !current.some(next => next.name === item.name)), ...current]);
    }
    const { expert, ...workOrder } = withSkills;
    await writeFile(requestFile, JSON.stringify({ taskId: input.taskId, projectRoot: directory, dataRoot: stateRoot, authorizationRoot: input.dataRoot, workerContext: input.workerContext, plugins: input.plugins, generation: input.generation, comfyUrl: input.comfyUrl, objective: order.objective, workOrder, workerExpert: expert, modelSelector, browserProxyDir: browserDirectory, mcpProxyDir: mcpDirectory, mcpDescriptors: descriptors, eventFile: join(runDir, "events.jsonl") }));
    await input.onWorkerEvent?.(withSkills, "started");
    const browserTool = createBrowserTool(() => input.browserAccess?.() === false ? null : input.browser ?? null, input.dataRoot, input.browserUrl);
    const handled = new Set<string>();
    let browserPump: Promise<void> | undefined;
    const handledMCP = new Set<string>();
    let mcpPump: Promise<void> | undefined;
    const serveMCP = () => {
      if (mcpPump) return mcpPump;
      mcpPump = (async () => {
        for (const name of (await readdir(mcpDirectory)).filter(item => /^[0-9a-f-]{36}\.request\.json$/.test(item)).sort()) {
          if (handledMCP.has(name)) continue;
          handledMCP.add(name);
          const id = name.slice(0, 36);
          let result: unknown;
          try {
            const file = join(mcpDirectory, name);
            const info = await lstat(file);
            if (!info.isFile() || info.size > 64_000) throw new Error("Invalid worker MCP request");
            const request = parseWorkerMCPRequest(JSON.parse(await readFile(file, "utf8")), id, new Set(guardedMCP.map(tool => tool.name)));
            if (await Bun.file(join(mcpDirectory, `${id}.cancel`)).exists() || workerSignal.aborted) throw new Error("Worker MCP request was cancelled");
            const tool = guardedMCP.find(item => item.name === request.name)!;
            result = await tool.execute(request.callId, request.args as never, undefined, undefined as never, workerSignal);
          } catch (error) { result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
          await writeWorkerMCPResponse(mcpDirectory, id, result);
        }
      })().finally(() => { mcpPump = undefined; });
      return mcpPump;
    };
    const serveBrowser = () => {
      if (browserPump) return browserPump;
      browserPump = (async () => {
        for (const name of (await readdir(browserDirectory)).filter(name => /^[0-9a-f-]{36}\.request\.json$/.test(name)).sort()) {
          if (handled.has(name)) continue;
          handled.add(name);
          const file = join(browserDirectory, name);
          let result: unknown;
          try {
            const info = await lstat(file);
            if (!info.isFile() || info.size > 16_000) throw new Error("Invalid worker browser request");
            const request = parseWorkerBrowserRequest(JSON.parse(await readFile(file, "utf8")), name.slice(0, 36));
            const cancelFile = join(browserDirectory, `${request.id}.cancel`);
            const cancelled = () => readFile(cancelFile).then(() => true, () => false);
            const action = browserQueue.then(async () => {
              if (await cancelled() || Date.now() >= request.deadlineAt || workerSignal.aborted) throw new Error("Worker browser request was cancelled before execution");
              if (!input.browser || !input.browserUrl) return { content: [{ type: "text" as const, text: "No visible local preview is connected to this task" }], isError: true };
              if (input.browserAccess?.() === false || input.browserLease && !input.browserLease.claim(order.instanceId!)) throw new Error("Visible browser is owned by another instance or the user");
              const controller = new AbortController();
              const check = setInterval(() => { void cancelled().then(value => { if (value || Date.now() >= request.deadlineAt || workerSignal.aborted) controller.abort(); }); }, 50);
              try { return await browserTool.execute(request.id, request.args as never, undefined, undefined as never, controller.signal); }
              finally { clearInterval(check); }
            });
            browserQueue = action.then(() => undefined, () => undefined);
            result = await action;
          } catch (error) { result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
          const responseFile = join(browserDirectory, name.replace(".request.json", ".response.json"));
          const temp = `${responseFile}.tmp`;
          await writeFile(temp, JSON.stringify(result), { flag: "wx" });
          await rename(temp, responseFile);
        }
      })().finally(() => { browserPump = undefined; });
      return browserPump;
    };
    workerSignal.throwIfAborted();
    const child = Bun.spawn([process.execPath, "run", join(appRoot, "scripts", "run-worker.ts"), requestFile, resultFile], {
      cwd: appRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abort = () => {
      localAbort.abort();
      child.kill("SIGINT");
      hardKill ??= setTimeout(() => child.kill(), 2_000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => { timedOut = true; abort(); }, 610_000);
    await input.onWorkerStart?.(withSkills, { pid: child.pid });
    const started = performance.now();
    let usageRecorded = false;
    const browserPoll = setInterval(() => { void serveBrowser().catch(() => undefined); }, 50);
    const mcpPoll = setInterval(() => { void serveMCP().catch(() => undefined); }, 50);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const result = await readFile(resultFile, "utf8").then(text => JSON.parse(text) as WorkerResult & { error?: string }).catch(() => null);
      if (result?.usage) { await input.onWorkerUsage?.(withSkills, result.usage); usageRecorded = true; }
      if (workerSignal.aborted) throw new WorkerStopError(timedOut && !signal?.aborted ? "no-result" : "aborted", `Worker ${order.id} was cancelled or timed out`);
      if (exitCode !== 0 || result?.error || !result) {
        const message = result?.error || stderr.trim().slice(-2_000) || stdout.trim().slice(-2_000) || `Worker ${order.id} exited ${exitCode}`;
        throw new WorkerStopError(workerStopReason({ resultStopReason: result?.stopReason, errorText: message, usageIncomplete: !result }), message);
      }
      await input.onWorkerEvent?.(withSkills, "completed");
      return result;
    } catch (error) {
      if (!usageRecorded) await input.onWorkerUsage?.(withSkills, { model: modelSelector ?? "task-default", toolCalls: 0, elapsedMs: Math.round(performance.now() - started), outcome: signal?.aborted ? "cancelled" : "error", incomplete: true });
      await input.onWorkerEvent?.(withSkills, "failed");
      throw error;
    } finally {
      clearInterval(browserPoll);
      clearInterval(mcpPoll);
      await browserPump;
      await mcpPump;
      await mcp?.manager.disconnectAll();
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener("abort", abort);
      if (order.instanceId) input.browserLease?.release(order.instanceId);
    }
  } });
}
