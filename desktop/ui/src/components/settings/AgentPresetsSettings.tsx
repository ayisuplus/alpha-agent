import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { AgentPreset, AgentPresetSummary } from "../../api/types";
import { notify } from "../../state/workbench";
import { Markdown } from "../Markdown";
import { Button } from "../ui";
import { SectionTitle, Toggle } from "./controls";
import "./agent-presets.css";

type Draft = Pick<AgentPreset, "name" | "description" | "instructions">;

export function AgentPresetsSettings() {
  const [presets, setPresets] = useState<AgentPresetSummary[]>([]);
  const [selectedId, setSelectedId] = useState("general");
  const [selected, setSelected] = useState<AgentPreset | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const all = await api.agentPresets();
    setPresets(all);
    if (!all.some(item => item.id === selectedId)) setSelectedId(all[0]?.id ?? "general");
  };

  useEffect(() => { void refresh().catch(error => notify(error instanceof Error ? error.message : String(error))); }, []);
  useEffect(() => {
    let current = true;
    setSelected(null);
    void api.agentPreset(selectedId).then(preset => {
      if (!current) return;
      setSelected(preset);
      setDraft({ name: preset.name, description: preset.description, instructions: preset.instructions });
    }).catch(error => { if (current) notify(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [selectedId]);

  const updateEnabled = async (item: AgentPresetSummary, enabled: boolean) => {
    setBusy(true);
    try {
      const next = await api.setAgentPresetEnabled(item.id, enabled);
      setPresets(all => all.map(preset => preset.id === item.id ? { ...preset, enabled: next.enabled } : preset));
      if (selected?.id === item.id) setSelected(next);
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const created = await api.copyAgentPreset(selected.id);
      await refresh();
      setSelectedId(created.id);
      notify("角色副本已创建，可修改详细指令", "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      const updated = await api.updateAgentPreset(selected.id, draft);
      setSelected(updated);
      await refresh();
      notify("角色预设已保存，下轮运行生效", "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <section className="agent-presets-settings">
    <SectionTitle title="角色预设" description="主代理按工单自动选择启用的专业角色。当前运行使用开始时的版本；通用 worker 始终可用。" />
    <div className="agent-presets-layout">
      <div className="agent-presets-list" aria-label="可用角色">
        {presets.map(item => <div className="agent-preset-row" key={item.id}>
          <button className="agent-preset-select" aria-current={selectedId === item.id ? "true" : undefined} onClick={() => setSelectedId(item.id)}>
            <strong>{item.name}</strong><small>{item.description}</small>
          </button>
          <Toggle label={`启用 ${item.name}`} checked={item.enabled} disabled={busy || item.id === "general"} onChange={enabled => void updateEnabled(item, enabled)} />
        </div>)}
      </div>
      {selected && draft && <div className="agent-preset-detail">
        <div className="agent-preset-title"><h3>{selected.name}</h3><span>{selected.builtin ? "内置" : "自定义"} · {selected.hash.slice(0, 8)}</span></div>
        {selected.source && <p className="agent-preset-source">来源：{selected.source.url}/{selected.source.path} · {selected.source.revision.slice(0, 8)}</p>}
        {selected.basedOn && <p className="agent-preset-source">基于：{selected.basedOn}</p>}
        {selected.builtin ? <>
          <div className="agent-preset-body"><Markdown text={selected.instructions} /></div>
          <Button size="sm" busy={busy} disabled={busy} onClick={() => void copy()}>复制并修改</Button>
        </> : <>
          <label>名称<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>适用说明<input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
          <label>详细指令<textarea value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} rows={14} /></label>
          <Button size="sm" busy={busy} disabled={busy} onClick={() => void save()}>保存角色</Button>
          <div className="agent-preset-body"><Markdown text={draft.instructions} /></div>
        </>}
      </div>}
    </div>
  </section>;
}
