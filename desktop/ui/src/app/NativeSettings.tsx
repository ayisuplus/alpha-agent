import { useState } from "react";
import { Bot, Gauge, MonitorCog, X } from "lucide-react";
import { Field, SectionTitle, Toggle } from "../components/settings/controls";
import "../components/settings/settings.css";
import { NativeModelPicker } from "./NativeModelPicker";
import { modelPreference, nativeApi, type NativeCatalog, type NativeConfig, type NativeSetting } from "./native-api";

const names: Record<string, string> = { defaultThinkingLevel: "默认思考强度", "compaction.enabled": "自动压缩上下文", "retry.enabled": "失败自动重试", "retry.maxRetries": "最大重试次数", "lsp.enabled": "语言服务", "skills.enabled": "启用 Skills" };
const groups: Record<string, string> = { context: "上下文", model: "模型行为", files: "文件与编辑", tools: "工具", tasks: "子任务", memory: "记忆", providers: "服务商", shell: "Shell", interaction: "OMP 交互", appearance: "OMP 终端外观" };
function SettingRow({ item, save, busy }: { item: NativeSetting; save(input: Record<string, unknown>): Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState(String(item.value ?? ""));
  const change = (value: unknown) => void save({ id: item.id, value });
  return <Field label={names[item.id] ?? item.label} description={item.description || item.id}>
    {item.type === "boolean" ? <Toggle label={names[item.id] ?? item.label} checked={item.value === true} disabled={busy} onChange={change} /> : item.values ? <select aria-label={names[item.id] ?? item.label} disabled={busy} value={String(item.value ?? "")} onChange={event => change(event.target.value)}>{item.values.map(value => <option key={value}>{value}</option>)}</select> : <form className="native-setting-form" onSubmit={event => { event.preventDefault(); change(item.type === "number" ? Number(draft) : draft); }}><input aria-label={names[item.id] ?? item.label} type={item.type === "number" ? "number" : "text"} step="any" value={draft} onChange={event => setDraft(event.target.value)} /><button disabled={busy || draft === String(item.value ?? "")}>保存</button></form>}
    <button className="native-reset" title="恢复 OMP 默认值" disabled={busy} onClick={() => void save({ id: item.id, reset: true })}>重置</button>
  </Field>;
}

export function NativeSettings({ config, catalog, onConfig, reload, onClose, fontSize, setFontSize, workspaceVisible, setWorkspaceVisible }: {
  config: NativeConfig | null; catalog: NativeCatalog | null; onConfig(value: NativeConfig): void; reload(): Promise<void>; onClose(): void;
  fontSize: number; setFontSize(value: number): void; workspaceVisible: boolean; setWorkspaceVisible(value: boolean): void;
}) {
  const [section, setSection] = useState("model");
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState("context");
  const [allProviders, setAllProviders] = useState(false);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function save(input: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { onConfig(await nativeApi<NativeConfig>("settings", input)); setNotice("已保存到 OMP。新会话使用新配置；项目配置仍按 OMP 规则优先。"); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function credential(id: string, action: "save" | "remove") {
    if (action === "remove" && !window.confirm(`删除 ${id} 保存的 API Key？此凭据与 OMP 命令行共享。`)) return;
    setBusy(true); setError(""); setNotice("");
    try { await nativeApi("credentials", { provider: id, action, ...(action === "save" ? { key } : {}) }); setKey(""); setProvider(""); await reload(); setNotice("凭据已保存，模型列表已更新。已打开的会话可能需要重新打开才能读取新凭据。"); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  const fields = config?.settings ?? [];
  return <div className="settings-view native-settings" data-testid="settings-view">
    <header className="settings-header"><h1>设置</h1><span className="settings-header-hint">模型与配置直接使用 OMP 的原生存储</span><button aria-label="关闭设置" onClick={onClose}><X size={18} /></button></header>
    <div className="settings-layout"><nav className="settings-nav" aria-label="设置分组">{[{ id: "model", title: "模型与账号", Icon: Bot }, { id: "runtime", title: "运行与工具", Icon: Gauge }, { id: "interface", title: "界面", Icon: MonitorCog }].map(({ id, title, Icon }) => <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => { setSection(id); setFilter(""); }}><Icon size={15} />{title}</button>)}</nav>
      <div className="settings-content">{error && <p role="alert" className="native-settings-error">{error}</p>}{notice && <p role="status" className="native-settings-notice">{notice}</p>}
      {!config || !catalog ? <p>正在读取 OMP 配置…</p> : section === "model" ? <section><SectionTitle title="模型与账号" description="在这里选择默认模型、管理 API Key。与 OMP 命令行共享，保存后新会话生效。" />
        {catalog.error && <p role="alert">{catalog.error}</p>}
        <Field label="默认模型" description="在首页还可以为单次任务选择其他模型。"><NativeModelPicker models={catalog.models} value={modelPreference(catalog.models, config.modelRoles.default ?? "").selector} disabled={busy} label="选择默认模型" onChange={model => void save({ role: "default", model })} /></Field>
        {fields.filter(item => item.id === "defaultThinkingLevel").map(item => <SettingRow key={`${item.id}-${item.value}`} item={item} save={save} busy={busy} />)}
        <h3 className="settings-subheading">服务商与凭据</h3><div className="native-settings-search"><input aria-label="搜索服务商" placeholder="搜索服务商…" value={filter} onChange={event => setFilter(event.target.value)} /><label><input type="checkbox" checked={allProviders} onChange={event => setAllProviders(event.target.checked)} />显示全部服务商</label><button disabled={busy} onClick={() => { setBusy(true); void reload().catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>刷新</button></div>
        {catalog.providers.filter(item => (allProviders || filter || item.origin || item.storedKey) && item.id.toLowerCase().includes(filter.toLowerCase())).map(item => <div className="provider-row" key={item.id}><div className="provider-main"><strong>{item.id}</strong><small>{item.origin ? `已配置 · ${item.origin}` : "未配置凭据"} · {item.available} 个模型可用</small></div>{provider === item.id ? <form className="provider-key-form" onSubmit={event => { event.preventDefault(); void credential(item.id, "save"); }}><input type="password" autoComplete="off" aria-label={`${item.id} API Key`} placeholder="粘贴 API Key" value={key} onChange={event => setKey(event.target.value)} /><button disabled={busy || !key.trim()}>保存</button><button type="button" onClick={() => { setProvider(""); setKey(""); }}>取消</button></form> : <div className="provider-actions">{!item.oauth && <button disabled={busy} onClick={() => { setProvider(item.id); setKey(""); }}>{item.storedKey ? "更换 Key" : "添加 Key"}</button>}{item.storedKey && <button disabled={busy} onClick={() => void credential(item.id, "remove")}>删除 Key</button>}{item.oauth && <span>OAuth 已登录</span>}</div>}</div>)}
        <p className="native-muted">OMP 配置目录：{config.agentDir}</p>
      </section> : section === "runtime" ? <section><SectionTitle title="运行与工具" description="以下选项来自当前 OMP 内核。使用原生校验和持久化规则；一般在新会话中生效。" /><select aria-label="配置分组" value={group} onChange={event => setGroup(event.target.value)}><option value="">全部分组</option>{Object.entries(groups).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><input className="native-settings-filter" aria-label="搜索 OMP 设置" placeholder="搜索设置，如 compaction、retry、lsp、browser…" value={filter} onChange={event => setFilter(event.target.value)} />{fields.filter(item => item.id !== "defaultThinkingLevel" && (!group || item.tab === group) && `${names[item.id] ?? ""} ${item.id} ${item.label} ${item.description}`.toLowerCase().includes(filter.toLowerCase())).map(item => <SettingRow key={`${item.id}-${String(item.value)}`} item={item} save={save} busy={busy} />)}</section> : <section><SectionTitle title="界面" description="恢复熟悉的开场与桌面工作方式，显示偏好自动保存。" /><Field label="对话字号"><select aria-label="对话字号" value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>{[13, 14, 15, 16, 18].map(size => <option key={size} value={size}>{size} px</option>)}</select></Field><Field label="显示右侧工作区" description="在会话中显示认知、文件、浏览器和日志。"><Toggle label="显示右侧工作区" checked={workspaceVisible} onChange={setWorkspaceVisible} /></Field></section>}
      </div></div>
  </div>;
}
