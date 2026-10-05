import { t } from "./ui-language";
import { useEffect, useState } from "react";
import { Field } from "../components/settings/controls";
import { nativeApi } from "./native-api";

type Config = { path: string; revision: string; config: { providers?: Record<string, unknown> }; pendingReload?: boolean };
export function NativeProviders({ onSaved }: { onSaved(): Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [key, setKey] = useState("");
  const [keyless, setKeyless] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const read = async () => { const value = await nativeApi<Config>("provider-config"); setConfig(value); setDraft(JSON.stringify(value.config, null, 2)); };
  useEffect(() => { void read().catch(cause => setError(String(cause))); }, []);
  const save = async (value: unknown) => {
    if (!config) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await nativeApi<Config>("provider-config", { config: value, revision: config.revision });
      setConfig(result); setDraft(JSON.stringify(result.config, null, 2)); setKey("");
      await onSaved();
      setNotice(result.pendingReload ? "配置已保存；已打开的会话需重新加载后使用新服务商。" : "配置已保存，模型目录已更新。");
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  return <details className="native-provider-config">
    <summary>{t("自定义服务商与端点")}</summary>
    {error && <p role="alert" className="native-settings-error">{t(error)}</p>}{notice && <p role="status">{t(notice)}</p>}
    <form onSubmit={event => {
      event.preventDefault();
      if (config?.config.providers?.[name]) { setError("服务商名称已存在，请在下方编辑原有配置。"); return; }
      void save({ ...config?.config, providers: { ...config?.config.providers, [name]: { baseUrl: endpoint, api, ...(keyless ? { auth: "none" } : { apiKey: key }), models: [{ id: model }] } } });
    }}>
      <Field label={t("服务商名称")}><input aria-label={t("自定义服务商名称")} required pattern="[a-zA-Z0-9_-]+" value={name} onChange={event => setName(event.target.value)} /></Field>
      <Field label={t("API 端点")}><input aria-label={t("自定义 API 端点")} type="url" required placeholder="https://example.com/v1" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></Field>
      <Field label={t("协议")}><select aria-label={t("自定义 API 协议")} value={api} onChange={event => setApi(event.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></Field>
      <Field label={t("模型 ID")}><input aria-label={t("自定义模型 ID")} required value={model} onChange={event => setModel(event.target.value)} /></Field>
      <Field label="API Key"><input aria-label={t("自定义 API Key")} type="password" autoComplete="off" disabled={keyless} required={!keyless} value={key} onChange={event => setKey(event.target.value)} /><label><input type="checkbox" checked={keyless} onChange={event => setKeyless(event.target.checked)} />{t("无需鉴权（本机服务）")}</label></Field>
      <button disabled={busy || !config}>{t("添加服务商")}</button>
    </form>
    <details><summary>{t("高级配置")}</summary>
      <p className="native-muted">{t("原生模型配置。密钥以 •••• 显示，保存时保留原值；可在这里调整上下文、输出上限、价格、请求头和模型发现。")}</p>
      <textarea aria-label={t("原生服务商配置")} rows={16} spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} />
      <button disabled={busy || !config} onClick={() => { try { void save(JSON.parse(draft)); } catch (cause) { setError(String(cause)); } }}>{t("保存配置")}</button>
    </details>
    <button disabled={busy} onClick={() => void read().catch(cause => setError(String(cause)))}>{t("重新读取")}</button>
    <p className="native-muted">{config?.path}</p>
  </details>;
}
