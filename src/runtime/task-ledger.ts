import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type EvidenceKind = "build" | "test" | "browser" | "asset" | "preview" | "source" | "artifact";
export type TaskType = "web-product" | "code-change" | "research" | "file-work";

export interface WorkspaceOrigin {
  kind: "generated" | "git" | "copy";
  sourcePath?: string;
  snapshotFile?: string;
  initialRevision?: string;
  checks?: Array<{ name: string; command: string }>;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  kind: EvidenceKind;
}

export interface Evidence {
  id: string;
  attemptId?: string;
  criterionId: string;
  kind: EvidenceKind;
  revision: string;
  contractVersion?: number;
  previewId?: string;
  passed: boolean;
  source: string;
  contentHash?: string;
  referenceIds?: string[];
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
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input";
  failureReason?: string;
  recordedAt: string;
}

export interface GuidanceRecord {
  id?: string;
  instruction: string;
  recordedAt: string;
  status?: "recorded" | "delivered" | "processed";
}

export interface TaskState {
  id: string;
  taskType?: TaskType;
  workspaceOrigin?: WorkspaceOrigin;
  inputs?: Array<{ id: string; name: string; path: string; mimeType: string; sha256: string; uploadedAt: string }>;
  objective: string;
  contractVersion?: number;
  contractHistory?: Array<{ version: number; objective: string; revisedAt: string }>;
  guidanceHistory?: GuidanceRecord[];
  projectRoot: string;
  criteria: AcceptanceCriterion[];
  status: "active" | "stopped" | "complete" | "needs-input";
  pendingQuestion?: string;
  blockedService?: string;
  revision: string | null;
  evidence: Evidence[];
  runs?: RunRecord[];
  preview: LocalPreview | null;
  createdAt: string;
  updatedAt: string;
  reopenReason?: string;
  lastFailure?: string;
  /** The model this task runs with ("provider/id"); absent means the workbench default. */
  modelSelector?: string;
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
  private saveQueue: Promise<void> = Promise.resolve();
  private legacyBackupPending = false;
  private constructor(readonly file: string, readonly state: TaskState) {}

  static async create(dataRoot: string, input: {
    objective: string;
    projectRoot: string;
    criteria: AcceptanceCriterion[];
    modelSelector?: string;
    taskType?: TaskType;
    workspaceOrigin?: WorkspaceOrigin;
    inputs?: TaskState["inputs"];
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
      taskType: input.taskType ?? "web-product",
      workspaceOrigin: input.workspaceOrigin ?? { kind: "generated" },
      ...(input.inputs?.length ? { inputs: input.inputs } : {}),
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
      ...(input.modelSelector ? { modelSelector: input.modelSelector } : {}),
    };
    const ledger = new TaskLedger(file, state);
    await ledger.save();
    return ledger;
  }

  static async load(file: string): Promise<TaskLedger> {
    const state = JSON.parse(await readFile(file, "utf8")) as TaskState;
    const ledger = new TaskLedger(resolve(file), state);
    ledger.legacyBackupPending = !state.taskType || !state.contractVersion;
    return ledger;
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
    if ((input.kind === "source" || input.kind === "artifact") && !/^[0-9a-f]{64}$/.test(input.contentHash ?? "")) throw new Error("Versioned source or artifact evidence needs a SHA-256 hash");
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
    if ((this.state.taskType ?? "web-product") === "web-product" && (!this.state.preview || this.state.preview.revision !== this.state.revision)) gaps.push("local-preview");
    return gaps;
  }

  async complete(): Promise<void> {
    this.assertActive();
    if (await fingerprintSource(this.state.projectRoot) !== this.state.revision) throw new Error("Task source changed before completion");
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
    if (this.state.status !== "stopped" && this.state.status !== "needs-input") throw new Error("Only a stopped or waiting task can be resumed");
    if (!reason.trim()) throw new Error("Resume reason is required");
    this.state.status = "active";
    delete this.state.pendingQuestion;
    delete this.state.blockedService;
    this.state.reopenReason = reason.trim();
    this.state.guidanceHistory ??= [];
    this.state.guidanceHistory.push({ instruction: reason.trim(), recordedAt: new Date().toISOString() });
    await this.save();
  }

  async recordGuidance(instruction: string): Promise<string> {
    if (this.state.status === "complete") throw new Error("A completed task cannot receive guidance");
    if (!instruction.trim()) throw new Error("Guidance is required");
    this.state.guidanceHistory ??= [];
    const id = randomUUID();
    this.state.guidanceHistory.push({ id, instruction: instruction.trim(), recordedAt: new Date().toISOString(), status: "recorded" });
    await this.save();
    return id;
  }

  async setGuidanceStatus(id: string, status: "delivered" | "processed"): Promise<void> {
    const guidance = this.state.guidanceHistory?.find(item => item.id === id);
    if (!guidance) throw new Error("Guidance not found");
    if (guidance.status === "processed" || guidance.status === status) return;
    guidance.status = status;
    await this.save();
  }

  async setModel(selector: string | null): Promise<void> {
    if (selector) this.state.modelSelector = selector;
    else delete this.state.modelSelector;
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

  async needInput(question: string, service?: string): Promise<void> {
    this.assertActive();
    if (!question.trim()) throw new Error("A user question is required");
    this.state.status = "needs-input";
    this.state.pendingQuestion = question.trim();
    if (service) this.state.blockedService = service;
    await this.save();
  }

  private assertActive(): void {
    if (this.state.status !== "active") throw new Error(`Task is ${this.state.status}`);
  }

  private async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const contents = JSON.stringify(this.state, null, 2);
    this.saveQueue = this.saveQueue.then(async () => {
      await mkdir(resolve(this.file, ".."), { recursive: true });
      if (this.legacyBackupPending) {
        try { await copyFile(this.file, `${this.file}.pre-contract-extension.bak`, constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        this.legacyBackupPending = false;
      }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents);
      await rename(temporary, this.file);
    });
    await this.saveQueue;
  }
}
