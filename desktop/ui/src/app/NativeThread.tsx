/**
 * 对话流与顶栏（方案 8.2）：
 * - 工具调用 = 可折叠行（工具名、参数摘要、成功/失败、耗时），由消息流 toolCall/toolResult 组装；
 * - 产物 = 卡片（C5：缩略图/前后对比、打开、在文件夹中显示）；alpha_office 与媒体工具把预览 PNG
 *   以 ImageContent 附在工具结果里，卡片按顺序映射到 preview/before；
 * - `alpha-tianshu` 自定义消息显示为折叠的检查建议，原始证据可展开；
 * - 自动压缩/自动重试各一行说明；`setWidget` 字符串行显示在输入框上方；
 * - 顶栏显示运行检查状态（SSE 转发的 setStatus，statusKey="tianshu"）。
 */

import { desktopStorage } from "./desktop-storage";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, Check, Copy, MoreHorizontal, RotateCcw } from "lucide-react";
import {
  contentImages, plain, toolPayload, request,
  type NativeMessage, type NativeModel, type SessionItem, type ToolPayload,
} from "./native-api";
import type { PendingCall, SessionController } from "./useSession";
import { NativeComposer } from "./NativeComposer";
import { NativePlan } from "./NativePlan";
import { invokeDesktopCommand } from "./desktop-commands";
import { atBottom, evidenceLabel, toolLabel, toolTarget, withLiveMessage } from "./workbench-state";
import "./Thread.css";

/** 新元素（缩略图/画面）自适应样式：现有样式表没有对应图片规则，其余全部复用现有类。 */
const THUMB_STYLE: CSSProperties = { width: "100%", height: "auto", border: "1px solid var(--border)", background: "white" };

type ToolItem = {
  kind: "tool";
  key: string;
  toolName: string;
  args: string;
  target: string;
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

/** Only adjacent completed successes collapse together; failures and artifacts remain visible. */
export function groupThreadItems(items: ThreadItem[]): Array<ThreadItem | { kind: "toolGroup"; key: string; tools: ToolItem[] }> {
  const rows: Array<ThreadItem | { kind: "toolGroup"; key: string; tools: ToolItem[] }> = [];
  let successes: ToolItem[] = [];
  const flush = () => {
    if (successes.length > 1) rows.push({ kind: "toolGroup", key: `group:${successes[0].key}`, tools: successes });
    else rows.push(...successes);
    successes = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && item.ok && !item.running) successes.push(item);
    else { flush(); rows.push(item); }
  }
  flush();
  return rows;
}

