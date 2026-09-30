/**
 * 对话流与顶栏（方案 8.2）：
 * - 工具调用 = 可折叠行（工具名、参数摘要、成功/失败、耗时），由消息流 toolCall/toolResult 组装；
 * - 产物 = 卡片（C5：缩略图/前后对比、打开、在文件夹中显示）；alpha_office 与媒体工具把预览 PNG
 *   以 ImageContent 附在工具结果里，卡片按顺序映射到 preview/before；
 * - `alpha-tianshu` 自定义消息以天枢样式显示（专属竖条 + ▌ 行），与普通消息区分；
 * - 自动压缩/自动重试各一行说明；`setWidget` 字符串行显示在输入框上方；
 * - 顶栏显示天枢状态段（SSE 转发的 setStatus，statusKey="tianshu"）。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, CircleStop, FileText, RotateCcw, Terminal } from "lucide-react";
import { NativeTerminal } from "./NativeTerminal";
import {
  argsSummary, contentImages, plain, toolPayload,
  type NativeMessage, type SessionItem, type ToolPayload,
} from "./native-api";
import type { PendingCall, SessionController } from "./useSession";
import "./Thread.css";

/** 新元素（缩略图/画面）自适应样式：现有样式表没有对应图片规则，其余全部复用现有类。 */
const THUMB_STYLE: CSSProperties = { width: "100%", height: "auto", border: "1px solid var(--border)", background: "white" };

type ToolItem = {
  kind: "tool";
  key: string;
  toolName: string;
  args: string;
  ok: boolean;
  running: boolean;
  durationMs: number | null;
  resultText: string;
  images: string[];
  payload: ToolPayload | null;
};

type ThreadItem =
  | { kind: "user" | "assistant"; key: string; text: string; images: string[] }
  | ToolItem
  | { kind: "tianshu"; key: string; lines: string[]; timeline: string[] }
  | { kind: "note"; key: string; text: string };

/** 消息流 + 进行中的工具调用 + 计时 → 对话条目。 */
function buildItems(messages: NativeMessage[], pending: PendingCall[], timing: Record<string, number>, liveNotes: Array<{ id: string; text: string }>): ThreadItem[] {
  const items: ThreadItem[] = [];
  const settledCalls = new Set<string>();
  for (const message of messages) {
    const key = `${message.role}:${message.timestamp ?? items.length}`;
    if (message.role === "user") {
      items.push({ kind: "user", key, text: plain(message), images: contentImages(message).map(image => image.dataUrl) });
      continue;
    }
    if (message.role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = parts.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      const recovery = message.retryRecovery;
      if (recovery) {
        items.push({
          kind: "note", key: `${key}:retry`,
          text: `自动重试${typeof recovery.attempt === "number" ? `（第 ${recovery.attempt} 次）` : ""}${recovery.status ? ` · ${recovery.status}` : ""}${recovery.note ? ` · ${recovery.note}` : ""}`,
        });
      }
      if (text.trim()) items.push({ kind: "assistant", key, text, images: contentImages(message).map(image => image.dataUrl) });
      for (const part of parts.filter(candidate => candidate.type === "toolCall")) {
        const callId = part.id ?? `${key}:${part.name}:${items.length}`;
        settledCalls.add(callId);
        const result = messages.find(message => message.role === "toolResult" && message.toolCallId === callId);
        items.push({
          kind: "tool", key: `tool:${callId}`, toolName: part.name ?? "工具", args: argsSummary(part.arguments),
          ok: result ? !result.isError : true, running: !result,
          durationMs: timing[callId] ?? (result?.timestamp && message.timestamp ? result.timestamp - message.timestamp : null),
          resultText: result ? plain(result) : "", images: result ? contentImages(result).map(image => image.dataUrl) : [],
          payload: result ? toolPayload(result) : null,
        });
      }
      continue;
    }
    if (message.role === "toolResult") {
      const callId = message.toolCallId ?? key;
      if (settledCalls.has(callId)) continue;
      settledCalls.add(callId);
      items.push({
        kind: "tool", key: `tool:${callId}`, toolName: message.toolName ?? "工具", args: "",
        ok: !message.isError, running: false,
        durationMs: timing[callId] ?? null, resultText: plain(message),
        images: contentImages(message).map(image => image.dataUrl), payload: toolPayload(message),
      });
      continue;
    }
    if (message.role === "custom") {
      if (message.customType === "alpha-tianshu") {
        const details = message.details as { timeline?: unknown } | null;
        items.push({
          kind: "tianshu", key,
          lines: plain(message).split("\n").filter(line => line.trim()),
          timeline: Array.isArray(details?.timeline) ? details.timeline.map(String) : [],
        });
      } else if (message.display !== false && plain(message).trim()) {
        items.push({ kind: "note", key, text: `${message.customType ?? "扩展"}：${plain(message).split("\n")[0] ?? ""}` });
      }
      continue;
    }
    if (message.role === "compactionSummary") {
      const before = typeof message.tokensBefore === "number" ? `（压缩前约 ${message.tokensBefore} tokens）` : "";
      items.push({ kind: "note", key, text: `自动压缩上下文${before} · ${message.shortSummary ?? message.summary ?? ""}` });
      continue;
    }
    if (message.role === "branchSummary") items.push({ kind: "note", key, text: "已切换到另一条会话分支。" });
  }
  for (const call of pending) {
    if (settledCalls.has(call.toolCallId)) continue;
    items.push({ kind: "tool", key: `tool:${call.toolCallId}`, toolName: call.toolName, args: argsSummary(call.args), ok: true, running: true, durationMs: null, resultText: "", images: [], payload: null });
  }
  for (const note of liveNotes) items.push({ kind: "note", key: `live:${note.id}`, text: note.text });
  return items;
}

