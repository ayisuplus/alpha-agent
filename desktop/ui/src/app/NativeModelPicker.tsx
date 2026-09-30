import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Search, Settings } from "lucide-react";
import type { NativeModel } from "./native-api";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

export function NativeModelPicker({ models, value, onChange, label = "选择模型", disabled = false, thinking, onThinkingChange, onOpenSettings }: {
  models: NativeModel[]; value: string; onChange(value: string): void; label?: string; disabled?: boolean;
  thinking?: string; onThinkingChange?(value: string): void; onOpenSettings?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"models" | "thinking">("models");
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const selected = models.find(model => model.selector === value);
  const available = models.filter(model => model.available && `${model.name} ${model.selector}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="native-model-picker" ref={root} onKeyDown={event => { if (event.key === "Escape") { if (view === "thinking") setView("models"); else setOpen(false); } }}>
    <button className="native-model-trigger" aria-label={label} aria-expanded={open} disabled={disabled} onClick={() => { setView("models"); setOpen(!open); }}>{selected?.name ?? (value || label)}<ChevronDown size={13} /></button>
    {open && <div className="native-model-menu" role="dialog" aria-label={view === "thinking" ? "推理强度" : "模型选择"}>
      {view === "thinking" ? <>
        <button className="native-model-back" autoFocus onClick={() => setView("models")} aria-label="返回模型选择"><ArrowLeft size={14} /> 推理强度</button>
        <div className="native-model-options">{THINKING_LEVELS.map(level => <button key={level} aria-pressed={thinking === level} onClick={() => { onThinkingChange?.(level); setOpen(false); }}><strong>{level === "auto" ? "auto · 跟随全局默认" : level}</strong></button>)}</div>
      </> : <>
        <label><Search size={14} /><input autoFocus aria-label="搜索模型" placeholder="搜索模型或服务商" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="native-model-options">{available.map(model => <button key={model.selector} aria-pressed={model.selector === value} onClick={() => { onChange(model.selector); setOpen(false); }}><strong>{model.name}</strong><small>{model.provider} · {Math.round(model.contextWindow / 1000)}k</small></button>)}{!available.length && <p>没有可用模型，请到设置中配置服务商。</p>}</div>
        {(onThinkingChange || onOpenSettings) && <div className="native-model-actions">
          {onThinkingChange && <button onClick={() => setView("thinking")}><span>推理强度</span><small>{thinking === "auto" ? "跟随全局默认" : thinking}</small><ChevronRight size={14} /></button>}
          {onOpenSettings && <button onClick={() => { setOpen(false); onOpenSettings(); }}><Settings size={14} /> 模型与账号配置</button>}
        </div>}
      </>}
    </div>}
  </div>;
}
