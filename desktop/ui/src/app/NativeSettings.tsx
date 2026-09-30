/**
 * 设置（方案 8.2）：模型与账号、运行与工具（内核原生设置）、本机能力（状态/检测/浏览器授权）、
 * 技能（只读 30 个 Alpha Skill）、界面、关于（Alpha 版本、OMP 版本与许可、天枢来源与许可）。
 * OMP 产品名只出现在“关于”页与更新横幅。
 */

import { useEffect, useState } from "react";
import { Bot, Gauge, Info, MonitorCog, Sparkles, Timer, Wrench, X } from "lucide-react";
import type { BrowserHostStatus } from "../api/types";
import { Field, SectionTitle, Toggle } from "../components/settings/controls";
import "../components/settings/settings.css";
import { NativeModelPicker } from "./NativeModelPicker";
import {
  ALPHA_VERSION,
  modelPreference,
  nativeApi,
  nativeDelete,
  type NativeCatalog,
  type NativeConfig,
  type NativeSetting,
  type UpdateStatus,
} from "./native-api";

const names: Record<string, string> = { defaultThinkingLevel: "默认思考强度", "compaction.enabled": "自动压缩上下文", "retry.enabled": "失败自动重试", "retry.maxRetries": "最大重试次数", "lsp.enabled": "语言服务", "skills.enabled": "启用 Skills" };
const groups: Record<string, string> = { context: "上下文", model: "模型行为", files: "文件与编辑", tools: "工具", tasks: "子任务", memory: "记忆", providers: "服务商", shell: "Shell", interaction: "交互", appearance: "终端外观" };

