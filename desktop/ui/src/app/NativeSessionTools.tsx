import { tf, t } from "./ui-language";
import { useEffect, useState } from "react";
import { NativeModal } from "./NativeModal";
import { nativeApi, plain, sessionRequest, type NativeMessage } from "./native-api";
import type { SessionController } from "./useSession";
import { readDraft, writeDraft } from "./workbench-state";
import { desktopStorage } from "./desktop-storage";

type Node = { entry: { id: string; type: string; timestamp: string; message?: NativeMessage }; children: Node[]; label?: string };
type QueueDraft = { id: string; path: string; createdAt: string; text: string; paths: string[]; imageCount: number };
function rows(nodes: Node[], depth = 0): Array<{ node: Node; depth: number }> { return nodes.flatMap(node => [{ node, depth }, ...rows(node.children, depth + 1)]); }

export function NativeSessionTools({ session, initial, onClose }: { session: SessionController; initial: "history" | "progress"; onClose(): void }) {
  const [tab, setTab] = useState(initial);
  const [tree, setTree] = useState<{ tree: Node[]; leafId: string } | null>(null);
  const [queues, setQueues] = useState<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
  const [agents, setAgents] = useState<Array<Record<string, unknown>>>([]);
  const [queueDrafts, setQueueDrafts] = useState<QueueDraft[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState(session.current?.tags?.join(", ") ?? "");
  const [transcript, setTranscript] = useState<{ data: { messages: NativeMessage[] } } | null>(null);
  const [labelNode, setLabelNode] = useState<string | null>(null);
  const [labelText, setLabelText] = useState("");
  const id = session.selected!;
  const refresh = async () => {
    const values = await Promise.allSettled([
      sessionRequest<{ data: { tree: Node[]; leafId: string } }>(id, "command", { type: "get_tree" }),
      sessionRequest<typeof queues>(id, "host/session", { action: "queues" }),
      sessionRequest<{ data: { subagents: typeof agents } }>(id, "command", { type: "get_subagents" }),
      sessionRequest<QueueDraft[]>(id, "host/session", { action: "queue-drafts" }),
      sessionRequest<typeof agents>(id, "host/session", { action: "subagent-history" }),
    ]);
    if (values[0].status === "fulfilled") setTree(values[0].value.data);
    else setError(String(values[0].reason));
    if (values[1].status === "fulfilled") setQueues(values[1].value);
    else setError(String(values[1].reason));
    if (values[2].status === "fulfilled") {
      const active = values[2].value.data.subagents;
      const history: typeof agents = values[4].status === "fulfilled" ? values[4].value.map(row => ({ ...row, status: row.status === "started" ? "interrupted" : row.status })) : [];
      setAgents([...new Map([...history, ...active].map(row => [row.id, row])).values()]);
    } else setError(String(values[2].reason));
    if (values[3].status === "fulfilled") setQueueDrafts(values[3].value); else setError(String(values[3].reason));
  };
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); const timer = setInterval(() => void refresh().catch(() => undefined), 2000); return () => clearInterval(timer); }, [id]);
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation(); session.refresh(); await session.reloadList(); await refresh(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  const restoreDraft = (text: string, images?: Array<{ data: string; mimeType: string }>) => {
    const draft = readDraft(id, desktopStorage);
    const combined = [...(draft.images ?? (draft.image ? [draft.image] : [])), ...(images ?? [])];
    if (combined.length > 8 || combined.reduce((size, image) => size + image.data.length, 0) > 6_000_000) throw new Error("请先发送或保存当前图片草稿，再从历史中取回材料。原始材料仍在原生会话记录中。");
    if (!writeDraft(id, { ...draft, text: [draft.text, text].filter(Boolean).join("\n"), image: undefined, images: [...(draft.images ?? (draft.image ? [draft.image] : [])), ...(images ?? []).map((image, index) => ({ ...image, name: tf`历史附件 ${index + 1}` }))] }, desktopStorage)) throw new Error("草稿已取回，但磁盘保存失败，请在关闭窗口前发送或复制。");
  };
  return <NativeModal title={tab === "history" ? t("会话树") : t("任务进度")} onCancel={onClose}>
    <nav className="native-plan-actions"><button onClick={() => setTab("history")}>{t("历史与分支")}</button><button onClick={() => setTab("progress")}>{t("Todo / 子任务 / 队列")}</button><button onClick={() => void refresh()}>{t("刷新")}</button><button onClick={onClose}>{t("关闭")}</button></nav>
    {error && <p role="alert">{t(error)}</p>}
    {labelNode && <form onSubmit={event => { event.preventDefault(); void run(async () => { await sessionRequest(id, "host/session", { action: "label", entryId: labelNode, label: labelText }); setLabelNode(null); }); }}><label>{t("历史节点标签")}<input autoFocus aria-label={t("历史节点标签")} value={labelText} onChange={event => setLabelText(event.target.value)} /></label><button disabled={busy}>{t("保存标签")}</button><button type="button" onClick={() => setLabelNode(null)}>{t("取消")}</button></form>}
    {tab === "history" ? <><label>{t("会话标签")}<input aria-label={t("会话标签")} value={tags} onChange={event => setTags(event.target.value)} /><button disabled={busy} onClick={() => void run(() => nativeApi(`sessions/${id}`, { tags: tags.split(/[,，]/).map(value => value.trim()).filter(Boolean) }))}>{t("保存标签")}</button></label>
      <input aria-label={t("搜索历史")} placeholder={t("搜索当前会话树…")} value={filter} onChange={event => setFilter(event.target.value)} />
      <div className="native-history-list">{rows(tree?.tree ?? []).filter(({ node }) => `${node.label ?? ""} ${node.entry.message ? plain(node.entry.message) : node.entry.type}`.toLowerCase().includes(filter.toLowerCase())).map(({ node, depth }) => {
        const entry = node.entry, message = entry.message;
        return <div key={entry.id} className="native-history-row" style={{ paddingLeft: `${Math.min(depth, 8) * 10}px` }}><button disabled={busy || !session.state?.isSettled} aria-current={entry.id === tree?.leafId ? "step" : undefined} onClick={() => void run(async () => {
          const result = await sessionRequest<{ editorText?: string; editorImages?: Array<{ data: string; mimeType: string }>; cancelled?: boolean }>(id, "host/navigate", { entryId: entry.id }); if (!result.cancelled && (result.editorText || result.editorImages?.length)) restoreDraft(result.editorText ?? "", result.editorImages);
        })}>{entry.id === tree?.leafId ? "● " : ""}{node.label ?? `${message?.role ?? entry.type} · ${message ? plain(message).slice(0, 100) : entry.timestamp}`}</button>
          {message?.role === "user" && <button disabled={busy || !session.state?.isSettled} onClick={() => void run(async () => {
            const result = await sessionRequest<{ selectedText: string; selectedImages: Array<{ data: string; mimeType: string }>; cancelled: boolean }>(id, "host/session", { action: "branch", entryId: entry.id }); if (!result.cancelled) restoreDraft(result.selectedText, result.selectedImages);
          })}>{t("从此分支")}</button>}
          <button disabled={busy} onClick={() => { setLabelNode(entry.id); setLabelText(node.label ?? ""); }}>{t("标签")}</button>
        </div>;
      })}</div></> : <>
      <h3>Todo</h3>{session.state?.todoPhases?.length ? session.state.todoPhases.map((phase, index) => <section key={index}><strong>{phase.name}</strong>{phase.tasks.map((task, position) => <p key={position}>{task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : "○"} {task.content}</p>)}</section>) : <p className="native-muted">{t("当前会话没有 Todo。")}</p>}
      <h3>{t("子任务")}</h3>{agents.length ? agents.map((agent, index) => <div key={index}><strong>{String(agent.agent ?? agent.id ?? "子任务")}</strong> · {String(agent.status ?? "")}<p>{String(agent.description ?? agent.task ?? "")}</p><button onClick={() => void run(async () => { const data = await sessionRequest<{ messages: NativeMessage[] }>(id, "host/session", { action: "subagent-transcript", subagentId: agent.id }); setTranscript({ data }); })}>{t("查看记录")}</button></div>) : <p className="native-muted">{t("没有运行中的子任务。")}</p>}
      <h3>{t("消息队列 ·")} {session.state?.queuedMessageCount ?? 0}</h3>{queues.steering.map((text, index) => <p key={`s${index}`}>{t("中途补充：")}{text}</p>)}{queues.followUp.map((text, index) => <p key={`f${index}`}>{t("下一轮：")}{text}</p>)}
      <button disabled={busy || !queues.steering.length && !queues.followUp.length} onClick={() => void run(async () => {
        const value = await sessionRequest<{ empty?: boolean; text: string; paths: string[]; savedPaths: string[]; images?: Array<{ data: string; mimeType: string }>; error?: string; checkpoint?: string }>(id, "host/session", { action: "pop-queue" });
        if (value.empty) throw new Error("消息已进入执行，当前没有可取回的队列材料。");
        if (value.error) throw new Error(`${value.error}\n${t("原生队列备份：")}${value.checkpoint}`);
        const draft = readDraft(id, desktopStorage), currentImages = draft.images ?? (draft.image ? [draft.image] : []), combined = [...currentImages, ...(value.images ?? []).map((image, index) => ({ ...image, name: tf`队列附件 ${index + 1}` }))];
        const inline = combined.length <= 8 && combined.reduce((size, image) => size + image.data.length, 0) <= 6_000_000;
        if (!writeDraft(id, { ...draft, image: undefined, text: [draft.text, value.text].filter(Boolean).join("\n\n"), paths: [...new Set([...draft.paths, ...(inline ? value.paths : value.savedPaths)])], images: inline ? combined : currentImages }, desktopStorage)) throw new Error("草稿磁盘保存失败。完整队列材料已保存在下方本机备份中。");
      })}>{t("取回最后一条到草稿")}</button>
      {queueDrafts.length > 0 && <details><summary>{t("取回材料的本机备份")}</summary>{queueDrafts.map(row => <div key={row.id}><p>{row.createdAt} · {row.imageCount} {t("张图片")}</p><p>{row.text.slice(0, 200)}</p><button onClick={() => void run(async () => { const draft = readDraft(id, desktopStorage); if (!writeDraft(id, { ...draft, text: [draft.text, row.text].filter(Boolean).join("\n\n"), paths: [...new Set([...draft.paths, ...row.paths])] }, desktopStorage)) throw new Error("草稿磁盘保存失败。完整队列材料已保存在下方本机备份中。"); })}>{t("恢复文本与本机图片引用")}</button><button onClick={() => void window.alpha?.revealItem?.(row.path).then(error => { if (error) setError(error); }, cause => setError(String(cause)))}>{t("在文件夹中显示")}</button></div>)}</details>}
      {session.uiRequest && <p>{t("待处理请求：")}{session.uiRequest.title ?? session.uiRequest.method}</p>}
      {transcript !== null && <section aria-label={t("子任务会话记录")}>{transcript.data.messages.map((message, index) => <article key={index}><strong>{message.role === "assistant" ? "Alpha" : message.role === "user" ? t("你") : message.toolName ?? message.role}</strong><pre className="native-code-block">{plain(message)}</pre></article>)}<details><summary>{t("原始记录与证据")}</summary><pre className="native-code-block">{JSON.stringify(transcript, null, 2)}</pre></details></section>}
    </>}
  </NativeModal>;
}
