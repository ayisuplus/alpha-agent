import { tf, t } from "./ui-language";
import { useEffect, useState } from "react";
import { Field, SectionTitle } from "../components/settings/controls";
import { NativeModal } from "./NativeModal";
import { nativeApi, type SessionItem } from "./native-api";
import type { ExtensionCatalog, ExtensionRow } from "../../../../src/native/host-types";

const labels = { skill: "技能", mcp: "MCP", plugin: "插件" };
const statuses: Record<string, string> = { loaded: "已加载", configured: "已配置，未加载", disabled: "已禁用", connected: "已连接", connecting: "连接中", disconnected: "未连接", bundled: "随包加载", overridden: "已被覆盖", needs_adaptation: "接口需要适配" };

export function NativeExtensions({ kind, sessionId, onUse }: { kind: ExtensionRow["kind"]; sessionId: string | null; onUse(name: string): void }) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selected, setSelected] = useState(sessionId ?? "");
  const [catalog, setCatalog] = useState<ExtensionCatalog | null>(null);
  const [filter, setFilter] = useState("");
  const [row, setRow] = useState<ExtensionRow | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [scope, setScope] = useState(kind === "plugin" ? "user" : "project");
  const [content, setContent] = useState("");
  const [previous, setPrevious] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [output, setOutput] = useState<unknown>(null);
  const [inputDialog, setInputDialog] = useState<"oauth" | "features" | null>(null);
  const [inputValue, setInputValue] = useState("");
  useEffect(() => { void nativeApi<{ sessions: SessionItem[] }>("sessions").then(value => { setSessions(value.sessions); }, cause => setError(String(cause))); }, []);
  const refresh = async () => { if (selected) { const value = await nativeApi<ExtensionCatalog>(`sessions/${selected}/host/catalog`); setCatalog(value); return value; } };
  useEffect(() => {
    let current = true;
    setRow(null); setCatalog(null);
    if (selected) void nativeApi<ExtensionCatalog>(`sessions/${selected}/host/catalog`).then(value => { if (current) setCatalog(value); }, cause => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [selected, kind]);
  async function run(action: string, input: Record<string, unknown> = {}) {
    if (!selected) { setError("请选择一个会话，读取它实际加载的扩展。"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await nativeApi<{ result?: unknown; pendingReload?: boolean }>(`sessions/${selected}/host/extension`, { kind, action, name: row?.name ?? name, scope, ...input });
      if (result.result !== undefined) setOutput(result.result);
      setNotice(result.pendingReload ? "已保存，当前会话忙碌，待重新加载。" : ["read", "references", "oauth-status"].includes(action) ? "" : "操作成功。请以刷新后的加载状态为准。");
      const fresh = await refresh();
      if (["save", "add"].includes(action) && kind !== "plugin") {
        const saved = fresh?.entries.find(entry => entry.kind === kind && entry.name === (input.name ?? row?.name ?? name) && entry.scope === scope);
        if (saved) setRow(saved);
        if (kind === "skill") setPrevious(String(input.content ?? ""));
      }
      return result.result;
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function open(entry: ExtensionRow) {
    setRow(entry); setName(entry.name); setOutput(null); setError(""); setReferences([]);
    setScope(entry.scope === "project" ? "project" : kind === "skill" && entry.scope !== "user" ? "project" : "user");
    if (kind === "skill") {
      const result = await run("read", { id: entry.id }) as { content: string } | undefined;
      if (result) { setContent(result.content); setPrevious(result.content); }
      const files = await run("references", { id: entry.id }) as { files: string[] } | undefined;
      if (files) setReferences(files.files);
    } else setContent(JSON.stringify(kind === "mcp" ? (entry.details as { config: unknown }).config : (entry.details as { settings?: unknown })?.settings ?? {}, null, 2));
  }
  const rows = catalog?.entries.filter(entry => entry.kind === kind && (!row || entry.id === row.id) && `${entry.name} ${entry.description ?? ""} ${entry.source}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const commit = () => { if (kind === "skill") void run("save", { name, content, previous: row?.scope === scope ? previous : undefined }); else { try { void run(row ? "save" : "add", { name, config: JSON.parse(content) }); } catch (cause) { setError(String(cause)); } } };
  return <section className="native-extension-manager">
    <SectionTitle title={labels[kind]} description={t("来源和配置与原生运行时共用。加载状态来自下方选定的会话。")} />
    <Field label={t("运行时会话")} description={sessions.find(item => item.id === selected)?.cwd ?? "选择会话后打开真实运行时目录。"}>
      <select aria-label={t("扩展运行时会话")} disabled={busy} value={selected} onChange={event => setSelected(event.target.value)}><option value="">{t("选择会话…")}</option>{sessions.filter(item => !item.archived).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <button disabled={busy} onClick={() => { setBusy(true); void nativeApi<{ session: SessionItem }>("sessions", { title: "扩展管理" }).then(value => { setSessions(items => [value.session, ...items]); setSelected(value.session.id); }, cause => setError(String(cause))).finally(() => setBusy(false)); }}>{t("新建管理会话")}</button>
      <button disabled={busy || !selected} onClick={() => void refresh().catch(cause => setError(String(cause)))}>{t("刷新状态")}</button>
      <button disabled={busy || !selected} onClick={() => { setBusy(true); void nativeApi<ExtensionCatalog & { pendingReload?: boolean }>(`sessions/${selected}/host/reload`, {}).then(value => { if (value.pendingReload) setNotice("会话仍在工作，请在结束后重新加载。"); else { setCatalog(value); setNotice("已重新加载原生运行时。"); } }, cause => setError(String(cause))).finally(() => setBusy(false)); }}>{t("重新加载")}</button>
    </Field>
    {error && <p role="alert" className="native-settings-error">{t(error)}</p>}{notice && <p role="status" className="native-settings-notice">{t(notice)}</p>}
    {catalog?.pendingReload && <p role="status" className="native-settings-notice">{t("扩展配置已改变，此会话需重新加载后生效。")}</p>}
    {row && <button onClick={() => { setRow(null); setContent(""); setOutput(null); setReferences([]); }}>{t("返回目录")}</button>}
    <input className="native-settings-filter" aria-label={tf`搜索${t(labels[kind])}`} placeholder={tf`搜索${t(labels[kind])}…`} value={filter} onChange={event => setFilter(event.target.value)} />
    {catalog?.warnings.map((warning, index) => <p className="native-settings-error" key={index}>{warning}</p>)}
    {rows.map(entry => <div key={entry.id} className="native-extension-row">
      <div className="native-file"><button disabled={busy} onClick={() => void open(entry)}>{entry.name}</button><span className="native-muted">{entry.version} · {t(statuses[entry.status] ?? entry.status)} · {entry.scope}</span>
        {kind === "skill" && <button disabled={!entry.loaded || selected !== sessionId} title={selected !== sessionId ? t("请先切换到这个会话，再用于当前任务") : undefined} onClick={() => onUse(entry.name)}>{t("用于当前任务")}</button>}
        {(kind === "skill" || entry.scope !== "bundled") && <button disabled={busy || entry.status === "needs_adaptation"} onClick={() => void run("toggle", { name: entry.name, scope: entry.scope, enabled: !entry.enabled })}>{entry.enabled ? t("禁用") : t("启用")}</button>}
        {kind !== "skill" && entry.scope !== "bundled" && <button disabled={busy} onClick={() => { if (window.confirm(tf`卸载 / 删除 ${entry.name}？`)) void run("remove", { name: entry.name, scope: entry.scope }); }}>{t("移除")}</button>}
        {kind === "mcp" && <button disabled={busy} onClick={() => void run("reconnect", { name: entry.name })}>{t("测试 / 重连")}</button>}
        {kind === "plugin" && entry.scope !== "bundled" && <button disabled={busy} onClick={() => void run("upgrade", { name: entry.name, scope: entry.scope })}>{t("更新")}</button>}
      </div><p className="native-muted">{entry.description}<br />{entry.source} {entry.license && `· ${entry.license}`}</p>{entry.error && <p role="alert">{entry.error}</p>}
    </div>)}
    {selected && <>
      <h3 className="settings-subheading">{row ? tf`编辑 ${row.name}` : kind === "plugin" ? t("安装 / 链接") : t("添加 / 导入")}</h3>
      <Field label={t("名称 / 包来源")}><input aria-label={t("扩展名称")} value={name} onChange={event => setName(event.target.value)} /><button onClick={() => { setRow(null); setName(""); setContent(kind === "mcp" ? '{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}' : ""); setPrevious(""); }}>{t("新建")}</button></Field>
      {<Field label={t("保存位置")} description={kind === "skill" ? t("内置或插件 Skill 的修改会复制到这里；不会修改随包来源。") : t("外部工具配置只读；编辑会写入选定的原生覆盖配置。")}><select aria-label={t("扩展作用域")} value={scope} onChange={event => setScope(event.target.value)}><option value="project">{t("项目")}</option><option value="user">{t("用户")}</option></select></Field>}
      {kind !== "mcp" && <Field label={t("本地目录")}><input aria-label={t("扩展目录")} value={path} onChange={event => setPath(event.target.value)} /><button onClick={() => void window.alpha?.choosePaths?.("directory").then(paths => { if (paths[0]) setPath(paths[0]); })}>{t("选择目录")}</button><button disabled={busy || !path || (kind === "skill" && !name)} onClick={() => void run(kind === "skill" ? "import" : "link", { name, path })}>{kind === "skill" ? t("导入目录") : t("链接目录")}</button></Field>}
      {kind === "plugin" ? <><button disabled={busy || !name} onClick={() => void run("install", { name })}>{t("安装原生包")}</button><button disabled={busy} onClick={() => void run("doctor")}>{t("原生诊断")}</button><p className="native-muted">{t("OpenCode JS/npm 插件接口需要适配，不能直接执行。npm 包与本地链接保存到用户目录；name@marketplace 可安装到项目。")}</p><Field label={t("原生插件市场来源")}><input aria-label={t("插件市场来源")} value={path} onChange={event => setPath(event.target.value)} placeholder={t("本地市场目录或原生支持的仓库来源")} /><button disabled={busy || !path} onClick={() => void run("marketplace", { path })}>{t("添加市场")}</button><button disabled={busy} onClick={() => void run("marketplaces")}>{t("查看市场")}</button></Field></> : <Field label={kind === "skill" ? t("Skill 正文") : t("原生 MCP 配置（JSON）")} stacked><textarea aria-label={t("扩展内容")} rows={14} spellCheck={false} value={content} onChange={event => setContent(event.target.value)} /><button disabled={busy || !name || !content} onClick={commit}>{t("保存")}</button></Field>}
      {kind === "skill" && references.length > 0 && <Field label={t("参考材料")}>{references.map(reference => <button key={reference} disabled={busy} onClick={() => void run("read", { id: row?.id, reference })}>{reference}</button>)}</Field>}
      {kind === "mcp" && row && <><button disabled={busy} onClick={() => void run("refresh")}>{t("刷新工具列表")}</button><button disabled={busy} onClick={() => void run("oauth")}>{t("OAuth 授权")}</button><button onClick={() => void run("oauth-status").then(value => { const url = (value as { url?: string })?.url; if (url) void window.alpha?.openExternal?.(url); })}>{t("授权状态 / 打开授权页")}</button><button onClick={() => { setInputDialog("oauth"); setInputValue(""); }}>{t("输入回调")}</button><button onClick={() => void run("oauth-cancel")}>{t("取消授权")}</button></>}
      {row && kind !== "skill" && <details open><summary>{t("功能、工具与资源")}</summary><pre className="native-code-block">{JSON.stringify(row.details, null, 2)}</pre>{kind === "mcp" && ((row.details as { resources?: Array<{ uri: string; name?: string }> }).resources ?? []).map(resource => <button key={resource.uri} onClick={() => void run("resource", { uri: resource.uri })}>{resource.name ?? resource.uri}</button>)}
        {kind === "plugin" && row.scope !== "bundled" && <><Field label={t("配置项")}><input aria-label={t("插件配置键")} placeholder={t("配置键")} value={path} onChange={event => setPath(event.target.value)} /><input aria-label={t("插件配置值")} type="password" placeholder={t("JSON 值")} value={content} onChange={event => setContent(event.target.value)} /><button disabled={busy} onClick={() => { try { void run("setting", { key: path, value: JSON.parse(content) }); } catch (cause) { setError(String(cause)); } }}>{t("保存配置")}</button></Field><button onClick={() => { setInputDialog("features"); setInputValue(((row.details as { features?: string[] }).features ?? []).join(", ")); }}>{t("选择功能")}</button></>}
      </details>}
      {output !== null && <details open><summary>{t("操作结果")}</summary><pre className="native-code-block">{JSON.stringify(output, null, 2)}</pre></details>}
      {inputDialog && <NativeModal title={inputDialog === "oauth" ? t("输入授权回调") : t("选择插件功能")} onCancel={() => setInputDialog(null)}>
        <p>{inputDialog === "oauth" ? t("粘贴授权后的完整回调 URL 或授权码。") : t("启用的功能名称，以逗号分隔；留空使用默认值。")}</p>
        <input aria-label={t("扩展操作输入")} value={inputValue} onChange={event => setInputValue(event.target.value)} />
        <button onClick={() => setInputDialog(null)}>{t("取消")}</button><button disabled={busy || inputDialog === "oauth" && !inputValue.trim()} onClick={() => {
          void (inputDialog === "oauth" ? run("oauth-code", { code: inputValue }) : run("features", { features: inputValue.trim() ? inputValue.split(",").map(item => item.trim()) : null }));
          setInputDialog(null); setInputValue("");
        }}>{t("确认")}</button>
      </NativeModal>}
    </>}
  </section>;
}
