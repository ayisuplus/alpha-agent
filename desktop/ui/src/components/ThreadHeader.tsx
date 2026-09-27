import { useEffect, useState } from "react";
import { ChevronDown, CircleAlert, Info, MoreHorizontal, PanelRightOpen } from "lucide-react";
import type { TaskView } from "../api/types";
import { api } from "../api/client";
import { criterionState, describeStep, parseFailure } from "../state/evidence";
import { criterionLabel, failureHeadline, formatDateTime, phaseInfo, reopenText, taskStatus, taskTitle } from "../state/labels";
import { notify, openDetail, openSettings, setGoalContinuation, setTaskModel, showPreview, store, syncSelected } from "../state/workbench";
import { useStore } from "../state/store";
import { ModelPicker, shortModel } from "./ModelPicker";
import { WebPanel } from "./WebPanel";
import { TaskMenu } from "./TaskMenu";
import { TaskAutomationPanel } from "./TaskAutomationPanel";
import { Badge, IconButton, Spinner, StateIcon } from "./ui";
import "./ThreadHeader.css";

function FailureAlert({ reason }: { reason: string }) {
  const [expanded, setExpanded] = useState(false);
  const failure = parseFailure(reason);
  const detail = failure
    ? `第 ${failure.step}/${failure.total} 步${failure.spec ? `（${describeStep(failure.spec)}）` : ""}失败：${failure.message}`
    : reason;
  const verification = !!failure || /verification|browser|preview/i.test(reason);
  const modelProblem = /Authenticated model is unavailable|no response within/i.test(reason);
  return <div className="thread-alert tone-danger" role="status">
    <CircleAlert size={16} aria-hidden />
    <div className="thread-alert-body">
      <strong>{failureHeadline(reason)}</strong>
      <p className={expanded ? "" : "clamped"}>{detail}</p>
    </div>
    <div className="thread-alert-actions">
      {detail.length > 140 && <button className="link-button" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}</button>}
      {verification && <button className="link-button" onClick={() => openDetail({ kind: "evidence", criterionId: "user-path" })}>查看证据</button>}
      {modelProblem && <button className="link-button" onClick={() => openSettings("model")}>模型设置</button>}
    </div>
  </div>;
}

