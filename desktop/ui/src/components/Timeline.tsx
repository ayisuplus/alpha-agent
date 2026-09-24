import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Check, ChevronDown, ChevronRight, CircleDot, FileDiff, Globe, Hand, RotateCw, Square, X } from "lucide-react";
import type { EvidenceItem, GuidanceStatus, ReviewSummary, TaskView } from "../api/types";
import { evidenceNear } from "../state/evidence";
import { formatDateTime, formatDuration, formatTime, guidanceLabel, guidanceText, phaseInfo, toolInfo } from "../state/labels";
import type { Block, TimelineItem, ToolCall, Turn, TurnKind } from "../state/timeline";
import { openDetail } from "../state/workbench";
import { Markdown } from "./Markdown";
import { shortModel } from "./ModelPicker";
import { Badge, Spinner, StateIcon, ToolGlyph } from "./ui";
import "./Timeline.css";

const KIND_LABEL: Record<TurnKind, string> = {
  create: "开始构建",
  revise: "按修订后的目标构建",
  resume: "继续修复",
  publish: "重新发布预览",
  verify: "浏览器验收",
  other: "运行",
};

function UserMessage({ label, text, at, status }: { label: string; text: string; at: string | null; status?: GuidanceStatus }) {
  const statusLabel = guidanceLabel(status);
  return <div className="user-message">
    <div className="user-message-meta">
      <span>{label}</span>
      {at && <time dateTime={at}>{formatDateTime(at)}</time>}
      {statusLabel && <Badge tone={status === "processed" ? "success" : status === "delivered" ? "accent" : "neutral"}>{statusLabel}</Badge>}
    </div>
    <div className="user-message-bubble">{text}</div>
  </div>;
}

function ReviewLink({ review }: { review: ReviewSummary }) {
  const shown = review.paths.slice(0, 3).join("、");
  const more = review.paths.length > 3 ? ` 等 ${review.paths.length} 个` : "";
  return <button className="review-link" onClick={() => openDetail({ kind: "diff", operationId: review.operationId })} disabled={!review.paths.length}>
    <FileDiff size={15} aria-hidden />
    <span className="review-link-title">{review.paths.length ? `改动了 ${review.paths.length} 个文件` : "本轮没有文本源码改动"}</span>
    {review.paths.length > 0 && <span className="review-link-paths">{shown}{more}</span>}
    {review.paths.length > 0 && <ChevronRight size={15} aria-hidden />}
  </button>;
}

