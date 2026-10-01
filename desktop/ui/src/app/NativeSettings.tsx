import { tf, t } from "./ui-language";
/**
 * 设置（方案 8.2）：模型与账号、运行与工具（内核原生设置）、本机能力（状态/检测/浏览器授权）、
 * 原生技能、MCP、插件管理、界面、关于（Alpha 版本、OMP 版本与许可、天枢来源与许可）。
 * OMP 来源与版本只出现在“关于”页。
 */

import { useEffect, useState } from "react";
import { Bot, Gauge, Info, MonitorCog, Sparkles, Timer, Wrench, X } from "lucide-react";
import type { BrowserHostStatus } from "../api/types";
import { Field, SectionTitle, Toggle } from "../components/settings/controls";
import "../components/settings/settings.css";
import { NativeModelPicker } from "./NativeModelPicker";
import { NativeExtensions } from "./NativeExtensions";
import { NativeProviders } from "./NativeProviders";
import { NativeDefinitions } from "./NativeDefinitions";
import { NativePreferences } from "./NativePreferences";
import { NativeAppUpdates } from "./NativeAppUpdates";
import { NativeLogs } from "./NativeLogs";
import {
  ALPHA_VERSION,
  nativeApi,
  nativeDelete,
  sessionRequest,
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
    <small className="native-muted">{t("来源：")}{item.provenance}</small>
    {structured ? <form className="native-setting-form" onSubmit={event => { event.preventDefault(); saveJson(); }}>
      <textarea aria-label={t(names[item.id] ?? item.label)} value={json} rows={6} spellCheck={false} onChange={event => setJson(event.target.value)} />
      <button disabled={busy || json === JSON.stringify(item.value ?? (item.type === "array" ? [] : {}), null, 2)}>{t("保存")}</button>
      {jsonError && <span className="native-settings-error">{t(jsonError)}</span>}
    </form>
    : item.type === "boolean" ? <Toggle label={names[item.id] ?? item.label} checked={item.value === true} disabled={busy} onChange={change} />
      : item.values ? <select aria-label={t(names[item.id] ?? item.label)} disabled={busy} value={String(item.value ?? "")} onChange={event => change(event.target.value)}>{item.values.map(value => <option key={value}>{value}</option>)}</select>
      : <form className="native-setting-form" onSubmit={event => { event.preventDefault(); change(item.type === "number" ? Number(draft) : draft); }}>
        <input aria-label={t(names[item.id] ?? item.label)} type={item.type === "number" ? "number" : "text"} step="any" value={draft} onChange={event => setDraft(event.target.value)} />
        <button disabled={busy || draft === String(item.value ?? "")}>{t("保存")}</button>
      </form>}
    <button className="native-reset" title={t("恢复默认值")} disabled={busy} onClick={() => void save({ id: item.id, reset: true })}>{t("重置")}</button>
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
    ? status.office.available ? tf`可用${status.office.version ? `（${status.office.version}${status.office.location ? ` · ${status.office.location === "bundled" ? t("随包") : t("系统")}` : ""}）` : ""}` : tf`缺失${status.office.reason ? `（${status.office.reason}）` : ""}`
    : "未检测";
  const comfyLine = status
    ? status.comfy.available ? tf`服务可连接（${status.comfy.url}）` : tf`不可用${status.comfy.reason ? `（${status.comfy.reason}）` : ""}`
    : "未检测";
  return <section>
    <SectionTitle title={t("本机能力")} description={t("模型可调用的本机能力、引擎状态与浏览器授权。浏览器授权按会话存储，可在此撤销。")} />
    <h3 className="settings-subheading">{t("引擎与服务")}</h3>
    <Field label={t("Office 引擎")} description={t("LibreOffice（UNO）：inspect / edit / create(docx,pdf,pptx) / convert / preview 依赖它；create xlsx 与 pdf 动作不依赖。")}>
      <span className="native-muted">{officeLine}</span>
      <button disabled={busy} onClick={check}>{t("检测")}</button>
    </Field>
    <Field label={t("浏览器宿主")} description={t("独立的浏览器宿主进程，只承载智能体页面；不可用时回退无头浏览器。")}>
      <span className="native-muted">{host ? host.available ? tf`可用（127.0.0.1:${host.port}）` : tf`当前为不可见模式${host.reason ? `（${host.reason}）` : ""}` : t("未检测")}</span>
      <button disabled={busy} onClick={check}>{t("检测")}</button>
      <button disabled={busy} onClick={() => {
        setBusy(true);
        void window.alpha?.browserHostRestart?.().then(check, () => setBusy(false));
      }}>{t("重启宿主")}</button>
    </Field>
    <Field label="ComfyUI" description={t("本机图片、配音与视频生成服务，由你保持运行。这里只检测连接；生成前还需准备工作流要求的节点与模型。")}>
      <span className="native-muted">{comfyLine}</span>
    </Field>
    <h3 className="settings-subheading">{t("浏览器授权（当前会话）")}</h3>
    <Field label={t("会话级授权")} description={tf`首次使用浏览器时会询问“仅这次 / 本会话 / 拒绝”。当前状态：${consent === "session" ? t("本会话已授权") : consent === "once" ? t("仅上一次调用已授权") : consent === "denied" ? t("已拒绝") : t("未授权（下次调用时询问）")}。撤销后下次调用会重新询问。`} stacked>
      <button disabled={busy || !sessionId || consent === null} onClick={() => {
        if (!sessionId) return;
        setBusy(true);
        void nativeDelete(`sessions/${sessionId}/browser-consent`).then(check, () => setBusy(false));
      }}>{t("撤销授权")}</button>
    </Field>
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
    <SectionTitle title={t("定时任务")} description={tf`仅在 Alpha 运行时执行。按本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone} 调度；重启后错过的触发只补一次。目标会话忙碌时本次跳过，完成记录以实际执行结束为准。`} />
    <h3 className="settings-subheading">{editing ? t("编辑任务") : t("新建")}</h3>
    <Field label={t("名称")} description={t("显示在列表里的名字。")}>
      <input aria-label={t("名称")} value={name} onChange={event => setName(event.target.value)} placeholder={t("例如：每早日报")} />
    </Field>
    <Field label={t("提示词")} description={t("到点发给会话的完整提示词。")}>
      <textarea aria-label={t("提示词")} value={prompt} rows={4} spellCheck={false} onChange={event => setPrompt(event.target.value)} placeholder={t("例如：汇总昨天的进展并写一份日报。")} />
    </Field>
    <Field label={t("计划")} description={t("间隔（分钟）或标准 5 段 cron（分 时 日 月 周）。")}>
      <select aria-label={t("计划类型")} value={kind} onChange={event => setKind(event.target.value === "cron" ? "cron" : "interval")}>
        <option value="interval">{t("间隔")}</option>
        <option value="cron">{t("cron 表达式")}</option>
      </select>
      {kind === "interval"
        ? <input aria-label={t("间隔分钟")} type="number" min={1} value={intervalMinutes} onChange={event => setIntervalMinutes(event.target.value)} />
        : <input aria-label={t("cron 表达式")} value={cron} onChange={event => setCron(event.target.value)} />}
    </Field>
    <Field label={t("目标")} description={t("投递给已有会话，或到点新建会话。")}>
      <select aria-label={t("目标类型")} value={targetKind} onChange={event => setTargetKind(event.target.value === "session" ? "session" : "new")}>
        <option value="new">{t("新建会话")}</option>
        <option value="session">{t("指定会话")}</option>
      </select>
      {targetKind === "session" && <select aria-label={t("目标会话")} value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">{t("选择会话…")}</option>
        {sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
      </select>}
      {targetKind === "new" && <input aria-label={t("定时任务项目目录")} value={cwd} onChange={event => setCwd(event.target.value)} placeholder={t("项目目录（留空使用默认工作区）")} />}
      <button disabled={busy || !name.trim() || !prompt.trim() || (targetKind === "session" && !sessionId)} onClick={submit}>{editing ? t("保存修改") : t("添加")}</button>
      {editing && <button onClick={() => { setEditing(null); setName(""); setPrompt(""); }}>{t("取消编辑")}</button>}
    </Field>
    {error && <p className="native-settings-error">{t(error)}</p>}
    <h3 className="settings-subheading">{t("计划列表（")}{rows.length}）</h3>
    {rows.length === 0 && <p className="native-muted">{t("还没有定时任务。")}</p>}
    {rows.map(row => {
      const target = row.target as { kind?: string; sessionId?: string; cwd?: string } | undefined;
      return <div key={String(row.id)} className="native-file">
        <span>{String(row.name)}</span>
        <span className="native-muted">{row.kind === "interval" ? tf`每 ${String(row.intervalMinutes)} 分钟` : `cron ${String(row.cron)}`}</span>
        <span className="native-muted">{target?.kind === "new" ? t("新建会话") : t("指定会话")}</span>
        <span className="native-muted">{t("下次")} {row.nextRunAt ? new Date(String(row.nextRunAt)).toLocaleString() : "—"}</span>
        <span className="native-muted">{row.lastResult ? tf`上次：${String(row.lastResult)}` : ""}</span>
        {typeof row.lastSessionId === "string" && <button onClick={() => onOpenSession?.(row.lastSessionId as string)}>{t("查看执行会话")}</button>}
        <button disabled={busy || row.lastStatus === "running"} onClick={() => {
          setEditing(String(row.id)); setName(String(row.name)); setPrompt(String(row.prompt));
          setKind(row.kind === "cron" ? "cron" : "interval"); setIntervalMinutes(String(row.intervalMinutes ?? 30)); setCron(String(row.cron ?? "0 9 * * 1-5"));
          setTargetKind(target?.kind === "session" ? "session" : "new"); setSessionId(target?.sessionId ?? ""); setCwd(target?.cwd ?? "");
        }}>{t("编辑")}</button>
        <button disabled={busy} onClick={() => patch(String(row.id), { enabled: row.enabled !== true })}>{row.enabled === true ? t("停用") : t("启用")}</button>
        <button disabled={busy} onClick={() => remove(String(row.id))}>{t("删除")}</button>
      </div>;
    })}
  </section>;
}

/** “关于”页：Alpha 版本、OMP 版本与许可、天枢来源与许可。 */
function AboutPage({ update, onCheckUpdate, sessionId }: { update: UpdateStatus | null; onCheckUpdate(): void; sessionId: string | null }) {
  return <section>
    <SectionTitle title={t("关于")} description={t("产品、内核与天枢层的版本与许可。")} />
    <NativeAppUpdates />
    <NativeLogs sessionId={sessionId} />
    <Field label="Alpha" description={t("桌面工作台与本机能力层。Apache-2.0 许可，见发行包 LICENSE 与 NOTICE。")}><span className="native-muted">{ALPHA_VERSION}</span></Field>
    <Field label={t("OMP 内核")} description={t("会话、模型、工具与终端由 OMP 原生内核执行；MIT 许可（随包 node_modules/@oh-my-pi/pi-coding-agent/LICENSE）。")}>
      <span className="native-muted">{update?.current ?? "18.4.3"}</span>
    </Field>
    {update?.available && update.latest && <p className="native-settings-notice">{t("OMP 内核有新版本")} {update.latest}{t("（当前")} {update.current}{t("），升级需在开发环境中进行。")}</p>}
    {update?.error && <p className="native-settings-error">{t("更新检测失败：")}{update.error}</p>}
    <Field label={t("检测 OMP 更新")} description={update?.checkedAt ? tf`上次检测：${new Date(update.checkedAt).toLocaleString()}` : t("尚未检测。")}>
      <button onClick={onCheckUpdate}>{t("检测")}</button>
    </Field>
    <Field label={t("天枢证据层")} description={t("改编自 Tianshu-harness v3.27.0，Apache-2.0 许可；来源声明与许可证见 licenses/Tianshu-APACHE-2.0.txt、licenses/Tianshu-NOTICE.txt。")} stacked>
      <span className="native-muted">Tianshu-harness v3.27.0 · Apache-2.0</span>
    </Field>
  </section>;
}

export function NativeSettings({ config, catalog, onConfig, reload, onClose, fontSize, setFontSize, diagnostics, setDiagnostics, update, onCheckUpdate, sessionId, initialSection = "model", onOpenSession, onUseSkill, theme, setTheme }: {
  initialSection?: string;
  onOpenSession?(id: string): void;
  onUseSkill(name: string): void;
  theme: string;
  setTheme(value: string): void;
  config: NativeConfig | null;
  catalog: NativeCatalog | null;
  onConfig(value: NativeConfig): void;
  reload(): Promise<void>;
  onClose(): void;
  fontSize: number;
  setFontSize(value: number): void;
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
  const [scope, setScope] = useState("user");
  const [runtimeConfig, setRuntimeConfig] = useState<NativeConfig | null>(null);
  const [runtimeCatalog, setRuntimeCatalog] = useState<NativeCatalog | null>(null);
  const refreshRuntime = async () => {
    if (!sessionId) return;
    const query = "?sessionId=" + encodeURIComponent(sessionId);
    const [value, models] = await Promise.all([nativeApi<NativeConfig>("configuration" + query), nativeApi<NativeCatalog>("models" + query)]);
    setRuntimeConfig(value); setRuntimeCatalog(models);
  };
  useEffect(() => { setRuntimeConfig(null); setRuntimeCatalog(null); setScope("user"); void refreshRuntime().catch(cause => setError(String(cause))); }, [sessionId]);
  async function save(input: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await nativeApi<NativeConfig>("settings", { ...input, scope, ...(sessionId ? { sessionId, revision: runtimeConfig?.projectRevision } : {}) });
      if (sessionId) { setRuntimeConfig(value); onConfig(await nativeApi<NativeConfig>("configuration")); } else onConfig(value);
      setNotice(sessionId ? "已保存并重新读取当前会话；实际值与来源如下。其他已打开会话需重新加载。" : "已保存。新会话使用新配置。");
    }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function credential(id: string, action: "save" | "remove") {
    if (action === "remove" && !window.confirm(tf`删除 ${id} 保存的 API Key？此凭据与内核命令行共享。`)) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await nativeApi<{ pendingReload: boolean }>("credentials", { provider: id, action, ...(action === "save" ? { key } : {}) }); setKey(""); setProvider(""); await reload(); await refreshRuntime(); setNotice(result.pendingReload ? "凭据已保存，忙碌的会话待重新加载。" : "凭据已保存，原生模型目录已刷新。"); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  const shownConfig = runtimeConfig ?? config;
  const shownCatalog = runtimeCatalog ?? catalog;
  const fields = shownConfig?.settings ?? [];
  const navigation = [
    { id: "model", title: "模型与账号", Icon: Bot },
    { id: "runtime", title: "运行与工具", Icon: Gauge },
    { id: "permissions", title: "权限", Icon: Gauge },
    { id: "definitions", title: "规则与命令", Icon: Sparkles },
    { id: "lsp", title: "语言服务", Icon: Wrench },
    { id: "capabilities", title: "本机能力", Icon: Wrench },
    { id: "skills", title: "技能", Icon: Sparkles },
    { id: "mcp", title: "MCP", Icon: Wrench },
    { id: "plugins", title: "插件", Icon: Wrench },
    { id: "schedules", title: "定时任务", Icon: Timer },
    { id: "interface", title: "界面", Icon: MonitorCog },
    { id: "about", title: "关于", Icon: Info },
  ];
  return <div className="settings-view native-settings" data-testid="settings-view">
    <header className="settings-header"><h1>{t("设置")}</h1><span className="settings-header-hint">{t("让 Alpha 适合你的工作方式")}</span><button aria-label={t("关闭设置")} onClick={onClose}><X size={18} /></button></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label={t("设置分组")}>{navigation.map(({ id, title, Icon }) =>
        <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => { setSection(id); setFilter(""); }}><Icon size={15} />{t(title)}</button>)}</nav>
      <div className="settings-content">
        {error && <p role="alert" className="native-settings-error">{t(error)}</p>}
        {notice && <p role="status" className="native-settings-notice">{t(notice)}</p>}
        {["model", "runtime", "permissions", "lsp"].includes(section) && <Field label={t("保存作用域")} description={runtimeConfig?.cwd ?? "未打开会话，配置保存到用户目录。"}><select aria-label={t("配置作用域")} value={scope} onChange={event => setScope(event.target.value)}><option value="user">{t("用户")}</option><option value="project" disabled={!sessionId}>{t("当前项目")}</option></select><button disabled={busy || !sessionId} onClick={() => void refreshRuntime().catch(cause => setError(String(cause)))}>{t("读取当前会话")}</button><button disabled={busy || !sessionId} onClick={() => { setBusy(true); void nativeApi(`sessions/${sessionId}/host/reload`, {}).then(refreshRuntime).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>{t("重新加载会话")}</button></Field>}
        {section === "capabilities" ? <CapabilityPage sessionId={sessionId} />
          : section === "definitions" ? <NativeDefinitions sessionId={sessionId} />
          : section === "lsp" ? <section><NativeDefinitions sessionId={sessionId} lsp />{fields.filter(item => item.id.startsWith("lsp.")).map(item => <SettingRow key={`${item.id}-${JSON.stringify(item.value)}`} item={item} save={save} busy={busy} />)}</section>
          : section === "permissions" ? <section><SectionTitle title={t("项目工具权限")} description={t("沿用原生审批流程。allow 允许，prompt 询问，deny 拒绝；默认 yolo 自主执行。权限保存到上方选择的作用域。")} />{fields.filter(item => ["tools.approval", "tools.approvalMode"].includes(item.id)).map(item => <SettingRow key={`${item.id}-${JSON.stringify(item.value)}`} item={item} save={save} busy={busy} />)}</section>
          : ["skills", "mcp", "plugins"].includes(section) ? <NativeExtensions key={section} kind={section === "skills" ? "skill" : section === "mcp" ? "mcp" : "plugin"} sessionId={sessionId} onUse={onUseSkill} />
          : section === "schedules" ? <SchedulesPage onOpenSession={onOpenSession} />
          : section === "about" ? <AboutPage update={update} onCheckUpdate={onCheckUpdate} sessionId={sessionId} />
          : section === "interface" ? <section>
            <SectionTitle title={t("界面")} description={t("只影响工作台本身。")} />
            <NativePreferences />
            <Field label={t("外观")} description={t("选择浅色、深色，或跟随系统。")}><select aria-label={t("外观")} value={theme} onChange={event => setTheme(event.target.value)}><option value="light">{t("浅色")}</option><option value="dark">{t("深色")}</option><option value="system">{t("跟随系统")}</option></select></Field>
            <Field label={t("文字大小")} description={t("调整工作台文字；代码与终端保留独立字号。")}>
              <select aria-label={t("文字大小")} value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>
                {[12, 13, 14, 15, 16].map(size => <option key={size} value={size}>{size}px</option>)}
              </select>
            </Field>
            <p className="settings-note">{t("文件、浏览器、审查与终端可从会话顶栏打开，用完即可收起。")}</p>
            <Field label={t("诊断日志")} description={t("右栏的“日志”页签只用于诊断，默认隐藏。")}>
              <Toggle label={t("显示诊断日志")} checked={diagnostics} onChange={setDiagnostics} />
            </Field>
            <Field label={t("快捷键")} description={t("Ctrl+Enter 发送 · Shift+Enter 换行 · Ctrl+N 新会话 · Ctrl+, 设置 · Ctrl+Shift+F 文件 · Esc 关闭弹窗、设置或工作区。")}><span>{t("模型选择菜单支持方向键和 Enter。")}</span></Field>
          </section>
          : !shownConfig || !shownCatalog ? <p>{t("正在读取配置…")}</p>
          : section === "model" ? <section>
            <SectionTitle title={t("模型与账号")} description={t("在这里选择默认模型、管理 API Key。与内核命令行共享，保存后新会话生效。")} />
            {shownCatalog.error && <p role="alert">{shownCatalog.error}</p>}
            {(shownCatalog.roles ?? [{ id: "default", name: "Default", candidates: shownCatalog.models.map(model => model.selector) }]).map(role => <Field key={role.id} label={role.id === "default" ? t("默认模型") : role.name} description={tf`原生角色：${role.id} · 来源：${shownConfig.roles?.find(item => item.id === role.id)?.provenance ?? "default"}`}>
              <NativeModelPicker models={(shownCatalog.roleModels ?? shownCatalog.models).filter(model => role.candidates.includes(model.selector))} value={shownConfig.modelRoles[role.id] ?? ""} disabled={busy} label={tf`选择 ${role.id} 模型`} onChange={model => void save({ role: role.id, model })} />
              <button disabled={busy} onClick={() => void save({ role: role.id, model: "" })}>{t("重置")}</button>
            </Field>)}
            {fields.filter(item => item.id === "defaultThinkingLevel").map(item => <SettingRow key={`${item.id}-${item.value}`} item={item} save={save} busy={busy} />)}
            <h3 className="settings-subheading">{t("服务商与凭据")}</h3>
            <div className="native-settings-search"><input aria-label={t("搜索服务商")} placeholder={t("搜索服务商…")} value={filter} onChange={event => setFilter(event.target.value)} /><label><input type="checkbox" checked={allProviders} onChange={event => setAllProviders(event.target.checked)} />{t("显示全部服务商")}</label><button disabled={busy} onClick={() => { setBusy(true); void reload().catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>{t("刷新")}</button></div>
            {shownCatalog.providers.filter(item => (allProviders || filter || item.origin || item.storedKey || item.oauth) && item.id.toLowerCase().includes(filter.toLowerCase())).map(item =>
              <div className="provider-row" key={item.id}>
                <div className="provider-main"><strong>{item.id}</strong><small>{item.origin === "env" && !item.storedKey && !item.oauth ? t("检测到环境凭据，请在这里保存后使用") : item.origin ? tf`已配置 · ${item.origin}` : t("未配置凭据")} · {item.available} {t("个模型可用")}</small></div>
                {provider === item.id ? <form className="provider-key-form" onSubmit={event => { event.preventDefault(); void credential(item.id, "save"); }}>
                  <input type="password" autoComplete="off" aria-label={`${item.id} API Key`} placeholder={t("粘贴 API Key")} value={key} onChange={event => setKey(event.target.value)} />
                  <button disabled={busy || !key.trim()}>{t("保存")}</button>
                  <button type="button" onClick={() => { setProvider(""); setKey(""); }}>{t("取消")}</button>
                </form> : <div className="provider-actions">
                  <button disabled={busy} onClick={() => { setProvider(item.id); setKey(""); }}>{item.storedKey ? t("更换") : t("设置")}</button>
                  {item.storedKey && <button disabled={busy} onClick={() => void credential(item.id, "remove")}>{t("删除")}</button>}
                  {item.login && <button disabled={busy || !sessionId} onClick={() => { if (!sessionId) return; setBusy(true); setError(""); void sessionRequest(sessionId, "command", { type: "login", providerId: item.id }).then(async () => { await reload(); await refreshRuntime(); setNotice("原生授权已完成，模型目录已刷新。"); }).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>{item.oauth ? t("重新授权") : t("OAuth 登录")}</button>}
                  {item.oauth && <button disabled={busy} onClick={() => { setBusy(true); void nativeApi("credentials", { provider: item.id, action: "remove", oauth: true }).then(async () => { await reload(); await refreshRuntime(); }).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>{t("退出授权")}</button>}
                </div>}
              </div>)}
            <p className="native-muted">{t("内核配置目录：")}{shownConfig.agentDir}</p>
            <NativeProviders onSaved={async () => { await reload(); await refreshRuntime(); }} />
          </section>
          : <section>
            <SectionTitle title={t("运行与工具")} description={t("以下选项来自当前内核。使用原生校验和持久化规则；一般在新会话中生效。")} />
            <select aria-label={t("配置分组")} value={group} onChange={event => setGroup(event.target.value)}><option value="">{t("全部分组")}</option>{Object.entries(groups).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select>
            <input className="native-settings-filter" aria-label={t("搜索设置")} placeholder={t("搜索设置，如 compaction、retry、lsp、browser…")} value={filter} onChange={event => setFilter(event.target.value)} />
            {fields.filter(item => item.id !== "defaultThinkingLevel" && (!group || item.tab === group) && `${names[item.id] ?? ""} ${item.id} ${item.label} ${item.description}`.toLowerCase().includes(filter.toLowerCase())).map(item =>
              <SettingRow key={`${item.id}-${item.value}`} item={item} save={save} busy={busy} />)}
          </section>}
      </div>
    </div>
  </div>;
}