function SettingRow({ item, save, busy }: { item: NativeSetting; save(input: Record<string, unknown>): Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState(String(item.value ?? ""));
  const [json, setJson] = useState(() => (item.type === "array" || item.type === "record") ? JSON.stringify(item.value ?? (item.type === "array" ? [] : {}), null, 2) : "");
  const [jsonError, setJsonError] = useState("");
  const change = (value: unknown) => void save({ id: item.id, value });
  const structured = item.type === "array" || item.type === "record";
  const saveJson = () => {
    try {
      const parsed: unknown = JSON.parse(json);
      if (item.type === "array" && !Array.isArray(parsed)) { setJsonError("需要 JSON 数组"); return; }
      if (item.type === "record" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) { setJsonError("需要 JSON 对象"); return; }
      setJsonError("");
      change(parsed);
    } catch { setJsonError("JSON 解析失败，请检查格式"); }
  };
  return <Field label={names[item.id] ?? item.label} description={item.description || item.id}>
    {structured ? <form className="native-setting-form" onSubmit={event => { event.preventDefault(); saveJson(); }}>
      <textarea aria-label={names[item.id] ?? item.label} value={json} rows={6} spellCheck={false} onChange={event => setJson(event.target.value)} />
      <button disabled={busy || json === JSON.stringify(item.value ?? (item.type === "array" ? [] : {}), null, 2)}>保存</button>
      {jsonError && <span className="native-settings-error">{jsonError}</span>}
    </form>
    : item.type === "boolean" ? <Toggle label={names[item.id] ?? item.label} checked={item.value === true} disabled={busy} onChange={change} />
      : item.values ? <select aria-label={names[item.id] ?? item.label} disabled={busy} value={String(item.value ?? "")} onChange={event => change(event.target.value)}>{item.values.map(value => <option key={value}>{value}</option>)}</select>
      : <form className="native-setting-form" onSubmit={event => { event.preventDefault(); change(item.type === "number" ? Number(draft) : draft); }}>
        <input aria-label={names[item.id] ?? item.label} type={item.type === "number" ? "number" : "text"} step="any" value={draft} onChange={event => setDraft(event.target.value)} />
        <button disabled={busy || draft === String(item.value ?? "")}>保存</button>
      </form>}
    <button className="native-reset" title="恢复默认值" disabled={busy} onClick={() => void save({ id: item.id, reset: true })}>重置</button>
  </Field>;
}

type CapabilityStatus = {
  office: { available: boolean; version?: string; location?: "bundled" | "system"; reason?: string };
  comfy: { available: boolean; url: string; reason?: string };
};

/** “本机能力”页：Office 引擎 / 浏览器宿主 / ComfyUI 状态与检测；当前会话浏览器授权与撤销。 */
function CapabilityPage({ sessionId }: { sessionId: string | null }) {
  const [host, setHost] = useState<BrowserHostStatus | null>(null);
  const [status, setStatus] = useState<CapabilityStatus | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    void Promise.all([
      nativeApi<CapabilityStatus>("capabilities"),
      window.alpha?.browserHostStatus?.() ?? Promise.resolve(null),
      sessionId ? nativeApi<{ consent: string | null }>(`sessions/${sessionId}/browser-consent`) : Promise.resolve({ consent: null }),
    ]).then(([capabilities, hostStatus, consentState]) => {
      setStatus(capabilities);
      setHost(hostStatus);
      setConsent(consentState.consent);
    }, () => undefined).finally(() => setBusy(false));
  };
  useEffect(() => { check(); }, [sessionId]);
  const officeLine = status
    ? status.office.available ? `可用${status.office.version ? `（${status.office.version}${status.office.location ? ` · ${status.office.location === "bundled" ? "随包" : "系统"}` : ""}）` : ""}` : `缺失${status.office.reason ? `（${status.office.reason}）` : ""}`
    : "未检测";
  const comfyLine = status
    ? status.comfy.available ? `服务可连接（${status.comfy.url}）` : `不可用${status.comfy.reason ? `（${status.comfy.reason}）` : ""}`
    : "未检测";
  return <section>
    <SectionTitle title="本机能力" description="模型可调用的本机能力、引擎状态与浏览器授权。浏览器授权按会话存储，可在此撤销。" />
    <h3 className="settings-subheading">引擎与服务</h3>
    <Field label="Office 引擎" description="LibreOffice（UNO）：inspect / edit / create(docx,pdf,pptx) / convert / preview 依赖它；create xlsx 与 pdf 动作不依赖。">
      <span className="native-muted">{officeLine}</span>
      <button disabled={busy} onClick={check}>检测</button>
    </Field>
    <Field label="浏览器宿主" description="独立的浏览器宿主进程，只承载智能体页面；不可用时回退无头浏览器。">
      <span className="native-muted">{host ? host.available ? `可用（127.0.0.1:${host.port}）` : `当前为不可见模式${host.reason ? `（${host.reason}）` : ""}` : "未检测"}</span>
      <button disabled={busy} onClick={check}>检测</button>
      <button disabled={busy} onClick={() => {
        setBusy(true);
        void window.alpha?.browserHostRestart?.().then(check, () => setBusy(false));
      }}>重启宿主</button>
    </Field>
    <Field label="ComfyUI" description="本机图片、配音与视频生成服务，由你保持运行。这里只检测连接；生成前还需准备工作流要求的节点与模型。">
      <span className="native-muted">{comfyLine}</span>
    </Field>
    <h3 className="settings-subheading">浏览器授权（当前会话）</h3>
    <Field label="会话级授权" description={`首次使用浏览器时会询问“仅这次 / 本会话 / 拒绝”。当前状态：${consent === "session" ? "本会话已授权" : consent === "once" ? "仅上一次调用已授权" : consent === "denied" ? "已拒绝" : "未授权（下次调用时询问）"}。撤销后下次调用会重新询问。`} stacked>
      <button disabled={busy || !sessionId || consent === null} onClick={() => {
        if (!sessionId) return;
        setBusy(true);
        void nativeDelete(`sessions/${sessionId}/browser-consent`).then(check, () => setBusy(false));
      }}>撤销授权</button>
    </Field>
  </section>;
}

