import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { NativeModel } from "./native-api";

export function NativeModelPicker({ models, value, onChange, label = "选择模型", disabled = false }: {
  models: NativeModel[]; value: string; onChange(value: string): void; label?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
  return <div className="native-model-picker" ref={root} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
    <button className="native-model-trigger" aria-label={label} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{selected?.name ?? (value || label)}<ChevronDown size={13} /></button>
    {open && <div className="native-model-menu"><label><Search size={14} /><input autoFocus aria-label="搜索模型" placeholder="搜索模型或服务商" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="native-model-options">{available.map(model => <button key={model.selector} aria-pressed={model.selector === value} onClick={() => { onChange(model.selector); setOpen(false); }}><strong>{model.name}</strong><small>{model.provider} · {Math.round(model.contextWindow / 1000)}k</small></button>)}{!available.length && <p>没有可用模型，请到设置中配置服务商。</p>}</div></div>}
  </div>;
}
