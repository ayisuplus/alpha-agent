import { useEffect, useMemo, useState } from "react";
import { KeyRound, RefreshCw, TriangleAlert } from "lucide-react";
import { api } from "../../api/client";
import type { ProviderInfo } from "../../api/types";
import { useStore } from "../../state/store";
import { deleteApiKey, loadModels, saveApiKey, store, updateSettings } from "../../state/workbench";
import { ModelPicker, modelName } from "../ModelPicker";
import { Badge, Button, IconButton, Spinner } from "../ui";
import { Field, SectionTitle } from "./controls";

function originText(provider: ProviderInfo): { text: string; tone: "success" | "neutral" } {
  switch (provider.origin) {
    case "api_key": return { text: "已保存 API Key", tone: "success" };
    case "oauth": return { text: "已通过 OAuth 登录", tone: "success" };
    case "env": return { text: `来自环境变量${provider.envVar ? ` ${provider.envVar}` : ""}`, tone: "success" };
    case "config": return { text: "来自 OMP 配置文件", tone: "success" };
    case "runtime":
    case "fallback": return { text: "已认证", tone: "success" };
    default: return { text: "未认证", tone: "neutral" };
  }
}

function ProviderRow({ provider }: { provider: ProviderInfo }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const origin = originText(provider);
  // Only a key Alpha can see in the store may be replaced or removed; OAuth, environment and config credentials win over it.
  const managed = provider.origin === null || provider.origin === "api_key";

  const save = async () => {
    setBusy(true);
    const saved = await saveApiKey(provider.id, key);
    setBusy(false);
    if (saved) { setKey(""); setEditing(false); }
  };
  const remove = async () => {
    if (!window.confirm(`删除 ${provider.id} 的 API Key？\n它保存在 OMP 共享凭据库，删除后 OMP 命令行也无法再使用。`)) return;
    setBusy(true);
    await deleteApiKey(provider.id);
    setBusy(false);
  };

  return <div className="provider-row">
    <div className="provider-main">
      <span className="provider-name">{provider.id}</span>
      <span className="provider-meta">
        <Badge tone={origin.tone === "success" ? "success" : "neutral"}>{origin.text}</Badge>
        <span>{provider.available}/{provider.models} 个模型可用</span>
      </span>
    </div>
    {editing
      ? <form className="provider-key-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <input type="password" autoFocus autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)}
          placeholder="粘贴 API Key" aria-label={`${provider.id} 的 API Key`} className="settings-text" />
        <Button size="sm" variant="primary" type="submit" disabled={!key.trim()} busy={busy}>保存</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setKey(""); }}>取消</Button>
      </form>
      : <span className="provider-actions">
        {managed && <Button size="sm" icon={KeyRound} onClick={() => setEditing(true)} disabled={busy}>{provider.storedKey ? "更换 Key" : "添加 Key"}</Button>}
        {managed && provider.storedKey && <Button size="sm" variant="danger" onClick={() => void remove()} busy={busy}>删除</Button>}
        {!managed && <span className="provider-hint">在 OMP 中管理</span>}
      </span>}
  </div>;
}

export function ModelSettings() {
  const settings = useStore(store, state => state.settings)!;
  const catalog = useStore(store, state => state.models);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "failed"; text?: string }>({ state: "idle" });

  useEffect(() => { void loadModels(true); }, []);

  const effective = settings.model.default ?? catalog?.builtin ?? null;
  const defaultMissing = !!catalog && !!effective && !catalog.models.some(model => model.selector === effective && model.available);
  const providers = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    const list = (catalog?.providers ?? []).filter(provider => !needle || provider.id.toLocaleLowerCase().includes(needle));
    return needle || showAll ? list : list.filter(provider => provider.origin !== null);
  }, [catalog, filter, showAll]);
  const hidden = (catalog?.providers.length ?? 0) - (catalog?.providers.filter(provider => provider.origin !== null).length ?? 0);

  const runTest = async () => {
    if (!effective) return;
    setTest({ state: "running" });
    try {
      const result = await api.testModel(effective);
      setTest(result.ok ? { state: "ok", text: `可用 · ${(result.latencyMs / 1000).toFixed(1)} 秒` } : { state: "failed", text: result.error ?? "连接失败" });
    } catch (error) {
      setTest({ state: "failed", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await loadModels(true);
    setRefreshing(false);
  };

  return <section>
    <SectionTitle title="模型" description="新任务默认使用这里的模型；每个任务也可以在自己的头部单独选择。模型和认证来自本机的 OMP。" />
    <Field stacked label="默认模型" description={settings.model.default ? "只列出已经认证、支持工具调用的模型。" : "尚未指定，使用 Alpha 内置默认。"}>
      <span className="settings-inline">
        <ModelPicker value={settings.model.default} allowDefault defaultKind="builtin" label="默认模型"
          onChange={value => { setTest({ state: "idle" }); void updateSettings({ model: { default: value } }); }} />
        <Button size="sm" onClick={() => void runTest()} busy={test.state === "running"} disabled={!effective || defaultMissing}>测试连接</Button>
        {test.state === "ok" && <Badge tone="success">{test.text}</Badge>}
      </span>
    </Field>
    {test.state === "failed" && <p className="settings-error"><TriangleAlert size={14} aria-hidden />{test.text}</p>}
    {defaultMissing && <p className="settings-error"><TriangleAlert size={14} aria-hidden />默认模型 {modelName(effective, catalog)} 当前没有可用的认证，新任务会无法启动。请为它的服务商添加 API Key，或换一个模型。</p>}
    <p className="settings-note">「测试连接」会发送一次很短的请求，消耗极少量额度。</p>
    <Field stacked label="提示词英译模型" description="优化使用输入框对应的任务模型；英译可单独指定模型。未指定时沿用优化模型。">
      <ModelPicker value={settings.model.translation} allowDefault label="提示词英译模型" defaultLabel="跟随优化模型" defaultHint="使用当前输入框的模型"
        onChange={value => void updateSettings({ model: { translation: value } })} />
    </Field>

    <div className="settings-subheading-row">
      <h3 className="settings-subheading">服务商与 API Key</h3>
      <IconButton icon={RefreshCw} label="重新读取" onClick={() => void refresh()} disabled={refreshing} />
    </div>
    <p className="settings-note warning">API Key 保存在 OMP 的共享凭据库中，OMP 命令行也会使用它；Alpha 不会显示已保存的 Key。通过 OAuth、环境变量或配置文件认证的服务商请在 OMP 中管理。</p>
    <input className="settings-text settings-filter" value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选服务商" aria-label="筛选服务商" />
    {!catalog
      ? <p className="settings-loading"><Spinner size={14} />正在读取模型与认证…</p>
      : <div className="provider-list">
        {providers.map(provider => <ProviderRow key={provider.id} provider={provider} />)}
        {!providers.length && <p className="settings-note">{filter ? "没有匹配的服务商" : "还没有已认证的服务商。展开全部服务商来添加 API Key。"}</p>}
      </div>}
    {catalog && !filter && hidden > 0 && <button className="link-button settings-more" onClick={() => setShowAll(value => !value)}>
      {showAll ? "只显示已认证的服务商" : `显示全部服务商（另有 ${hidden} 个未认证）`}
    </button>}
  </section>;
}
