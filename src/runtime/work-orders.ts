import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fingerprintSource } from "./task-ledger";
import type { AgentPresetSnapshot } from "./agent-presets";
import { excludedSourceDirectory } from "./source-review";

export interface WorkOrder {
  id: string;
  objective: string;
  ownedPaths: string[];
  resources: string[];
  readPaths?: string[];
  /** Async worktree workers may use the whole project; scopes remain scheduling hints. */
  fullAccess?: boolean;
  mode?: "investigate" | "implement" | "review";
  expertId?: string;
  skillIds?: string[];
  skillSnapshots?: Array<{ id: string; hash: string; revision: string }>;
  dependsOn?: string[];
  acceptance?: string[];
  instanceId?: string;
  contractVersion?: number;
  cognitionRevision?: number;
  baseRevision?: string;
  presetId?: string;
  /** Resolved once when the parent run starts; never supplied by the model. */
  preset?: AgentPresetSnapshot;
}

export interface WorkerResult {
  status?: "completed" | "needs-context" | "blocked" | "failed";
  findings?: string[];
  reviewVerdict?: "pass" | "changes-requested" | "inconclusive";
  reviewEvidence?: Array<{ path: string; excerpt: string }>;
  evidence: string[];
  readPaths?: string[];
  unresolved: string[];
  requests?: Array<{ capability: string; reason: string; details: string }>;
  usage?: { model: string; toolCalls: number; elapsedMs: number; tokens?: RunUsage; outcome?: "returned" | "cancelled" | "budget" | "error" | "needs-input"; incomplete?: boolean };
}

type RunUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };

export interface WorkBatchReport {
  status: "ready" | "merged" | "merging" | "rejected" | "partial";
  elapsedMs: number;
  baseRevision: string;
  mergedRevision?: string;
  workRoot: string;
  changes: Record<string, string[]>;
  outputHashes?: Record<string, Record<string, string | null>>;
  committed: string[];
  planned?: Record<string, { before?: string; after?: string }>;
  rolledBack?: string[];
  inFlight?: { file: string; temporary: string };
  results: Record<string, WorkerResult>;
  presets?: Record<string, Pick<AgentPresetSnapshot, "id" | "name" | "hash" | "source">>;
  reason?: string;
}

type Snapshot = Map<string, string>;

function validPath(path: string): boolean {
  const parts = path.endsWith("/") ? path.slice(0, -1).split("/") : path.split("/");
  return !path.includes("\\") && !path.startsWith("/") && !path.includes(":") && parts.every((part, index) => part && part !== "." && part !== ".." && !excludedSourceDirectory(part, index === 0));
}

function owns(scope: string, path: string): boolean {
  return scope.endsWith("/") ? path.startsWith(scope) : path === scope;
}

function overlaps(first: string, second: string): boolean {
  if (first.endsWith("/") && second.endsWith("/")) return first.startsWith(second) || second.startsWith(first);
  if (first.endsWith("/")) return owns(first, second);
  if (second.endsWith("/")) return owns(second, first);
  return first === second;
}

export function validateOrders(orders: WorkOrder[], maximum = 2): void {
  if (orders.length < 1 || orders.length > maximum) throw new Error(`One to ${maximum} work orders are required`);
  const ids = new Set<string>();
  const scopes: string[] = [];
  const resources = new Set<string>();
  for (const order of orders) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(order.id) || ids.has(order.id) || !order.objective.trim() || (!order.fullAccess && (order.mode ?? "implement") === "implement" && order.ownedPaths.length === 0)) throw new Error("Invalid work order");
    if (order.mode && !["investigate", "implement", "review"].includes(order.mode)) throw new Error("Invalid work order mode");
    if (!order.fullAccess && order.mode && order.mode !== "implement" && order.ownedPaths.length) throw new Error("Read-only orders cannot own source paths");
    ids.add(order.id);
    for (const scope of order.ownedPaths) {
      if (!validPath(scope) || (!order.fullAccess && (scope === "alpha-verification.json" || scopes.some(previous => overlaps(previous, scope))))) throw new Error(`Conflicting or invalid ownership: ${scope}`);
      if (!order.fullAccess) scopes.push(scope);
    }
    for (const path of order.readPaths ?? []) {
      if (path !== "." && !validPath(path)) throw new Error(`Invalid read path: ${path}`);
    }
    for (const resource of order.resources) {
      if (!resource.trim() || resources.has(resource)) throw new Error(`Conflicting resource: ${resource}`);
      resources.add(resource);
    }
  }
}

