import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TaskLedger, fingerprintSource, type TaskType } from "./task-ledger";
import { listResearchSources } from "./research-source";
import { prohibitionViolations, statedProhibitions } from "./stated-prohibitions";

export interface UploadedInput { name: string; mimeType: string; bytes: Uint8Array }
interface Deliverable { outputs: Array<{ path: string; sourceIds?: string[] }> }

const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function createGeneralWorkspace(input: { taskType: "research" | "file-work" | "general"; objective: string; productsRoot: string; dataRoot: string; files?: UploadedInput[]; modelSelector?: string; startMode?: "plan" | "execute"; continueUntilAccepted?: boolean }): Promise<TaskLedger> {
  if (!input.objective.trim()) throw new Error("Task objective is required");
  const files = input.files ?? [];
  if (files.length > 20 || files.reduce((size, file) => size + file.bytes.length, 0) > 50_000_000) throw new Error("Too many or too large input files");
  const projectRoot = join(resolve(input.productsRoot), `work-${randomUUID()}`);
  await mkdir(join(projectRoot, "inputs"), { recursive: true });
  await mkdir(join(projectRoot, "outputs"), { recursive: true });
  const inputs: NonNullable<TaskLedger["state"]["inputs"]> = [];
  for (const file of files) {
    const name = file.name.trim();
    if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name === "." || name === ".." || file.bytes.length > 25_000_000) throw new Error("Invalid input file");
    const id = randomUUID();
    const path = join(projectRoot, "inputs", `${id}-${name}`);
    await writeFile(path, file.bytes, { flag: "wx" });
    inputs.push({ id, name, path, mimeType: file.mimeType, size: file.bytes.length, sha256: sha256(file.bytes), uploadedAt: new Date().toISOString() });
  }
  return TaskLedger.create(input.dataRoot, { objective: input.objective, projectRoot, taskType: input.taskType, inputs, modelSelector: input.modelSelector, startMode: input.startMode, continueUntilAccepted: input.continueUntilAccepted,
    criteria: input.taskType === "general" ? [] : [{ id: "deliverable", description: "Reviewable deliverable", kind: "artifact" }],
  });
}

