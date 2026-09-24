import { randomUUID } from "node:crypto";

export type OperationKind = "run" | "publish" | "verify" | "cleanup" | "apply";

export interface OperationSnapshot {
  id: string;
  kind: OperationKind;
  taskId: string | null;
  phase: string;
  browserTaskId: string | null;
  cancellable: boolean;
}

export interface OperationLease {
  readonly id: string;
  readonly controller: AbortController;
}

/** One server-wide operation owns mutation and the visible browser at a time. */
export class OperationManager {
  private current: (OperationSnapshot & OperationLease) | null = null;

  constructor(private readonly onChange: (snapshot: OperationSnapshot | null) => void = () => {}) {}

  snapshot(): OperationSnapshot | null {
    if (!this.current) return null;
    const { id, kind, taskId, phase, browserTaskId, cancellable } = this.current;
    return { id, kind, taskId, phase, browserTaskId, cancellable };
  }

  claim(kind: OperationKind, taskId: string | null = null): OperationLease | null {
    if (this.current) return null;
    const lease = { id: randomUUID(), controller: new AbortController() };
    this.current = { ...lease, kind, taskId, phase: "准备中", browserTaskId: null, cancellable: kind !== "cleanup" && kind !== "apply" };
    this.onChange(this.snapshot());
    return lease;
  }

  update(lease: Pick<OperationLease, "id">, patch: Partial<Pick<OperationSnapshot, "taskId" | "phase" | "browserTaskId">>): void {
    if (this.current?.id !== lease.id) return;
    Object.assign(this.current, patch);
    this.onChange(this.snapshot());
  }

  cancel(id: string): boolean {
    if (!this.current || this.current.id !== id || !this.current.cancellable) return false;
    this.current.controller.abort(new Error("Operation cancelled"));
    return true;
  }

  release(lease: OperationLease): void {
    if (this.current?.id !== lease.id) return;
    this.current = null;
    this.onChange(null);
  }
}
