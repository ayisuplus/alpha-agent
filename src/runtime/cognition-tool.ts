import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { ExpertStore } from "./experts";
import { SkillPluginStore } from "../plugins/third-party";
import { accessOf, planApprovalModeOf, type PlanNode, type TaskLedger } from "./task-ledger";
import { discoverForGap } from "./skill-discovery";
import { taskProfile } from "./task-profile";

const planParameters = type({
  summary: "string",
  reason: "string",
  scope: "string[]?",
  constraints: "string[]?",
  openQuestions: "string[]?",
  candidates: "string[]",
  nodes: type({
    id: "string",
    objective: "string",
    kind: "'investigate' | 'execute' | 'review'",
    phase: "'investigate' | 'execute' | 'review'",
    dependsOn: "string[]",
    host: "'coordinator' | 'worker'",
    expertDecision: type({ expertId: "string?", "temporaryExpert?": type({ name: "string", description: "string", instructions: "string", skillIds: "string[]" }), reason: "string" }),
    skillIds: "string[]",
    consumes: "string[]?",
    produces: "string[]?",
    ownedPaths: "string[]?",
    gateRole: "string?",
  }).array(),
  "edges?": type({ from: "string", to: "string", kind: "'rework' | 'premise'", maxTraversals: "number?" }).array(),
});

const gapParameters = type({ kind: "string", description: "string", publicQuery: "string?" });
const resolveParameters = type({ kind: "string", description: "string", evidence: "string" });
const exitParameters = type({
  nodeId: "string",
  artifacts: type({ path: "string", hash: "string", kind: "string" }).array(),
  findings: type({ claim: "string", source: "string" }).array(),
  verdict: "'pass' | 'changes-requested' | 'inconclusive'?",
  note: "string",
  unresolved: "string[]",
});

/** What the runner needs to know after a node exits: whether the cursor moved onto a differently configured node (§3.6). */
export interface NodeExitHooks {
  onCursorMoved?: (input: { next?: { nodeId: string; sameConfig: boolean } }) => void;
}

const reopenParameters = type({ nodeId: "string", edge: "'rework' | 'premise'?", sourceNodeId: "string?", reason: "string" });