async function sourceFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.name === ".git") continue;
    if (entry.isSymbolicLink()) throw new Error(`Worker source contains a symlink: ${absolute}`);
    if (entry.isDirectory()) {
      if (!excludedSourceDirectory(entry.name, directory === root)) files.push(...await sourceFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(absolute.slice(root.length + 1).split(sep).join("/"));
    }
  }
  return files.sort();
}

async function snapshot(root: string): Promise<Snapshot> {
  const hashes = new Map<string, string>();
  for (const file of await sourceFiles(root)) hashes.set(file, createHash("sha256").update(await readFile(join(root, file))).digest("hex"));
  return hashes;
}

async function copySnapshot(source: string, destination: string, files: Iterable<string>): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file), target);
  }
}

async function createGitWorktree(projectRoot: string, destination: string): Promise<void> {
  const child = Bun.spawn(["git", "-C", projectRoot, "worktree", "add", "--detach", "--no-checkout", destination, "HEAD"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Cannot create worker Git worktree: ${stderr.slice(0, 500)}`);
}

function changedFiles(base: Snapshot, current: Snapshot): string[] {
  return [...new Set([...base.keys(), ...current.keys()])].filter(file => base.get(file) !== current.get(file)).sort();
}

async function fileHash(path: string): Promise<string | undefined> {
  return readFile(path).then(bytes => createHash("sha256").update(bytes).digest("hex")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

async function rollbackMerge(projectRoot: string, workRoot: string, report: WorkBatchReport): Promise<void> {
  if (!report.planned) throw new Error("Incomplete merge has no recovery journal");
  if (report.inFlight) {
    const target = join(projectRoot, report.inFlight.file);
    if (!report.planned[report.inFlight.file] || !report.inFlight.temporary.startsWith(`${target}.`) || !/\.[0-9a-f-]{36}\.tmp$/.test(report.inFlight.temporary)) throw new Error("Incomplete merge has an invalid temporary file journal");
  }
  for (const [file, hashes] of Object.entries(report.planned)) {
    const current = await fileHash(join(projectRoot, file));
    if (current !== hashes.before && current !== hashes.after) throw new Error(`Main file changed independently during merge: ${file}`);
  }
  const rolledBack: string[] = [];
  for (const [file, hashes] of Object.entries(report.planned)) {
    const target = join(projectRoot, file);
    if (await fileHash(target) === hashes.before) continue;
    if (hashes.before === undefined) await unlink(target);
    else {
      const temporary = `${target}.${randomUUID()}.tmp`;
      await copyFile(join(workRoot, "base", file), temporary);
      await rename(temporary, target);
    }
    rolledBack.push(file);
  }
  if (report.inFlight) await unlink(report.inFlight.temporary).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  report.inFlight = undefined;
  report.rolledBack = rolledBack;
}

export async function recoverIncompleteMerges(projectRoot: string, dataRoot: string, taskId: string): Promise<string[]> {
  const parent = join(resolve(dataRoot), "workers", taskId);
  const batches = await readdir(parent, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const recovered: string[] = [];
  for (const batch of batches) {
    if (!batch.isDirectory()) continue;
    const workRoot = join(parent, batch.name);
    const reportFile = join(workRoot, "merge.json");
    const report = await readFile(reportFile, "utf8").then(text => JSON.parse(text) as WorkBatchReport).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!report || (report.status !== "merging" && !(report.status === "partial" && report.planned))) continue;
    await rollbackMerge(projectRoot, workRoot, report);
    report.status = "rejected";
    report.reason = `${report.reason ? `${report.reason}; ` : ""}Recovered incomplete merge`;
    const temporary = `${reportFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2));
    await rename(temporary, reportFile);
    recovered.push(workRoot);
  }
  return recovered;
}

