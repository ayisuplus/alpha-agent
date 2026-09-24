import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type EvidenceKind = "build" | "test" | "browser" | "asset" | "preview";

export interface AcceptanceCriterion {
  id: string;
  description: string;
  kind: EvidenceKind;
}

export interface Evidence {
  id: string;
  criterionId: string;
  kind: EvidenceKind;
  revision: string;
  contractVersion?: number;
  previewId?: string;
  passed: boolean;
  source: string;
  recordedAt: string;
}

export interface LocalPreview {
  id: string;
  revision: string;
  path: string;
  url: string;
  taskId?: string;
  pid?: number;
  port?: number;
  recordedAt: string;
}

export interface RunRecord {
  model: string;
  contractVersion?: number;
  toolCalls: number;
  compactions?: number;
  compactionFailures?: number;
  maxToolCalls: number;
  wallTimeMs: number;
  elapsedMs: number;
  outcome: "returned" | "cancelled" | "budget" | "error";
  failureReason?: string;
  recordedAt: string;
}

export interface TaskState {
  id: string;
  objective: string;
  contractVersion?: number;
  contractHistory?: Array<{ version: number; objective: string; revisedAt: string }>;
  guidanceHistory?: Array<{ instruction: string; recordedAt: string }>;
  projectRoot: string;
  criteria: AcceptanceCriterion[];
  status: "active" | "stopped" | "complete";
  revision: string | null;
  evidence: Evidence[];
  runs?: RunRecord[];
  preview: LocalPreview | null;
  createdAt: string;
  updatedAt: string;
  reopenReason?: string;
  lastFailure?: string;
}

const EXCLUDED_DIRS = new Set([".alpha", ".git", "node_modules", "dist"]);

async function listSourceFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) files.push(...await listSourceFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  return files;
}

