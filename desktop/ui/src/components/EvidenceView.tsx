import { useEffect, useState } from "react";
import { ArrowLeft, Check, Maximize2, Minimize2, X } from "lucide-react";
import { api } from "../api/client";
import type { EvidenceDetail, EvidenceItem, TaskView } from "../api/types";
import { actionLabel, criterionState, describeStep, parseEvidence } from "../state/evidence";
import { criterionLabel, formatDateTime } from "../state/labels";
import { Badge, Button, IconButton, Spinner, StateIcon } from "./ui";
import "./DetailView.css";

const details = new Map<string, EvidenceDetail>();

function EvidenceBody({ taskId, record }: { taskId: string; record: EvidenceItem }) {
  const key = `${taskId}:${record.id}`;
  const [state, setState] = useState<{ key: string; detail: EvidenceDetail | null; error: string | null } | null>(() => details.has(key) ? { key, detail: details.get(key)!, error: null } : null);
  const [fullSize, setFullSize] = useState(false);

  useEffect(() => {
    if (details.has(key)) { setState({ key, detail: details.get(key)!, error: null }); return; }
    let current = true;
    setState(null);
    api.evidence(taskId, record.id).then(detail => {
      details.set(key, detail);
      if (current) setState({ key, detail, error: null });
    }).catch((error: Error) => { if (current) setState({ key, detail: null, error: error.message }); });
    return () => { current = false; };
  }, [key, taskId, record.id]);

  if (!state || state.key !== key) return <p className="detail-loading"><Spinner size={14} />正在读取证据…</p>;
  if (!state.detail) return <p className="detail-empty">{state.error ?? "证据文件不可用"}</p>;
  const parsed = parseEvidence(state.detail.content);
  const screenshot = state.detail.screenshotUrl;

  if (parsed.kind === "text") {
    return <div className="evidence-body">
      <div className={`evidence-summary ${record.passed ? "pass" : "fail"}`}>
        {record.passed ? <Check size={16} aria-hidden /> : <X size={16} aria-hidden />}
        <strong>{record.passed ? "记录为通过" : "记录为未通过"}</strong>
      </div>
      <pre className="evidence-log">{parsed.text || "（空日志）"}</pre>
    </div>;
  }

  const { steps, failure, reason } = parsed;
  return <div className="evidence-body">
    {failure
      ? <div className="evidence-summary fail">
        <X size={16} aria-hidden />
        <div>
          <strong>第 {failure.step}/{failure.total} 步失败{failure.spec ? `：${describeStep(failure.spec)}` : ""}</strong>
          <p>{failure.message}</p>
          <small>此前 {failure.passedBefore} 步已通过</small>
        </div>
      </div>
      : reason
        ? <div className="evidence-summary fail"><X size={16} aria-hidden /><div><strong>验收未通过</strong><p>{reason}</p></div></div>
        : <div className="evidence-summary pass"><Check size={16} aria-hidden /><strong>全部 {steps.length} 步通过</strong></div>}
    {(steps.length > 0 || failure) && <ol className="evidence-steps">
      {steps.map(step => <li key={step.index}>
        <StateIcon state={step.passed ? "pass" : "fail"} size={13} />
        <span className="evidence-step-no">{step.index}</span>
        <span>{actionLabel(step.action)}{step.detail ? ` · ${step.detail}` : ""}</span>
      </li>)}
      {failure && <li className="failed">
        <StateIcon state="fail" size={13} />
        <span className="evidence-step-no">{failure.step}</span>
        <span>{failure.spec ? describeStep(failure.spec) : "失败步骤"}</span>
      </li>}
    </ol>}
    {screenshot && <figure className={`evidence-shot ${fullSize ? "full" : ""}`}>
      <figcaption>
        <span>验收结束时的页面截图</span>
        <IconButton icon={fullSize ? Minimize2 : Maximize2} label={fullSize ? "适应宽度" : "原始大小"} size={14} onClick={() => setFullSize(value => !value)} />
      </figcaption>
      <div className="evidence-shot-frame"><img src={screenshot} alt="验收结束时的产品页面截图" /></div>
    </figure>}
  </div>;
}

function LocalPreviewInfo({ task }: { task: TaskView }) {
  const passed = !task.pending.includes("local-preview");
  return <div className="evidence-body">
    <div className={`evidence-summary ${passed ? "pass" : "pending"}`}>
      <StateIcon state={passed ? "pass" : "pending"} size={16} />
      <div>
        <strong>{passed ? "当前源码版本已发布到本机预览" : "当前源码版本还没有发布到本机预览"}</strong>
        <p>{task.preview ? `${task.preview.url}（${task.preview.live ? "在线" : "已停止"}）` : "尚未发布过预览"}</p>
      </div>
    </div>
    <p className="detail-note">本机预览不单独保存证据文件：它要求当前源码版本已经发布为预览，浏览器验收也必须在这个预览上完成。</p>
  </div>;
}

export function EvidenceView({ task, criterionId, evidenceId, onBack }: { task: TaskView; criterionId?: string; evidenceId?: string; onBack(): void }) {
  const criteria = [...task.criteria.map(item => item.id).filter(id => id !== "local-preview"), "local-preview"];
  const [criterion, setCriterion] = useState(() => criterionId && criteria.includes(criterionId)
    ? criterionId
    : criteria.find(id => criterionState(id, task.pending, task.evidence) === "fail") ?? criteria[0]);
  const [selected, setSelected] = useState<string | null>(evidenceId ?? null);
  const records = task.evidence.filter(item => item.criterionId === criterion).reverse();
  const active = records.find(item => item.id === selected) ?? records.find(item => item.current) ?? records[0] ?? null;

  const choose = (id: string) => {
    setCriterion(id);
    setSelected(null);
  };

  return <div className="detail-view" data-testid="evidence-view">
    <header className="detail-header">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>返回对话</Button>
      <h2>验收证据</h2>
    </header>
    <div className="detail-tabs" role="tablist">
      {criteria.map(id => <button key={id} role="tab" aria-selected={id === criterion} onClick={() => choose(id)}>
        <StateIcon state={criterionState(id, task.pending, task.evidence)} size={13} />{criterionLabel(id, task.criteria)}
      </button>)}
    </div>
    <div className="detail-body">
      {criterion === "local-preview"
        ? <LocalPreviewInfo task={task} />
        : !records.length
          ? <p className="detail-empty">这一项还没有验收记录。</p>
          : <>
            <ol className="evidence-records" aria-label="验收记录">
              {records.map(item => <li key={item.id}>
                <button aria-current={item.id === active?.id ? "true" : undefined} onClick={() => setSelected(item.id)}>
                  <StateIcon state={item.passed ? "pass" : "fail"} size={13} />
                  <span className="evidence-record-time">{formatDateTime(item.recordedAt)}</span>
                  <span className="evidence-record-version">目标 v{item.contractVersion}</span>
                  {item.current ? <Badge tone={item.passed ? "success" : "danger"}>当前版本</Badge> : <span className="evidence-record-old">历史</span>}
                </button>
              </li>)}
            </ol>
            {active && <EvidenceBody taskId={task.id} record={active} />}
          </>}
    </div>
  </div>;
}
