import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { api } from "../../api/client";
import type { Diagnostics, StorageReport } from "../../api/types";
import { notify } from "../../state/workbench";
import { Badge, Button, Spinner } from "../ui";
import { SectionTitle } from "./controls";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

async function openFolder(path: string): Promise<void> {
  if (!window.alpha?.openFolder) { notify("桌面端才能打开本机目录"); return; }
  const error = await window.alpha.openFolder(path);
  if (error) notify(error);
}

export function WorkspaceSettings() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const refresh = () => { void api.storage().then(setStorage).catch(error => notify(String(error))); };
  useEffect(() => { refresh(); void api.diagnostics().then(setDiagnostics).catch(error => notify(String(error))); }, []);

  const clean = async () => {
    if (!storage?.cleanup.count || !window.confirm(`清理 ${storage.cleanup.count} 个过期预览副本（约 ${bytes(storage.cleanup.bytes)}）？\n当前任务引用或正在运行的预览不会删除。`)) return;
    setCleaning(true);
    try {
      const result = await api.cleanupPreviews();
      notify(`已清理 ${result.removed} 个过期预览`, "info");
      refresh();
    } catch (error) { notify(String(error)); }
    finally { setCleaning(false); }
  };

  return <section>
    <SectionTitle title="工作区与数据" description="任务、验收证据和预览副本都保存在本机。清理只作用于不再使用的预览副本。" />
    <h3 className="settings-subheading">目录</h3>
    {!diagnostics ? <p className="settings-loading"><Spinner size={14} />正在读取目录…</p>
      : Object.entries(diagnostics.paths).map(([key, path]) => <div className="settings-path" key={key}>
        <span>{({ workspace: "工作区", data: "运行数据", products: "产品项目" } as Record<string, string>)[key]}</span>
        <code title={path}>{path}</code>
        <Button size="sm" icon={FolderOpen} onClick={() => void openFolder(path)}>打开</Button>
      </div>)}
    <div className="settings-subheading-row"><h3 className="settings-subheading">磁盘占用</h3>
      <Button size="sm" icon={RefreshCw} onClick={refresh}>刷新</Button></div>
    {!storage ? <p className="settings-loading"><Spinner size={14} />正在统计…</p>
      : <div className="settings-storage">
        {storage.categories.map(item => <div key={item.id}><span>{item.label}</span><strong>{bytes(item.bytes)}</strong></div>)}
      </div>}
    <div className="settings-cleanup">
      <p>可清理的过期预览：{storage ? `${storage.cleanup.count} 个，约 ${bytes(storage.cleanup.bytes)}` : "正在统计…"}</p>
      <Button size="sm" onClick={() => void clean()} disabled={!storage?.cleanup.count} busy={cleaning}>清理过期预览</Button>
    </div>
  </section>;
}

export function DiagnosticsSettings() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try { setDiagnostics(await api.diagnostics()); }
    catch (error) { notify(String(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const copy = async () => {
    if (!diagnostics) return;
    try { await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)); notify("诊断信息已复制", "info"); }
    catch { notify("无法访问剪贴板"); }
  };

  return <section>
    <SectionTitle title="诊断" description="检查本机服务和当前配置；离线项目只显示状态，不会自动启动或更换服务。" />
    <div className="settings-subheading-row"><h3 className="settings-subheading">准备情况</h3><Button size="sm" icon={RefreshCw} onClick={() => void refresh()} busy={loading}>重新检查</Button></div>
    {!diagnostics ? <p className="settings-loading"><Spinner size={14} />正在检查…</p>
      : <>
        <div className="diagnostic-list">{diagnostics.checks.map(check => <div key={check.id}>
          <span>{check.label}<small>{check.detail}</small></span><Badge tone={check.ok ? "success" : "warning"}>{check.ok ? "可用" : "不可用"}</Badge>
        </div>)}</div>
        <h3 className="settings-subheading">版本</h3>
        <p className="settings-note">Bun {diagnostics.versions.bun} · OMP {diagnostics.versions.omp} · Electron {diagnostics.versions.electron ?? "未在桌面端运行"}</p>
        <Button size="sm" onClick={() => void copy()}>复制诊断信息</Button>
      </>}
  </section>;
}