function TextBlock({ text, live }: { text: string; live?: boolean }) {
  const long = !live && text.length > 2400;
  const [expanded, setExpanded] = useState(false);
  return <div className={["turn-text", long && !expanded ? "collapsed" : "", live ? "live" : ""].filter(Boolean).join(" ")}>
    <Markdown text={text} />
    {long && <button className="link-button turn-text-toggle" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开全文"}</button>}
  </div>;
}

function ToolRow({ call }: { call: ToolCall }) {
  const info = toolInfo(call.name);
  return <li className={`tool-call state-${call.state}`}>
    <ToolGlyph icon={info.icon} size={13} />
    <span className="tool-call-label">{info.label}</span>
    {call.target ? <code className="tool-call-target" title={call.target}>{call.target}</code> : <span />}
    {call.intent ? <span className="tool-call-intent" title={call.intent}>{call.intent}</span> : <span />}
    <span className="tool-call-state">{call.state === "running" ? <Spinner size={12} /> : call.state === "error" ? <X size={13} className="tone-text-danger" aria-label="失败" /> : <Check size={13} className="tone-text-muted" aria-label="完成" />}</span>
  </li>;
}

function ToolGroup({ calls, live }: { calls: ToolCall[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  // A couple of calls read better as plain rows than behind a summary.
  if (calls.length <= 2) {
    return <div className="tool-group"><ol className="tool-list flat">{calls.map(call => <ToolRow key={call.id} call={call} />)}</ol></div>;
  }
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = toolInfo(call.name).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const running = live ? calls.findLast(call => call.state === "running") : undefined;
  const errors = calls.filter(call => call.state === "error").length;
  return <div className="tool-group">
    <button className="tool-summary" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronRight size={14} className="tool-chevron" aria-hidden />
      <span className="tool-counts">{[...counts].map(([label, count]) => <span key={label}>{label} {count}</span>)}</span>
      {running
        ? <span className="tool-current"><Spinner size={12} />正在{toolInfo(running.name).label}{running.target ? ` ${running.target}` : ""}</span>
        : errors > 0 && <span className="tool-errors">{errors} 次失败</span>}
    </button>
    {open && <ol className="tool-list">{calls.map(call => <ToolRow key={call.id} call={call} />)}</ol>}
  </div>;
}

type ProgressBlock = Extract<Block, { type: "phase" | "check" | "error" }>;

function phaseIcon(phase: string, active: boolean): ReactNode {
  if (active) return <Spinner size={13} />;
  switch (phase) {
    case "已验收": return <Check size={13} className="tone-text-success" aria-hidden />;
    case "失败": return <X size={13} className="tone-text-danger" aria-hidden />;
    case "待验收": return <CircleDot size={13} className="tone-text-warning" aria-hidden />;
    case "已停止": return <Square size={11} className="tone-text-muted" aria-hidden />;
    case "用户接管": return <Hand size={13} className="tone-text-warning" aria-hidden />;
    default: return <span className="progress-dot" aria-hidden />;
  }
}

function Progress({ blocks, live, evidence }: { blocks: ProgressBlock[]; live: boolean; evidence: EvidenceItem[] }) {
  return <ol className="progress">
    {blocks.map((block, index) => {
      const last = live && index === blocks.length - 1;
      if (block.type === "phase") {
        const url = block.phase.startsWith("本机预览：") ? block.phase.slice("本机预览：".length) : null;
        return <li key={block.id} className="progress-row">
          <span className="progress-icon">{phaseIcon(block.phase, last)}</span>
          <span className="progress-label">{phaseInfo(block.phase).label}</span>
          {url && <code className="progress-detail">{url}</code>}
        </li>;
      }
      if (block.type === "error") {
        return <li key={block.id} className="progress-row tone-danger">
          <span className="progress-icon"><X size={13} className="tone-text-danger" aria-hidden /></span>
          <span className="progress-label progress-error">{block.message}</span>
        </li>;
      }
      const criterionId = block.name === "browser" ? "user-path" : block.name === "build" ? "build" : null;
      const record = criterionId ? evidenceNear(evidence, criterionId, block.at) : null;
      return <li key={block.id} className={`progress-row ${block.passed ? "" : "tone-danger"}`}>
        <span className="progress-icon"><StateIcon state={block.passed ? "pass" : "fail"} size={13} /></span>
        <span className="progress-label">{toolInfo(block.name).label}{block.passed ? "通过" : "未通过"}</span>
        {block.detail && <span className="progress-detail failure" title={block.detail}>{block.detail}</span>}
        {criterionId && (record || !block.passed) && <button className="link-button" onClick={() => openDetail({ kind: "evidence", criterionId, evidenceId: record?.id })}>证据</button>}
      </li>;
    })}
  </ol>;
}

type Segment = { kind: "progress"; blocks: ProgressBlock[] } | { kind: "block"; block: Exclude<Block, ProgressBlock> };

function TurnBody({ turn, evidence }: { turn: Turn; evidence: EvidenceItem[] }) {
  const segments: Segment[] = [];
  for (const block of turn.blocks) {
    if (block.type === "phase" || block.type === "check" || block.type === "error") {
      const previous = segments.at(-1);
      if (previous?.kind === "progress") previous.blocks.push(block);
      else segments.push({ kind: "progress", blocks: [block] });
    } else segments.push({ kind: "block", block });
  }
  return <>
    {segments.map((segment, position) => {
      const tail = turn.live && position === segments.length - 1;
      if (segment.kind === "progress") return <Progress key={segment.blocks[0].id} blocks={segment.blocks} live={tail} evidence={evidence} />;
      const block = segment.block;
      if (block.type === "text") return <TextBlock key={block.id} text={block.text} live={block.live} />;
      if (block.type === "tools") return <ToolGroup key={block.id} calls={block.calls} live={tail} />;
      const status = guidanceLabel(block.status);
      return <div key={block.id} className="inline-guidance">
        <span className="inline-guidance-label">你补充了要求</span>
        <span className="inline-guidance-text">{guidanceText(block.text)}</span>
        {status && <Badge tone={block.status === "processed" ? "success" : "accent"}>{status}</Badge>}
      </div>;
    })}
    {turn.live && !turn.blocks.length && <p className="turn-waiting"><Spinner size={13} />正在等待模型响应…</p>}
  </>;
}

function turnSummary(turn: Turn): string {
  const text = turn.blocks.findLast(block => block.type === "text");
  if (text?.type === "text") return text.text.replace(/[#*`>\-\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return turn.toolCount ? `${turn.toolCount} 次工具调用` : "";
}

const AgentTurn = memo(function AgentTurn({ turn, defaultOpen, evidence }: { turn: Turn; defaultOpen: boolean; evidence: EvidenceItem[] }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (turn.live) setOpen(true); }, [turn.live]);
  const outcome = turn.outcome ? phaseInfo(turn.outcome) : null;
  const duration = formatDuration(new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime());
  const status = turn.live
    ? <Badge tone="accent"><Spinner size={12} />进行中</Badge>
    : outcome && <Badge tone={outcome.tone}>{outcome.label}</Badge>;

  if (!turn.modelRun) {
    return <article className="system-turn" data-live={turn.live || undefined}>
      <header className="system-turn-header">
        {turn.kind === "publish" ? <RotateCw size={14} aria-hidden /> : <Globe size={14} aria-hidden />}
        <span className="system-turn-title">{KIND_LABEL[turn.kind]}</span>
        <time dateTime={turn.startedAt}>{formatTime(turn.startedAt)}</time>
        {status}
      </header>
      <div className="system-turn-body"><TurnBody turn={turn} evidence={evidence} /></div>
      {turn.review && turn.review.paths.length > 0 && <ReviewLink review={turn.review} />}
    </article>;
  }

  const summary = turnSummary(turn);
  return <article className="agent-turn" data-live={turn.live || undefined}>
    <header className="agent-turn-header">
      <span className="agent-avatar" aria-hidden>α</span>
      <button className="agent-turn-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="agent-turn-title">第 {turn.index} 轮 · {KIND_LABEL[turn.kind]}</span>
        <span className="agent-turn-meta">
          {formatTime(turn.startedAt)}{duration && !turn.live ? ` · ${duration}` : ""}{turn.toolCount ? ` · ${turn.toolCount} 次工具调用` : ""}{turn.models.length ? ` · ${turn.models.map(shortModel).join("、")}` : ""}
        </span>
        <ChevronDown size={14} className="agent-turn-chevron" aria-hidden />
      </button>
      {status}
    </header>
    {open
      ? <div className="agent-turn-body"><TurnBody turn={turn} evidence={evidence} /></div>
      : summary && <p className="agent-turn-summary" onClick={() => setOpen(true)}>{summary}</p>}
    {turn.review && <ReviewLink review={turn.review} />}
  </article>;
});

export function Timeline({ items, task }: { items: TimelineItem[]; task: TaskView }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);
  const lastTop = useRef(0);
  const turnCount = items.filter(item => item.type === "turn").length;

  const stick = (value: boolean) => {
    stuckRef.current = value;
    setStuck(value);
  };

  useEffect(() => stick(true), [task.id]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stuckRef.current) element.scrollTop = element.scrollHeight;
  }, [items, task.id]);

  // Content can still grow after a render (expanded groups, late layout); stay pinned while following.
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => { if (stuckRef.current) element.scrollTop = element.scrollHeight; });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Only the reader scrolling up stops following; growth below the viewport never does.
  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (atBottom && !stuckRef.current) stick(true);
    else if (!atBottom && stuckRef.current && element.scrollTop < lastTop.current - 4) stick(false);
    lastTop.current = element.scrollTop;
  };

  const jump = () => {
    const element = scrollRef.current;
    if (!element) return;
    stuckRef.current = true;
    setStuck(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  return <div className="timeline-shell">
    <div className="timeline-scroll" ref={scrollRef} onScroll={onScroll} data-testid="timeline">
      <div className="timeline" ref={contentRef}>
        {items.map(item => {
          switch (item.type) {
            case "objective":
              return <UserMessage key={item.id} label={item.version === 1 ? "目标" : `修订目标 · v${item.version}`} text={item.text} at={item.at} />;
            case "guidance":
              return <UserMessage key={item.id} label="补充要求" text={guidanceText(item.text)} at={item.at} status={item.status} />;
            case "review":
              return <div key={item.id} className="system-turn">
                <header className="system-turn-header"><FileDiff size={14} aria-hidden /><span className="system-turn-title">源码快照</span><time dateTime={item.at}>{formatDateTime(item.at)}</time></header>
                <ReviewLink review={item.review} />
              </div>;
            case "legacy":
              return <p key={item.id} className="timeline-note">这个任务创建于过程记录功能之前，没有逐轮过程；验收证据和源码快照仍然可以查看。</p>;
            case "turn":
              return <AgentTurn key={item.id} turn={item} defaultOpen={item.live || item.index > turnCount - 2} evidence={task.evidence} />;
          }
        })}
      </div>
    </div>
    {!stuck && <button className="jump-latest" onClick={jump}><ArrowDown size={14} aria-hidden />最新进展</button>}
  </div>;
}
