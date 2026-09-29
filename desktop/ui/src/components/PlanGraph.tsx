import type { TaskView } from "../api/types";
import "./PlanGraph.css";

type PlanNodeView = NonNullable<TaskView["cognition"]>["nodes"][number];

const STAGES: Array<{ id: PlanNodeView["phase"]; label: string }> = [
  { id: "investigate", label: "调查" },
  { id: "execute", label: "执行" },
  { id: "review", label: "审查" },
];

const STATUS_LABELS: Record<PlanNodeView["status"], string> = {
  planned: "计划中", ready: "就绪", active: "进行中", waiting: "等待中", done: "已完成", reopened: "已重开", cancelled: "已取消",
};

const KIND_LABELS: Record<PlanNodeView["kind"], string> = { investigate: "调查", execute: "执行", review: "审查" };

const VERDICT_LABELS: Record<string, string> = { pass: "通过", "changes-requested": "需修改", inconclusive: "未定论" };

function expertName(node: PlanNodeView): string {
  return node.activation?.expert?.name ?? node.activation?.temporaryExpert?.name
    ?? (node.expertDecision.temporaryExpert ? node.expertDecision.temporaryExpert.name : undefined)
    ?? (node.expertDecision.expertId ? node.expertDecision.expertId : "主代理自己做");
}

type PlanEdgeView = NonNullable<TaskView["cognition"]>["edges"];
const EDGE_LABELS: Record<string, string> = { rework: "退回重做", premise: "前提回退" };

function NodeCard({ node, nodes, edges }: { node: PlanNodeView; nodes: PlanNodeView[]; edges: PlanEdgeView }) {
  const waiting = node.status === "waiting";
  const cursor = node.status === "active";
  // §3.5: the back-edges that can reopen this node; depends edges already show up as 依赖.
  const backEdges = (edges ?? []).filter(edge => edge.to === node.id && edge.kind !== "depends");
  return <article className={`plan-node plan-node-${node.status}${cursor ? " plan-node-cursor" : ""}`} aria-label={`${node.id} ${STATUS_LABELS[node.status]}`}>
    <header>
      <strong>{node.id}</strong>
      <span className="plan-node-kind">{KIND_LABELS[node.kind]}</span>
      {node.kind === "review" && node.gateRole && <span className="plan-node-gate">gate · {node.gateRole}</span>}
      <span className="plan-node-status">{STATUS_LABELS[node.status]}</span>
    </header>
    <p>{node.objective}</p>
    <dl>
      <dt>专家</dt><dd>{expertName(node)}</dd>
      <dt>执行位置</dt><dd>{node.host === "worker" ? "子代理" : "主会话"} · {node.activation?.access ?? (node.kind === "execute" ? "write" : "read-only")}</dd>
      {node.dependsOn.length > 0 && <><dt>依赖</dt><dd>{node.dependsOn.map(id => nodes.find(item => item.id === id) ? `${id}（${STATUS_LABELS[nodes.find(item => item.id === id)!.status]}）` : id).join("、")}</dd></>}
      {backEdges.length > 0 && <><dt>回边</dt><dd className="plan-node-backedge">{backEdges.map(edge => `${edge.from} → ${EDGE_LABELS[edge.kind] ?? edge.kind}`).join("、")}</dd></>}
      {node.produces && node.produces.length > 0 && <><dt>产出</dt><dd>{node.produces.join("、")}</dd></>}
    </dl>
    {waiting && <p className="plan-node-waiting">⏸ 停在此节点：{node.statusReason ?? "等待中"}</p>}
    {node.handoff && <div className="plan-node-handoff">
      <strong>交接记录</strong>
      {node.handoff.verdict && <p>gate 结论：{VERDICT_LABELS[node.handoff.verdict] ?? node.handoff.verdict}（绑定契约 v{node.handoff.contractVersion}）</p>}
      <p>{node.handoff.note}</p>
      {!!node.handoff.artifacts.length && <ul>{node.handoff.artifacts.map(artifact => <li key={artifact.path}><code>{artifact.path}</code> · {artifact.kind} · sha256 {artifact.hash.slice(0, 12)}…</li>)}</ul>}
      {!!node.handoff.findings?.length && <ul>{node.handoff.findings.map((finding, index) => <li key={index}>{finding.claim}（依据：{finding.source}）</li>)}</ul>}
      {!!node.handoff.unresolved.length && <p className="plan-node-unresolved">待解决：{node.handoff.unresolved.join("、")}</p>}
    </div>}
  </article>;
}

/** The plan as its graph (§1): three stages, nodes with their expert and handoff, and the cursor on what runs now. */
export function PlanGraph({ nodes, edges }: { nodes: PlanNodeView[]; edges?: PlanEdgeView }) {
  return <div className="plan-graph" aria-label="计划图">
    {STAGES.map(stage => {
      const staged = nodes.filter(node => node.phase === stage.id);
      return <section key={stage.id} className="plan-graph-stage" aria-label={`${stage.label}阶段`}>
        <h4>{stage.label} · {staged.filter(node => node.status === "done").length}/{staged.length}</h4>
        {staged.map(node => <NodeCard key={node.id} node={node} nodes={nodes} edges={edges} />)}
        {!staged.length && <p className="plan-graph-empty">此阶段尚无节点</p>}
      </section>;
    })}
  </div>;
}