export async function executeWorkOrders(input: {
  projectRoot: string;
  dataRoot: string;
  taskId: string;
  baseRevision: string;
  orders: WorkOrder[];
  signal?: AbortSignal;
  deferMerge?: boolean;
  batchId?: string;
  isolate?: "copy" | "git-worktree";
  runWorker: (order: WorkOrder, directory: string, signal?: AbortSignal) => Promise<WorkerResult>;
}): Promise<WorkBatchReport> {
  const started = performance.now();
  validateOrders(input.orders);
  if (!/^[0-9a-f-]{36}$/.test(input.taskId)) throw new Error("Invalid task ID");
  const projectRoot = resolve(input.projectRoot);
  if (input.batchId && !/^[0-9a-f-]{36}$/.test(input.batchId)) throw new Error("Invalid worker batch ID");
  const workRoot = join(resolve(input.dataRoot), "workers", input.taskId, input.batchId ?? randomUUID());
  const reportFile = join(workRoot, "merge.json");
  const report: WorkBatchReport = { status: "rejected", elapsedMs: 0, baseRevision: input.baseRevision, workRoot, changes: {}, committed: [], results: {}, presets: Object.fromEntries(input.orders.filter(order => order.preset).map(order => [order.id, { id: order.preset!.id, name: order.preset!.name, hash: order.preset!.hash, source: order.preset!.source }])) };
  const save = async () => {
    const temporary = `${reportFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2));
    await rename(temporary, reportFile);
  };
  await mkdir(workRoot, { recursive: true });
  try {
    if (!input.deferMerge) await recoverIncompleteMerges(projectRoot, input.dataRoot, input.taskId);
    input.signal?.throwIfAborted();
    if ((await fingerprintSource(projectRoot)) !== input.baseRevision) throw new Error("Main project changed before workers started");
    const base = await snapshot(projectRoot);
    const baseDir = join(workRoot, "base");
    await copySnapshot(projectRoot, baseDir, base.keys());
    if ((await fingerprintSource(projectRoot)) !== input.baseRevision || changedFiles(base, await snapshot(baseDir)).length) throw new Error("Main project changed during worker snapshot");
    const directories = input.orders.map(order => join(workRoot, order.id));
    if (input.isolate === "git-worktree") {
      for (const directory of directories) await createGitWorktree(projectRoot, directory);
    }
    await Promise.all(directories.map(directory => copySnapshot(baseDir, directory, base.keys())));
    const settled = await Promise.allSettled(input.orders.map((order, index) => input.runWorker(order, directories[index], input.signal)));
    for (const [index, outcome] of settled.entries()) {
      const order = input.orders[index];
      if (outcome.status === "rejected") throw new Error(`Worker ${order.id} failed: ${String(outcome.reason)}`);
      report.results[order.id] = outcome.value;
      if (outcome.value.status && outcome.value.status !== "completed") throw new Error(`Worker ${order.id} ended ${outcome.value.status}`);
      if (outcome.value.unresolved.length) throw new Error(`Worker ${order.id} has unresolved items: ${outcome.value.unresolved.join("; ")}`);
      if (!order.fullAccess && order.mode === "review" && outcome.value.reviewVerdict !== "pass") throw new Error(`Review ${order.id} did not pass: ${outcome.value.reviewVerdict ?? "inconclusive"}`);
      const workerSnapshot = await snapshot(directories[index]);
      const changes = changedFiles(base, workerSnapshot);
      report.changes[order.id] = changes;
      (report.outputHashes ??= {})[order.id] = Object.fromEntries(changes.map(file => [file, workerSnapshot.get(file) ?? null]));
      if (!changes.length && (order.mode ?? "implement") === "implement" && !order.fullAccess) throw new Error(`Worker ${order.id} produced no source changes`);
      if (!order.fullAccess && changes.length && order.mode && order.mode !== "implement") throw new Error(`Read-only worker ${order.id} changed source`);
      const unexpected = order.fullAccess ? undefined : changes.find(file => !order.ownedPaths.some(scope => owns(scope, file)));
      if (unexpected) throw new Error(`Worker ${order.id} changed unowned file: ${unexpected}`);
    }
    input.signal?.throwIfAborted();
    if (input.deferMerge) {
      report.status = "ready";
      report.elapsedMs = Math.round(performance.now() - started);
      await save();
      return report;
    }
    if ((await fingerprintSource(projectRoot)) !== input.baseRevision) throw new Error("Main project changed before merge");
    report.planned = {};
    for (const [index, order] of input.orders.entries()) {
      const worker = await snapshot(directories[index]);
      for (const file of report.changes[order.id]) report.planned[file] = { before: base.get(file), after: worker.get(file) };
    }
    report.status = "merging";
    await save();
    for (const [index, order] of input.orders.entries()) {
      const worker = await snapshot(directories[index]);
      for (const file of report.changes[order.id]) {
        input.signal?.throwIfAborted();
        const target = join(projectRoot, file);
        const current = await fileHash(target);
        if (current !== base.get(file)) throw new Error(`Main file changed before merge: ${file}`);
        if (worker.has(file)) {
          await mkdir(dirname(target), { recursive: true });
          const temporary = `${target}.${randomUUID()}.tmp`;
          report.inFlight = { file, temporary };
          await save();
          await copyFile(join(directories[index], file), temporary);
          await rename(temporary, target);
        } else {
          await unlink(target);
        }
        report.committed.push(file);
        report.inFlight = undefined;
        await save();
      }
    }
    report.status = "merged";
    report.mergedRevision = await fingerprintSource(projectRoot);
  } catch (error) {
    report.reason = error instanceof Error ? error.message : String(error);
    if (report.status === "merging") {
      try {
        await rollbackMerge(projectRoot, workRoot, report);
        report.status = "rejected";
      } catch (rollbackError) {
        report.status = "partial";
        report.reason += `; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
    } else report.status = "rejected";
  }
  report.elapsedMs = Math.round(performance.now() - started);
  await save();
  return report;
}

