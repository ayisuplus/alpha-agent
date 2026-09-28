/**
 * Dispatch binding: the one place where an order becomes runnable. The vocabulary this file enforces:
 * - **expert** supplies knowledge (persona + its packaged Skill snapshots) — binding one loads its skills;
 * - **mode** (`investigate` | `implement` | `review`) grants permissions — read-only or writable source;
 * - capabilities (MCP services, builtin tools) are never implied: the coordinator selects them explicitly.
 * Runtime rules (worktree isolation, command approval, budgets) stay authoritative over any persona.
 */
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { ExpertStore, type ExpertSnapshot } from "./experts";
import { validateSkillBindings } from "./skill-binding";
import type { TaskLedger } from "./task-ledger";
import type { WorkOrder } from "./work-orders";

/**
 * Plan consistency: an approved plan decides each step's objective, mode and expert, so a dispatched order may not
 * disagree with it, be re-dispatched, or skip its dependencies. Orders outside an approved plan keep their own
 * fields (the coordinator decides), but every delegation must still state why.
 */
export function applyPlanConstraints(ledger: TaskLedger, requested: WorkOrder[]): WorkOrder[] {
  const orders = requested.map(order => {
    if (!order.decisionReason?.trim() || order.decisionReason.length > 500) throw new Error(`Delegation reason is required for ${order.id}`);
    const planned = ledger.state.cognition?.steps.find(step => step.id === order.id);
    if (ledger.state.planApproval && !planned) throw new Error(`Approved plan has no order: ${order.id}`);
    if (planned && (order.objective !== planned.objective || (order.mode && order.mode !== planned.mode) || (order.dependsOn && JSON.stringify(order.dependsOn) !== JSON.stringify(planned.dependsOn)) || (order.expertId && order.expertId !== planned.expertId))) throw new Error(`Order conflicts with approved plan: ${order.id}`);
    if (planned && ["running", "complete", "cancelled"].includes(planned.status)) throw new Error(`Plan step is already dispatched: ${order.id}`);
    return { ...order, decisionReason: order.decisionReason.trim(), mode: planned?.mode ?? order.mode, dependsOn: planned?.dependsOn ?? order.dependsOn, skillIds: [...new Set([...(planned?.expertId && !order.expertId ? [] : planned?.skillIds ?? []), ...(order.skillIds ?? [])])] };
  });
  for (const order of orders) for (const dependency of order.dependsOn ?? []) {
    if (orders.some(item => item.id === dependency)) continue;
    if (ledger.state.cognition?.steps.find(step => step.id === dependency)?.status !== "complete") throw new Error(`Unknown or incomplete dependency: ${order.id} -> ${dependency}`);
  }
  return orders;
}

/**
 * A user-designated expert is an execution contract for dispatching task types (see task-profile): some
 * implementing order must carry it, because acceptance later requires a completed instance of exactly this expert.
 */
export function assertDesignatedExpertAllocated(ledger: TaskLedger, orders: readonly WorkOrder[]): void {
  if (ledger.state.designatedExpertId && !ledger.state.cognition?.steps.length && orders.some(order => (order.mode ?? "implement") === "implement") && !orders.some(order => order.expertId === ledger.state.designatedExpertId)) {
    throw new Error(`The designated expert must be assigned to a work order: ${ledger.state.designatedExpertId}`);
  }
}

/**
 * Binding: the referenced expert resolves to its persona and packaged Skill snapshot catalogue — the persona loads
 * automatically, while Skills are explicit selections (an expert's skills are its recommended combination, never an
 * implicit load). Unknown experts and skills are refused before anything runs, and review orders always keep the
 * project root readable.
 */
export function bindWorkOrders(orders: readonly WorkOrder[], experts: readonly ExpertSnapshot[], skills: readonly Skill[] = []): WorkOrder[] {
  return orders.map(order => {
    const expert = order.expertId ? experts.find(item => item.id === order.expertId) : undefined;
    if (order.expertId && !expert) throw new Error(`专家不存在或未启用：${order.expertId}`);
    const skillIds = [...new Set(order.skillIds ?? [])];
    const missing = skillIds.find(id => !skills.some(skill => skill.name === id) && !expert?.package?.skills.some(skill => skill.id === id));
    if (missing) throw new Error(`Skill 未安装或未启用：${missing}`);
    if (order.mode && !["investigate", "implement", "review"].includes(order.mode)) throw new Error(`执行模式无效：${order.mode}`);
    return { ...order, expert, mode: order.mode ?? "implement", readPaths: order.mode === "review" ? [...new Set([".", ...(order.readPaths ?? [])])] : order.readPaths, skillIds };
  });
}

/** The dispatch entry: bind, then check every Skill's declared requirements against the order's mode. */
export async function bindAndValidateWorkOrders(orders: readonly WorkOrder[], experts: readonly ExpertSnapshot[], skills: readonly Skill[], dataRoot: string): Promise<WorkOrder[]> {
  const bound = bindWorkOrders(orders, experts, skills);
  const store = new ExpertStore(dataRoot);
  for (const order of bound) await validateSkillBindings([order], [...(order.expert ? await store.loadBundledSkills(order.expert) : []), ...skills]);
  return bound;
}
