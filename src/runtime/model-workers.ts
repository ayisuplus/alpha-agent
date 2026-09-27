import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { executeWorkOrders, type WorkBatchReport, type WorkOrder, type WorkerResult } from "./work-orders";
import { SkillPluginStore, type SkillPlugin } from "../plugins/third-party";
import { AgentPresetStore } from "./agent-presets";
import { createBrowserTool } from "./browser-tool";
import type { BrowserSession } from "./visible-browser";
import { parseWorkerBrowserRequest } from "./worker-browser-tool";
import type { TaskState } from "./task-ledger";

const appRoot = resolve(import.meta.dir, "..", "..");

async function copySkill(source: string, target: string): Promise<string> {
  const digest = createHash("sha256");
  let total = 0;
  async function walk(from: string, to: string, prefix = ""): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Skill contains unsupported entry: ${entry.name}`);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(from, entry.name), join(to, entry.name), `${relative}/`);
      else {
        const path = join(from, entry.name);
        const size = (await stat(path)).size;
        total += size;
        if (total > 8_000_000) throw new Error("Selected Skill exceeds snapshot size limit");
        const bytes = await readFile(path);
        digest.update(relative).update("\0").update(bytes).update("\0");
        await copyFile(path, join(to, entry.name));
      }
    }
  }
  await walk(source, target);
  return digest.digest("hex");
}

export async function snapshotSkills(dataRoot: string, stateRoot: string, order: WorkOrder): Promise<WorkOrder> {
  if (!order.skillIds?.length) return order;
  const pluginStore = new SkillPluginStore(dataRoot);
  const [available, installed] = await Promise.all([pluginStore.loadSkills(), pluginStore.list()]);
  const bundled = order.preset ? await new AgentPresetStore(dataRoot).loadBundledSkills(order.preset) : [];
  const selected: SkillPlugin[] = [];
  const skillSnapshots: NonNullable<WorkOrder["skillSnapshots"]> = [];
  for (const id of order.skillIds) {
    const bundledSkill = bundled.find(item => item.name === id);
    const skill = bundledSkill ?? available.find(item => item.name === id);
    const pluginId = id.split(":")[0];
    const plugin = bundledSkill
      ? { id: pluginId, name: pluginId, source: `expert:${order.preset!.id}`, revision: order.preset!.package!.revision, enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false }
      : installed.find(item => item.id === pluginId && item.enabled);
    const pathWithin = skill?.containRoot ? relative(await realpath(skill.containRoot), await realpath(skill.baseDir)) : "..";
    if (!skill || !plugin || !skill.containRoot || pathWithin === ".." || pathWithin.startsWith(`..${sep}`) || isAbsolute(pathWithin)) throw new Error(`Skill 不可用于 worker：${id}`);
    const target = join(stateRoot, "plugin-packs", pluginId, "skills", id.slice(pluginId.length + 1));
    const hash = await copySkill(skill.baseDir, target);
    skillSnapshots.push({ id, hash, revision: plugin.revision });
    if (!selected.some(item => item.id === pluginId)) selected.push({ ...plugin, enabled: true, skillCount: 0, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false });
    selected.find(item => item.id === pluginId)!.skillCount++;
  }
  await mkdir(join(stateRoot, "plugin-packs"), { recursive: true });
  await writeFile(join(stateRoot, "plugin-packs", "installed.json"), JSON.stringify({ plugins: selected }));
  return { ...order, skillSnapshots };
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
  onWorkerUsage?: (order: WorkOrder, usage: NonNullable<WorkerResult["usage"]>) => void | Promise<void>;
}): Promise<WorkBatchReport> {
  let browserQueue: Promise<unknown> = Promise.resolve();
  return executeWorkOrders({ ...input, async runWorker(order, directory, signal) {
    signal?.throwIfAborted();
    const modelSelector = order.modelSelector ?? input.modelSelector;
    const localAbort = new AbortController();
    const workerSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
    const runDir = join(input.dataRoot, "worker-runs", input.taskId, order.instanceId ?? `${order.id}-${randomUUID()}`);
    await mkdir(runDir, { recursive: true });
    const requestFile = join(runDir, "request.json");
    const resultFile = join(runDir, "result.json");
    const browserDirectory = join(runDir, "browser-requests");
    await mkdir(browserDirectory, { recursive: true });
    const stateRoot = order.agentId ? join(input.dataRoot, "worker-agents", input.taskId, order.agentId, "state") : join(runDir, "state");
    const withSkills = order.skillSnapshots?.length ? order : await snapshotSkills(input.dataRoot, stateRoot, order);
    const { preset, ...workOrder } = withSkills;
    await writeFile(requestFile, JSON.stringify({ taskId: input.taskId, projectRoot: directory, dataRoot: stateRoot, authorizationRoot: input.dataRoot, workerContext: input.workerContext, plugins: input.plugins, generation: input.generation, comfyUrl: input.comfyUrl, objective: order.objective, workOrder, workerPreset: preset, modelSelector, browserProxyDir: browserDirectory, eventFile: join(runDir, "events.jsonl") }));
    await input.onWorkerEvent?.(withSkills, "started");
    const browserTool = createBrowserTool(() => input.browserAccess?.() === false ? null : input.browser ?? null, input.dataRoot, input.browserUrl);
    const handled = new Set<string>();
    let browserPump: Promise<void> | undefined;
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
    const abort = () => {
      localAbort.abort();
      child.kill("SIGINT");
      hardKill ??= setTimeout(() => child.kill(), 2_000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 125_000);
    const started = performance.now();
    let usageRecorded = false;
    const browserPoll = setInterval(() => { void serveBrowser().catch(() => undefined); }, 50);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const result = await readFile(resultFile, "utf8").then(text => JSON.parse(text) as WorkerResult & { error?: string }).catch(() => null);
      if (result?.usage) { await input.onWorkerUsage?.(withSkills, result.usage); usageRecorded = true; }
      if (workerSignal.aborted) throw new Error(`Worker ${order.id} was cancelled or timed out`);
      if (exitCode !== 0 || result?.error || !result) throw new Error(result?.error || stderr.trim().slice(-2_000) || stdout.trim().slice(-2_000) || `Worker ${order.id} exited ${exitCode}`);
      await input.onWorkerEvent?.(withSkills, "completed");
      return result;
    } catch (error) {
      if (!usageRecorded) await input.onWorkerUsage?.(withSkills, { model: modelSelector ?? "task-default", toolCalls: 0, elapsedMs: Math.round(performance.now() - started), outcome: signal?.aborted ? "cancelled" : "error", incomplete: true });
      await input.onWorkerEvent?.(withSkills, "failed");
      throw error;
    } finally {
      clearInterval(browserPoll);
      await browserPump;
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener("abort", abort);
      if (order.instanceId) input.browserLease?.release(order.instanceId);
    }
  } });
}
