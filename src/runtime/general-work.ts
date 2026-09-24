import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TaskLedger, fingerprintSource, type TaskType } from "./task-ledger";
import { listResearchSources } from "./research-source";

export interface UploadedInput { name: string; mimeType: string; bytes: Uint8Array }
interface Deliverable { outputs: Array<{ path: string; sourceIds?: string[] }> }

const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function createGeneralWorkspace(input: { taskType: "research" | "file-work"; objective: string; productsRoot: string; dataRoot: string; files?: UploadedInput[]; modelSelector?: string }): Promise<TaskLedger> {
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
    inputs.push({ id, name, path, mimeType: file.mimeType, sha256: sha256(file.bytes), uploadedAt: new Date().toISOString() });
  }
  return TaskLedger.create(input.dataRoot, { objective: input.objective, projectRoot, taskType: input.taskType, inputs, modelSelector: input.modelSelector,
    criteria: input.taskType === "research"
      ? [{ id: "sources", description: "Archived web sources with access dates", kind: "source" }, { id: "deliverable", description: "Reviewable research deliverable", kind: "artifact" }]
      : [{ id: "deliverable", description: "Reviewable PDF, DOCX or XLSX deliverable", kind: "artifact" }],
  });
}

export async function verifyGeneralDeliverable(ledger: TaskLedger, dataRoot: string): Promise<void> {
  const taskType: TaskType = ledger.state.taskType ?? "web-product";
  if (taskType !== "research" && taskType !== "file-work") throw new Error("Task is not a general work task");
  if (await fingerprintSource(ledger.state.projectRoot) !== ledger.state.revision) throw new Error("Workspace changed before deliverable review");
  for (const input of ledger.state.inputs ?? []) {
    const inputRoot = await realpath(join(ledger.state.projectRoot, "inputs"));
    if (!inside(inputRoot, await realpath(input.path)) || sha256(await readFile(input.path)) !== input.sha256) throw new Error(`Input changed after upload: ${input.name}`);
  }
  const manifestPath = join(ledger.state.projectRoot, "alpha-deliverable.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Deliverable;
  if (!Array.isArray(manifest.outputs) || !manifest.outputs.length || manifest.outputs.length > 20) throw new Error("Deliverable needs 1–20 outputs");
  const sources = taskType === "research" ? await listResearchSources(dataRoot, ledger.state.id) : [];
  const sourceById = new Map(sources.map(source => [source.id, source]));
  if (taskType === "research" && !sources.length) throw new Error("Research deliverable needs archived web sources");
  const outputs: Array<{ path: string; hash: string; sourceIds: string[] }> = [];
  for (const item of manifest.outputs) {
    if (!item || typeof item.path !== "string" || !item.path.startsWith("outputs/") || item.path.includes("\\") || item.path.split("/").some(part => part === ".." || part === ".")) throw new Error("Output must stay in outputs/");
    const path = resolve(ledger.state.projectRoot, item.path);
    if (!inside(join(ledger.state.projectRoot, "outputs"), path) || !inside(ledger.state.projectRoot, await realpath(path)) || !(await stat(path)).isFile()) throw new Error("Output path leaves task workspace");
    if (taskType === "file-work" && !/\.(pdf|docx|xlsx)$/i.test(path)) throw new Error("File-work output must be PDF, DOCX or XLSX");
    const sourceIds = item.sourceIds ?? [];
    if (!Array.isArray(sourceIds) || sourceIds.some(id => typeof id !== "string" || !sourceById.has(id))) throw new Error("Deliverable cites an unknown source");
    if (taskType === "research" && !sourceIds.length) throw new Error("Every research output must cite archived sources");
    outputs.push({ path, hash: sha256(await readFile(path)), sourceIds });
  }
  if (taskType === "research") {
    for (const source of sources) {
      await ledger.recordEvidence({ criterionId: "sources", kind: "source", revision: ledger.state.revision!, passed: true, source: join(dataRoot, "sources", ledger.state.id, `${source.id}.json`), contentHash: source.sha256, referenceIds: [source.id] });
    }
  }
  for (const output of outputs) {
    const frozenDir = join(dataRoot, "artifacts", ledger.state.id, randomUUID());
    await mkdir(frozenDir, { recursive: true });
    const frozenPath = join(frozenDir, basename(output.path));
    await writeFile(frozenPath, await readFile(output.path), { flag: "wx" });
    await ledger.recordEvidence({ criterionId: "deliverable", kind: "artifact", revision: ledger.state.revision!, passed: true, source: frozenPath, contentHash: output.hash, referenceIds: output.sourceIds });
  }
  await ledger.complete();
}
