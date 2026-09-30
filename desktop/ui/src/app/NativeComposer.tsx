import { useEffect, useRef, useState } from "react";
import { ArrowUp, FolderOpen, MoreHorizontal, Paperclip, X } from "lucide-react";
import { NativeModelPicker } from "./NativeModelPicker";
import { sessionRequest, type NativeModel } from "./native-api";
import type { SessionController } from "./useSession";
import { clearSentDraft, draftVersion, promptText, readDraft, shouldSubmit, subscribeDraft, writeDraft, type ComposerDraft } from "./workbench-state";

export function NativeComposer({ session, models, model, thinking, onModel, onThinking, onOpenSettings, home, projectPath, setProjectPath }: {
  session: SessionController; models: NativeModel[]; model: string; thinking: string;
  onModel(value: string): void; onThinking(value: string): void; onOpenSettings(): void;
  home?: boolean; projectPath?: string; setProjectPath?(value: string): void;
}) {
  const scope = home ? "home" : session.selected!;
  const [draft, setDraft] = useState(() => readDraft(scope, localStorage));
  const [savingError, setSavingError] = useState(false);
  const [sending, setSending] = useState(false);
  const [commands, setCommands] = useState<Array<{ name: string; description?: string }> | null>(null);
  const [commandSearch, setCommandSearch] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  const update = (value: ComposerDraft) => {
    value = { ...value, model, thinking, ...(home ? { cwd: projectPath } : {}) };
    latest.current = value;
    setDraft(value);
    setSavingError(!writeDraft(scope, value, localStorage));
  };
  useEffect(() => {
    const sync = (value: ComposerDraft) => { latest.current = value; setDraft(value); };
    const unsubscribe = subscribeDraft(scope, sync);
    sync(readDraft(scope, localStorage));
    return unsubscribe;
  }, [scope]);
  useEffect(() => {
    if (!session.queuedDraft) return;
    update({ ...latest.current, text: `${latest.current.text}${latest.current.text ? "\n" : ""}${session.queuedDraft}` });
    session.consumeDraft();
    input.current?.focus();
  }, [session.queuedDraft]);
  const chosen = models.find(item => item.selector === model);
  const ready = !!promptText(draft) && !!chosen?.available && (home || session.opened) && !session.busy && !sending;
  const send = async () => {
    if (!ready || inFlight.current) return;
    if (draft.image && chosen?.input && !chosen.input.includes("image")) { session.setError("当前模型不支持图片，请选择支持图片的模型。"); return; }
    inFlight.current = true; setSending(true);
    const sent = draftVersion(scope);
    try {
      const ok = home
        ? await session.startFromHome({ text: promptText(draft), cwd: projectPath ?? "", model, thinking, image: draft.image })
        : await session.send(promptText(draft), draft.image);
      if (ok) { const saved = clearSentDraft(scope, sent, localStorage); if (saved !== null) setSavingError(!saved); }
    } catch (cause) { session.setError(String(cause)); }
    finally { inFlight.current = false; setSending(false); }
  };
  const attach = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 4_000_000) { session.setError("请选择不超过 4 MB 的图片；其他文件请使用添加文件。"); return; }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
      });
      update({ ...latest.current, image: { data: dataUrl.split(",")[1] ?? "", mimeType: file.type, name: file.name } });
    } catch { session.setError("无法读取图片，请重新选择。"); }
  };
  const pickFiles = async () => {
    if (!window.alpha?.choosePaths) { fileInput.current?.click(); return; }
    try { const paths = await window.alpha.choosePaths("files"); update({ ...latest.current, paths: [...new Set([...latest.current.paths, ...paths])] }); }
    catch (cause) { session.setError(String(cause)); }
  };
  return <div className={`native-compose ${home ? "native-home-composer" : ""}`}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={event => { event.preventDefault(); void attach(event.dataTransfer.files[0]); }}>
    {session.widgets.map(block => block.lines.map((line, index) => <div className="native-tool-call" key={`${block.key}:${index}`}>{line}</div>))}
    {(draft.image || draft.paths.length > 0) && <div className="native-attachments" aria-label="已添加材料">
      {draft.image && <span><img src={`data:${draft.image.mimeType};base64,${draft.image.data}`} alt="已添加图片" />{draft.image.name}<button aria-label="移除图片" onClick={() => update({ ...draft, image: undefined })}><X size={14} /></button></span>}
      {draft.paths.map(path => <span key={path} title={path}>{path.split(/[\\/]/).at(-1)}<button aria-label={`移除 ${path.split(/[\\/]/).at(-1)}`} onClick={() => update({ ...draft, paths: draft.paths.filter(item => item !== path) })}><X size={14} /></button></span>)}
      {draft.image && <small className="native-muted">图片在当前窗口保留；刷新后需要重新添加。</small>}
    </div>}
    <textarea ref={input} data-testid={home ? "brief" : "composer"} aria-label={home ? "描述任务目标" : "向 Alpha 说明任务"}
      value={draft.text} onChange={event => update({ ...draft, text: event.target.value })}
      onKeyDown={event => { if (shouldSubmit({ ...event, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); void send(); } }}
      onPaste={event => { const file = [...event.clipboardData.files].find(item => item.type.startsWith("image/")); if (file) { event.preventDefault(); void attach(file); } }}
      placeholder={session.state?.isStreaming ? "补充要求，实时送给正在工作的 Alpha…" : "描述要完成的任务，也可以粘贴或拖入图片…"} rows={home ? 5 : 3} />
    <div className="native-compose-toolbar">
      <button className="native-icon-button" aria-label="添加材料" title={window.alpha?.choosePaths ? "添加文件" : "添加图片"} onClick={() => void pickFiles()}><Paperclip size={17} /></button>
      <input hidden ref={fileInput} type="file" accept="image/*" aria-label="选择图片" onChange={event => { void attach(event.target.files?.[0]); event.target.value = ""; }} />
      <NativeModelPicker models={models} value={model} onChange={onModel} thinking={thinking} onThinkingChange={onThinking} onOpenSettings={onOpenSettings} disabled={sending} allowAuto={!!home} />
      {home && <label className="native-home-directory" title={projectPath || "Alpha 工作区"}><FolderOpen size={15} /><input aria-label="工作目录" value={projectPath} onChange={event => setProjectPath?.(event.target.value)} placeholder="Alpha 工作区" /></label>}
      {!home && <details className="native-more"><summary aria-label="更多输入操作" title="更多操作"><MoreHorizontal size={18} /></summary><div onClick={event => event.currentTarget.parentElement?.removeAttribute("open")}>
        <button onClick={onOpenSettings}>模型与账号设置</button>
        <button onClick={() => void session.command({ type: "compact" })}>压缩上下文</button>
        <button onClick={() => {
          if (!session.selected) return;
          void sessionRequest<{ data: { commands: Array<{ name: string; description?: string }> } }>(session.selected, "command", { type: "get_available_commands" }).then(result => setCommands(result.data.commands), cause => session.setError(String(cause)));
        }}>命令与技能</button>
      </div></details>}
      <span className="native-send-hint">Ctrl + Enter</span>
      <button className="native-primary" disabled={!ready} onClick={() => void send()} aria-label={home ? "开始任务" : "发送"}>{home && (sending ? "正在启动…" : "开始任务")}<ArrowUp size={17} /></button>
    </div>
    {commands && <div className="native-command-list"><input aria-label="搜索命令与技能" placeholder="搜索命令与技能…" value={commandSearch} onChange={event => setCommandSearch(event.target.value)} />
      <button aria-label="关闭命令列表" onClick={() => setCommands(null)}><X size={16} /></button>
      {commands.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(commandSearch.toLowerCase())).map(item => <button key={item.name} title={item.description} onClick={() => { update({ ...draft, text: `${draft.text}${draft.text ? "\n" : ""}/${item.name} ` }); setCommands(null); input.current?.focus(); }}>/{item.name}</button>)}
    </div>}
    {savingError && <p role="alert" className="native-muted">此窗口仍保留草稿，但无法保存到本机；关闭或刷新前请复制内容。</p>}
  </div>;
}