/** “技能”页：只读清单（随包发行的 Alpha Skill，来自 sidecar 的 /api/native/skills）。 */
function SkillsPage() {
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([]);
  const [filter, setFilter] = useState("");
  useEffect(() => { void nativeApi<{ skills: Array<{ name: string; description: string }> }>("skills").then(result => setSkills(result.skills), () => setSkills([])); }, []);
  const shown = skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(filter.toLowerCase()));
  return <section>
    <SectionTitle title="技能" description={`只读清单：随包发行的 ${skills.length} 个 Alpha Skill（来自 presets/alpha-plugin）。`} />
    <input className="native-settings-filter" aria-label="搜索技能" placeholder="搜索技能…" value={filter} onChange={event => setFilter(event.target.value)} />
    {shown.map(skill => <div key={skill.name}>
      <div className="native-file"><span>{skill.name}</span></div>
      <p className="native-muted">{skill.description}</p>
    </div>)}
  </section>;
}

/** “定时任务”页：到点把提示词投递给指定会话或新建会话（sidecar 调度，不叠加执行）。 */
function SchedulesPage({ onOpenSession }: { onOpenSession?(id: string): void }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"interval" | "cron">("interval");
  const [intervalMinutes, setIntervalMinutes] = useState("30");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [targetKind, setTargetKind] = useState<"new" | "session">("new");
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const refresh = () => {
    void Promise.all([
      nativeApi<{ schedules: Array<Record<string, unknown>> }>("schedules").then(result => setRows(result.schedules)),
      nativeApi<{ sessions: Array<{ id: string; title: string }> }>("sessions").then(result => setSessions(result.sessions)),
    ]).catch(cause => setError(String(cause)));
  };
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5_000); return () => clearInterval(timer); }, []);
  const submit = () => {
    setBusy(true); setError("");
    void nativeApi(editing ? `schedules/${editing}` : "schedules", {
      name, prompt, kind,
      ...(kind === "interval" ? { intervalMinutes: Number(intervalMinutes) } : { cron }),
      target: targetKind === "new" ? { kind: "new", ...(cwd.trim() ? { cwd: cwd.trim() } : {}) } : { kind: "session", sessionId },
    }).then(() => { setName(""); setPrompt(""); setEditing(null); refresh(); }, cause => setError(String(cause))).finally(() => setBusy(false));
  };
  const patch = (id: string, input: Record<string, unknown>) => {
    setBusy(true);
    void nativeApi(`schedules/${id}`, input).then(refresh, cause => setError(String(cause))).finally(() => setBusy(false));
  };
  const remove = (id: string) => {
    if (!window.confirm("删除这个定时任务？")) return;
    setBusy(true);
    void nativeDelete(`schedules/${id}`).then(refresh, cause => setError(String(cause))).finally(() => setBusy(false));
  };
  return <section>
    <SectionTitle title="定时任务" description={`仅在 Alpha 运行时执行。按本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone} 调度；重启后错过的触发只补一次。目标会话忙碌时本次跳过，完成记录以实际执行结束为准。`} />
    <h3 className="settings-subheading">{editing ? "编辑任务" : "新建"}</h3>
    <Field label="名称" description="显示在列表里的名字。">
      <input aria-label="名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如：每早日报" />
    </Field>
    <Field label="提示词" description="到点发给会话的完整提示词。">
      <textarea aria-label="提示词" value={prompt} rows={4} spellCheck={false} onChange={event => setPrompt(event.target.value)} placeholder="例如：汇总昨天的进展并写一份日报。" />
    </Field>
    <Field label="计划" description="间隔（分钟）或标准 5 段 cron（分 时 日 月 周）。">
      <select aria-label="计划类型" value={kind} onChange={event => setKind(event.target.value === "cron" ? "cron" : "interval")}>
        <option value="interval">间隔</option>
        <option value="cron">cron 表达式</option>
      </select>
      {kind === "interval"
        ? <input aria-label="间隔分钟" type="number" min={1} value={intervalMinutes} onChange={event => setIntervalMinutes(event.target.value)} />
        : <input aria-label="cron 表达式" value={cron} onChange={event => setCron(event.target.value)} />}
    </Field>
    <Field label="目标" description="投递给已有会话，或到点新建会话。">
      <select aria-label="目标类型" value={targetKind} onChange={event => setTargetKind(event.target.value === "session" ? "session" : "new")}>
        <option value="new">新建会话</option>
        <option value="session">指定会话</option>
      </select>
      {targetKind === "session" && <select aria-label="目标会话" value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">选择会话…</option>
        {sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
      </select>}
      {targetKind === "new" && <input aria-label="定时任务项目目录" value={cwd} onChange={event => setCwd(event.target.value)} placeholder="项目目录（留空使用默认工作区）" />}
      <button disabled={busy || !name.trim() || !prompt.trim() || (targetKind === "session" && !sessionId)} onClick={submit}>{editing ? "保存修改" : "添加"}</button>
      {editing && <button onClick={() => { setEditing(null); setName(""); setPrompt(""); }}>取消编辑</button>}
    </Field>
    {error && <p className="native-settings-error">{error}</p>}
    <h3 className="settings-subheading">计划列表（{rows.length}）</h3>
    {rows.length === 0 && <p className="native-muted">还没有定时任务。</p>}
    {rows.map(row => {
      const target = row.target as { kind?: string; sessionId?: string; cwd?: string } | undefined;
      return <div key={String(row.id)} className="native-file">
        <span>{String(row.name)}</span>
        <span className="native-muted">{row.kind === "interval" ? `每 ${String(row.intervalMinutes)} 分钟` : `cron ${String(row.cron)}`}</span>
        <span className="native-muted">{target?.kind === "new" ? "新建会话" : "指定会话"}</span>
        <span className="native-muted">下次 {row.nextRunAt ? new Date(String(row.nextRunAt)).toLocaleString() : "—"}</span>
        <span className="native-muted">{row.lastResult ? `上次：${String(row.lastResult)}` : ""}</span>
        {typeof row.lastSessionId === "string" && <button onClick={() => onOpenSession?.(row.lastSessionId as string)}>查看执行会话</button>}
        <button disabled={busy || row.lastStatus === "running"} onClick={() => {
          setEditing(String(row.id)); setName(String(row.name)); setPrompt(String(row.prompt));
          setKind(row.kind === "cron" ? "cron" : "interval"); setIntervalMinutes(String(row.intervalMinutes ?? 30)); setCron(String(row.cron ?? "0 9 * * 1-5"));
          setTargetKind(target?.kind === "session" ? "session" : "new"); setSessionId(target?.sessionId ?? ""); setCwd(target?.cwd ?? "");
        }}>编辑</button>
        <button disabled={busy} onClick={() => patch(String(row.id), { enabled: row.enabled !== true })}>{row.enabled === true ? "停用" : "启用"}</button>
        <button disabled={busy} onClick={() => remove(String(row.id))}>删除</button>
      </div>;
    })}
  </section>;
}

