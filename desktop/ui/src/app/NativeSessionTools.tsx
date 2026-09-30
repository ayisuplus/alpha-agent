import { useEffect, useState } from "react";
import { NativeModal } from "./NativeModal";
import { nativeApi, plain, sessionRequest, type NativeMessage } from "./native-api";
import type { SessionController } from "./useSession";
import { readDraft, writeDraft } from "./workbench-state";
import { desktopStorage } from "./desktop-storage";

type Node = { entry: { id: string; type: string; timestamp: string; message?: NativeMessage }; children: Node[]; label?: string };
function rows(nodes: Node[], depth = 0): Array<{ node: Node; depth: number }> { return nodes.flatMap(node => [{ node, depth }, ...rows(node.children, depth + 1)]); }

export function NativeSessionTools({ session, initial, onClose }: { session: SessionController; initial: "history" | "progress"; onClose(): void }) {
  const [tab, setTab] = useState(initial);
  const [tree, setTree] = useState<{ tree: Node[]; leafId: string } | null>(null);
  const [queues, setQueues] = useState<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
  const [agents, setAgents] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState(session.current?.tags?.join(", ") ?? "");
  const [transcript, setTranscript] = useState<unknown>(null);
  const id = session.selected!;
  const refresh = async () => {
    const values = await Promise.allSettled([
      sessionRequest<{ data: { tree: Node[]; leafId: string } }>(id, "command", { type: "get_tree" }),
      sessionRequest<typeof queues>(id, "host/session", { action: "queues" }),
      sessionRequest<{ data: { subagents: typeof agents } }>(id, "command", { type: "get_subagents" }),
    ]);
    if (values[0].status === "fulfilled") setTree(values[0].value.data);
    else setError(String(values[0].reason));
    if (values[1].status === "fulfilled") setQueues(values[1].value);
    else setError(String(values[1].reason));
    if (values[2].status === "fulfilled") setAgents(values[2].value.data.subagents); else setError(String(values[2].reason));
  };
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); const timer = setInterval(() => void refresh().catch(() => undefined), 2000); return () => clearInterval(timer); }, [id]);
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation(); session.refresh(); await session.reloadList(); await refresh(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  const restoreDraft = (text: string, images?: Array<{ data: string; mimeType: string }>) => {
    const draft = readDraft(id, desktopStorage);
    if (!writeDraft(id, { ...draft, text: [draft.text, text].filter(Boolean).join("\n"), image: undefined, images: [...(draft.images ?? (draft.image ? [draft.image] : [])), ...(images ?? []).map((image, index) => ({ ...image, name: `历史附件 ${index + 1}` }))] }, desktopStorage)) throw new Error("草稿已取回，但磁盘保存失败，请在关闭窗口前发送或复制。");
  };
  return <NativeModal title={tab === "history" ? "会话树" : "任务进度"} onCancel={onClose}>
    <nav className="native-plan-actions"><button onClick={() => setTab("history")}>历史与分支</button><button onClick={() => setTab("progress")}>Todo / 子任务 / 队列</button><button onClick={() => void refresh()}>刷新</button><button onClick={onClose}>关闭</button></nav>
    {error && <p role="alert">{error}</p>}
    {tab === "history" ? <><label>会话标签<input aria-label="会话标签" value={tags} onChange={event => setTags(event.target.value)} /><button disabled={busy} onClick={() => void run(() => nativeApi(`sessions/${id}`, { tags: tags.split(/[,，]/).map(value => value.trim()).filter(Boolean) }))}>保存标签</button></label>
      <input aria-label="搜索历史" placeholder="搜索当前会话树…" value={filter} onChange={event => setFilter(event.target.value)} />
      <div className="native-history-list">{rows(tree?.tree ?? []).filter(({ node }) => `${node.label ?? ""} ${node.entry.message ? plain(node.entry.message) : node.entry.type}`.toLowerCase().includes(filter.toLowerCase())).map(({ node, depth }) => {
        const entry = node.entry, message = entry.message;
        return <div key={entry.id} className="native-history-row" style={{ paddingLeft: `${Math.min(depth, 8) * 10}px` }}><button disabled={busy || !session.state?.isSettled} aria-current={entry.id === tree?.leafId ? "step" : undefined} onClick={() => void run(async () => {
          const result = await sessionRequest<{ editorText?: string; editorImages?: Array<{ data: string; mimeType: string }>; cancelled?: boolean }>(id, "host/navigate", { entryId: entry.id }); if (!result.cancelled && (result.editorText || result.editorImages?.length)) restoreDraft(result.editorText ?? "", result.editorImages);
        })}>{entry.id === tree?.leafId ? "● " : ""}{node.label ?? `${message?.role ?? entry.type} · ${message ? plain(message).slice(0, 100) : entry.timestamp}`}</button>
          {message?.role === "user" && <button disabled={busy || !session.state?.isSettled} onClick={() => void run(async () => {
            const result = await sessionRequest<{ selectedText: string; selectedImages: Array<{ data: string; mimeType: string }>; cancelled: boolean }>(id, "host/session", { action: "branch", entryId: entry.id }); if (!result.cancelled) restoreDraft(result.selectedText, result.selectedImages);
          })}>从此分支</button>}
          <button disabled={busy} onClick={() => { const label = window.prompt("历史节点标签", node.label ?? ""); if (label !== null) void run(() => sessionRequest(id, "host/session", { action: "label", entryId: entry.id, label })); }}>标签</button>
        </div>;
      })}</div></> : <>
      <h3>Todo</h3>{session.state?.todoPhases?.length ? session.state.todoPhases.map((phase, index) => <section key={index}><strong>{phase.name}</strong>{phase.tasks.map((task, position) => <p key={position}>{task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : "○"} {task.content}</p>)}</section>) : <p className="native-muted">当前会话没有 Todo。</p>}
      <h3>子任务</h3>{agents.length ? agents.map((agent, index) => <div key={index}><strong>{String(agent.agent ?? agent.id ?? "子任务")}</strong> · {String(agent.status ?? "")}<p>{String(agent.description ?? agent.task ?? "")}</p><button onClick={() => void run(async () => { const result = await sessionRequest(id, "command", { type: "get_subagent_messages", subagentId: agent.id }); setTranscript(result); })}>查看记录</button></div>) : <p className="native-muted">没有运行中的子任务。</p>}
      <h3>消息队列 · {session.state?.queuedMessageCount ?? 0}</h3>{queues.steering.map((text, index) => <p key={`s${index}`}>中途补充：{text}</p>)}{queues.followUp.map((text, index) => <p key={`f${index}`}>下一轮：{text}</p>)}
      <button disabled={busy || !queues.steering.length && !queues.followUp.length} onClick={() => void run(async () => {
        const value = await sessionRequest<{ steering: Array<{ text: string; images?: Array<{ data: string; mimeType: string }> }>; followUp: Array<{ text: string; images?: Array<{ data: string; mimeType: string }> }> }>(id, "host/session", { action: "clear-queue" });
        const all = [...value.steering, ...value.followUp], draft = readDraft(id, desktopStorage);
        if (!writeDraft(id, { ...draft, image: undefined, text: [draft.text, ...all.map(item => item.text)].filter(Boolean).join("\n\n"), images: [...(draft.images ?? (draft.image ? [draft.image] : [])), ...all.flatMap(item => (item.images ?? []).map((image, index) => ({ ...image, name: `队列附件 ${index + 1}` })))] }, desktopStorage)) throw new Error("队列已取回，但草稿未保存到磁盘，请在关闭窗口前发送或复制材料。");
      })}>取回队列到草稿</button>
      {session.uiRequest && <p>待处理请求：{session.uiRequest.title ?? session.uiRequest.method}</p>}
      {transcript !== null && <pre className="native-code-block">{JSON.stringify(transcript, null, 2)}</pre>}
    </>}
  </NativeModal>;
}