export async function fingerprintSource(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const files = (await listSourceFiles(root)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = await readFile(join(root, file));
    hash.update(file);
    hash.update("\0");
    hash.update(String(contents.length));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export class TaskLedger {
  private constructor(readonly file: string, readonly state: TaskState) {}

  static async create(dataRoot: string, input: {
    objective: string;
    projectRoot: string;
    criteria: AcceptanceCriterion[];
  }): Promise<TaskLedger> {
    if (!input.objective.trim()) throw new Error("Task objective is required");
    if (input.criteria.length === 0 || new Set(input.criteria.map(item => item.id)).size !== input.criteria.length) {
      throw new Error("Criteria must be nonempty with unique IDs");
    }
    const projectRoot = resolve(input.projectRoot);
    if (!(await stat(projectRoot)).isDirectory()) throw new Error("Project root must be a directory");
    const now = new Date().toISOString();
    const id = randomUUID();
    const file = join(resolve(dataRoot), "tasks", `${id}.json`);
    const state: TaskState = {
      id,
      objective: input.objective.trim(),
      contractVersion: 1,
      contractHistory: [],
      guidanceHistory: [],
      projectRoot,
      criteria: input.criteria,
      status: "active",
      revision: await fingerprintSource(projectRoot),
      evidence: [],
      runs: [],
      preview: null,
      createdAt: now,
      updatedAt: now,
    };
    const ledger = new TaskLedger(file, state);
    await ledger.save();
    return ledger;
  }

  static async load(file: string): Promise<TaskLedger> {
    const state = JSON.parse(await readFile(file, "utf8")) as TaskState;
    return new TaskLedger(resolve(file), state);
  }

  async refreshRevision(): Promise<boolean> {
    this.assertActive();
    const revision = await fingerprintSource(this.state.projectRoot);
    if (revision === this.state.revision) return false;
    this.state.revision = revision;
    this.state.preview = null;
    await this.save();
    return true;
  }

  async recordEvidence(input: Omit<Evidence, "id" | "recordedAt">): Promise<Evidence> {
    this.assertActive();
    const criterion = this.state.criteria.find(item => item.id === input.criterionId);
    if (!criterion || criterion.kind !== input.kind) throw new Error("Evidence does not match a criterion");
    if (input.revision !== this.state.revision) throw new Error("Evidence revision is stale");
    if (input.kind === "browser" && (!this.state.preview || input.previewId !== this.state.preview.id)) {
      throw new Error("Browser evidence must match the current preview");
    }
    if (!input.source.trim()) throw new Error("Evidence source is required");
    const evidence = { ...input, contractVersion: this.state.contractVersion ?? 1, id: randomUUID(), recordedAt: new Date().toISOString() };
    this.state.evidence.push(evidence);
    await this.save();
    return evidence;
  }

  async recordPreview(input: Omit<LocalPreview, "recordedAt">): Promise<void> {
    this.assertActive();
    if (input.revision !== this.state.revision) throw new Error("Preview revision is stale");
    if (!isAbsolute(input.path) || !input.url.startsWith("http://127.0.0.1:")) {
      throw new Error("Preview must use an absolute local path and loopback URL");
    }
    this.state.preview = { ...input, recordedAt: new Date().toISOString() };
    await this.save();
  }

  completionGaps(): string[] {
    const gaps = this.state.criteria.filter(criterion => {
      const latest = this.state.evidence.findLast(item => item.criterionId === criterion.id && (item.contractVersion ?? 1) === (this.state.contractVersion ?? 1) && item.revision === this.state.revision && (criterion.kind !== "browser" || item.previewId === this.state.preview?.id));
      return !latest?.passed;
    }).map(criterion => criterion.id);
    if (!this.state.preview || this.state.preview.revision !== this.state.revision) gaps.push("local-preview");
    return gaps;
  }

  async complete(): Promise<void> {
    this.assertActive();
    const gaps = this.completionGaps();
    if (gaps.length > 0) throw new Error(`Task cannot complete: ${gaps.join(", ")}`);
    this.state.status = "complete";
    this.state.lastFailure = undefined;
    this.state.reopenReason = undefined;
    await this.save();
  }

  async reopen(reason: string): Promise<void> {
    if (this.state.status !== "complete") throw new Error("Only a completed task can be reopened");
    if (!reason.trim()) throw new Error("Reopen reason is required");
    this.state.status = "active";
    this.state.reopenReason = reason.trim();
    await this.save();
  }

  async reviseObjective(objective: string): Promise<void> {
    const next = objective.trim();
    if (!next || next === this.state.objective) throw new Error("A changed task objective is required");
    const version = this.state.contractVersion ?? 1;
    this.state.contractHistory ??= [];
    this.state.contractHistory.push({ version, objective: this.state.objective, revisedAt: new Date().toISOString() });
    this.state.objective = next;
    this.state.contractVersion = version + 1;
    this.state.preview = null;
    this.state.status = "active";
    this.state.reopenReason = "User revised the task objective";
    this.state.lastFailure = undefined;
    await this.save();
  }

  async resume(reason: string): Promise<void> {
    if (this.state.status !== "stopped") throw new Error("Only a stopped task can be resumed");
    if (!reason.trim()) throw new Error("Resume reason is required");
    this.state.status = "active";
    this.state.reopenReason = reason.trim();
    this.state.guidanceHistory ??= [];
    this.state.guidanceHistory.push({ instruction: reason.trim(), recordedAt: new Date().toISOString() });
    await this.save();
  }

  async recordGuidance(instruction: string): Promise<void> {
    if (this.state.status !== "active") throw new Error("Only an active task can receive guidance");
    if (!instruction.trim()) throw new Error("Guidance is required");
    this.state.guidanceHistory ??= [];
    this.state.guidanceHistory.push({ instruction: instruction.trim(), recordedAt: new Date().toISOString() });
    await this.save();
  }

  async recordFailure(reason: string): Promise<void> {
    this.assertActive();
    if (!reason.trim()) throw new Error("Failure reason is required");
    this.state.lastFailure = reason.trim();
    await this.save();
  }

  async clearFailure(): Promise<void> {
    if (!this.state.lastFailure) return;
    this.state.lastFailure = undefined;
    await this.save();
  }

  async recordRun(input: Omit<RunRecord, "recordedAt">): Promise<void> {
    this.state.runs ??= [];
    this.state.runs.push({ ...input, contractVersion: this.state.contractVersion ?? 1, recordedAt: new Date().toISOString() });
    await this.save();
  }

  async stop(): Promise<void> {
    this.assertActive();
    this.state.status = "stopped";
    await this.save();
  }

  private assertActive(): void {
    if (this.state.status !== "active") throw new Error(`Task is ${this.state.status}`);
  }

  private async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await mkdir(resolve(this.file, ".."), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, this.file);
  }
}
