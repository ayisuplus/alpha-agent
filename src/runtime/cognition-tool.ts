import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { ExpertStore } from "./experts";
import { SkillPluginStore } from "../plugins/third-party";
import type { CognitionStep, TaskLedger } from "./task-ledger";
import { discoverForGap } from "./skill-discovery";

const planParameters = type({
  summary: "string",
  reason: "string",
  scope: "string[]?",
  constraints: "string[]?",
  openQuestions: "string[]?",
  candidates: "string[]",
  steps: type({ id: "string", objective: "string", mode: "'investigate' | 'implement' | 'review'", dependsOn: "string[]", expertId: "string?", skillIds: "string[]" }).array(),
});

const gapParameters = type({ kind: "string", description: "string", publicQuery: "string?" });
const resolveParameters = type({ kind: "string", description: "string", evidence: "string" });
const stepParameters = type({ id: "string", status: "'running' | 'complete' | 'blocked' | 'cancelled'", reason: "string" });

export function createCognitionTools(ledger: TaskLedger, dataRoot: string): [CustomTool<typeof planParameters>, CustomTool<typeof gapParameters>, CustomTool<typeof resolveParameters>, CustomTool<typeof stepParameters>] {
  return [
    {
      name: "alpha_plan",
      label: "Record or adjust task plan",
      description: "Record task understanding: scope, constraints, unresolved questions, steps and candidate experts. Candidates are not dispatched. Call again only when evidence or user guidance changes the plan. Use only enabled experts and available Skills.",
      parameters: planParameters,
      loadMode: "essential",
      async execute(_id, args) {
        try {
          const [experts, skills] = await Promise.all([new ExpertStore(dataRoot).enabled(), new SkillPluginStore(dataRoot).loadSkills()]);
          const expertIds = new Set(experts.map(item => item.id));
          const skillIds = new Set(skills.map(item => item.name));
          const candidates = [...new Set(args.candidates)];
          if (candidates.some(id => !expertIds.has(id))) throw new Error("计划引用了未启用的专家");
          const steps: CognitionStep[] = args.steps.map(step => {
            if (!["investigate", "implement", "review"].includes(step.mode)) throw new Error(`未知执行模式：${step.mode}`);
            if (step.expertId && !expertIds.has(step.expertId)) throw new Error(`专家未启用：${step.expertId}`);
            const expert = step.expertId ? experts.find(item => item.id === step.expertId) : undefined;
            const available = new Set([...skillIds, ...(expert?.package?.skills.map(item => item.id) ?? [])]);
            if (step.skillIds.some(id => !available.has(id))) throw new Error(`Skill 未安装、未启用或不属于所选专家：${step.skillIds.find(id => !available.has(id))}`);
            return { ...step, mode: step.mode as CognitionStep["mode"], status: "planned" };
          });
          await ledger.reviseCognition({ summary: args.summary, reason: args.reason, scope: args.scope, constraints: args.constraints, openQuestions: args.openQuestions, candidates, steps });
          return { content: [{ type: "text", text: `认知修订 v${ledger.state.cognition?.revision} 已记录。${ledger.state.phase === "plan" ? "计划将交给用户审阅；此轮规划到此结束，不要声称已批准。" : ledger.state.phase === "plan-review" ? "关键计划变更需要用户重新审阅；现在停止执行。" : "候选专家不会自动启动。"}` }] };
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
      name: "alpha_step", label: "Update a planned step", loadMode: "essential", parameters: stepParameters,
      description: "Update the status of one existing plan step with a concrete reason or result. A checked step is progress only; final acceptance still needs independent evidence.",
      async execute(_id, args) {
        try {
          await ledger.updateStep(args.id, args.status, args.reason);
          return { content: [{ type: "text", text: `步骤 ${args.id} 已更新为 ${args.status}；验收仍由任务证据判定。` }] };
        } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
      },
    },
  ];
}