export async function verifyGeneralDeliverable(ledger: TaskLedger, dataRoot: string, complete = true): Promise<void> {
  const taskType: TaskType = ledger.state.taskType ?? "web-product";
  if (taskType !== "research" && taskType !== "file-work" && taskType !== "general") throw new Error("Task is not a general work task");
  if (await fingerprintSource(ledger.state.projectRoot) !== ledger.state.revision) throw new Error("Workspace changed before deliverable review");
  for (const input of ledger.state.inputs ?? []) {
    const inputRoots = await Promise.all([join(ledger.state.projectRoot, "inputs"), join(dataRoot, "task-inputs", ledger.state.id)].map(path => realpath(path).catch(() => null)));
    const file = await realpath(input.path);
    if (!inputRoots.some(root => root && inside(root, file)) || sha256(await readFile(file)) !== input.sha256) throw new Error(`Input changed after upload: ${input.name}`);
  }
  const manifestPath = join(ledger.state.projectRoot, "alpha-deliverable.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Deliverable;
  if (!Array.isArray(manifest.outputs) || !manifest.outputs.length || manifest.outputs.length > 20) throw new Error("Deliverable needs 1–20 outputs");
  const sources = taskType === "research" || taskType === "general" ? await listResearchSources(dataRoot, ledger.state.id) : [];
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const outputs: Array<{ path: string; hash: string; sourceIds: string[] }> = [];
  for (const item of manifest.outputs) {
    if (!item || typeof item.path !== "string" || !item.path.startsWith("outputs/") || item.path.includes("\\") || item.path.split("/").some(part => part === ".." || part === ".")) throw new Error("Output must stay in outputs/");
    const path = resolve(ledger.state.projectRoot, item.path);
    if (!inside(join(ledger.state.projectRoot, "outputs"), path) || !inside(ledger.state.projectRoot, await realpath(path)) || !(await stat(path)).isFile()) throw new Error("Output path leaves task workspace");
    const sourceIds = item.sourceIds ?? [];
    if (!Array.isArray(sourceIds) || sourceIds.some(id => typeof id !== "string" || !sourceById.has(id))) throw new Error("Deliverable cites an unknown source");
    outputs.push({ path, hash: sha256(await readFile(path)), sourceIds });
  }
  for (const output of [...outputs]) {
    const id = /^([0-9a-f-]{36})-/.exec(basename(output.path))?.[1];
    if (!id) continue;
    const record = await readFile(join(dataRoot, "artifacts", ledger.state.id, `${id}.json`), "utf8").then(value => JSON.parse(value) as { id: string; taskId: string; path: string; sha256: string; previewPath?: string; previewSha256?: string; beforePreviewPath?: string; beforePreviewSha256?: string }).catch(() => null);
    if (!record || record.id !== id || record.taskId !== ledger.state.id || record.path !== output.path || record.sha256 !== output.hash) continue;
    for (const [candidate, expected] of [[record.previewPath, record.previewSha256], [record.beforePreviewPath, record.beforePreviewSha256]]) {
      if (!candidate || !expected || candidate === output.path || outputs.some(item => item.path === candidate)) continue;
      const path = await realpath(candidate);
      if (!inside(join(ledger.state.projectRoot, "outputs"), path) || sha256(await readFile(path)) !== expected) throw new Error("Office preview changed after verification");
      outputs.push({ path, hash: expected, sourceIds: output.sourceIds });
    }
  }
  if (ledger.state.criteria.some(item => item.id === "sources")) {
    for (const source of sources) {
      await ledger.recordEvidence({ criterionId: "sources", kind: "source", revision: ledger.state.revision!, passed: true, source: join(dataRoot, "sources", ledger.state.id, `${source.id}.json`), contentHash: source.sha256, referenceIds: [source.id] });
    }
  }
  const prohibited = statedProhibitions(ledger.state.objective);
  if (prohibited.length) {
    for (const output of outputs) {
      if (!TEXT_OUTPUT.test(output.path)) continue;
      const violations = prohibitionViolations(await readFile(output.path, "utf8"), prohibited);
      if (violations.length) throw new Error(`Output ${basename(output.path)} uses prohibited terms: ${violations.join(", ")}`);
    }
  }
  for (const output of outputs) {
    const frozenDir = join(dataRoot, "artifacts", ledger.state.id, randomUUID());
    await mkdir(frozenDir, { recursive: true });
    const frozenPath = join(frozenDir, basename(output.path));
    await writeFile(frozenPath, await readFile(output.path), { flag: "wx" });
    await ledger.recordEvidence({ criterionId: "deliverable", kind: "artifact", revision: ledger.state.revision!, passed: true, source: frozenPath, contentHash: output.hash, referenceIds: output.sourceIds });
  }
  if (complete) await ledger.complete();
}

/** Text outputs carry copy, so what the objective forbids in words applies to them too. */
const TEXT_OUTPUT = /\.(?:md|txt|tsv|csv|json|srt|vtt|xml|ya?ml|html?)$/i;

/**
 * The runtime, not the model, decides whether the answer respects what the objective forbids in words
 * ("不要使用“最”“第一”这类绝对化用语"). The scan covers the task's full text answer — the surface the person reads
 * in the thread and independent checks grade — so a prohibited term anywhere keeps the task out of "已验收".
 * Clean answers get passing evidence for the `compliance` criterion; violations are recorded as failing evidence,
 * which leaves the criterion unmet: exactly the completion gap that keeps the task from completing.
 */
export async function recordAnswerCompliance(ledger: TaskLedger, dataRoot: string, runId: string, text: string): Promise<boolean> {
  const terms = statedProhibitions(ledger.state.objective);
  if (!terms.length) return true;
  if (!ledger.state.criteria.some(item => item.id === "compliance")) {
    await ledger.setCriteria([...ledger.state.criteria, { id: "compliance", description: "回答不含目标明示的禁用词", kind: "asset" }]);
  }
  const violations = prohibitionViolations(text, terms);
  const contentHash = sha256(new TextEncoder().encode(text));
  const evidencePath = join(dataRoot, "evidence", `${ledger.state.id}-${runId}-compliance-${contentHash.slice(0, 12)}.json`);
  await mkdir(join(dataRoot, "evidence"), { recursive: true });
  await writeFile(evidencePath, JSON.stringify({ terms, violations, contentHash }, null, 2), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await ledger.recordEvidence({ criterionId: "compliance", kind: "asset", revision: ledger.state.revision!, passed: !violations.length, source: evidencePath, contentHash });
  if (violations.length) {
    await ledger.recordFailure(`Answer uses prohibited terms: ${violations.join(", ")}`);
    return false;
  }
  return true;
}
