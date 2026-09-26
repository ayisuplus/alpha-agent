import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../api/client";
import "./CapabilityPicker.css";

type Catalog = Awaited<ReturnType<typeof api.capabilities>>;

export function fileLimitReason(files: readonly File[], existing: readonly { size?: number | null }[] = []): string | null {
  if (files.length + existing.length > 20) return "每个任务最多添加 20 个文件";
  const large = files.find(file => file.size > 25_000_000);
  if (large) return `${large.name} 超过单文件 25 MB 上限`;
  if (files.reduce((size, file) => size + file.size, 0) + existing.reduce((size, file) => size + (file.size ?? 0), 0) > 50_000_000) return "文件总大小超过 50 MB 上限";
  return null;
}

function sizeLabel(size: number): string { return size < 1_000_000 ? `${Math.round(size / 1_000)} KB` : `${(size / 1_000_000).toFixed(1)} MB`; }

export function CapabilityPicker({ files, existingFiles = [], skillIds, pluginIds, onFiles, onSkills, onPlugins, direct = false, capabilitiesDisabled = false }: {
  files: File[]; skillIds: string[]; pluginIds: string[];
  existingFiles?: Array<{ size?: number | null }>;
  onFiles(files: File[]): void; onSkills(ids: string[]): void; onPlugins(ids: string[]): void;
  direct?: boolean; capabilitiesDisabled?: boolean;
}) {
  const [open, setOpen] = useState<"menu" | "skills" | "plugins" | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open === "skills" || open === "plugins") void api.capabilities().then(setCatalog).catch(cause => setError(String(cause))); }, [open]);
  const addFiles = (incoming: File[]) => {
    onFiles([...files, ...incoming]);
    if (fileInput.current) fileInput.current.value = "";
    setOpen(null);
  };
  const install = async () => {
    if (!source.trim()) return;
    setInstalling(true); setError(null);
    try { await api.installPlugin(source.trim()); setCatalog(await api.capabilities()); setSource(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setInstalling(false); }
  };
  const toggle = (items: string[], id: string, update: (items: string[]) => void) => update(items.includes(id) ? items.filter(item => item !== id) : [...items, id]);
  const limit = fileLimitReason(files, existingFiles);
  return <div className="capability-picker">
    <input ref={fileInput} type="file" multiple hidden aria-label="添加任务文件" onChange={event => addFiles(Array.from(event.target.files ?? []))} />
    <button className="capability-plus" type="button" aria-label="添加文件、Skill 或插件" aria-expanded={!!open} onClick={() => setOpen(open ? null : "menu")}><Plus size={17} aria-hidden /></button>
    {!!open && <div className="capability-popover" role="dialog" aria-label="添加任务材料和能力">
      <div className="capability-head"><strong>{open === "menu" ? "添加到当前任务" : open === "skills" ? "选择 Skill" : "选择插件"}</strong><button type="button" aria-label="关闭添加菜单" onClick={() => setOpen(null)}><X size={14} /></button></div>
      {open === "menu" ? <div className="capability-menu">
        <button type="button" onClick={() => fileInput.current?.click()}>添加文件</button>
        <button type="button" disabled={capabilitiesDisabled} onClick={() => setOpen("skills")}>添加 Skill</button>
        <button type="button" disabled={capabilitiesDisabled} onClick={() => setOpen("plugins")}>添加插件</button>
        {capabilitiesDisabled && <p>运行中的能力选择会在下一轮生效，请等本轮结束后选择。</p>}
      </div> : <>
        {!catalog ? <p>正在读取能力库…</p> : open === "skills" ? <div className="capability-list">{catalog.skills.map(skill => <label key={skill.id} title={skill.description}><input type="checkbox" checked={skillIds.includes(skill.id)} onChange={() => toggle(skillIds, skill.id, onSkills)} /><span>{skill.name}<small>{skill.description}</small></span></label>)}{!catalog.skills.length && <p>还没有已安装的 Skill。</p>}</div>
          : <div className="capability-list">{catalog.plugins.map(plugin => {
            const reason = direct ? "本机直连项目不能在沙箱外运行 Hook/MCP" : !plugin.enabled ? "插件已停用" : !plugin.hooksEnabled && !plugin.mcpEnabled ? "Hook/MCP 尚未启用" : null;
            return <label key={plugin.id} title={reason ?? plugin.source}><input type="checkbox" disabled={!!reason} checked={pluginIds.includes(plugin.id)} onChange={() => toggle(pluginIds, plugin.id, onPlugins)} /><span>{plugin.name}<small>{reason ?? `Hook ${plugin.hookCount} · MCP ${plugin.mcpCount}`}</small></span></label>;
          })}{!catalog.plugins.length && <p>还没有已安装的插件。</p>}</div>}
        <div className="capability-install"><input value={source} onChange={event => setSource(event.target.value)} placeholder="GitHub 仓库 HTTPS 地址" aria-label="安装 Skill 或插件的 GitHub 地址" /><button type="button" disabled={!source.trim() || installing} onClick={() => void install()}>{installing ? "安装中…" : "安装"}</button></div>
        {error && <p role="alert">{error}</p>}
        <button type="button" className="capability-back" onClick={() => setOpen("menu")}>返回</button>
      </>}
    </div>}
    {(files.length > 0 || skillIds.length > 0 || pluginIds.length > 0) && <div className="capability-tags">
      {files.map((file, index) => <span key={`${file.name}-${index}`} className="capability-tag" title={`${file.name} · ${sizeLabel(file.size)}`}>
        {file.name} · {sizeLabel(file.size)}<button type="button" aria-label={`移除文件 ${file.name}`} onClick={() => onFiles(files.filter((_, at) => at !== index))}><X size={12} /></button>
      </span>)}
      {skillIds.map(id => <span key={id} className="capability-tag">Skill · {id}<button type="button" aria-label={`移除 Skill ${id}`} onClick={() => onSkills(skillIds.filter(item => item !== id))}><X size={12} /></button></span>)}
      {pluginIds.map(id => <span key={id} className="capability-tag">插件 · {id}<button type="button" aria-label={`移除插件 ${id}`} onClick={() => onPlugins(pluginIds.filter(item => item !== id))}><X size={12} /></button></span>)}
    </div>}
    {limit && <p className="capability-error" role="alert">{limit}</p>}
  </div>;
}