export function ThreadHeader({ task, busy, phase, detailsOnly = false, onBack }: { task: TaskView; busy: boolean; phase: string | null; detailsOnly?: boolean; onBack?: () => void }) {
  const [showObjective, setShowObjective] = useState(false);
  const projects = useStore(store, state => state.projects);
  const projectName = projects.find(project => project.id === task.projectId)?.name;
  const [modelSaving, setModelSaving] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [skillDecision, setSkillDecision] = useState<string | null>(null);
  const [selectedWorker, setSelectedWorker] = useState<{ id: string; diff?: string; status: string; reason?: string; findings?: string[]; events?: Array<{ sequence: number; type: string; value: string }> } | null>(null);
  const [workerLoading, setWorkerLoading] = useState<string | null>(null);
  const [agentMessages, setAgentMessages] = useState<Awaited<ReturnType<typeof api.agentMessages>>["messages"]>([]);
  const [memory, setMemory] = useState<{ taskId: string; content: string; commit: string | null } | null>(null);
  useEffect(() => {
    if (!selectedWorker) return;
    const timer = setInterval(() => { void api.worker(task.id, selectedWorker.id).then(result => setSelectedWorker(current => current?.id === selectedWorker.id ? { id: selectedWorker.id, diff: result.diff, status: result.report?.status ?? result.instance.status, reason: result.report?.reason, findings: result.report?.results[result.instance.orderId]?.findings, events: result.events } : current)).catch(() => undefined); }, 2_000);
    return () => clearInterval(timer);
  }, [task.id, selectedWorker?.id]);
  useEffect(() => {
    if (!task.cognition?.agents?.length) { setAgentMessages([]); return; }
    let current = true;
    const refresh = () => { void api.agentMessages(task.id).then(result => { if (current) setAgentMessages(result.messages); }).catch(() => undefined); };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { current = false; clearInterval(timer); };
  }, [task.id, task.cognition?.agents?.length]);
  useEffect(() => {
    if (!detailsOnly) return;
    let current = true;
    void api.projectMemory(task.id).then(result => { if (current) setMemory({ taskId: task.id, content: result.content, commit: result.commit }); }).catch(() => { if (current) setMemory({ taskId: task.id, content: "项目记忆暂时无法读取。", commit: null }); });
    return () => { current = false; };
  }, [detailsOnly, task.id, task.checkpoint?.memoryCommit]);
  const status = taskStatus(task);
  const criteria = [...task.criteria.map(item => item.id).filter(id => id !== "local-preview"), ...(!task.taskType || task.taskType === "web-product" ? ["local-preview"] : []), ...(task.development?.enabled ? ["development-review"] : []), ...(task.designatedExpertId ? ["designated-expert"] : []), ...(task.cognition?.gaps.some(gap => !gap.resolvedAt) ? ["capability-gap"] : [])];
  const history = [...(task.contractHistory ?? [])].sort((a, b) => b.version - a.version);
  const proposals = task.cognition?.skillProposals?.filter(item => item.status === "pending") ?? [];
  const steps = task.cognition?.steps ?? [];
  const completedSteps = steps.filter(step => step.status === "complete").length;
  const usedCalls = (task.runs ?? []).reduce((sum, run) => sum + run.toolCalls, 0);
  const usedMinutes = Math.floor((task.runs ?? []).reduce((sum, run) => sum + run.elapsedMs, 0) / 60_000);
  const workerModels = new Map((task.runs ?? []).filter(run => run.instanceId).map(run => [run.instanceId, run.model]));
  const planningState = task.status === "stopped" ? "已停止" : task.status === "needs-input" ? "需要回答" : task.status === "complete" ? "已完成" : task.phase === "plan" ? "规划中" : task.phase === "plan-review" ? "待审阅" : "执行中";
  const decideSkill = async (id: string, decision: "install" | "reject") => {
    setSkillDecision(id);
    try {
      await api.decideSkillProposal(task.id, id, decision);
      await syncSelected(task.id);
      notify(decision === "install" ? "Skill 已按提案版本安装，后续派发可使用" : "Skill 提案已拒绝", "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setSkillDecision(null); }
  };

  const information = <div className="thread-information">
    <div className="thread-meta">
      <button className="objective-toggle" aria-expanded={showObjective} onClick={() => setShowObjective(value => !value)}>
        目标 v{task.contractVersion}<ChevronDown size={14} aria-hidden />
      </button>
      <ModelPicker value={task.modelSelector ?? null} allowDefault onChange={async value => {
        setModelSaving(true);
        try { await setTaskModel(value); } finally { setModelSaving(false); }
      }} label="这个任务的模型" disabled={busy || modelSaving}
        disabledReason={modelSaving ? "正在保存模型" : "任务运行中，结束后才能更换模型"} />
      {task.createdAt && <span>创建于 {formatDateTime(task.createdAt)}</span>}
      <span>更新于 {formatDateTime(task.updatedAt)}</span>
    </div>
    <div className="thread-meta" aria-label="认知运行状态">
      <span>阶段：{planningState}</span>
      <span>{task.planApproval ? `已批准计划 v${task.planApproval.cognitionRevision}` : task.phase === "plan-review" ? `待审计划 v${task.cognition?.revision ?? 0}` : "计划未批准"}</span>
      <span>待办 {completedSteps}/{steps.length}</span>
      {task.goal?.budget && <span>预算 {usedCalls}/{task.goal.budget.maxTotalToolCalls} 次工具调用 · {usedMinutes}/{Math.ceil(task.goal.budget.totalWallTimeMs / 60_000)} 分钟</span>}
      {task.status !== "complete" && <label><input type="checkbox" checked={!!task.goal?.enabled} disabled={busy} onChange={event => void setGoalContinuation(event.target.checked)} /> 持续推进</label>}
      {task.goal?.stopReason && <span>停止原因：{task.goal.stopReason}</span>}
    </div>
    {showObjective && <div className="objective-panel">
      <div className="objective-version current">
        <span className="objective-label">当前目标 · v{task.contractVersion}</span>
        <p>{task.objective}</p>
      </div>
      {history.map(item => <div key={item.version} className="objective-version">
        <span className="objective-label">v{item.version} · 修订于 {formatDateTime(item.revisedAt)}</span>
        <p>{item.objective}</p>
      </div>)}
      {!!task.inputs?.length && <div className="objective-version"><span className="objective-label">输入文件</span>{task.inputs.map(item => <p key={item.id}><a href={item.url} download>{item.name}</a> · SHA-256 {item.sha256.slice(0, 12)}…</p>)}</div>}
    </div>}
    <div className="criteria-row" aria-label="验收进度">
      {criteria.map(id => {
        const state = criterionState(id, task.pending, task.evidence);
        return <button key={id} className={`criterion state-${state}`} onClick={() => {
          if (id === "development-review" || id === "capability-gap") {
            const panel = document.getElementById("cognition-panel") as HTMLDetailsElement | null;
            if (panel) { panel.open = true; panel.scrollIntoView({ block: "nearest" }); }
          } else openDetail({ kind: "evidence", criterionId: id });
        }} title="查看验收证据">
          <StateIcon state={state} size={13} />{id === "development-review" ? "独立审查" : id === "designated-expert" ? "指定专家参与" : id === "capability-gap" ? "能力缺口" : criterionLabel(id, task.criteria)}
        </button>;
      })}
    </div>
    {task.cognition && <details id="cognition-panel" className="cognition-panel">
      <summary>任务计划 · 修订 v{task.cognition.revision} · 已调用 {task.cognition.instances?.length ?? 0} 个实例{proposals.length ? ` · ${proposals.length} 个 Skill 提案` : ""}</summary>
      <p>{task.cognition.summary}</p>
      {task.designatedExpertId && <p>用户指定专家：{task.designatedExpertId}（必须实际参与）</p>}
      {!!task.cognition.scope?.length && <p>任务范围：{task.cognition.scope.join("；")}</p>}
      {!!task.cognition.constraints?.length && <p>约束：{task.cognition.constraints.join("；")}</p>}
      {!!task.cognition.openQuestions?.length && <p>待澄清：{task.cognition.openQuestions.join("；")}</p>}
      {!!task.cognition.candidates.length && <p>候选专家：{task.cognition.candidates.join("、")}（按需派发）</p>}
      {!!steps.length && <ol aria-label="任务待办">{steps.map(step => <li key={step.id}><strong>{step.id}</strong> · {step.objective} · {step.mode} · {step.status}{step.dependsOn.length ? ` · 依赖 ${step.dependsOn.join("、")}` : ""}{step.expertId ? ` · 专家 ${step.expertId}` : ""}{step.statusReason ? ` · ${step.statusReason}` : ""}</li>)}</ol>}
      {!!task.cognition.amendments.length && <details><summary>分工调整记录</summary><ul>{task.cognition.amendments.map(item => <li key={item.revision}>v{item.revision} · {item.reason}</li>)}</ul></details>}
      {!!task.cognition.agents?.length && <div><strong>子代理 · {task.cognition.agents.length} 个稳定身份</strong><ul>{task.cognition.agents.map(agent => <li key={agent.id}>
        <strong>{agent.expert?.name ?? "通用执行"}</strong> · {agent.mode} · {agent.status} · ID {agent.id.slice(0, 8)} · {agent.skillIds.join("、")}
        <div>运行记录：{task.cognition?.instances?.filter(instance => instance.agentId === agent.id).map(instance => `${instance.id.slice(0, 8)} ${instance.status}${instance.integration ? `/${instance.integration}` : ""}`).join(" → ") || "暂无"}</div>
        {agent.cognition && <div>认知 v{agent.cognition.revision}：{agent.cognition.understanding}{agent.cognition.openQuestions.length ? ` · 待查 ${agent.cognition.openQuestions.join("；")}` : ""}</div>}
      </li>)}</ul></div>}
      {!!agentMessages.length && <div><strong>主代理待处理消息 · {agentMessages.length}</strong><ul>{agentMessages.map(message => {
        const agent = task.cognition?.agents?.find(item => item.id === message.fromAgentId);
        const stale = message.contractVersion !== task.contractVersion || (agent && agent.lastAttemptId !== message.fromRunId);
        return <li key={message.id}>{agent?.expert?.name ?? message.fromAgentId?.slice(0, 8) ?? "主代理"} · {message.kind}{stale ? " · 旧运行/任务版本" : ""} · {message.body}</li>;
      })}</ul></div>}
      {!!task.cognition.instances?.length && <div><strong>执行实例</strong><ul>{task.cognition.instances.map(instance => <li key={instance.id}>
        <strong>{instance.orderId}</strong> · {instance.expert?.name ?? "通用执行"} · {instance.mode} · {instance.status}{instance.integration ? ` / ${instance.integration}` : ""}{instance.agentId ? ` · 子代理 ${instance.agentId.slice(0, 8)}` : ""}
        {(workerModels.get(instance.id) ?? instance.order?.modelSelector) && ` · 模型 ${shortModel((workerModels.get(instance.id) ?? instance.order?.modelSelector)!)}`}
        {instance.parentId ? ` · 主实例 ${instance.parentId.slice(0, 8)}` : ""}
        {instance.worktreePath && <div>Worktree：<code>{instance.worktreePath}</code></div>}
        {instance.startedAt && <div>开始：{formatDateTime(instance.startedAt)}{instance.endedAt ? ` · 结束：${formatDateTime(instance.endedAt)}` : ""}</div>}
        {!!instance.findings?.length && <div>{instance.findings.join("；")}</div>}
        {instance.parentId && <button className="link-button" disabled={!!workerLoading} onClick={() => { setWorkerLoading(instance.id); void api.worker(task.id, instance.id).then(result => setSelectedWorker({ id: instance.id, diff: result.diff, status: result.report?.status ?? instance.status, reason: result.report?.reason, findings: result.report?.results[instance.orderId]?.findings, events: result.events })).catch(error => notify(error instanceof Error ? error.message : String(error))).finally(() => setWorkerLoading(null)); }}>查看活动与差异</button>}
        {instance.orderId !== "coordinator" && ["queued", "running", "returned"].includes(instance.status) && <button className="link-button" disabled={!!workerLoading} onClick={() => { setWorkerLoading(instance.id); void api.cancelWorker(task.id, instance.id).then(() => syncSelected(task.id)).catch(error => notify(error instanceof Error ? error.message : String(error))).finally(() => setWorkerLoading(null)); }}>停止此实例</button>}
      </li>)}</ul>
      {selectedWorker && <div className="worker-result"><strong>实例 {selectedWorker.id.slice(0, 8)} · {selectedWorker.status}</strong>{selectedWorker.reason && <p>{selectedWorker.reason}</p>}{!!selectedWorker.findings?.length && <p>{selectedWorker.findings.join("；")}</p>}{!!selectedWorker.events?.length && <ol>{selectedWorker.events.slice(-30).map(item => <li key={item.sequence}>{item.type} · {item.value}</li>)}</ol>}{selectedWorker.diff && <pre>{selectedWorker.diff}</pre>}</div>}
      </div>}
      {!!task.cognition.gaps.length && <div><strong>能力缺口</strong><ul>{task.cognition.gaps.map((gap, index) => <li key={index}>{gap.kind} · {gap.description} · {gap.resolvedAt ? `已解决：${gap.resolution}` : gap.blockingReason ?? "待解决"}</li>)}</ul></div>}
      {task.development?.review && <p>独立审查：{task.development.review.verdict}{task.development.review.findings.length ? ` · ${task.development.review.findings.join("；")}` : ""}</p>}
      {!!task.development?.review?.evidence?.length && <details><summary>独立审查的源码依据</summary><ul>{task.development.review.evidence.map((item, index) => <li key={`${item.path}-${index}`}><strong>{item.path}</strong>：<code>{item.excerpt}</code></li>)}</ul></details>}
      {!!proposals.length && <div><strong>待决定的 Skill 提案</strong>{proposals.map(proposal => <div className="skill-proposal" key={proposal.id}>
        <a href={`${proposal.source}/blob/${proposal.revision}/${proposal.path}`} target="_blank" rel="noreferrer">{proposal.name}</a>
        <p>{proposal.description} · 提交 {proposal.revision.slice(0, 10)} · 路径 {proposal.path}</p>
        <p>解决缺口：{task.cognition?.skillSearches?.find(search => search.key === proposal.key)?.gapDescription ?? "当前任务的方法缺口"}。仅添加此 Skill 的只读方法文件，工具权限不变。</p>
        {!!proposal.requirements?.tools.length && <p>声明需要的工具：{proposal.requirements.tools.join("、")}</p>}
        {!!proposal.requirements?.services.length && <p>声明需要的外部服务：{proposal.requirements.services.join("、")}（worker 无权自行接入）</p>}
        {!!proposal.requirements?.conflicts.length && <p>声明冲突的 Skill：{proposal.requirements.conflicts.join("、")}</p>}
        <button disabled={!!skillDecision} onClick={() => void decideSkill(proposal.id, "install")}>安装此 Skill</button>
        <button disabled={!!skillDecision} onClick={() => void decideSkill(proposal.id, "reject")}>拒绝</button>
      </div>)}</div>}
      {!!task.cognition.skillSearches?.some(search => search.error) && <p>Skill 搜索异常：{task.cognition.skillSearches.filter(search => search.error).map(search => search.error).join("；")}</p>}
    </details>}
    <details className="cognition-panel">
      <summary>项目状态记忆 · {task.checkpointStatus === "pending" ? "收尾待完成" : task.checkpointStatus === "failed" ? "收尾失败" : task.checkpoint ? "已提交" : "尚无提交"}</summary>
      {task.checkpointError && <p role="alert">收尾失败：{task.checkpointError}</p>}
      {memory?.taskId === task.id && memory.commit && <p>最新记忆提交 {memory.commit.slice(0, 12)}</p>}
      {task.checkpoint && <p>本任务最近轮次记忆提交 {task.checkpoint.memoryCommit.slice(0, 12)} · 项目提交 {task.checkpoint.codeCommits.length} 个</p>}
      {task.checkpoint?.codeCommits.map(item => <p key={item.root}>{item.root} · {item.commit.slice(0, 12)}</p>)}
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{memory?.taskId === task.id ? memory.content || "项目记忆尚未生成。" : "正在读取项目记忆…"}</pre>
    </details>
    <TaskAutomationPanel task={task} />
    </div>;

  if (detailsOnly) return <section className="task-info-view">
    <header className="detail-header"><button className="link-button" onClick={onBack}>← 返回对话</button><h2>任务详情</h2></header>
    <div className="task-info-scroll">{information}<WebPanel task={task} /></div>
  </section>;

  return <header className="thread-header">
    <div className="thread-title-row">
      <h1 title={task.objective}>{taskTitle(task)}</h1>
      {projectName && <span className="thread-project" title={projectName}>{projectName}</span>}
      <span aria-live="polite">
        {busy
          ? <Badge tone="accent"><Spinner size={12} />{phase ? `运行中 · ${phaseInfo(phase).label}` : "运行中"}</Badge>
          : <Badge tone={status.tone}>{status.label}</Badge>}
      </span>
      <IconButton icon={Info} label="任务详情" onClick={() => openDetail({ kind: "info" })} />
      <IconButton icon={PanelRightOpen} label="打开工作区预览" onClick={showPreview} />
      <div className="task-menu-anchor">
        <IconButton icon={MoreHorizontal} label="任务操作" onClick={() => setMenuOpen(value => !value)} />
        <TaskMenu task={task} open={menuOpen} onClose={() => setMenuOpen(false)} />
      </div>
    </div>
    <WebPanel task={task} />
    {task.blockedService === "project" && <div className="thread-alert tone-warning" role="alert"><CircleAlert size={16} aria-hidden /><div className="thread-alert-body"><strong>项目目录已变化</strong><p>{task.pendingQuestion ?? "重新检查后可继续当前任务"}</p></div><div className="thread-alert-actions"><button className="link-button" disabled={rechecking} onClick={() => void (async () => {
      setRechecking(true);
      try { await api.recheckTaskProject(task.id); await syncSelected(task.id); notify("项目目录已重新检查，可以继续任务", "info"); }
      catch (error) { notify(error instanceof Error ? error.message : String(error)); }
      finally { setRechecking(false); }
    })()}>{rechecking ? "检查中…" : "重新检查项目"}</button></div></div>}
    {task.phase === "plan-review" && <div className="thread-alert tone-info" role="status"><Info size={16} aria-hidden /><div className="thread-alert-body"><strong>计划待审阅 · v{task.cognition?.revision ?? 0}</strong><p>{task.cognition?.summary ?? "尚无计划摘要"}</p><p>范围：{task.cognition?.scope?.join("；") || "未列出"}；约束：{task.cognition?.constraints?.join("；") || "未列出"}</p><ol aria-label="待审计划步骤">{steps.map(step => <li key={step.id}>{step.id} · {step.objective} · {step.mode}{step.dependsOn.length ? ` · 依赖 ${step.dependsOn.join("、")}` : ""}</li>)}</ol></div></div>}
    {!!proposals.length && <button className="thread-attention" onClick={() => openDetail({ kind: "info" })}>{proposals.length} 个 Skill 提案待决定 · 查看任务详情</button>}
    {task.lastFailure && task.status !== "complete" && !busy && <FailureAlert reason={task.lastFailure} />}
    {!task.lastFailure && task.reopenReason && task.status === "active" && !busy && <div className="thread-alert tone-info">
      <Info size={16} aria-hidden />
      <div className="thread-alert-body"><p>{reopenText(task.reopenReason)}</p></div>
    </div>}
  </header>;
}