function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** “打开 / 在文件夹中显示”走桌面桥（openPath 语义）；失败原因原样显示，不虚构结果。 */
async function openOnDesktop(path: string, setError: (value: string) => void): Promise<void> {
  if (!window.alpha?.openFolder) { setError("桌面端才能打开本机文件"); return; }
  const error = await window.alpha.openFolder(path);
  if (error) setError(error);
}

async function revealOnDesktop(path: string, setError: (value: string) => void): Promise<void> {
  if (window.alpha?.revealItem) {
    const error = await window.alpha.revealItem(path);
    if (error) setError(error);
    return;
  }
  await openOnDesktop(parentDir(path), setError);
}

/** 产物路径是项目相对路径；按会话项目目录拼成绝对路径再交给桌面桥。 */
export function absoluteArtifactPath(path: string, cwd: string | undefined): string {
  if (!cwd || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, "")}${path.startsWith("/") ? "" : "\\"}${path.replace(/^[\\/]+/, "")}`;
}

/** C5 产物卡片：缩略图（edit 带前后对比）、打开、在文件夹中显示。 */
function ArtifactCard({ payload, images, setError, cwd }: { payload: ToolPayload; images: string[]; setError(value: string): void; cwd?: string }) {
  let cursor = 0;
  const rows = payload.artifacts?.map(artifact => {
    if (artifact.before) return { artifact, after: images[cursor++] ?? null, before: images[cursor++] ?? null };
    if (artifact.preview || artifact.kind === "png") return { artifact, after: images[cursor++] ?? null, before: null };
    return { artifact, after: null, before: null };
  }) ?? [];
  return <section className="task-results" aria-label="产物">
    {payload.summary && <h2>{payload.summary}</h2>}
    {rows.map(({ artifact, after, before }) => <div className="task-result" key={artifact.path}>
      <div className="task-result-file">
        <strong>{artifact.path.split(/[\\/]/).at(-1) ?? artifact.path}</strong>
        <a onClick={() => void openOnDesktop(absoluteArtifactPath(artifact.path, cwd), setError)}>打开</a>
        <a onClick={() => void revealOnDesktop(absoluteArtifactPath(artifact.path, cwd), setError)}>在文件夹中显示</a>
      </div>
      <p className="native-muted">{artifact.kind} · {artifact.path} · sha256 {artifact.sha256.slice(0, 12)}…</p>
      {before && after && <details open><summary>前后对比</summary><div className="office-preview-grid">
        <div className="office-pdf-preview"><strong>修改前</strong><img alt="修改前预览" src={before} style={THUMB_STYLE} /></div>
        <div className="office-pdf-preview"><strong>修改后</strong><img alt="修改后预览" src={after} style={THUMB_STYLE} /></div>
      </div></details>}
      {!before && after && <details><summary>页面预览</summary><img alt="页面预览" src={after} style={THUMB_STYLE} /></details>}
    </div>)}
    {!!payload.unsupported?.length && <p className="native-muted">未支持结构：{payload.unsupported.join("、")}</p>}
  </section>;
}

function ToolRow({ item, setError, cwd }: { item: ToolItem; setError(value: string): void; cwd?: string }) {
  return <article className="native-message">
    <details className="native-tool-call">
      <summary>
        <strong>{item.toolName}</strong>
        {item.args && <span> · {item.args}</span>}
        <span> · {item.running ? "运行中" : item.ok ? "成功" : "失败"}</span>
        {item.durationMs !== null && <span> · {item.durationMs >= 1000 ? `${(item.durationMs / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(item.durationMs))}ms`}</span>}
      </summary>
      {item.resultText && <pre>{item.resultText}</pre>}
      {item.images.map(src => <img alt="工具结果附图" key={src} src={src} style={THUMB_STYLE} />)}
    </details>
    {item.payload && <ArtifactCard payload={item.payload} images={item.images} setError={setError} cwd={cwd} />}
  </article>;
}

/** 天枢样式：专属竖条（native-message toolResult 的左边线）+ ▌ 行，与普通消息区分。 */
function TianshuMessage({ item }: { item: Extract<ThreadItem, { kind: "tianshu" }> }) {
  const [expanded, setExpanded] = useState(false);
  const lines = [...item.lines, ...(expanded ? item.timeline.map(entry => `  ${entry}`) : [])];
  return <article className="native-message toolResult">
    <div className="native-role">天枢</div>
    <div className="native-markdown">{lines.map((line, index) => <p key={index}>▌ {line.replace(/^▌\s*/, "")}</p>)}</div>
    {!!item.timeline.length && <button onClick={() => setExpanded(open => !open)}>{expanded ? "收起证据" : "展开证据"}</button>}
  </article>;
}

function ThreadBody({ items, setError, cwd }: { items: ThreadItem[]; setError(value: string): void; cwd?: string }) {
  return <div className="native-thread">
    {items.length ? items.map(item => {
      if (item.kind === "tool") return <ToolRow key={item.key} item={item} setError={setError} cwd={cwd} />;
      if (item.kind === "tianshu") return <TianshuMessage key={item.key} item={item} />;
      if (item.kind === "note") return <p className="native-log" key={item.key}>{item.text}</p>;
      return <article key={item.key} className={`native-message ${item.kind}`}>
        <div className="native-role">{item.kind === "user" ? "你" : "Alpha"}</div>
        <div className="native-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          {item.images.map(src => <img alt="消息附图" key={src} src={src} style={THUMB_STYLE} />)}
        </div>
      </article>;
    }) : <div className="native-welcome"><div className="native-glyph">α</div><h1>从这里开始</h1><p>告诉 Alpha 你想完成什么。</p></div>}
  </div>;
}

function Composer({ session, onOpenSettings }: { session: SessionController; onOpenSettings(): void }) {
  const [drafts] = useState(() => new Map<string, string>());
  const [draft, setDraft] = useState("");
  const [image, setImage] = useState<{ data: string; mimeType: string; name: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(drafts.get(session.selected ?? "") ?? ""); setImage(null); }, [session.selected, drafts]);
  useEffect(() => {
    if (!session.queuedDraft) return;
    setDraft(session.queuedDraft);
    session.consumeDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumeDraft 每次渲染都是新引用；只随草稿值触发。
  }, [session.queuedDraft]);
  const state = session.state;
  const placeholder = state?.isStreaming ? "补充要求，将实时送给正在工作的 Alpha…" : "向 Alpha 说明你的任务…";
  const send = async () => {
    if (await session.send(draft, image ?? undefined)) {
      setDraft("");
      setImage(null);
      drafts.delete(session.selected ?? "");
    }
  };
  const attach = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 4_000_000) { session.setError("请选择不超过 4 MB 的图片。"); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    setImage({ data: dataUrl.split(",")[1] ?? "", mimeType: file.type, name: file.name });
  };
  return <div className="native-compose">
    {session.widgets.map(block => block.lines.map((line, index) => <div className="native-tool-call" key={`${block.key}:${index}`}>{line}</div>))}
    <div className="native-compose-tools">
      <label title="添加图片"><FileText size={16} /><input type="file" accept="image/*" onChange={event => void attach(event.target.files?.[0])} /></label>
      {image && <span>{image.name} <button onClick={() => setImage(null)}>×</button></span>}
      <select title="模型" value={state?.model ? `${state.model.provider}/${state.model.id}` : ""} onChange={event => {
        const [provider, ...rest] = event.target.value.split("/");
        void session.command({ type: "set_model", provider, modelId: rest.join("/") });
      }}>
        <option value="">选择模型</option>
        {session.models.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? model.id} · {model.provider}</option>)}
      </select>
      <select aria-label="当前会话思考强度" value={state?.thinkingLevel ?? "off"} onChange={event => void session.command({ type: "set_thinking_level", level: event.target.value })}>
        {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => <option key={level}>{level}</option>)}
      </select>
      <button onClick={onOpenSettings}>模型设置</button>
      <button onClick={() => void session.command({ type: "compact" })} title="压缩上下文">压缩上下文</button>
    </div>
    <textarea ref={input} value={draft} aria-label={placeholder}
      onChange={event => { setDraft(event.target.value); drafts.set(session.selected ?? "", event.target.value); }}
      onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
      placeholder={placeholder} />
    <div className="native-compose-bottom">
      <span>{state?.model ? `${state.model.provider}/${state.model.id}` : "跟随全局默认模型"}</span>
      <button disabled={!draft.trim()} onClick={() => void send()} aria-label="发送"><ArrowUp size={17} /></button>
    </div>
  </div>;
}

/** 会话视图：顶栏（天枢状态段）+ 进程提示 + 对话流 + 输入框（setWidget 行在输入框上方）。 */
export function NativeThread({ session, sessionInfo, onOpenSettings }: { session: SessionController; sessionInfo: SessionItem; onOpenSettings(): void }) {
  const end = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => buildItems(session.messages, session.pendingCalls, session.toolTiming, session.liveNotes),
    [session.messages, session.pendingCalls, session.toolTiming, session.liveNotes],
  );
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [items.length, sessionInfo.id]);
  const state = session.state;
  return <>
    <header className="native-header">
      <div><strong>{sessionInfo.title}</strong><small>{sessionInfo.cwd}</small></div>
      <div className="native-header-actions">
        {session.tianshuStatus && <span className="native-status" title="天枢状态（与终端页脚一致）">{session.tianshuStatus}</span>}
        <span className={`native-status ${state?.isStreaming ? "running" : ""}`}>{state?.isStreaming ? "运行中" : state?.hasPendingAsyncWork ? "后台任务" : state?.isSettled ? "本轮结束" : "就绪"}</span>
        <button title="刷新" onClick={() => session.refresh()}><RotateCcw size={16} /></button>
        {session.terminalActive
          ? <button title="关闭 Alpha 终端" onClick={() => void session.terminal("stop")}><CircleStop size={17} /></button>
          : <button title="Alpha 终端" disabled={!state?.isSettled || state?.hasPendingAsyncWork} onClick={() => void session.terminal("start")}><Terminal size={17} /></button>}
        {state?.isStreaming && <button title="停止" onClick={() => void session.command({ type: "abort" })}><CircleStop size={17} /></button>}
      </div>
    </header>
    {session.hostNotice && <div className="native-update-banner" role="status">
      <strong>会话进程未运行</strong>
      <span>{session.hostNotice}</span>
      <button onClick={() => session.reopen()}>重新打开会话</button>
    </div>}
    {session.terminalActive
      ? <NativeTerminal id={sessionInfo.id} output={session.terminalOutput} />
      : <>
        <ThreadBody items={items} setError={session.setError} cwd={session.current?.cwd} />
        <Composer session={session} onOpenSettings={onOpenSettings} />
      </>}
  </>;
}
