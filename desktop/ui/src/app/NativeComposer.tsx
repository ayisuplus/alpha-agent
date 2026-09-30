import { desktopStorage } from "./desktop-storage";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, CircleStop, FolderOpen, MoreHorizontal, Paperclip, X } from "lucide-react";
import { NativeModelPicker } from "./NativeModelPicker";
import { sessionRequest, type NativeModel } from "./native-api";
import type { SessionController } from "./useSession";
import { clearSentDraft, draftVersion, promptText, readDraft, shouldSubmit, subscribeDraft, writeDraft, type ComposerDraft } from "./workbench-state";
import { desktopCommand, desktopCommands, invokeDesktopCommand } from "./desktop-commands";

export function NativeComposer({ session, models, model, thinking, onModel, onThinking, onOpenSettings, home, projectPath, setProjectPath }: {
  session: SessionController; models: NativeModel[]; model: string; thinking: string;
  onModel(value: string): void; onThinking(value: string): void; onOpenSettings(): void;
  home?: boolean; projectPath?: string; setProjectPath?(value: string): void;
}) {
  const scope = home ? "home" : session.selected!;
  const [draft, setDraft] = useState(() => readDraft(scope, desktopStorage));
  const [savingError, setSavingError] = useState(false);
  const [sending, setSending] = useState(false);
  const [commands, setCommands] = useState<Array<{ name: string; description?: string }>>([]);
  const [files, setFiles] = useState<Array<{ name: string; path: string; type: string }>>([]);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [queueMode, setQueueMode] = useState<"steer" | "follow_up">("steer");
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  const update = (value: ComposerDraft) => {
    value = { ...value, model, thinking, ...(home ? { cwd: projectPath } : {}) };
    latest.current = value;
    setDraft(value);
    setSavingError(!writeDraft(scope, value, desktopStorage));
  };
  useEffect(() => {
    const sync = (value: ComposerDraft) => { latest.current = value; setDraft(value); };
    const unsubscribe = subscribeDraft(scope, sync);
    sync(readDraft(scope, desktopStorage));
    return unsubscribe;
  }, [scope]);
  useEffect(() => {
    if (!session.queuedDraft) return;
    update({ ...latest.current, text: `${latest.current.text}${latest.current.text ? "\n" : ""}${session.queuedDraft}` });
    session.consumeDraft();
    input.current?.focus();
  }, [session.queuedDraft]);
  useEffect(() => {
    if (!session.selected || !session.opened) return;
    let cancelled = false;
    void sessionRequest<{ data: { commands: typeof commands } }>(session.selected, "command", { type: "get_available_commands" }).then(result => { if (!cancelled) setCommands(result.data.commands); }, cause => session.setError(String(cause)));
    void sessionRequest<{ files: typeof files }>(session.selected, "files").then(result => { if (!cancelled) setFiles(result.files); }, () => undefined);
    return () => { cancelled = true; };
  }, [session.selected, session.opened]);
  const images = draft.images ?? (draft.image ? [draft.image] : []);
  const slash = /^\/([^\s]*)$/.exec(draft.text), reference = /(?:^|\s)@([^\s]*)$/.exec(draft.text);
  const completions = slash ? [...desktopCommands, ...commands.filter(item => !desktopCommands.some(command => command.name === item.name))].filter(item => item.name.toLowerCase().includes(slash[1].toLowerCase())).map(item => ({ label: `/${item.name}`, value: `/${item.name} `, description: item.description }))
    : reference ? files.filter(item => item.type === "file" && item.name.toLowerCase().includes(reference[1].toLowerCase())).map(item => ({ label: item.name, value: `${draft.text.slice(0, draft.text.length - reference[1].length - 1)}@${JSON.stringify(item.path)} `, description: item.path })) : [];
  useEffect(() => { setCompletionIndex(0); }, [draft.text]);
  const complete = (index: number) => { if (completions[index]) update({ ...draft, text: completions[index].value }); input.current?.focus(); };
  const chosen = models.find(item => item.selector === model);
  const ready = !!promptText(draft) && !!chosen?.available && (home || session.opened) && !session.busy && !sending;
  const send = async () => {
    if (!ready || inFlight.current) return;
    if (images.length && chosen?.input && !chosen.input.includes("image")) { session.setError("当前模型不支持图片，请选择支持图片的模型。"); return; }
    inFlight.current = true; setSending(true);
    const sent = draftVersion(scope);
    try {
      const command = desktopCommand(draft.text);
      const ok = home && command && command.id !== "plan"
        ? await invokeDesktopCommand(command.id)
        : home ? await session.startFromHome({ text: promptText(draft), cwd: projectPath ?? "", model, thinking, image: images })
        : await session.send(promptText(draft), images, queueMode);
      if (ok) { const saved = clearSentDraft(scope, sent, desktopStorage); if (saved !== null) setSavingError(!saved); }
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
      const attached = latest.current.images ?? (latest.current.image ? [latest.current.image] : []);
      const image = { data: dataUrl.split(",")[1] ?? "", mimeType: file.type, name: file.name };
      if (attached.length >= 8 || attached.reduce((size, item) => size + item.data.length, image.data.length) > 6_000_000) { session.setError("最多添加 8 张图片，合计大小不超过 4.5 MB。"); return; }
      update({ ...latest.current, image: undefined, images: [...attached, image] });
    } catch { session.setError("无法读取图片，请重新选择。"); }
  };
  const pickFiles = async () => {
    if (!window.alpha?.choosePaths) { fileInput.current?.click(); return; }
    try { const paths = await window.alpha.choosePaths("files"); update({ ...latest.current, paths: [...new Set([...latest.current.paths, ...paths])] }); }
    catch (cause) { session.setError(String(cause)); }
  };
  return <div className={`native-compose ${home ? "native-home-composer" : ""}`}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={event => { event.preventDefault(); void (async () => { for (const file of event.dataTransfer.files) await attach(file); })(); }}>
    {session.widgets.filter(block => block.key !== "alpha-header").map(block => block.lines.map((line, index) => <div className="native-tool-call" key={`${block.key}:${index}`}>{line}</div>))}
    {(images.length > 0 || draft.paths.length > 0) && <div className="native-attachments" aria-label="已添加材料">
      {images.map((image, index) => <span key={index}><img src={`data:${image.mimeType};base64,${image.data}`} alt="已添加图片" />{image.name}<button aria-label={`移除图片 ${image.name}`} onClick={() => update({ ...draft, image: undefined, images: images.filter((_, position) => position !== index) })}><X size={14} /></button></span>)}
      {draft.paths.map(path => <span key={path} title={path}>{path.split(/[\\/]/).at(-1)}<button aria-label={`移除 ${path.split(/[\\/]/).at(-1)}`} onClick={() => update({ ...draft, paths: draft.paths.filter(item => item !== path) })}><X size={14} /></button></span>)}
      {images.length > 0 && <small className="native-muted">图片与草稿一起保存在本机。</small>}
    </div>}
    <textarea ref={input} data-testid={home ? "brief" : "composer"} aria-label={home ? "描述任务目标" : "向 Alpha 说明任务"}
      value={draft.text} onChange={event => update({ ...draft, text: event.target.value })}
      onKeyDown={event => {
        if (!event.nativeEvent.isComposing && completions.length && ["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) {
          event.preventDefault(); if (event.key === "Tab") complete(completionIndex); else setCompletionIndex(index => (index + (event.key === "ArrowDown" ? 1 : completions.length - 1)) % completions.length);
        } else if (shouldSubmit({ ...event, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); void send(); }
      }}
      onPaste={event => { const file = [...event.clipboardData.files].find(item => item.type.startsWith("image/")); if (file) { event.preventDefault(); void attach(file); } }}
      placeholder={session.state?.isStreaming ? "补充要求，实时送给正在工作的 Alpha…" : "描述要完成的任务，也可以粘贴或拖入图片…"} rows={home ? 5 : 3} />
    <div className="native-compose-toolbar">
      <button className="native-icon-button" aria-label="添加材料" title={window.alpha?.choosePaths ? "添加文件" : "添加图片"} onClick={() => void pickFiles()}><Paperclip size={17} /></button>
      <input hidden multiple ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="选择图片" onChange={event => { const selected = [...event.target.files ?? []]; event.target.value = ""; void (async () => { for (const file of selected) await attach(file); })(); }} />
      <NativeModelPicker models={models} value={model} onChange={onModel} thinking={thinking} onThinkingChange={onThinking} onOpenSettings={onOpenSettings} disabled={sending} allowAuto={!!home} />
      {home && <div className="native-home-directory" title={projectPath || "Alpha 工作区"}>
        {window.alpha?.choosePaths ? <button className="native-icon-button" aria-label="选择工作目录" title="选择文件夹" onClick={() => void window.alpha!.choosePaths!("directory").then(paths => { if (paths[0]) setProjectPath?.(paths[0]); }, cause => session.setError(String(cause)))}><FolderOpen size={16} /></button> : <FolderOpen size={16} />}
        <input aria-label="工作目录" value={projectPath} onChange={event => setProjectPath?.(event.target.value)} placeholder="Alpha 工作区" />
      </div>}
      {!home && <details className="native-more"><summary aria-label="更多输入操作" title="更多操作"><MoreHorizontal size={18} /></summary><div onClick={event => event.currentTarget.parentElement?.removeAttribute("open")}>
        <button onClick={onOpenSettings}>模型与账号设置</button>
        <button onClick={() => void invokeDesktopCommand("compact")}>压缩上下文</button>
        <button onClick={() => void invokeDesktopCommand("palette")}>命令与技能</button>
      </div></details>}
      {session.state?.isStreaming && <select aria-label="消息发送方式" value={queueMode} onChange={event => setQueueMode(event.target.value as typeof queueMode)}><option value="steer">中途补充</option><option value="follow_up">下一轮排队</option></select>}
      <span className="native-send-hint">Ctrl + Enter</span>
      {session.state?.isStreaming && <button className="native-stop" aria-label="停止生成" title="停止生成" onClick={() => void session.command({ type: "abort" })}><CircleStop size={17} /></button>}
      <button className="native-primary" disabled={!ready} onClick={() => void send()} aria-label={home ? "开始任务" : "发送"}>{home && (sending ? "正在启动…" : "开始任务")}<ArrowUp size={17} /></button>
    </div>
    {completions.length > 0 && <div className="native-command-results native-completions" role="listbox" aria-label="输入补全">{completions.slice(0, 40).map((item, index) => <button key={item.label} role="option" aria-selected={index === completionIndex} onClick={() => complete(index)}><span>{item.label}</span><small>{item.description}</small></button>)}</div>}
    {savingError && <p role="alert" className="native-muted">此窗口仍保留草稿，但无法保存到本机；关闭或刷新前请复制内容。</p>}
  </div>;
}
