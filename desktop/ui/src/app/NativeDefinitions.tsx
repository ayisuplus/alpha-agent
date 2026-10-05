import { t } from "./ui-language";
import { useEffect, useState } from "react";
import { Field, SectionTitle } from "../components/settings/controls";
import { nativeApi } from "./native-api";
import type { DefinitionRow } from "../../../../src/native/definitions";

type Catalog = { entries: DefinitionRow[]; warnings: string[]; lsp: { configured: Array<{ name: string; status: string; fileTypes: string[]; error?: string }>; active: Array<{ name: string; status: string; fileTypes: string[] }> } };
const labels: Record<string, string> = { rule: "规则", command: "自定义命令", prompt: "提示词模板", task: "原生任务定义" };
type LspConfiguration = { path: string; config: unknown; revision: string; sources: Array<{ path: string; config?: unknown; error?: string; readOnly: boolean }>; effective: unknown };
export function NativeDefinitions({ sessionId, lsp = false }: { sessionId: string | null; lsp?: boolean }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [kind, setKind] = useState("rule");
  const [row, setRow] = useState<DefinitionRow | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("project");
  const [content, setContent] = useState("");
  const [previous, setPrevious] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [lspConfiguration, setLspConfiguration] = useState<LspConfiguration | null>(null);
  const [lspContent, setLspContent] = useState("");
  const request = <T,>(input: Record<string, unknown>) => nativeApi<T>(`sessions/${sessionId}/host/definitions`, input);
  const read = async () => { if (sessionId) setCatalog(await request<Catalog>({ action: "list" })); };
  useEffect(() => { let current = true; setCatalog(null); if (sessionId) void request<Catalog>({ action: "list" }).then(value => { if (current) setCatalog(value); }, cause => { if (current) setError(String(cause)); }); return () => { current = false; }; }, [sessionId]);
  const run = async (operation: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (cause) { setError(String(cause)); } finally { await read().catch(cause => setError(String(cause))); setBusy(false); } };
  const readLsp = async () => { const value = await request<LspConfiguration>({ action: "lsp-read", scope }); setLspConfiguration(value); setLspContent(JSON.stringify(value.config, null, 2)); };
  useEffect(() => { setLspConfiguration(null); if (sessionId && lsp) void readLsp().catch(cause => setError(String(cause))); }, [sessionId, lsp, scope]);
  const fresh = () => { setRow(null); setName(""); setPrevious(""); setContent(kind === "task" ? "---\nname: custom-task\ndescription: Describe the task\ntools: [read, grep, find]\n---\n" : "---\ndescription: Describe when to use this\n---\n"); };
  if (!sessionId) return <p>{t("请先打开一个会话，读取实际运行时。")}</p>;
  return <section>
    <SectionTitle title={lsp ? t("语言服务与格式化") : t("规则、命令与任务定义")} description={lsp ? t("状态来自当前会话的原生语言服务。未安装或项目未匹配的服务不会显示为已就绪。") : t("沿用原生发现和覆盖顺序。外部或内置定义的编辑会复制到选定目录。")} />
    {error && <p role="alert" className="native-settings-error">{t(error)}</p>}{notice && <p role="status">{t(notice)}</p>}
    <button disabled={busy} onClick={() => void run(read)}>{t("刷新状态")}</button>
    {lsp ? <>
      <button disabled={busy} onClick={() => void run(async () => { const value = await request<Catalog>({ action: "lsp-start" }); setCatalog(value); })}>{t("连接语言服务")}</button>
      <button disabled={busy} onClick={() => void run(async () => { await request({ action: "lsp-stop" }); })}>{t("停止语言服务")}</button>
      <h3>{t("项目可用服务")}</h3>
      {catalog?.lsp.configured.map(server => <p key={server.name}>{server.name} · {server.fileTypes.join(", ")} · {server.status}</p>)}
      {!catalog?.lsp.configured.length && <p className="native-muted">{t("没有检测到可用的语言服务。配置和可执行文件均由原生运行时检查。")}</p>}
      <h3>{t("实际连接")}</h3>{catalog?.lsp.active.map((server, index) => <p key={index}>{server.name} · {server.status}</p>)}
      <details><summary>{t("语言服务配置")}</summary>
        <Field label={t("保存位置")}><select aria-label={t("语言服务作用域")} value={scope} onChange={event => setScope(event.target.value)}><option value="project">{t("项目")}</option><option value="user">{t("用户")}</option></select></Field>
        <p className="native-muted">{t("沿用原生语言服务配置。disabled 控制启停；命令、参数、项目标记与格式化能力由原生服务处理。外部来源保持只读。")}</p>
        <p>{lspConfiguration?.path}</p><textarea aria-label={t("语言服务配置正文")} rows={12} value={lspContent} spellCheck={false} onChange={event => setLspContent(event.target.value)} />
        <button disabled={busy || !lspConfiguration} onClick={() => void run(async () => {
          const result = await request<{ pendingReload: boolean }>({ action: "lsp-save", scope, config: JSON.parse(lspContent), revision: lspConfiguration!.revision });
          await readLsp(); setNotice(result.pendingReload ? "已保存，当前会话待重新加载。" : "已保存并重新加载原生运行时。");
        })}>{t("保存配置")}</button><button disabled={busy} onClick={() => void run(readLsp)}>{t("重新读取")}</button>
        <details><summary>{t("配置来源与实际生效值")}</summary>{lspConfiguration?.sources.map(source => <div key={source.path}><p>{source.path} · {source.readOnly ? t("只读") : t("可编辑")}</p>{source.error && <p role="alert">{source.error}</p>}<pre className="native-code-block">{JSON.stringify(source.config, null, 2)}</pre></div>)}<pre className="native-code-block">{JSON.stringify(lspConfiguration?.effective, null, 2)}</pre></details>
      </details>
    </> : <>
      <Field label={t("定义类型")}><select aria-label={t("原生定义类型")} value={kind} onChange={event => { setKind(event.target.value); setRow(null); setName(""); setContent(""); }}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select></Field>
      <input aria-label={t("搜索原生定义")} placeholder={t("搜索名称与来源")} value={filter} onChange={event => setFilter(event.target.value)} />
      {catalog?.warnings.map((warning, index) => <p key={index} role="alert">{warning}</p>)}
      {catalog?.entries.filter(entry => entry.kind === kind && `${entry.name} ${entry.path ?? ""}`.toLowerCase().includes(filter.toLowerCase())).map((entry, index) => <div className="native-extension-row" key={`${entry.path ?? entry.name}-${index}`}>
        <button disabled={busy} onClick={() => void run(async () => { const value = await request<DefinitionRow & { content: string }>({ action: "read", kind, name: entry.name, path: entry.path }); setRow(value); setName(value.name); setContent(value.content); setPrevious(value.content); setScope(value.scope === "user" ? "user" : "project"); })}>{entry.name}</button>
        <small className="native-muted"> · {entry.scope} · {entry.loaded ? t("当前已加载") : entry.status === "overridden" ? t("已被覆盖") : kind === "task" ? t("调用时由原生加载") : t("已发现")}<br />{entry.path ?? entry.source}</small>
      </div>)}
      <button onClick={fresh}>{t("新建定义")}</button>
      <Field label={t("名称")}><input aria-label={t("原生定义名称")} value={name} onChange={event => setName(event.target.value)} /></Field>
      <Field label={t("保存位置")}><select aria-label={t("原生定义作用域")} value={scope} onChange={event => setScope(event.target.value)}><option value="project">{t("项目")}</option><option value="user">{t("用户")}</option></select></Field>
      <textarea aria-label={t("原生定义正文")} spellCheck={false} rows={16} value={content} onChange={event => setContent(event.target.value)} />
      <button disabled={busy || !content.trim() || !name.trim()} onClick={() => void run(async () => {
        const value = await request<{ path: string; pendingReload?: boolean }>({ action: "save", kind, name, scope, content, ...(row?.scope === scope && row.name === name ? { previous } : {}) });
        setRow({ kind, name, scope, path: value.path, source: "native", loaded: false, status: "discovered" }); setPrevious(content); setNotice(value.pendingReload ? "已保存，当前会话待重新加载。" : "已保存并重新加载原生运行时。");
      })}>{t("保存")}</button>
      {row?.path && <button onClick={() => void window.alpha?.openEditor?.(row.path!).catch(cause => setError(String(cause)))}>{t("在外部编辑器打开来源")}</button>}
    </>}
  </section>;
}
