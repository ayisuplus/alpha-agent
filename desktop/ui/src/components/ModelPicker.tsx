import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Search } from "lucide-react";
import type { ModelCatalog, ModelInfo } from "../api/types";
import { useStore } from "../state/store";
import { loadModels, openSettings, store } from "../state/workbench";
import { Spinner } from "./ui";
import "./ModelPicker.css";

export function shortModel(selector: string): string {
  return selector.slice(selector.lastIndexOf("/") + 1);
}

export function modelName(selector: string | null, catalog: ModelCatalog | null): string {
  if (!selector) return "";
  return catalog?.models.find(model => model.selector === selector)?.name ?? shortModel(selector);
}

/** The model a "follow default" choice resolves to right now. */
export function effectiveDefault(catalog: ModelCatalog | null, settingsDefault: string | null): string | null {
  return settingsDefault ?? catalog?.builtin ?? null;
}

function contextLabel(model: ModelInfo): string | null {
  if (!model.contextWindow) return null;
  return model.contextWindow >= 1_000_000 ? `${Math.round(model.contextWindow / 100_000) / 10}M` : `${Math.round(model.contextWindow / 1000)}K`;
}

export function ModelTags({ model }: { model: ModelInfo }) {
  const context = contextLabel(model);
  return <span className="model-tags">
    {context && <span>{context}</span>}
    {model.reasoning && <span>推理</span>}
    {model.images && <span>看图</span>}
  </span>;
}

interface Props {
  /** The chosen model; null follows the workbench default (only offered when `allowDefault`). */
  value: string | null;
  onChange(value: string | null): void;
  allowDefault?: boolean;
  /** Wording of the null choice; tasks "follow the default", the default itself falls back to Alpha's built-in model. */
  defaultKind?: "task" | "builtin";
  defaultLabel?: string;
  defaultHint?: string;
  placement?: "up" | "down";
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
}

export function ModelPicker({ value, onChange, allowDefault, defaultKind = "task", defaultLabel, defaultHint, placement = "down", disabled, disabledReason, label = "模型" }: Props) {
  const catalog = useStore(store, state => state.models);
  const settingsDefault = useStore(store, state => state.settings?.model.default ?? null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadModels(); }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const fallback = defaultKind === "builtin" ? catalog?.builtin ?? null : effectiveDefault(catalog, settingsDefault);
  const defaultName = defaultKind === "builtin" ? "内置默认" : "默认";
  const shown = value ?? fallback;
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const models = (catalog?.models ?? []).filter(model => model.available && (!needle || `${model.name} ${model.selector}`.toLocaleLowerCase().includes(needle)));
    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
    return [...byProvider.entries()];
  }, [catalog, query]);

  const choose = (next: string | null) => {
    setOpen(false);
    setQuery("");
    if (next !== value) onChange(next);
  };

  const buttonText = value
    ? modelName(value, catalog)
    : allowDefault ? `${defaultLabel ?? defaultName} · ${defaultHint ?? (fallback ? modelName(fallback, catalog) : "…")}` : "选择模型";

  return <div className="model-picker" ref={root}>
    <button className="model-picker-button" aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
      title={disabled ? disabledReason : `${label}：${shown ?? "未选择"}`} onClick={() => setOpen(current => !current)}>
      <Bot size={14} aria-hidden />
      <span className="model-picker-value">{buttonText}</span>
      <ChevronDown size={13} aria-hidden />
    </button>
    {open && <div className={`model-popover ${placement}`} role="dialog" aria-label={`选择${label}`}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
      <label className="model-search">
        <Search size={13} aria-hidden />
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型" />
      </label>
      <div className="model-options" role="listbox">
        {!catalog && <p className="model-empty"><Spinner size={13} />正在读取模型…</p>}
        {allowDefault && catalog && !query && <button role="option" aria-selected={value === null} className="model-option" onClick={() => choose(null)}>
          <span className="model-option-main">
            <span className="model-option-name">{defaultLabel ?? (defaultKind === "builtin" ? "使用 Alpha 内置默认" : "跟随默认")}</span>
            <span className="model-option-id">{defaultHint ?? `${fallback ? modelName(fallback, catalog) : "未设置"}${defaultKind === "task" ? " · 在设置里修改" : ""}`}</span>
          </span>
          {value === null && <Check size={14} aria-hidden />}
        </button>}
        {groups.map(([provider, models]) => <div key={provider} className="model-group">
          <div className="model-group-label">{provider}</div>
          {models.map(model => <button key={model.selector} role="option" aria-selected={model.selector === value} className="model-option" onClick={() => choose(model.selector)}>
            <span className="model-option-main">
              <span className="model-option-name">{model.name}</span>
              <span className="model-option-id">{model.id}</span>
            </span>
            <ModelTags model={model} />
            {model.selector === value && <Check size={14} aria-hidden />}
          </button>)}
        </div>)}
        {catalog && !groups.length && <p className="model-empty">
          {query ? "没有匹配的可用模型" : "还没有可用的模型。"}
          {!query && <button className="link-button" onClick={() => { setOpen(false); openSettings("model"); }}>去设置 API Key</button>}
        </p>}
      </div>
    </div>}
  </div>;
}
