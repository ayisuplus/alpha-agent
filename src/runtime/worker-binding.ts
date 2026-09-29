/**
 * Dispatch binding: the one place where an order becomes runnable. The vocabulary this file enforces:
 * - **expert** supplies knowledge (persona + its packaged Skill snapshots) — binding one loads its skills;
 * - **mode** (`investigate` | `implement` | `review`) grants permissions — read-only or writable source;
 * - capabilities (MCP services, builtin tools) are never implied: the coordinator selects them explicitly.
 * Runtime rules (worktree isolation, command approval, budgets) stay authoritative over any persona.
 */
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import type { ExpertSnapshot } from "./experts";
import { resolveExpertScope } from "./expert-scope";
import { validateSkillBindings } from "./skill-binding";
import type { TaskLedger } from "./task-ledger";
import { orderKind, type WorkOrder } from "./work-orders";

/**
 * Plan consistency: an approved plan decides each step's objective, mode and expert, so a dispatched order may not
 * disagree with it, be re-dispatched, or skip its dependencies. Orders outside an approved plan keep their own
 * fields (the coordinator decides), but every delegation must still state why.
 */
export function applyPlanConstraints(ledger: TaskLedger, requested: WorkOrder[]): WorkOrder[] {
  const orders = requested.map(order => {
    if (!order.decisionReason?.trim() || order.decisionReason.length > 500) throw new Error(`Delegation reason is required for ${order.id}`);
    const planned = ledger.state.cognition?.nodes.find(node => node.id === order.id);
    if (ledger.state.planApproval && !planned) throw new Error(`Approved plan has no order: ${order.id}`);
    const plannedExpert = planned?.expertDecision.expertId;
    if (planned && (order.objective !== planned.objective || orderKind(order) !== planned.kind || (order.dependsOn && JSON.stringify(order.dependsOn) !== JSON.stringify(planned.dependsOn)) || (order.expertId && order.expertId !== plannedExpert))) throw new Error(`Order conflicts with approved plan: ${order.id}`);
    if (planned && ["active", "done", "cancelled"].includes(planned.status)) throw new Error(`Plan node is already dispatched: ${planned.id}`);
    return { ...order, decisionReason: order.decisionReason.trim(), kind: planned?.kind ?? orderKind(order), dependsOn: planned?.dependsOn ?? order.dependsOn, skillIds: [...new Set([...(plannedExpert && !order.expertId ? [] : planned?.skillIds ?? []), ...(order.skillIds ?? [])])] };
  });
  for (const order of orders) for (const dependency of order.dependsOn ?? []) {
    if (orders.some(item => item.id === dependency)) continue;
    if (ledger.state.cognition?.nodes.find(node => node.id === dependency)?.status !== "done") throw new Error(`Unknown or incomplete dependency: ${order.id} -> ${dependency}`);
  }
  return orders;
}

/**
 * A user-designated expert is an execution contract for dispatching task types (see task-profile): some
 * implementing order must carry it, because acceptance later requires a completed instance of exactly this expert.
 */
export function assertDesignatedExpertAllocated(ledger: TaskLedger, orders: readonly WorkOrder[]): void {
  if (ledger.state.designatedExpertId && !ledger.state.cognition?.nodes.length && orders.some(order => orderKind(order) === "execute") && !orders.some(order => order.expertId === ledger.state.designatedExpertId)) {
    throw new Error(`The designated expert must be assigned to a work order: ${ledger.state.designatedExpertId}`);
  }
}

/**
 * Binding: the referenced expert resolves to its mounted state (§4.4) — persona and packaged Skills load with
 * activation, and explicit selections only add Skills on top. Unknown experts, Skills and undeclared services are
 * refused before anything runs, and review orders always keep the project root readable.
 */
export async function bindWorkOrders(orders: readonly WorkOrder[], experts: readonly ExpertSnapshot[], skills: readonly Skill[] = [], dataRoot: string): Promise<WorkOrder[]> {
  return Promise.all(orders.map(async raw => {
    const { mode: _legacyMode, ...order } = raw; // bound orders carry `kind` only; the legacy field stays on serialized history
    const expert = order.expertId ? experts.find(item => item.id === order.expertId) : undefined;
    if (order.expertId && !expert) throw new Error(`专家不存在或未启用：${order.expertId}`);
    if (order.kind && !["investigate", "execute", "review"].includes(order.kind)) throw new Error(`节点类型无效：${order.kind}`);
    const kind = orderKind(raw);
    let skillIds: string[];
    if (expert) {
      const scope = await resolveExpertScope({ expert, host: "worker", access: kind === "execute" ? "write" : "read-only", dataRoot, extraSkillIds: order.skillIds ?? [], mcpServers: order.capabilityIds ?? [], fullAccess: order.fullAccess });
      if (scope.missingMcp.length) throw new Error(`专家声明的 MCP 服务不可用：${scope.missingMcp.join(", ")}`);
      skillIds = scope.skills.map(skill => skill.name);
    } else {
      skillIds = [...new Set(order.skillIds ?? [])];
      const missing = skillIds.find(id => !skills.some(skill => skill.name === id));
      if (missing) throw new Error(`Skill 未安装或未启用：${missing}`);
    }
    return { ...order, expert, kind, readPaths: kind === "review" ? [...new Set([".", ...(order.readPaths ?? [])])] : order.readPaths, skillIds };
  }));
}

/** The dispatch entry: bind, then check every Skill's declared requirements against the order's mode. */
export async function bindAndValidateWorkOrders(orders: readonly WorkOrder[], experts: readonly ExpertSnapshot[], skills: readonly Skill[], dataRoot: string): Promise<WorkOrder[]> {
  const bound = await bindWorkOrders(orders, experts, skills, dataRoot);
  // Expert orders are checked inside resolveExpertScope against their access; the rest are checked here.
  for (const order of bound) if (!order.expert) await validateSkillBindings([order], skills);
  return bound;
}
