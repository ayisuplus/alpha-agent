/**
 * The plan-node vocabulary's pure rules (docs/plan-graph-and-expert-state-2026-09-29.md §3.1, §7): node kinds map to
 * the two access tiers, and pre-rename `mode` values map onto kinds. This module stays dependency-free so event
 * reducers, work orders and prompts can share one implementation without a module cycle.
 */
export type PlanNodeKind = "investigate" | "execute" | "review";
/** Where a node runs: the coordinator session, or one subagent (§3.3). */
export type NodeHost = "coordinator" | "worker";
/** The two permission tiers (§7), derived from the node's type — never chosen by the model. */
export type AccessLevel = "read-only" | "write";

export function accessOf(kind: PlanNodeKind): AccessLevel {
  return kind === "execute" ? "write" : "read-only";
}

const KIND_VALUES: Record<string, PlanNodeKind> = { investigate: "investigate", execute: "execute", implement: "execute", review: "review" };

/** The value mapping behind `orderKind`; alpha_spawn still accepts the pre-rename mode values (§7 过渡期). */
export function mapNodeKind(value: unknown): PlanNodeKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const kind = KIND_VALUES[String(value)];
  if (!kind) throw new Error(`无效的节点类型：${String(value)}`);
  return kind;
}

/** Orders serialized before the kind rename carry `mode` with `implement`; reads map it (§7/§8: implement → execute). */
export function orderKind(order: { kind?: PlanNodeKind; mode?: "investigate" | "implement" | "review" }): PlanNodeKind {
  return order.kind ?? mapNodeKind(order.mode) ?? "execute";
}
