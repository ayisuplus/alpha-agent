import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { AgentPreset, AgentPresetSummary } from "../../api/types";
import { notify } from "../../state/workbench";
import { Markdown } from "../Markdown";
import { Button } from "../ui";
import { SectionTitle, Toggle } from "./controls";
import "./agent-presets.css";

type Draft = Pick<AgentPreset, "name" | "description" | "instructions"> & { skillIds: string };

export function AgentPresetsSettings() {
  const [presets, setPresets] = useState<AgentPresetSummary[]>([]);
  const [templates, setTemplates] = useState<AgentPresetSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<AgentPreset | null>(null);
  const [draft, setDraft] = useState<Draft | null>(() => {
    try { return JSON.parse(localStorage.getItem("alpha-expert-draft-new") ?? "null") as Draft | null; } catch { return null; }
  });
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [all, availableTemplates] = await Promise.all([api.agentPresets(), api.agentPresetTemplates()]);
    setPresets(all);
    setTemplates(availableTemplates);
  };

  useEffect(() => { void refresh().catch(error => notify(error instanceof Error ? error.message : String(error))); }, []);
  useEffect(() => {
    let current = true;
    setSelected(null);
    if (!selectedId) return () => { current = false; };
    void api.agentPreset(selectedId).then(preset => {
      if (!current) return;
      setSelected(preset);
      const saved = localStorage.getItem(`alpha-expert-draft-${preset.id}`);
      setDraft(saved ? JSON.parse(saved) as Draft : { name: preset.name, description: preset.description, instructions: preset.instructions, skillIds: (preset.skillIds ?? []).join(", ") });
    }).catch(error => { if (current) notify(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [selectedId]);
  useEffect(() => {
    if (draft && (selectedId === "" || selected?.id === selectedId)) localStorage.setItem(`alpha-expert-draft-${selectedId || "new"}`, JSON.stringify(draft));
  }, [draft, selected, selectedId]);

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
      notify("专家已加入专家库", "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      const updated = await api.updateAgentPreset(selected.id, { ...draft, skillIds: draft.skillIds.split(",").map(item => item.trim()).filter(Boolean) });
      setSelected(updated);
      localStorage.removeItem(`alpha-expert-draft-${selected.id}`);
      await refresh();
      notify("专家已保存，下次派发使用新版本", "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const created = await api.createAgentPreset({ ...draft, skillIds: draft.skillIds.split(",").map(item => item.trim()).filter(Boolean) });
      await refresh();
      setSelectedId(created.id);
      localStorage.removeItem("alpha-expert-draft-new");
      notify("专家已加入专家库", "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!selected || selected.builtin) return;
    setBusy(true);
    try {
      await api.deleteAgentPreset(selected.id);
      setSelectedId("");
      setSelected(null);
      setDraft(null);
      await refresh();
      notify("专家已从专家库移除；历史任务快照保持不变", "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <section className="agent-presets-settings">
    <SectionTitle title="专家库" description="每个用户专家保存独立人设文件和选定 Skill 的固定快照。仅派发该专家时加载它的 Skill；专家库为空时仍可执行任务。" />
    <Button size="sm" disabled={busy} onClick={() => { setSelectedId(""); setSelected(null); setDraft({ name: "", description: "", instructions: "", skillIds: "" }); }}>创建专家</Button>
    <div className="agent-presets-layout">
      <div className="agent-presets-list" aria-label="专家库">
        {presets.map(item => <div className="agent-preset-row" key={item.id}>
          <button className="agent-preset-select" aria-current={selectedId === item.id ? "true" : undefined} onClick={() => setSelectedId(item.id)}>
            <strong>{item.name}</strong><small>{item.description}</small>
          </button>
          <Toggle label={`启用 ${item.name}`} checked={item.enabled} disabled={busy} onChange={enabled => void updateEnabled(item, enabled)} />
        </div>)}
        {!presets.length && <p>暂无专家。可以创建专家，也可以从下面的模板添加。</p>}
        <h3>可选模板</h3>
        {templates.map(item => <div className="agent-preset-row" key={item.id}>
          <button className="agent-preset-select" aria-current={selectedId === item.id ? "true" : undefined} onClick={() => setSelectedId(item.id)}><strong>{item.name}</strong><small>{item.description}</small></button>
        </div>)}
      </div>
      {selected && draft && <div className="agent-preset-detail">
        <div className="agent-preset-title"><h3>{selected.name}</h3><span>{selected.builtin ? "可选模板" : "专家"} · {selected.hash.slice(0, 8)}</span></div>
        {selected.source && <p className="agent-preset-source">来源：{selected.source.url}/{selected.source.path} · {selected.source.revision.slice(0, 8)}</p>}
        {selected.basedOn && <p className="agent-preset-source">基于：{selected.basedOn}</p>}
        {selected.package && <p className="agent-preset-source">专家包版本：{selected.package.revision.slice(0, 10)} · 随包 Skill {selected.package.skills.length} 个</p>}
        {selected.builtin ? <>
          <div className="agent-preset-body"><Markdown text={selected.instructions} /></div>
          <Button size="sm" busy={busy} disabled={busy} onClick={() => void copy()}>添加到专家库</Button>
        </> : <>
          <label>名称<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>适用说明<input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
          <label>详细指令<textarea value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} rows={14} /></label>
          <label>随专家打包的已安装 Skill（逗号分隔）<input value={draft.skillIds} onChange={event => setDraft({ ...draft, skillIds: event.target.value })} placeholder="plugin:skill" /></label>
          <Button size="sm" busy={busy} disabled={busy} onClick={() => void save()}>保存角色</Button>
          <Button size="sm" busy={busy} disabled={busy} onClick={() => void remove()}>删除专家</Button>
          <div className="agent-preset-body"><Markdown text={draft.instructions} /></div>
        </>}
      </div>}
      {!selected && draft && <div className="agent-preset-detail">
        <h3>新专家</h3>
        <label>名称<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>适用范围<input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        <label>专业方法<textarea value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} rows={10} /></label>
        <label>随专家打包的已安装 Skill（逗号分隔）<input value={draft.skillIds} onChange={event => setDraft({ ...draft, skillIds: event.target.value })} placeholder="plugin:skill" /></label>
        <Button size="sm" busy={busy} disabled={busy} onClick={() => void create()}>添加专家</Button>
      </div>}
    </div>
  </section>;
}