/** “关于”页：Alpha 版本、OMP 版本与许可、天枢来源与许可。 */
function AboutPage({ update, onCheckUpdate }: { update: UpdateStatus | null; onCheckUpdate(): void }) {
  return <section>
    <SectionTitle title="关于" description="产品、内核与天枢层的版本与许可。" />
    <Field label="Alpha" description="桌面工作台与本机能力层。Apache-2.0 许可，见发行包 LICENSE 与 NOTICE。"><span className="native-muted">{ALPHA_VERSION}</span></Field>
    <Field label="OMP 内核" description="会话、模型、工具与终端由 OMP 原生内核执行；MIT 许可（随包 node_modules/@oh-my-pi/pi-coding-agent/LICENSE）。">
      <span className="native-muted">{update?.current ?? "18.4.3"}</span>
    </Field>
    {update?.available && update.latest && <p className="native-settings-notice">OMP 内核有新版本 {update.latest}（当前 {update.current}），升级需在开发环境中进行。</p>}
    {update?.error && <p className="native-settings-error">更新检测失败：{update.error}</p>}
    <Field label="检测 OMP 更新" description={update?.checkedAt ? `上次检测：${new Date(update.checkedAt).toLocaleString()}` : "尚未检测。"}>
      <button onClick={onCheckUpdate}>检测</button>
    </Field>
    <Field label="天枢证据层" description="改编自 Tianshu-harness v3.27.0，Apache-2.0 许可；来源声明与许可证见 licenses/Tianshu-APACHE-2.0.txt、licenses/Tianshu-NOTICE.txt。" stacked>
      <span className="native-muted">Tianshu-harness v3.27.0 · Apache-2.0</span>
    </Field>
  </section>;
}

