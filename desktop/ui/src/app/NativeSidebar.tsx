/** 左栏：品牌、新会话、会话列表、默认折叠的旧版任务、设置入口（方案 8.2 身份文案）。 */

import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus, Settings, Sparkles, Timer, Wrench } from "lucide-react";
import type { LegacyTask, SessionItem } from "./native-api";

export function NativeSidebar({ collapsed, onToggle, sessions, legacy, selected, busy, onSelect, onNew, onNewElsewhere, onContinueLegacy, onOpenSettings }: {
  collapsed: boolean;
  onToggle(): void;
  sessions: SessionItem[];
  legacy: LegacyTask[];
  selected: string | null;
  busy: boolean;
  onSelect(id: string): void;
  onNew(): void;
  onNewElsewhere(): void;
  onContinueLegacy(task: LegacyTask): void;
  onOpenSettings(section?: string): void;
}) {
  // 旧版任务默认折叠（方案 8.2：“旧任务 · 只读”→“旧版任务”，默认折叠）。
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  return <aside className="native-sidebar" id="native-sidebar" aria-label="侧边栏">
    <div className="native-brand"><span className="native-mark">α</span><span className="native-brand-label"><strong>Alpha</strong><small>Alpha · 天枢</small></span>
      <button className="native-sidebar-toggle" onClick={onToggle} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} title={collapsed ? "展开侧边栏" : "收起侧边栏"} aria-expanded={!collapsed} aria-controls="native-sidebar">
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>
    </div>
    <button className="native-new" onClick={onNew} disabled={busy} aria-label="新会话" title="新会话"><Plus size={16} /><span className="native-sidebar-label">新会话</span></button>
    <button className="native-project-choice" onClick={onNewElsewhere}>在其他目录开始</button>
    <nav className="native-sidebar-links" aria-label="功能入口">
      {[{ id: "model", label: "模型与账号", Icon: Bot }, { id: "skills", label: "技能", Icon: Sparkles }, { id: "schedules", label: "定时任务", Icon: Timer }, { id: "capabilities", label: "本机能力", Icon: Wrench }].map(({ id, label, Icon }) =>
        <button key={id} onClick={() => onOpenSettings(id)} aria-label={label} title={label}><Icon size={15} /><span className="native-sidebar-label">{label}</span></button>)}
    </nav>
    <input className="native-session-search" aria-label="搜索会话" placeholder="搜索会话或项目…" value={search} onChange={event => setSearch(event.target.value)} />
    <div className="native-list-title">会话</div>
    <button className="native-project-choice" onClick={() => setArchived(value => !value)}>{archived ? "返回会话" : "查看归档"}</button>
    <div className="native-session-list">{sessions.filter(item => !!item.archived === archived && `${item.title} ${item.cwd}`.toLowerCase().includes(search.toLowerCase())).map(item =>
      <button key={item.id} className={`native-session ${selected === item.id ? "active" : ""}`} onClick={() => onSelect(item.id)} title={item.cwd}>
        <span>{item.title}</span><small>{item.status ?? "未打开"} · {item.cwd}</small>
      </button>)}</div>
    {!!legacy.length && <div className="native-list-title">
      <button onClick={() => setLegacyOpen(open => !open)} aria-expanded={legacyOpen}>
        {legacyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 旧版任务（{legacy.length}）
      </button>
    </div>}
    {legacyOpen && <div className="native-session-list native-legacy">{legacy.map(item =>
      <div className="native-old" key={item.id}>
        <span title={item.objective}>{item.title}</span>
        <button onClick={() => onContinueLegacy(item)} disabled={busy}>继续这个任务</button>
      </div>)}</div>}
    <button className="native-settings-entry" onClick={() => onOpenSettings()} aria-label="设置" title="设置"><Settings size={17} /><span className="native-sidebar-label">设置</span><kbd>Ctrl ,</kbd></button>
  </aside>;
}
