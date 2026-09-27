import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";
import type { WorkOrder } from "./work-orders";
import { validateReviewEvidence } from "./development-review-tool";
import { dirname } from "node:path";
import { hasUnansweredWorkerRequest } from "./agent-mailbox";

const parameters = type({ status: "string", findings: "string[]", reviewVerdict: "string?", reviewEvidence: type({ path: "string", excerpt: "string" }).array().optional() });

export function createWorkerResultTool(ledger: TaskLedger, order: WorkOrder): CustomTool<typeof parameters> {
  return {
    name: "alpha_worker_result", label: "Submit work order result", loadMode: "essential", parameters,
    description: "Required before ending the work order. Report completed, needs-context, blocked, or failed with concrete findings. For review mode also submit pass, changes-requested, or inconclusive. A passing review needs reviewEvidence with a current 20+ character source excerpt and path. The parent checks actual changes before integration.",
    async execute(_id, args) {
      try {
        if (!["completed", "needs-context", "blocked", "failed"].includes(args.status)) throw new Error("工单结果状态无效");
        if (args.status === "completed" && order.agentId && order.instanceId && await hasUnansweredWorkerRequest(dirname(dirname(ledger.file)), order.instanceId)) throw new Error("子代理仍有待主代理回答的请求，请提交 needs-context");
        if (ledger.state.workerOutcome?.requests?.length && args.status === "completed") throw new Error("仍有能力请求待主代理处理，不能标记完成");
        if (order.mode === "review" && !["pass", "changes-requested", "inconclusive"].includes(args.reviewVerdict ?? "")) throw new Error("审查结论无效");
        if (order.mode === "review" && order.fullAccess && args.reviewVerdict === "pass" && !args.reviewEvidence?.length) throw new Error("通过审查需要当前源码引用");
        const reviewEvidence = args.reviewEvidence?.length ? await validateReviewEvidence(ledger.state.projectRoot, args.reviewEvidence) : undefined;
        const input = { status: args.status as NonNullable<typeof ledger.state.workerOutcome>["status"], findings: args.findings, ...(args.reviewVerdict ? { reviewVerdict: args.reviewVerdict as NonNullable<typeof ledger.state.workerOutcome>["reviewVerdict"] } : {}), ...(reviewEvidence ? { reviewEvidence } : {}) };
        await ledger.recordWorkerOutcome(input);
        return { content: [{ type: "text", text: "工单结果已记录。" }] };
      } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
    },
  };
}
