import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "../api/client";
import type { PromptCategory, PromptRefinement } from "../api/types";
import { modelName } from "./ModelPicker";
import { Button } from "./ui";
import { useStore } from "../state/store";
import { store } from "../state/workbench";
import "./PromptRefine.css";

const CATEGORY_NAMES: Record<PromptCategory, string> = {
  software: "软件开发", research: "事实与研究", creative: "创意生成", writing: "写作沟通", general: "通用",
};

export function PromptRefine({ value, onApply, optimizationModel, disabled = false }: {
  value: string;
  onApply(value: string): void;
  optimizationModel: string | null | undefined;
  disabled?: boolean;
}) {
  const catalog = useStore(store, state => state.models);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PromptRefinement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestValue = useRef(value);
  const resultSource = useRef("");
  const dialog = useRef<HTMLDivElement>(null);
  latestValue.current = value;
  const shown = result && resultSource.current === value ? result : null;
  useEffect(() => { setResult(null); setError(null); }, [value]);
  useEffect(() => { if (shown || error) dialog.current?.focus(); }, [shown, error]);

  const run = async () => {
    const source = value.trim();
    if (!source || !optimizationModel || busy) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const next = await api.refinePrompt(source, optimizationModel);
      if (latestValue.current.trim() === source) {
        resultSource.current = latestValue.current;
        setResult(next);
      }
    } catch (cause) {
      if (latestValue.current.trim() === source) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const apply = (text: string) => {
    onApply(text);
    setResult(null);
    setError(null);
  };

  return <>
    <Button variant="ghost" size="sm" icon={Sparkles} onClick={() => void run()} disabled={disabled || !value.trim() || !optimizationModel || busy} busy={busy} title="按提示词类别整理并翻译为英文；结果需确认后才替换输入">优化并英译</Button>
    {(shown || error) && <div className="prompt-refine-overlay" onClick={event => { if (event.target === event.currentTarget) { setResult(null); setError(null); } }} onKeyDown={event => { if (event.key === "Escape") { setResult(null); setError(null); } }}>
      <div className="prompt-refine-review" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="提示词优化结果">
      {error && <p className="prompt-refine-warning" role="alert">{error}</p>}
      {shown && <>
        <div className="prompt-refine-heading"><strong>{CATEGORY_NAMES[shown.category]}</strong><span>优化：{modelName(shown.optimizationModel, catalog)} · 英译：{modelName(shown.translationModel, catalog)}</span></div>
        {shown.warnings.length > 0 && <div className="prompt-refine-warning" role="alert">{shown.warnings.map(item => <p key={item}>{item}</p>)}</div>}
        <div className="prompt-refine-texts">
          <div><strong>原文</strong><pre>{value}</pre></div>
          <div><strong>{shown.usedOriginal ? "原文保留" : "优化稿"}</strong><pre>{shown.optimized}</pre></div>
          <div><strong>英文版</strong><pre>{shown.english}</pre></div>
        </div>
        {shown.changes.length > 0 && <p className="prompt-refine-note">模型说明的改动：{shown.changes.join("；")}</p>}
        {shown.unresolved.length > 0 && <p className="prompt-refine-note">待明确：{shown.unresolved.join("；")}</p>}
        <div className="prompt-refine-actions">
          {!shown.usedOriginal && shown.optimized !== value.trim() && <Button size="sm" onClick={() => apply(shown.optimized)}>使用优化稿</Button>}
          <Button size="sm" variant="primary" onClick={() => apply(shown.english)}>使用英文版</Button>
          <Button size="sm" variant="ghost" onClick={() => setResult(null)}>保留原文</Button>
        </div>
      </>}
      {error && <div className="prompt-refine-actions"><Button size="sm" onClick={() => setError(null)}>关闭</Button></div>}
      </div>
    </div>}
  </>;
}