export function createCognitionTools(ledger: TaskLedger, dataRoot: string, hooks: NodeExitHooks = {}): [CustomTool<typeof planParameters>, CustomTool<typeof gapParameters>, CustomTool<typeof resolveParameters>, CustomTool<typeof exitParameters>, CustomTool<typeof reopenParameters>] {
  return [
    {
      name: "alpha_plan",
      label: "Record or adjust task plan",
      description: "Record the task's plan graph: scope, constraints, open questions, candidate experts and nodes. Every task plans before it acts, and every node fills one of the three stages (investigate, execute, review) with a stated expert decision and reason. Candidates are not dispatched. Call again only when evidence or user guidance changes the plan. Use only enabled experts and available Skills.",
      parameters: planParameters,
      loadMode: "essential",
      async execute(_id, args) {
        try {
          if (!args.nodes.length) throw new Error("计划至少要有一个节点：没有节点的计划无法执行");
          const [experts, skills] = await Promise.all([new ExpertStore(dataRoot).enabled(), new SkillPluginStore(dataRoot).loadSkills()]);
          const expertIds = new Set(experts.map(item => item.id));
          const skillIds = new Set(skills.map(item => item.name));
          const candidates = [...new Set(args.candidates)];
          if (candidates.some(id => !expertIds.has(id))) throw new Error("计划引用了未启用的专家");
          const nodes: PlanNode[] = args.nodes.map(node => {
            if (node.gateRole && node.kind !== "review") throw new Error(`gateRole 只能用于审查节点：${node.id}`);
            const decision = node.expertDecision as { expertId?: string; temporaryExpert?: { name: string; description: string; instructions: string; skillIds: string[] }; reason: string };
            if (!decision.reason.trim()) throw new Error(`节点必须写明专家决定与理由：${node.id}`);
            if (decision.expertId && decision.temporaryExpert) throw new Error(`节点的专家决定只能选一种：${node.id}`);
            if (decision.expertId && !expertIds.has(decision.expertId)) throw new Error(`专家未启用：${decision.expertId}`);
            const expert = decision.expertId ? experts.find(item => item.id === decision.expertId) : undefined;
            const available = new Set([...skillIds, ...(expert?.package?.skills.map(item => item.id) ?? []), ...(decision.temporaryExpert?.skillIds ?? [])]);
            if (node.skillIds.some(id => !available.has(id))) throw new Error(`Skill 未安装、未启用或不属于所选专家：${node.skillIds.find(id => !available.has(id))}`);
            return { ...node, expertDecision: decision, status: "planned" as const };
          });
          const stages = new Set(nodes.map(node => node.phase));
          for (const stage of ["investigate", "execute", "review"] as const) if (!stages.has(stage)) throw new Error(`调查、执行、审查三个阶段都必须至少有一个节点：缺少 ${stage}`);
          // §6.2: the review stage must cover the task type's default gates and every gate the used experts declare;
          // those are the reviews that must pass before the product ships.
          const requiredGates = new Set(taskProfile(ledger.state.taskType).defaultGates);
          for (const node of nodes) {
            const actor = node.expertDecision.expertId ? experts.find(item => item.id === node.expertDecision.expertId) : undefined;
            for (const role of actor?.package?.handoff?.gate ?? []) requiredGates.add(role);
          }
          for (const role of requiredGates) if (!nodes.some(node => node.kind === "review" && node.gateRole === role)) throw new Error(`审查阶段缺少 ${role} gate 节点`);
          await ledger.reviseCognition({ summary: args.summary, reason: args.reason, scope: args.scope, constraints: args.constraints, openQuestions: args.openQuestions, candidates, nodes, ...(args.edges ? { edges: args.edges } : {}) });
          // §3.6/§7: an auto-approved plan moves the cursor onto the graph, and this run's session was built before
          // the plan existed — no node, default access. The run ends here so the driver's next run enters the first
          // node with that node's expert and access tier; without it the graph never runs.
          const live = ledger.state.cognition?.nodes ?? [];
          const firstReady = live.find(node => node.status === "ready" && node.host === "coordinator");
          if (ledger.state.phase === "execute" && planApprovalModeOf(ledger.state) === "auto" && !live.some(node => node.status === "active" && node.host === "coordinator") && firstReady) {
            hooks.onCursorMoved?.({ next: { nodeId: firstReady.id, sameConfig: false } });
            return { content: [{ type: "text", text: `计划修订 v${ledger.state.cognition?.revision} 已记录并自动批准（${nodes.length} 个节点）。本轮到此结束，下一轮从节点 ${firstReady.id} 开始执行；候选专家不会自动启动。` }] };
          }
          const outcome = ledger.state.phase === "execute"
            ? planApprovalModeOf(ledger.state) === "auto" ? "计划已自动批准，继续按计划执行。候选专家不会自动启动。" : "候选专家不会自动启动。"
            : ledger.state.phase === "plan-review" ? "计划正在等待用户审阅；此轮到此结束，不要声称已批准。"
            : "计划将交给用户审阅；此轮规划到此结束，不要声称已批准。";
          return { content: [{ type: "text", text: `计划修订 v${ledger.state.cognition?.revision} 已记录（${nodes.length} 个节点）。${outcome}` }] };
        } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
      },
    },
    {
      name: "alpha_gap",
      label: "Record a missing capability",
      description: "Classify a real task blocker as method, tool, permission, or context. Do not call this for an ordinary failed attempt before diagnosis.",
      parameters: gapParameters,
      loadMode: "essential",
      async execute(_id, args) {
        try {
          if (!["method", "tool", "permission", "context"].includes(args.kind)) throw new Error("能力缺口类型无效");
          await ledger.recordCapabilityGap(args.kind as "method" | "tool" | "permission" | "context", args.description);
          if (args.kind === "method" && args.publicQuery) {
            const discovery = await discoverForGap(ledger, args.description, args.publicQuery);
            const proposals = ledger.state.cognition?.skillProposals?.filter(item => item.status === "pending" && item.key === ledger.state.cognition?.skillSearches?.findLast(search => search.gapDescription === args.description)?.key) ?? [];
            return { content: [{ type: "text", text: JSON.stringify({ proposals: proposals.map(item => ({ id: item.id, name: item.name, source: item.source, revision: item.revision, path: item.path })), error: discovery.error ?? null, note: "候选仅供用户审阅；不可自行安装或替换来源。" }) }] };
          }
          return { content: [{ type: "text", text: "能力缺口已记录。方法缺口请用通用公开技术词提供 publicQuery 触发 Skill 发现；外部安装需用户批准。" }] };
        } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
      },
    },
    {
      name: "alpha_gap_resolve", label: "Resolve capability gap", loadMode: "discoverable", parameters: resolveParameters,
      description: "Resolve a recorded capability gap only after concrete evidence shows an alternative method or the user-provided missing context/tool is now available.",
      async execute(_id, args) {
        try {
          if (!["method", "tool", "permission", "context"].includes(args.kind)) throw new Error("能力缺口类型无效");
          await ledger.resolveCapabilityGap(args.kind as "method" | "tool" | "permission" | "context", args.description, args.evidence);
          return { content: [{ type: "text", text: "能力缺口已根据记录的依据解决。" }] };
        } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
      },
    },
    {
      name: "alpha_step", label: "Exit the current plan node", loadMode: "essential", parameters: exitParameters,
      description: "Exit the current plan node by submitting its handoff: the artifacts it produced (with hashes), findings with sources, and what downstream must know. The runtime checks the node's exit conditions and derives its status; models never report status directly. A review node must give a verdict bound to the reviewed artifacts.",
      async execute(_id, args) {
        try {
          await ledger.exitNode({ nodeId: args.nodeId, runId: ledger.runId ?? "unbound", artifacts: args.artifacts, findings: args.findings, ...(args.verdict ? { verdict: args.verdict } : {}), note: args.note, unresolved: args.unresolved });
          // §3.6: the cursor moves to the next coordinator node. The same expert and access continue in this run;
          // anything else ends it with `node-switch` so the driver rebuilds the session for the new node.
          const exited = ledger.state.cognition?.nodes.find(node => node.id === args.nodeId);
          const next = ledger.state.cognition?.nodes.find(node => node.status === "ready" && node.host === "coordinator");
          let sameConfig = false;
          if (next && exited) {
            sameConfig = accessOf(next.kind) === accessOf(exited.kind)
              && (next.expertDecision.expertId ?? null) === (exited.activation?.expert?.id ?? null)
              && !next.expertDecision.temporaryExpert && !exited.activation?.temporaryExpert;
            if (sameConfig) {
              const expert = next.expertDecision.expertId ? (await new ExpertStore(dataRoot).enabled()).find(item => item.id === next.expertDecision.expertId) : undefined;
              if (next.expertDecision.expertId && !expert) throw new Error(`节点 ${next.id} 指定的专家未启用：${next.expertDecision.expertId}`);
              await ledger.enterNode({ nodeId: next.id, host: "coordinator", runId: ledger.runId ?? "unbound", ...(expert ? { expert } : {}) });
            }
          }
          hooks.onCursorMoved?.({ ...(next ? { next: { nodeId: next.id, sameConfig } } : {}) });
          return { content: [{ type: "text", text: `节点 ${args.nodeId} 已退出，交接记录已写入。${next ? (sameConfig ? `游标移至 ${next.id}，继续执行。` : `下一个节点 ${next.id} 的专家或权限不同，本轮到此结束并切换节点。`) : ""}` }] };
        } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
      },
    },
    {
      name: "alpha_reopen", label: "Reopen a plan node", loadMode: "essential", parameters: reopenParameters,
      description: "Reopen a finished node (§3.5). With edge and sourceNodeId it walks a declared rework/premise back-edge (a review's changes-requested already walks its rework edge automatically, up to the cap); without an edge it redoes finished work — typically a node marked stale by changed inputs or an expired gate verdict. Keeping stale work needs no call: the mark stays on the record.",
      async execute(_id, args) {
        try {
          await ledger.reopenNode({ nodeId: args.nodeId, ...(args.edge ? { edge: args.edge } : {}), ...(args.sourceNodeId ? { sourceNodeId: args.sourceNodeId } : {}), reason: args.reason });
          return { content: [{ type: "text", text: `节点 ${args.nodeId} 已重开；重新进入后按它的出口条件完成。` }] };
        } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
      },
    },
  ];
}
