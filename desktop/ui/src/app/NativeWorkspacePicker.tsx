import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { nativeApi } from "./native-api";
import { NativeModal } from "./NativeModal";
import { t } from "./ui-language";

export function NativeWorkspacePicker({ value, onChange, onError, disabled }: {
  value: string; onChange(value: string): void; onError(value: string): void; disabled?: boolean;
}) {
  const [projects, setProjects] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const select = useRef<HTMLSelectElement>(null);
  const load = () => nativeApi<{ projects: Array<{ cwd: string }> }>("projects").then(result => setProjects(result.projects.map(project => project.cwd)));
  useEffect(() => { void load().catch(cause => onError(String(cause))); }, []);
  const add = async (cwd: string) => {
    setBusy(true); setError("");
    try {
      const result = await nativeApi<{ project: { cwd: string } }>("projects", { action: "add", cwd: cwd.trim() });
      setProjects(current => [...new Set([...current, result.project.cwd])]);
      onChange(result.project.cwd);
      setDialog(false);
    } catch (cause) { if (dialog) setError(String(cause)); else onError(String(cause)); }
    finally { setBusy(false); requestAnimationFrame(() => select.current?.focus()); }
  };
  const pick = async () => {
    if (!window.alpha?.choosePaths) { setPath(""); setError(""); setDialog(true); return; }
    setBusy(true);
    try { const paths = await window.alpha.choosePaths("directory"); if (paths[0]) await add(paths[0]); }
    catch (cause) { onError(String(cause)); }
    finally { setBusy(false); requestAnimationFrame(() => select.current?.focus()); }
  };
  const choices = [...new Set([...(value ? [value] : []), ...projects])];
  return <>
    <div className="native-home-directory">
      <FolderOpen size={16} aria-hidden="true" />
      <select ref={select} aria-label={t("工作区")} title={value || t("使用 Alpha 默认工作目录")}
        value={value} disabled={disabled || busy} onFocus={() => void load().catch(cause => onError(String(cause)))} onPointerDown={() => void load().catch(cause => onError(String(cause)))}
        onChange={event => { if (event.target.value === "add-folder") void pick(); else onChange(event.target.value); }}>
        <option value="">{t("不在项目中工作")}</option>
        {!!choices.length && <optgroup label={t("已有项目")}>{choices.map(cwd => <option key={cwd} value={cwd}>{cwd}</option>)}</optgroup>}
        <option value="add-folder">{t("添加文件夹…")}</option>
      </select>
    </div>
    {dialog && <NativeModal title={t("添加文件夹")} onCancel={() => { if (!busy) setDialog(false); }}>
      <p className="native-muted">{t("输入本机文件夹的完整路径。")}</p>
      <label>{t("项目路径")}<input aria-label={t("项目路径")} value={path} disabled={busy} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && path.trim() && !busy) { event.preventDefault(); void add(path); } }} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="native-dialog-actions"><button disabled={busy} onClick={() => setDialog(false)}>{t("取消")}</button><button className="native-primary" disabled={busy || !path.trim()} onClick={() => void add(path)}>{t("添加文件夹")}</button></div>
    </NativeModal>}
  </>;
}
