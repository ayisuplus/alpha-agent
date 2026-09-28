import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, UserRound } from "lucide-react";
import { api } from "../api/client";
import type { ExpertSummary } from "../api/types";
import { EXPERT_LINES, expertLineLabel } from "../state/labels";
import { openSettings } from "../state/workbench";
import { Spinner } from "./ui";
import "./ModelPicker.css";

let cached: ExpertSummary[] | null = null;

/** Enabled experts, shared across pickers; refreshed whenever a picker opens. */
async function loadExperts(): Promise<ExpertSummary[]> {
  cached = (await api.experts()).filter(item => item.enabled);
  return cached;
}

/** Finds the enabled expert derived from a core template, e.g. `xiaohongshu-planner` → `core-xiaohongshu-planner`. */
export function expertForTemplate(experts: readonly ExpertSummary[], templateId: string): ExpertSummary | undefined {
  return experts.find(item => item.id === `core-${templateId}`) ?? experts.find(item => item.basedOn === templateId);
}

export function useEnabledExperts(): ExpertSummary[] | null {
  const [experts, setExperts] = useState(cached);
  useEffect(() => {
    let current = true;
    void loadExperts().then(items => { if (current) setExperts(items); }).catch(() => undefined);
    return () => { current = false; };
  }, []);
  return experts;
}

/** Picks the expert a new task must involve; empty means Alpha chooses (or works alone). */
export function ExpertPicker({ value, onChange, placement = "up" }: { value: string; onChange(value: string): void; placement?: "up" | "down" }) {
  const [experts, setExperts] = useState(cached);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    void loadExperts().then(items => { if (current) setExperts(items); }).catch(() => undefined);
    return () => { current = false; };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  // A designated expert that was disabled meanwhile would be rejected at start; drop it instead.
  useEffect(() => { if (value && experts && !experts.some(item => item.id === value)) onChange(""); }, [value, experts]);

  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const shown = (experts ?? []).filter(item => !needle || `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle));
    const order = [...EXPERT_LINES.map(item => item.id as string), "custom"];
    const byLine = new Map<string, ExpertSummary[]>();
    for (const item of shown) byLine.set(item.line ?? "custom", [...(byLine.get(item.line ?? "custom") ?? []), item]);
    return [...byLine.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [experts, query]);

  const selected = experts?.find(item => item.id === value);
  const choose = (next: string) => {
    setOpen(false);
    setQuery("");
    if (next !== value) onChange(next);
  };

  return <div className="model-picker" ref={root}>
    <button className="model-picker-button" aria-haspopup="listbox" aria-expanded={open}
      title={selected ? `指定专家：${selected.name}。代码与网页任务由该专家的子代理执行，验收需要它完成的实例；其他任务把它作为主代理的专家视角` : "由 Alpha 按任务选择专家"} onClick={() => setOpen(current => !current)}>
      <UserRound size={14} aria-hidden />
      <span className="model-picker-value">{selected ? selected.name : "专家 · 自动"}</span>
      <ChevronDown size={13} aria-hidden />
    </button>
    {open && <div className={`model-popover ${placement}`} role="dialog" aria-label="指定专家"
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
      <label className="model-search">
        <Search size={13} aria-hidden />
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索专家" />
      </label>
      <div className="model-options" role="listbox">
        {!experts && <p className="model-empty"><Spinner size={13} />正在读取专家库…</p>}
        {experts && !query && <button role="option" aria-selected={!value} className="model-option" onClick={() => choose("")}>
          <span className="model-option-main">
            <span className="model-option-name">自动</span>
            <span className="model-option-id">Alpha 按任务从已启用专家中选择</span>
          </span>
          {!value && <Check size={14} aria-hidden />}
        </button>}
        {groups.map(([line, items]) => <div key={line} className="model-group">
          <div className="model-group-label">{expertLineLabel(line === "custom" ? undefined : items[0].line)}</div>
          {items.map(item => <button key={item.id} role="option" aria-selected={item.id === value} className="model-option" title={item.description} onClick={() => choose(item.id)}>
            <span className="model-option-main">
              <span className="model-option-name">{item.name}</span>
              <span className="model-option-id expert-option-description">{item.description}</span>
            </span>
            {item.id === value && <Check size={14} aria-hidden />}
          </button>)}
        </div>)}
        {experts && !groups.length && <p className="model-empty">
          {query ? "没有匹配的专家" : "还没有启用的专家。"}
          {!query && <button className="link-button" onClick={() => { setOpen(false); openSettings("agents"); }}>打开专家库</button>}
        </p>}
      </div>
    </div>}
  </div>;
}