/** 消息流 + 进行中的工具调用 + 计时 → 对话条目。 */
export function buildItems(messages: NativeMessage[], pending: PendingCall[], timing: Record<string, number>, liveNotes: Array<{ id: string; text: string }>): ThreadItem[] {
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
      const text = plain(message);
      if (message.errorMessage && !(typeof message.errorId === "number" && (message.errorId & 0x02000000))) items.push({ kind: "note", key: `${key}:error`, text: message.stopReason === "aborted" ? "已停止生成" : `执行失败：${message.errorMessage}` });
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
          kind: "tool", key: `tool:${callId}`, toolName: part.name ?? "工具", args: JSON.stringify(part.arguments, null, 2) ?? "", target: toolTarget(part.arguments),
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
        kind: "tool", key: `tool:${callId}`, toolName: message.toolName ?? "工具", args: "", target: "",
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
    items.push({ kind: "tool", key: `tool:${call.toolCallId}`, toolName: call.toolName, args: JSON.stringify(call.args, null, 2) ?? "", target: toolTarget(call.args), ok: true, running: true, durationMs: null, resultText: "", images: [], payload: null });
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
  if (!cwd || path.startsWith("/") || path.startsWith("local://") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, "")}${path.startsWith("/") ? "" : "\\"}${path.replace(/^[\\/]+/, "")}`;
}

/** C5 产物卡片：缩略图（edit 带前后对比）、打开、在文件夹中显示。 */
function ArtifactCard({ payload, images, setError, cwd, onOpenFile }: { payload: ToolPayload; images: string[]; setError(value: string): void; cwd?: string; onOpenFile(path: string): void }) {
  let cursor = 0;
  const rows = payload.artifacts?.map(artifact => {
    if (artifact.before) return { artifact, after: images[cursor++] ?? null, before: images[cursor++] ?? null };
    if (artifact.preview || artifact.kind === "png") return { artifact, after: images[cursor++] ?? null, before: null };
    return { artifact, after: null, before: null };
  }) ?? [];
  return <section className="task-results" aria-label="产物">
    <h2>生成结果</h2>
    {rows.map(({ artifact, after, before }) => <div className="task-result" key={artifact.path}>
      <div className="task-result-file">
        <strong>{artifact.path.split(/[\\/]/).at(-1) ?? artifact.path}</strong>
        <button onClick={() => onOpenFile(absoluteArtifactPath(artifact.path, cwd))}>预览</button>
        {window.alpha?.openFolder && <button onClick={() => void openOnDesktop(absoluteArtifactPath(artifact.path, cwd), setError)}>系统打开</button>}
        {window.alpha && <button onClick={() => void revealOnDesktop(absoluteArtifactPath(artifact.path, cwd), setError)}>在文件夹中显示</button>}
      </div>
      <p className="native-muted">{artifact.kind}</p><details className="native-artifact-details"><summary>文件信息</summary>{payload.summary && <p className="native-muted">{payload.summary}</p>}<p className="native-muted">{artifact.path}<br />sha256 {artifact.sha256}</p></details>
      {before && after && <details open><summary>前后对比</summary><div className="office-preview-grid">
        <div className="office-pdf-preview"><strong>修改前</strong><img alt="修改前预览" src={before} style={THUMB_STYLE} /></div>
        <div className="office-pdf-preview"><strong>修改后</strong><img alt="修改后预览" src={after} style={THUMB_STYLE} /></div>
      </div></details>}
      {!before && after && <details><summary>页面预览</summary><img alt="页面预览" src={after} style={THUMB_STYLE} /></details>}
    </div>)}
    {!!payload.unsupported?.length && <p className="native-muted">未支持结构：{payload.unsupported.join("、")}</p>}
  </section>;
}

function ToolRow({ item, setError, cwd, onOpenFile, showArtifacts = true }: { item: ToolItem; setError(value: string): void; cwd?: string; onOpenFile(path: string): void; showArtifacts?: boolean }) {
  return <article className="native-message">
    <details className={`native-tool-call ${!item.ok ? "failed" : ""}`} open={!item.running && !item.ok}>
      <summary>
        <span className={`native-status-dot ${item.running ? "running" : item.ok ? "success" : "danger"}`} />
        <strong>{toolLabel(item.toolName, item.running, item.ok)}</strong>
        {item.target && <span className="native-tool-target" title={item.target}>{item.target}</span>}
        {item.durationMs !== null && <span> · {item.durationMs >= 1000 ? `${(item.durationMs / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(item.durationMs))}ms`}</span>}
      </summary>
      <p className="native-muted">工具：{item.toolName}</p>
      {item.args && <pre>{item.args}</pre>}
      {item.resultText && <pre>{item.resultText}</pre>}
      {item.images.map(src => <img alt="工具结果附图" key={src} src={src} style={THUMB_STYLE} />)}
    </details>
    {showArtifacts && item.payload && <ArtifactCard payload={item.payload} images={item.images} setError={setError} cwd={cwd} onOpenFile={onOpenFile} />}
  </article>;
}

/** 历史与当前检查建议共用展示规则，原始记录保持可追溯。 */
function TianshuMessage({ item }: { item: Extract<ThreadItem, { kind: "tianshu" }> }) {
  return <article className="native-message native-check">
    <details><summary>检查建议<span>{evidenceLabel(item.lines[0] ?? "查看运行证据")}</span></summary>
      <div className="native-markdown">{item.lines.map((line, index) => <p key={index}>{evidenceLabel(line)}</p>)}</div>
      <details><summary>原始记录与证据</summary><pre>{[...item.lines, ...item.timeline].join("\n")}</pre></details>
    </details>
  </article>;
}

function ThreadBody({ items, setError, cwd, id, settled, loading, onOpenFile }: { items: ThreadItem[]; setError(value: string): void; cwd?: string; id: string; settled: boolean; loading: boolean; onOpenFile(path: string): void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const resumeOnScroll = useRef(false);
  const initialized = useRef(false);
  const [hasNew, setHasNew] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const storageKey = `alpha-scroll:${id}`;
  const save = () => {
    const element = viewport.current;
    if (!element || !initialized.current) return;
    try { desktopStorage.setItem(storageKey, JSON.stringify({ top: element.scrollTop, pinned: pinned.current })); } catch { /* Reading still works when storage is full. */ }
  };
  const jump = () => { pinned.current = true; const element = viewport.current; if (element) element.scrollTop = element.scrollHeight; setHasNew(false); save(); };
  const readingIntent = (up: boolean) => {
    resumeOnScroll.current = !up;
    if (up) { pinned.current = false; setHasNew(true); }
    else if (viewport.current && atBottom(viewport.current.scrollTop, viewport.current.scrollHeight, viewport.current.clientHeight)) { pinned.current = true; setHasNew(false); }
  };
  useLayoutEffect(() => {
    const element = viewport.current!;
    if (!initialized.current && items.length) {
      let saved: { top?: number; pinned?: boolean } = {};
      try { saved = JSON.parse(desktopStorage.getItem(storageKey) ?? "{}") ?? {}; } catch { /* Use the live tail. */ }
      pinned.current = saved.pinned !== false;
      element.scrollTop = pinned.current ? element.scrollHeight : Math.min(typeof saved.top === "number" ? saved.top : 0, Math.max(0, element.scrollHeight - element.clientHeight));
      setHasNew(!pinned.current);
      initialized.current = true;
    } else if (pinned.current) element.scrollTop = element.scrollHeight;
    else setHasNew(true);
  }, [items]);
  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => { if (pinned.current) element.scrollTop = element.scrollHeight; });
    observer.observe(content.current!);
    return () => { save(); observer.disconnect(); };
  }, []);
  const turnStart = items.findLastIndex(item => item.kind === "user");
  const tools = items.slice(turnStart + 1).filter((item): item is ToolItem => item.kind === "tool");
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); }
    catch { setError("无法复制消息，请选择文字后复制。"); }
  };
  return <div className="native-thread-wrap"><div className="native-thread" ref={viewport} tabIndex={0} aria-label="会话记录"
    onWheel={event => { if (event.deltaY) readingIntent(event.deltaY < 0); }}
    onPointerDown={event => { if (event.target === event.currentTarget) resumeOnScroll.current = true; }}
    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (["PageUp", "Home", "ArrowUp"].includes(event.key)) readingIntent(true); else if (["PageDown", "End", "ArrowDown"].includes(event.key)) readingIntent(false); }}
    onScroll={() => {
    const element = viewport.current!;
    if (!atBottom(element.scrollTop, element.scrollHeight, element.clientHeight)) pinned.current = false;
    else if (resumeOnScroll.current) { pinned.current = true; resumeOnScroll.current = false; }
    setHasNew(!pinned.current); save();
  }}><div ref={content}>
    {items.length ? groupThreadItems(items).map(item => {
      if (item.kind === "toolGroup") return <article className="native-message native-tool-group" key={item.key}>
        <details><summary><span className="native-status-dot success" /><strong>已完成 {item.tools.length} 项操作</strong><span>查看过程</span></summary>
          {item.tools.map(tool => <ToolRow key={tool.key} item={tool} setError={setError} cwd={cwd} onOpenFile={onOpenFile} showArtifacts={false} />)}
        </details>
        {item.tools.filter(tool => tool.payload).map(tool => <ArtifactCard key={tool.key} payload={tool.payload!} images={tool.images} setError={setError} cwd={cwd} onOpenFile={onOpenFile} />)}
      </article>;
      if (item.kind === "tool") return <ToolRow key={item.key} item={item} setError={setError} cwd={cwd} onOpenFile={onOpenFile} />;
      if (item.kind === "tianshu") return <TianshuMessage key={item.key} item={item} />;
      if (item.kind === "note") return <p className="native-log" key={item.key}>{item.text}</p>;
      return <article key={item.key} className={`native-message ${item.kind}`}>
        <div className="native-message-heading"><div className="native-role">{item.kind === "user" ? "你" : "Alpha"}</div><button className="native-icon-button" aria-label="复制消息" title="复制消息" onClick={() => void copy(item.key, item.text)}>{copied === item.key ? <Check size={15} /> : <Copy size={15} />}</button></div>
        <div className="native-markdown">
          <ReactMarkdown urlTransform={url => url.startsWith("local://") ? url : defaultUrlTransform(url)} remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => href && (href.startsWith("local://") || !/^[a-z]+:/i.test(href)) && !href.startsWith("//") && !href.startsWith("#")
            ? <button className="native-file-link" onClick={() => { let path = href; try { path = decodeURI(href); } catch { /* A literal percent can be part of a file name. */ } onOpenFile(absoluteArtifactPath(path, cwd)); }}>{children}</button>
            : <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{item.text}</ReactMarkdown>
          {item.images.map(src => <img alt="消息附图" key={src} src={src} style={THUMB_STYLE} />)}
        </div>
      </article>;
    }) : loading ? <div className="native-welcome" role="status"><p>正在读取会话记录…</p></div> : <div className="native-welcome"><span className="native-home-wordmark">Alpha</span><h1>从这里开始</h1><p>告诉 Alpha 你想完成什么。</p></div>}
    {settled && tools.length > 0 && <p className="native-turn-summary">本轮工具执行：{tools.filter(item => !item.running && item.ok).length} 项成功 · {tools.filter(item => !item.running && !item.ok).length} 项失败 · {tools.filter(item => item.running).length} 项待确认</p>}
  </div></div>{hasNew && <button className="native-jump" onClick={jump}><ArrowDown size={15} />回到最新</button>}</div>;
}

/** 会话视图：顶栏 + 进程提示 + 对话流 + 输入框。 */
export function NativeThread({ session, sessionInfo, models, onOpenFile, onOpenSettings, workspaceActions }: { session: SessionController; sessionInfo: SessionItem; models: NativeModel[]; onOpenFile(path: string): void; onOpenSettings(): void; workspaceActions: ReactNode }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(sessionInfo.title);
  useEffect(() => { setName(sessionInfo.title); setRenaming(false); }, [sessionInfo.id]);
  const edit = async (input: Record<string, unknown>) => {
    try { await request(`/api/native/sessions/${sessionInfo.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); await session.reloadList(); setRenaming(false); }
    catch (cause) { session.setError(String(cause)); }
  };
  const items = useMemo(
    () => buildItems(withLiveMessage(session.messages, session.liveMessage), session.pendingCalls, session.toolTiming, session.liveNotes),
    [session.messages, session.liveMessage, session.pendingCalls, session.toolTiming, session.liveNotes],
  );
  const state = session.state;
  const loading = !state && !session.terminalActive && !session.hostNotice;
  return <>
    <header className="native-header">
      <div><strong>{sessionInfo.title}</strong><small title={sessionInfo.cwd}>{sessionInfo.cwd.split(/[\\/]/).filter(Boolean).at(-1)}</small></div>
      <div className="native-header-actions">
        <details className="native-more"><summary aria-label="会话操作" title="会话操作"><MoreHorizontal size={18} /></summary><div onClick={event => event.currentTarget.parentElement?.removeAttribute("open")}>
          <button onClick={() => { setName(sessionInfo.title); setRenaming(value => !value); }}>重命名</button>
          <button onClick={() => void edit({ archived: !sessionInfo.archived })}>{sessionInfo.archived ? "恢复会话" : "归档"}</button>
          <button onClick={() => void invokeDesktopCommand("history")}>历史与分支</button>
          <button onClick={() => void invokeDesktopCommand("progress")}>任务进度与队列</button>
          <button onClick={() => void invokeDesktopCommand("export")}>导出</button>
        </div></details>
        {session.tianshuStatus && <span className="native-tianshu-status" title={evidenceLabel(session.tianshuStatus)}>{evidenceLabel(session.tianshuStatus).replace(/(\d+\.\d+)%/g, (_, percent: string) => `${Number(percent).toFixed(1)}%`)}</span>}
        <span className={`native-status ${state?.isStreaming ? "running" : ""}`}>{session.terminalActive ? "终端运行中" : loading ? "正在打开" : session.hostNotice ? "会话未打开" : session.uiRequest ? "等待输入" : state?.isStreaming ? "运行中" : state?.hasPendingAsyncWork ? "后台任务" : state?.isSettled ? "本轮结束" : "就绪"}</span>
        <button title="刷新" aria-label="刷新会话" onClick={() => session.refresh()}><RotateCcw size={16} /></button>
        {workspaceActions}
      </div>
    </header>
    {!session.terminalActive && <NativePlan key={sessionInfo.id} session={session} />}
    {renaming && <form className="native-compose-tools" onSubmit={event => { event.preventDefault(); void edit({ title: name }); }}><input aria-label="会话名称" value={name} maxLength={120} onChange={event => setName(event.target.value)} /><button disabled={!name.trim()}>保存名称</button><button type="button" onClick={() => setRenaming(false)}>取消</button></form>}
    {session.hostNotice && !session.terminalActive && <div className="native-update-banner" role="status">
      <strong>会话进程未运行</strong>
      <span>{session.hostNotice}</span>
      <button onClick={() => session.reopen()}>重新打开会话</button>
    </div>}
    <ThreadBody key={`thread:${sessionInfo.id}`} id={sessionInfo.id} items={items} setError={session.setError} cwd={session.current?.cwd} settled={!!state?.isSettled} loading={loading} onOpenFile={onOpenFile} />
    {session.terminalActive ? <div className="native-update-banner" role="status"><span>Alpha 终端正在使用这个会话。关闭终端后可继续对话。</span><button onClick={() => void session.terminal("stop")}>关闭终端</button></div>
      : <NativeComposer key={`composer:${sessionInfo.id}`} session={session} models={models} model={state?.model ? `${state.model.provider}/${state.model.id}` : ""} thinking={state?.thinkingLevel ?? "off"}
        onModel={selector => { const [provider, ...rest] = selector.split("/"); void session.command({ type: "set_model", provider, modelId: rest.join("/") }); }}
        onThinking={level => void session.command({ type: "set_thinking_level", level })} onOpenSettings={onOpenSettings} />}
  </>;
}
