import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export type OperationKind = "run" | "answer" | "publish" | "verify" | "cleanup" | "apply" | "sandbox-check" | "mount";

export interface OperationSnapshot {
  id: string;
  kind: OperationKind;
  taskId: string | null;
  projectId: string | null;
  phase: string;
  browserTaskId: string | null;
  cancellable: boolean;
}

export interface OperationLease {
  readonly id: string;
  readonly controller: AbortController;
}

export interface ClaimOptions {
  taskId?: string | null;
  projectId?: string | null;
  /** Folders the operation writes; two operations never write the same folder at once. */
  roots?: readonly string[];
  /** Hold every task in the project off (mount changes); ordinary work only shares the project. */
  exclusiveProject?: boolean;
  /** Conflicts with every other operation (preview cleanup). */
  exclusive?: boolean;
  /** Upper bound on concurrently running model operations ("run" and "answer"). */
  runLimit?: number;
}

interface Held extends Omit<OperationSnapshot, "id">, OperationLease {
  roots: string[];
  exclusiveProject: boolean;
  exclusive: boolean;
}

const MODEL_KINDS: readonly OperationKind[] = ["run", "answer"];

function normalizedRoot(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`) || b.startsWith(`${a}\\`) || b.startsWith(`${a}/`);
}

/**
 * Tasks run side by side. An operation owns its task, the folders it writes and, for mount changes, its project;
 * claims that collide on any of those are refused, as is anything while an exclusive operation holds the workbench.
 * Claims are synchronous so two requests can never both pass the check.
 */
export class OperationManager {
  private readonly held = new Map<string, Held>();

  constructor(private readonly onChange: (snapshots: OperationSnapshot[]) => void = () => {}) {}

  snapshots(): OperationSnapshot[] {
    return [...this.held.values()].map(({ id, kind, taskId, projectId, phase, browserTaskId, cancellable }) => ({ id, kind, taskId, projectId, phase, browserTaskId, cancellable }));
  }

  /** The operation currently working on a task, if any. */
  forTask(taskId: string): OperationSnapshot | null {
    return this.snapshots().find(item => item.taskId === taskId) ?? null;
  }

  busyProject(projectId: string): boolean {
    return [...this.held.values()].some(item => item.projectId === projectId);
  }

  /** Model operations ("run" and "answer") currently held. */
  get modelOperations(): number {
    return [...this.held.values()].filter(item => MODEL_KINDS.includes(item.kind)).length;
  }

  /** Why a claim with these options would be refused right now, or null when it would succeed. */
  conflict(kind: OperationKind, options: ClaimOptions = {}): "exclusive" | "task" | "folder" | "project" | "limit" | null {
    const roots = (options.roots ?? []).map(normalizedRoot);
    for (const other of this.held.values()) {
      if (other.exclusive || options.exclusive) return "exclusive";
      if (options.taskId && other.taskId === options.taskId) return "task";
      if (roots.some(root => other.roots.some(held => overlaps(root, held)))) return "folder";
      if (options.projectId && other.projectId === options.projectId && (options.exclusiveProject || other.exclusiveProject)) return "project";
    }
    if (options.runLimit !== undefined && MODEL_KINDS.includes(kind) && this.modelOperations >= options.runLimit) return "limit";
    return null;
  }

  claim(kind: OperationKind, options: ClaimOptions = {}): OperationLease | null {
    if (this.conflict(kind, options)) return null;
    const roots = (options.roots ?? []).map(normalizedRoot);
    const taskId = options.taskId ?? null;
    const projectId = options.projectId ?? null;
    const lease = { id: randomUUID(), controller: new AbortController() };
    this.held.set(lease.id, {
      ...lease, kind, taskId, projectId, phase: "准备中", browserTaskId: null,
      cancellable: kind !== "cleanup" && kind !== "apply" && kind !== "mount",
      roots, exclusiveProject: !!options.exclusiveProject, exclusive: !!options.exclusive,
    });
    this.onChange(this.snapshots());
    return lease;
  }

  /** Attach a task (created after the claim) or a folder to a held lease; refused when another operation owns it. */
  bind(lease: Pick<OperationLease, "id">, patch: { taskId?: string; projectId?: string | null; roots?: readonly string[] }): boolean {
    const current = this.held.get(lease.id);
    if (!current) return false;
    const roots = (patch.roots ?? []).map(normalizedRoot);
    for (const other of this.held.values()) {
      if (other.id === lease.id) continue;
      if (patch.taskId && other.taskId === patch.taskId) return false;
      if (roots.some(root => other.roots.some(held => overlaps(root, held)))) return false;
    }
    if (patch.taskId) current.taskId = patch.taskId;
    if (patch.projectId !== undefined) current.projectId = patch.projectId;
    current.roots.push(...roots);
    this.onChange(this.snapshots());
    return true;
  }

  update(lease: Pick<OperationLease, "id">, patch: Partial<Pick<OperationSnapshot, "phase" | "browserTaskId">>): void {
    const current = this.held.get(lease.id);
    if (!current) return;
    Object.assign(current, patch);
    this.onChange(this.snapshots());
  }

  cancel(id: string): boolean {
    const current = this.held.get(id);
    if (!current?.cancellable) return false;
    current.controller.abort(new Error("Operation cancelled"));
    return true;
  }

  release(lease: OperationLease): void {
    const current = this.held.get(lease.id);
    if (!current || current.controller !== lease.controller) return;
    this.held.delete(lease.id);
    this.onChange(this.snapshots());
  }
}

/** First-come waiting lock for the one visible preview browser. */
export class BrowserLock {
  private holder: string | null = null;
  private readonly waiters: Array<{ owner: string; resolve: () => void }> = [];

  get owner(): string | null { return this.holder; }

  async acquire(owner: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.holder !== null) {
      await new Promise<void>((resolveWait, reject) => {
        const waiter = { owner, resolve: resolveWait };
        this.waiters.push(waiter);
        signal.addEventListener("abort", () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Browser wait cancelled"));
        }, { once: true });
      });
    } else this.holder = owner;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      this.holder = next?.owner ?? null;
      next?.resolve();
    };
  }
}