/** Integrate one previously checked isolated result. Other, unrelated parent edits may coexist. */
export async function integratePreparedWorkOrder(projectRoot: string, dataRoot: string, taskId: string, instanceId: string, order: WorkOrder, signal?: AbortSignal): Promise<WorkBatchReport> {
  const root = resolve(projectRoot);
  const workRoot = join(resolve(dataRoot), "workers", taskId, instanceId);
  if (!/^[0-9a-f-]{36}$/.test(taskId) || !/^[0-9a-f-]{36}$/.test(instanceId)) throw new Error("Invalid worker identity");
  const reportFile = join(workRoot, "merge.json");
  const report = JSON.parse(await readFile(reportFile, "utf8")) as WorkBatchReport;
  if (report.workRoot !== workRoot || report.status !== "ready" || !report.results[order.id]) throw new Error("Worker result is not ready to integrate");
  const save = async () => { const temp = `${reportFile}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(report, null, 2)); await rename(temp, reportFile); };
  const base = await snapshot(join(workRoot, "base"));
  const worker = await snapshot(join(workRoot, order.id));
  const changes = changedFiles(base, worker);
  if (JSON.stringify(changes) !== JSON.stringify(report.changes[order.id]) || changes.some(file => (worker.get(file) ?? null) !== report.outputHashes?.[order.id]?.[file]) || (!order.fullAccess && changes.some(file => !order.ownedPaths.some(scope => owns(scope, file))))) throw new Error("Worker result changed after inspection");
  const current = await snapshot(root);
  const readScopes = [...new Set([...(order.readPaths ?? []), ...(report.results[order.id].readPaths ?? [])])];
  const readChanges = changedFiles(base, current).filter(file => readScopes.some(scope => scope === "." || owns(scope, file)));
  if (readChanges.length) throw new Error(`Worker read dependency changed: ${readChanges.slice(0, 5).join(", ")}`);
  if (changes.some(file => current.get(file) !== base.get(file))) throw new Error("Worker output conflicts with main project");
  report.planned = Object.fromEntries(changes.map(file => [file, { before: base.get(file), after: worker.get(file) }]));
  try {
    signal?.throwIfAborted();
    report.status = "merging";
    await save();
    for (const file of changes) {
      signal?.throwIfAborted();
      const target = join(root, file);
      if (await fileHash(target) !== base.get(file)) throw new Error(`Main file changed before merge: ${file}`);
      if (worker.has(file)) {
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        report.inFlight = { file, temporary }; await save();
        await copyFile(join(workRoot, order.id, file), temporary);
        await rename(temporary, target);
      } else await unlink(target);
      report.committed.push(file);
      report.inFlight = undefined;
      await save();
    }
    report.status = "merged";
    report.mergedRevision = await fingerprintSource(root);
  } catch (error) {
    report.reason = error instanceof Error ? error.message : String(error);
    try { await rollbackMerge(root, workRoot, report); report.status = "rejected"; }
    catch (rollbackError) { report.status = "partial"; report.reason += `; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`; }
  }
  await save();
  return report;
}
