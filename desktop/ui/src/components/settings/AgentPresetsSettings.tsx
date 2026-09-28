import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { api } from "../../api/client";
import type { AgentPreset, AgentPresetSummary, ExpertLine } from "../../api/types";
import { EXPERT_LINES, expertLineLabel } from "../../state/labels";
import { notify } from "../../state/workbench";
import { Markdown } from "../Markdown";
import { Button } from "../ui";
import { SectionTitle, Toggle } from "./controls";
import "./agent-presets.css";

type Draft = Pick<AgentPreset, "name" | "description" | "instructions"> & { skillIds: string };
type LineFilter = ExpertLine | "all" | "custom";

export function AgentPresetsSettings() {
  const [query, setQuery] = useState("");
  const [line, setLine] = useState<LineFilter>("all");
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

  const needle = query.trim().toLocaleLowerCase();
  const matchesQuery = (item: AgentPresetSummary) => !needle || `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle);
  const inLine = (item: AgentPresetSummary) => line === "all" || (line === "custom" ? !item.line : item.line === line);
  const visible = (item: AgentPresetSummary) => matchesQuery(item) && inLine(item);
  const enabled = presets.filter(item => item.enabled && visible(item));
  const disabled = presets.filter(item => !item.enabled && visible(item));
  const shownTemplates = templates.filter(visible);
  const lineCount = (id: LineFilter) => presets.filter(item => matchesQuery(item) && (id === "all" || (id === "custom" ? !item.line : item.line === id))).length;
  const lineFilters: Array<{ id: LineFilter; label: string }> = [
    { id: "all", label: "全部" },
    ...EXPERT_LINES.filter(item => item.id !== "general").map(item => ({ id: item.id, label: item.label })),
    { id: "custom", label: expertLineLabel(undefined) },
  ];
  const skillSummary = (item: AgentPresetSummary) => item.package?.skills.length ? `人设 + ${item.package.skills.length} 个 Skill` : item.builtin ? "核心模板" : "待补齐 Skill";
  const presetRow = (item: AgentPresetSummary) => <div className="agent-preset-row" key={item.id} data-selected={selectedId === item.id || undefined}>
    <button className="agent-preset-select" aria-current={selectedId === item.id ? "true" : undefined} onClick={() => setSelectedId(item.id)}>
      <span className="agent-preset-name"><strong>{item.name}</strong>{line === "all" && <span className="agent-preset-line">{expertLineLabel(item.line)}</span>}</span>
      <small className="agent-preset-description">{item.description}</small>
      <small className="agent-preset-meta">{skillSummary(item)}</small>
    </button>
    {!item.builtin && <Toggle label={`启用 ${item.name}`} checked={item.enabled} disabled={busy} onChange={value => void updateEnabled(item, value)} />}
  </div>;
  const empty = !enabled.length && !disabled.length && !shownTemplates.length;

  return <section className="agent-presets-settings">
    <SectionTitle title="专家库" description="专家由人设和可执行方法 Skill 组成。启用的专家会进入任务派发的候选名单；停用保留原内容与历史任务快照。" />
    <div className="expert-toolbar">
      <label className="expert-search">
        <Search size={14} aria-hidden />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索专家名称或擅长领域" aria-label="搜索专家" />
      </label>
      <Button size="sm" icon={Plus} disabled={busy} onClick={() => { setSelectedId(""); setSelected(null); setDraft({ name: "", description: "", instructions: "", skillIds: "" }); }}>创建专家</Button>
    </div>
    <div className="expert-lines" role="radiogroup" aria-label="按业务线筛选">
      {lineFilters.map(item => <button key={item.id} role="radio" aria-checked={line === item.id} onClick={() => setLine(item.id)}>
        {item.label}{lineCount(item.id) > 0 && <small>{lineCount(item.id)}</small>}
      </button>)}
    </div>
    <div className="agent-presets-layout">
      <div className="agent-presets-list" aria-label="专家库">
        {!!enabled.length && <h3>已启用 · {enabled.length}</h3>}
        {enabled.map(presetRow)}
        {!presets.some(item => item.enabled) && <p className="agent-presets-empty">暂无启用的专家。可以创建专家，也可以从下面的核心模板添加。</p>}
        {!!disabled.length && <details open={!!needle || line !== "all"}><summary>已停用 · {disabled.length}</summary>{disabled.map(presetRow)}</details>}
        {!!shownTemplates.length && <details open={!!needle}><summary>核心模板 · {shownTemplates.length}</summary>{shownTemplates.map(presetRow)}</details>}
        {empty && <p className="agent-presets-empty">{needle ? "没有匹配的专家。" : "这个分类下还没有专家。"}</p>}
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
          <label>人设与职责边界<textarea value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} rows={14} /></label>
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
        <label>人设与职责边界<textarea value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} rows={10} /></label>
        <label>随专家打包的已安装 Skill（逗号分隔）<input value={draft.skillIds} onChange={event => setDraft({ ...draft, skillIds: event.target.value })} placeholder="plugin:skill" /></label>
        <Button size="sm" busy={busy} disabled={busy} onClick={() => void create()}>添加专家</Button>
      </div>}
      {!selected && !draft && <p className="agent-preset-detail agent-preset-placeholder">选择一位专家，查看人设、随包 Skill 与来源。</p>}
    </div>
  </section>;
}