export function NativeSettings({ config, catalog, onConfig, reload, onClose, fontSize, setFontSize, workspaceVisible, setWorkspaceVisible, diagnostics, setDiagnostics, update, onCheckUpdate, sessionId, initialSection = "model", onOpenSession }: {
  initialSection?: string;
  onOpenSession?(id: string): void;
  config: NativeConfig | null;
  catalog: NativeCatalog | null;
  onConfig(value: NativeConfig): void;
  reload(): Promise<void>;
  onClose(): void;
  fontSize: number;
  setFontSize(value: number): void;
  workspaceVisible: boolean;
  setWorkspaceVisible(value: boolean): void;
  diagnostics: boolean;
  setDiagnostics(value: boolean): void;
  update: UpdateStatus | null;
  onCheckUpdate(): void;
  sessionId: string | null;
}) {
  const [section, setSection] = useState(initialSection);
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
    try { onConfig(await nativeApi<NativeConfig>("settings", input)); setNotice("已保存。新会话使用新配置；项目配置仍按内核规则优先。"); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function credential(id: string, action: "save" | "remove") {
    if (action === "remove" && !window.confirm(`删除 ${id} 保存的 API Key？此凭据与内核命令行共享。`)) return;
    setBusy(true); setError(""); setNotice("");
    try { await nativeApi("credentials", { provider: id, action, ...(action === "save" ? { key } : {}) }); setKey(""); setProvider(""); await reload(); setNotice("凭据已保存，模型列表已更新。已打开的会话可能需要重新打开才能读取新凭据。"); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  const fields = config?.settings ?? [];
  const navigation = [
    { id: "model", title: "模型与账号", Icon: Bot },
    { id: "runtime", title: "运行与工具", Icon: Gauge },
    { id: "capabilities", title: "本机能力", Icon: Wrench },
    { id: "skills", title: "技能", Icon: Sparkles },
    { id: "schedules", title: "定时任务", Icon: Timer },
    { id: "interface", title: "界面", Icon: MonitorCog },
    { id: "about", title: "关于", Icon: Info },
  ];
  return <div className="settings-view native-settings" data-testid="settings-view">
    <header className="settings-header"><h1>设置</h1><span className="settings-header-hint">模型与配置直接使用内核的原生存储</span><button aria-label="关闭设置" onClick={onClose}><X size={18} /></button></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分组">{navigation.map(({ id, title, Icon }) =>
        <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => { setSection(id); setFilter(""); }}><Icon size={15} />{title}</button>)}</nav>
      <div className="settings-content">
        {error && <p role="alert" className="native-settings-error">{error}</p>}
        {notice && <p role="status" className="native-settings-notice">{notice}</p>}
        {section === "capabilities" ? <CapabilityPage sessionId={sessionId} />
          : section === "skills" ? <SkillsPage />
          : section === "schedules" ? <SchedulesPage onOpenSession={onOpenSession} />
          : section === "about" ? <AboutPage update={update} onCheckUpdate={onCheckUpdate} />
          : section === "interface" ? <section>
            <SectionTitle title="界面" description="只影响工作台本身。" />
            <Field label="文字大小" description="调整正文与输入框的字号，界面布局不变。">
              <select aria-label="文字大小" value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>
                {[12, 13, 14, 15, 16].map(size => <option key={size} value={size}>{size}px</option>)}
              </select>
            </Field>
            <Field label="右侧工作区" description="显示或收起右栏（浏览器、文件、日志）。">
              <Toggle label="显示右侧工作区" checked={workspaceVisible} onChange={setWorkspaceVisible} />
            </Field>
            <Field label="诊断日志" description="右栏的“日志”页签只用于诊断，默认隐藏。">
              <Toggle label="显示诊断日志" checked={diagnostics} onChange={setDiagnostics} />
            </Field>
          </section>
          : !config || !catalog ? <p>正在读取配置…</p>
          : section === "model" ? <section>
            <SectionTitle title="模型与账号" description="在这里选择默认模型、管理 API Key。与内核命令行共享，保存后新会话生效。" />
            {catalog.error && <p role="alert">{catalog.error}</p>}
            <Field label="默认模型" description="在首页还可以为单次任务选择其他模型。"><NativeModelPicker models={catalog.models} value={modelPreference(catalog.models, config.modelRoles.default ?? "").selector} disabled={busy} label="选择默认模型" onChange={model => void save({ role: "default", model })} /></Field>
            {fields.filter(item => item.id === "defaultThinkingLevel").map(item => <SettingRow key={`${item.id}-${item.value}`} item={item} save={save} busy={busy} />)}
            <h3 className="settings-subheading">服务商与凭据</h3>
            <div className="native-settings-search"><input aria-label="搜索服务商" placeholder="搜索服务商…" value={filter} onChange={event => setFilter(event.target.value)} /><label><input type="checkbox" checked={allProviders} onChange={event => setAllProviders(event.target.checked)} />显示全部服务商</label><button disabled={busy} onClick={() => { setBusy(true); void reload().catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>刷新</button></div>
            {catalog.providers.filter(item => (allProviders || filter || item.origin || item.storedKey) && item.id.toLowerCase().includes(filter.toLowerCase())).map(item =>
              <div className="provider-row" key={item.id}>
                <div className="provider-main"><strong>{item.id}</strong><small>{item.origin === "env" && !item.storedKey && !item.oauth ? "检测到环境凭据，请在这里保存后使用" : item.origin ? `已配置 · ${item.origin}` : "未配置凭据"} · {item.available} 个模型可用</small></div>
                {provider === item.id ? <form className="provider-key-form" onSubmit={event => { event.preventDefault(); void credential(item.id, "save"); }}>
                  <input type="password" autoComplete="off" aria-label={`${item.id} API Key`} placeholder="粘贴 API Key" value={key} onChange={event => setKey(event.target.value)} />
                  <button disabled={busy || !key.trim()}>保存</button>
                  <button type="button" onClick={() => { setProvider(""); setKey(""); }}>取消</button>
                </form> : <div className="provider-actions">
                  <button disabled={busy} onClick={() => { setProvider(item.id); setKey(""); }}>{item.storedKey ? "更换" : "设置"}</button>
                  {item.storedKey && <button disabled={busy} onClick={() => void credential(item.id, "remove")}>删除</button>}
                </div>}
              </div>)}
            <p className="native-muted">内核配置目录：{config.agentDir}</p>
          </section>
          : <section>
            <SectionTitle title="运行与工具" description="以下选项来自当前内核。使用原生校验和持久化规则；一般在新会话中生效。" />
            <select aria-label="配置分组" value={group} onChange={event => setGroup(event.target.value)}><option value="">全部分组</option>{Object.entries(groups).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
            <input className="native-settings-filter" aria-label="搜索设置" placeholder="搜索设置，如 compaction、retry、lsp、browser…" value={filter} onChange={event => setFilter(event.target.value)} />
            {fields.filter(item => item.id !== "defaultThinkingLevel" && (!group || item.tab === group) && `${names[item.id] ?? ""} ${item.id} ${item.label} ${item.description}`.toLowerCase().includes(filter.toLowerCase())).map(item =>
              <SettingRow key={`${item.id}-${item.value}`} item={item} save={save} busy={busy} />)}
          </section>}
      </div>
    </div>
  </div>;
}
