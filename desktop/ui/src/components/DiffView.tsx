import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, TextWrap } from "lucide-react";
import { api } from "../api/client";
import type { ReviewDetail } from "../api/types";
import { fileDiff, type FileDiff } from "../state/diff";
import { formatDateTime } from "../state/labels";
import { Button, IconButton, Spinner } from "./ui";
import "./DetailView.css";

const reviews = new Map<string, ReviewDetail>();
const STATUS = { added: "新增", deleted: "删除", modified: "修改" } as const;

function FileSection({ file, wrap }: { file: FileDiff; wrap: boolean }) {
  const [open, setOpen] = useState(true);
  return <section className="diff-file" id={`diff-${file.path}`}>
    <button className="diff-file-header" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronDown size={14} className="diff-chevron" aria-hidden />
      <span className={`diff-status ${file.status}`}>{STATUS[file.status]}</span>
      <code className="diff-path">{file.path}</code>
      <span className="diff-counts"><span className="add">+{file.additions}</span><span className="del">−{file.deletions}</span></span>
    </button>
    {open && (file.hunks.length
      ? <div className="diff-table-wrap">
        <table className={`diff-table ${wrap ? "wrap" : ""}`}>
          <tbody>
            {file.hunks.map((hunk, index) => [
              <tr key={`h${index}`} className="diff-hunk"><td colSpan={3}>{hunk.header}</td></tr>,
              ...hunk.lines.map((line, row) => <tr key={`${index}-${row}`} className={`diff-line ${line.kind}`}>
                <td className="diff-ln">{line.oldNo ?? ""}</td>
                <td className="diff-ln">{line.newNo ?? ""}</td>
                <td className="diff-code"><span className="diff-marker">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>{line.text}</td>
              </tr>),
            ])}
          </tbody>
        </table>
        {file.truncated && <p className="detail-note">文件过长，只显示了前 4000 行差异。</p>}
      </div>
      : <p className="detail-note">没有可显示的文本差异。</p>)}
  </section>;
}

export function DiffView({ taskId, operationId, onBack }: { taskId: string; operationId: string; onBack(): void }) {
  const key = `${taskId}:${operationId}`;
  const [review, setReview] = useState<ReviewDetail | null>(() => reviews.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cached = reviews.get(key);
    if (cached) { setReview(cached); return; }
    let current = true;
    setReview(null);
    setError(null);
    api.review(taskId, operationId).then(result => {
      reviews.set(key, result);
      if (current) setReview(result);
    }).catch((reason: Error) => { if (current) setError(reason.message); });
    return () => { current = false; };
  }, [key, taskId, operationId]);

  const files = useMemo(() => review?.changes.map(fileDiff) ?? [], [review]);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  const jump = (path: string) => {
    const target = body.current?.querySelector(`[id="${CSS.escape(`diff-${path}`)}"]`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return <div className="detail-view" data-testid="diff-view">
    <header className="detail-header">
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>返回对话</Button>
      <h2>源码改动</h2>
      {review && <span className="detail-meta">
        {formatDateTime(review.recordedAt)} · 目标 v{review.contractVersion} · {files.length} 个文件
        <span className="diff-counts"><span className="add">+{additions}</span><span className="del">−{deletions}</span></span>
      </span>}
      <IconButton icon={TextWrap} label={wrap ? "关闭自动换行" : "自动换行"} className={wrap ? "active" : undefined} onClick={() => setWrap(value => !value)} />
    </header>
    {files.length > 1 && <nav className="diff-files" aria-label="改动的文件">
      {files.map(file => <button key={file.path} onClick={() => jump(file.path)} title={file.path}>
        <span className={`diff-status-dot ${file.status}`} aria-hidden />{file.path}
      </button>)}
    </nav>}
    <div className="detail-body" ref={body}>
      {error ? <p className="detail-empty">{error}</p>
        : !review ? <p className="detail-loading"><Spinner size={14} />正在读取源码快照…</p>
          : !files.length ? <p className="detail-empty">这一轮没有受支持的文本源码改动。</p>
            : files.map(file => <FileSection key={file.path} file={file} wrap={wrap} />)}
    </div>
  </div>;
}
