import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { notify } from "../../state/workbench";
import { Button } from "../ui";
import { Field, SectionTitle } from "./controls";

export function WebSettings() {
  const [providers, setProviders] = useState<Array<{ id: "tavily" | "firecrawl"; configured: boolean; source: string }>>([]);
  const [desktopBrowser, setDesktopBrowser] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const next = await api.webProviders();
    setProviders(next.providers); setDesktopBrowser(next.desktopBrowser);
  };
  useEffect(() => { void refresh().catch(error => notify(error instanceof Error ? error.message : String(error))); }, []);
  const save = async (id: "tavily" | "firecrawl") => {
    setBusy(true);
    try {
      await api.setWebKey(id, keys[id] ?? "");
      setKeys(current => ({ ...current, [id]: "" }));
      await refresh();
      notify(`${id} 密钥已保存`, "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const remove = async (id: "tavily" | "firecrawl") => {
    setBusy(true);
    try { await api.removeWebKey(id); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="web-settings">
    <SectionTitle title="网页服务" description="Alpha 内核使用 Tavily 搜索和 Firecrawl 提取、采集；网页窗口使用独立登录会话。密钥只在桌面端加密保存，也可通过环境变量提供。" />
    <p className="settings-note">内置网页浏览器：{desktopBrowser ? "可用" : "仅桌面端可用"}</p>
    {providers.map(provider => <Field key={provider.id} stacked label={provider.id} description={provider.configured ? `已配置 · ${provider.source === "environment" ? "环境变量" : "桌面密钥库"}` : "尚未配置；调用时会明确返回不可用"}>
      <div className="settings-inline">
        <input className="settings-text" type="password" aria-label={`${provider.id} API Key`} value={keys[provider.id] ?? ""} onChange={event => setKeys(current => ({ ...current, [provider.id]: event.target.value }))} placeholder="API Key" autoComplete="off" />
        <Button size="sm" busy={busy} disabled={!desktopBrowser || !keys[provider.id]?.trim()} onClick={() => void save(provider.id)}>保存</Button>
        {provider.configured && provider.source !== "environment" && <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(provider.id)}>移除</Button>}
      </div>
    </Field>)}
  </div>;
}
