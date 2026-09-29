import { createHash } from "node:crypto";
import type { ConsumedArtifact, PlanNode, PlanNodeKind, TaskState } from "../../task-ledger";
import { accessOf } from "../../plan-kind";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/**
 * Graph family (docs/plan-graph-and-expert-state-2026-09-29.md §3, §8): the runtime-owned skeleton and the node
 * lifecycle. Node status derives from these events and their outputs (§1.1 invariant 3) — nothing here accepts a
 * model-reported status.
 */

export const STAGES: PlanNodeKind[] = ["investigate", "execute", "review"];

function assertActive(state: TaskState): void {
  if (state.status !== "active") throw new InvariantError("apply/task-not-active", `Task is ${state.status}`);
}

function nodeOrThrow(state: TaskState, nodeId: string): PlanNode {
  const node = state.cognition?.nodes.find(item => item.id === nodeId);
  if (!node) throw new InvariantError("apply/node-unknown", `计划中没有节点：${nodeId}`);
  return node;
}

/** A stage opens when every node of the earlier stages is done (§3.2); cancelled nodes do not hold it. */
export function stageOpen(state: TaskState, phase: PlanNodeKind): boolean {
  const earlier = STAGES.slice(0, STAGES.indexOf(phase));
  return (state.cognition?.nodes ?? []).filter(node => earlier.includes(node.phase) && node.status !== "cancelled").every(node => node.status === "done");
}

/** Ready derivation (§3.4): every dependency done and the node's stage open. */
export function refreshReady(state: TaskState): void {
  for (const node of state.cognition?.nodes ?? []) {
    if (node.status !== "planned" && node.status !== "reopened") continue;
    const dependenciesDone = node.dependsOn.every(id => state.cognition!.nodes.find(item => item.id === id)?.status === "done");
    if (dependenciesDone && stageOpen(state, node.phase)) node.status = "ready";
  }
}

/** The outputs of every upstream node as they stand now (§3.5 input tracking: artifacts and findings both bind). */
function upstreamArtifacts(state: TaskState, node: PlanNode): ConsumedArtifact[] {
  const seen = new Set<string>();
  const artifacts: ConsumedArtifact[] = [];
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const parent of state.cognition!.nodes.find(item => item.id === id)?.dependsOn ?? []) {
      const target = state.cognition!.nodes.find(item => item.id === parent);
      for (const artifact of target?.handoff?.artifacts ?? []) artifacts.push({ nodeId: target!.id, key: artifact.path, hash: artifact.hash });
      for (const [index, finding] of (target?.handoff?.findings ?? []).entries()) {
        artifacts.push({ nodeId: target!.id, key: `finding:${index}`, hash: createHash("sha256").update(`${finding.claim}\n${finding.source}`).digest("hex") });
      }
      visit(parent);
    }
  };
  visit(node.id);
  return artifacts;
}

/**
 * Staleness derivation (§3.5): a finished node whose upstream outputs changed since it entered is stale — the
 * coordinator redoes it or keeps it knowingly. Gate nodes count stale verdicts as expired (§6.2).
 */
export function refreshStale(state: TaskState): void {
  const nodes = state.cognition?.nodes ?? [];
  for (const node of nodes) {
    if (node.status !== "done" || !node.activation?.inputs?.length) continue;
    const changed = node.activation.inputs.some(input => {
      const upstream = nodes.find(item => item.id === input.nodeId);
      const current = input.key.startsWith("finding:")
        ? (upstream?.handoff?.findings ?? [])[Number(input.key.slice("finding:".length))]
        : upstream?.handoff?.artifacts.find(artifact => artifact.path === input.key);
      const hash = current ? ("hash" in current ? current.hash : createHash("sha256").update(`${current.claim}\n${current.source}`).digest("hex")) : undefined;
      return hash !== input.hash;
    });
    if (changed) node.stale = true;
  }
}

export const graphReducers: FamilyReducers = {
  "graph/skeleton-created": (state, event) => {
    if (state.cognition?.stages) throw new InvariantError("apply/skeleton-exists", "计划骨架已存在");
    if (JSON.stringify(event.payload.stages) !== JSON.stringify(STAGES)) throw new InvariantError("apply/skeleton-invalid", "计划骨架固定为调查、执行、审查三个阶段");
    state.cognition ??= { revision: 1, recipeVersion: 1, summary: state.objective, candidates: [], nodes: [], gaps: [], amendments: [] };
    state.cognition.stages = [...STAGES];
  },

  "node/entered": (state, event) => {
    assertActive(state);
    const { nodeId, host, runId, access, expert, expertSnapshot, temporaryExpert } = event.payload;
    const node = nodeOrThrow(state, nodeId);
    if (node.status === "active" || node.status === "done" || node.status === "cancelled") throw new InvariantError("apply/node-not-enterable", `节点当前状态不能进入：${nodeId}`);
    if (access !== accessOf(node.kind)) throw new InvariantError("apply/node-access-mismatch", `节点访问权限与类型不符：${nodeId}`);
    if (host !== node.host) throw new InvariantError("apply/node-host-mismatch", `节点执行位置与计划不符：${nodeId}`);
    if (node.dependsOn.some(id => state.cognition!.nodes.find(item => item.id === id)?.status !== "done")) throw new InvariantError("apply/node-deps-incomplete", `节点前置未完成：${nodeId}`);
    if (!stageOpen(state, node.phase)) throw new InvariantError("apply/node-stage-closed", `节点所在阶段尚未开放：${nodeId}`);
    node.status = "active";
    node.claimedBy = runId;
    node.revision = (node.revision ?? 0) + 1;
    node.activation = { host, runId, access, ...(expert ? { expert } : {}), ...(expertSnapshot ? { expertSnapshot } : {}), ...(temporaryExpert ? { temporaryExpert } : {}), inputs: upstreamArtifacts(state, node) };
  },

  "node/waiting": (state, event) => {
    const node = nodeOrThrow(state, event.payload.nodeId);
    if (node.status !== "active") throw new InvariantError("apply/node-not-active", `只有进入中的节点可以等待：${event.payload.nodeId}`);
    node.status = "waiting";
    node.statusReason = event.payload.pause;
    node.revision = (node.revision ?? 0) + 1;
  },

  "node/exited": (state, event) => {
    const node = nodeOrThrow(state, event.payload.nodeId);
    if (node.status !== "active" && node.status !== "waiting") throw new InvariantError("apply/node-not-entered", `只有进入过的节点可以退出：${event.payload.nodeId}`);
    // Delegated nodes close through their work order's result only; a plan-side exit cannot forge acceptance.
    if (state.cognition?.instances?.some(instance => instance.orderId === event.payload.nodeId)) throw new InvariantError("apply/node-delegated", `派发节点的退出由工单结果决定：${event.payload.nodeId}`);
    const { exitedAt: _exitedAt, ...handoff } = event.payload;
    node.status = "done";
    node.statusReason = undefined;
    node.handoff = handoff;
    node.revision = (node.revision ?? 0) + 1;
    refreshReady(state);
    // A re-exit with different artifacts invalidates what downstream nodes consumed (§3.5).
    refreshStale(state);
  },

  "node/reopened": (state, event) => {
    assertActive(state);
    const { nodeId, edge, sourceNodeId, reason, recordedAt: _recordedAt } = event.payload;
    const node = nodeOrThrow(state, nodeId);
    if (node.status !== "done") throw new InvariantError("apply/node-not-reopenable", `只有已完成的节点可以重开：${nodeId}`);
    if (edge) {
      const declared = state.cognition?.edges?.find(item => item.kind === edge && item.from === sourceNodeId && item.to === nodeId);
      if (!declared) throw new InvariantError("apply/edge-not-declared", `计划没有声明这条${edge === "rework" ? "返工" : "前提"}回边：${sourceNodeId} → ${nodeId}`);
      const traversals = declared.traversals ?? 0;
      const maximum = declared.maxTraversals ?? 2;
      if (traversals >= maximum) throw new InvariantError("apply/edge-traversal-exhausted", `回边已达自动次数上限 ${maximum}：${sourceNodeId} → ${nodeId}`);
      declared.traversals = traversals + 1;
    }
    // Without an edge the coordinator simply redoes finished work — typically a node marked stale (§3.5) or a gate
    // whose verdict no longer binds the current contract (§6.2).
    node.status = "reopened";
    node.stale = false;
    node.statusReason = reason;
    node.claimedBy = undefined;
    node.revision = (node.revision ?? 0) + 1;
  },
};
