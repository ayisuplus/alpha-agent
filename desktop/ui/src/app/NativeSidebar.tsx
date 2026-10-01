import { t } from "./ui-language";
/** 左栏：品牌、新会话、会话列表、默认折叠的旧版任务、设置入口（方案 8.2 身份文案）。 */

import { desktopStorage } from "./desktop-storage";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Pin, Plus, Settings, Sparkles, Timer } from "lucide-react";
import { nativeApi, type LegacyTask, type SessionItem } from "./native-api";
import { groupSessions } from "./workbench-state";
import { invokeDesktopCommand } from "./desktop-commands";

function savedList(key: string): string[] {
  try { const value = JSON.parse(desktopStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.filter(item => typeof item === "string") : []; }
  catch { return []; }
}

export function NativeSidebar({ collapsed, onToggle, sessions, legacy, selected, busy, onSelect, onNew, onContinueLegacy, onOpenSettings }: {
  collapsed: boolean;
  onToggle(): void;
  sessions: SessionItem[];
  legacy: LegacyTask[];
  selected: string | null;
  busy: boolean;
  onSelect(id: string): void;
  onNew(): void;
  onContinueLegacy(task: LegacyTask): void;
  onOpenSettings(section?: string): void;
}) {
  // 旧版任务默认折叠（方案 8.2：“旧任务 · 只读”→“旧版任务”，默认折叠）。
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [searchError, setSearchError] = useState("");
  useEffect(() => {
    if (!search.trim()) { setSearchIds(null); setSearchError(""); return; }
    let cancelled = false;
    const timer = setTimeout(() => void nativeApi<{ sessions: SessionItem[]; errors: Array<{ error: string }> }>(`sessions?search=${encodeURIComponent(search)}`).then(result => { if (!cancelled) { setSearchIds(result.sessions.map(item => item.id)); setSearchError(result.errors.map(item => item.error).join("; ")); } }, cause => { if (!cancelled) setSearchError(String(cause)); }), 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, sessions.length]);
  const [archived, setArchived] = useState(false);
  const [pinned, setPinned] = useState(() => savedList("alpha-pinned-sessions"));
  const [folded, setFolded] = useState(() => savedList("alpha-folded-projects"));
  const [seen, setSeen] = useState<Record<string, string>>(() => { try { const value = JSON.parse(desktopStorage.getItem("alpha-seen-sessions") ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } });
  const stamp = (item: SessionItem) => `${item.updatedAt}:${item.status}`;
  useEffect(() => {
    setSeen(current => {
      const next = { ...current };
      for (const item of sessions) if (!next[item.id] || item.id === selected) next[item.id] = stamp(item);
      return next;
    });
  }, [sessions, selected]);
  useEffect(() => { desktopStorage.setItem("alpha-pinned-sessions", JSON.stringify(pinned)); }, [pinned]);
  useEffect(() => { desktopStorage.setItem("alpha-folded-projects", JSON.stringify(folded)); }, [folded]);
  useEffect(() => { desktopStorage.setItem("alpha-seen-sessions", JSON.stringify(seen)); }, [seen]);
  const shown = sessions.filter(item => !!item.archived === archived && (searchIds ? searchIds.includes(item.id) : `${item.title} ${item.cwd} ${item.tags?.join(" ") ?? ""}`.toLowerCase().includes(search.toLowerCase())));
  return <aside className="native-sidebar" id="native-sidebar" aria-label={t("侧边栏")}>
    <div className="native-brand"><span className="native-brand-label"><strong>Alpha</strong></span>
      <button className="native-sidebar-toggle" onClick={onToggle} aria-label={collapsed ? t("展开侧边栏") : t("收起侧边栏")} title={collapsed ? t("展开侧边栏") : t("收起侧边栏")} aria-expanded={!collapsed} aria-controls="native-sidebar">
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>
    </div>
    <button className="native-new" onClick={onNew} disabled={busy} aria-label={t("新会话")} title={t("新会话")}><Plus size={16} /><span className="native-sidebar-label">{t("新会话")}</span></button>
    <input className="native-session-search" aria-label={t("搜索会话")} placeholder={t("搜索会话或项目…")} value={search} onChange={event => setSearch(event.target.value)} />
    {searchError && <p className="native-muted" role="alert">{t(searchError)}</p>}
    <div className="native-list-title">{t("会话")}</div>
    <button className="native-project-choice" onClick={() => setArchived(value => !value)}>{archived ? t("返回会话") : t("查看归档")}</button>
    <div className="native-session-list">{groupSessions(shown, pinned).map(project => <section className="native-project-group" key={project.key}>
      <button className="native-project-heading" title={project.path} aria-expanded={!!search || !folded.includes(project.key)} onClick={() => setFolded(current => current.includes(project.key) ? current.filter(key => key !== project.key) : [...current, project.key])}>
        {folded.includes(project.key) && !search ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path}</span><small>{project.rows.length}</small>
      </button>
      {(!folded.includes(project.key) || search) && project.rows.map(item => <div className="native-session-row" key={item.id}>
        <button className={`native-session ${selected === item.id ? "active" : ""}`} onClick={() => onSelect(item.id)} title={item.title}>
          <span>{item.title}</span><small>{item.tags?.join(" · ")} <i className={`native-status-dot ${item.status === "工作中" ? "running" : item.status === "失败" ? "danger" : item.status === "等待输入" ? "warning" : ""}`} />{t(item.status ?? "未打开")}
            {item.id !== selected && seen[item.id] && seen[item.id] !== stamp(item) && ["完成", "失败", "等待输入"].includes(item.status ?? "") && <b className="native-unread" aria-label={t("有未读更新")} />}
          </small>
        </button>
        <button className="native-pin native-icon-button" aria-label={`${pinned.includes(item.id) ? t("取消置顶") : t("置顶")} ${item.title}`} aria-pressed={pinned.includes(item.id)} title={pinned.includes(item.id) ? t("取消置顶") : t("置顶")} onClick={() => setPinned(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}><Pin size={13} /></button>
      </div>)}
    </section>)}{!shown.length && <p className="native-muted">{search ? t("没有匹配的会话") : archived ? t("还没有归档会话") : t("新建一个任务，从这里开始。")}</p>}</div>
    {!!legacy.length && <div className="native-list-title">
      <button onClick={() => setLegacyOpen(open => !open)} aria-expanded={legacyOpen}>
        {legacyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t("旧版任务（")}{legacy.length}）
      </button>
    </div>}
    {legacyOpen && <div className="native-session-list native-legacy">{legacy.map(item =>
      <div className="native-old" key={item.id}>
        <span title={item.objective}>{item.title}</span>
        <button onClick={() => onContinueLegacy(item)} disabled={busy}>{t("继续这个任务")}</button>
      </div>)}</div>}
    <div className="native-sidebar-footer"><nav className="native-sidebar-links" aria-label={t("功能入口")}>
      <button onClick={() => void invokeDesktopCommand("projects")} title={t("项目与工作树")} aria-label={t("项目与工作树")}><span className="native-sidebar-label">{t("项目")}</span></button>
      {[{ id: "skills", label: "技能", Icon: Sparkles }, { id: "schedules", label: "定时任务", Icon: Timer }].map(({ id, label, Icon }) =>
        <button key={id} onClick={() => onOpenSettings(id)} aria-label={t(label)} title={t(label)}><Icon size={17} /><span className="native-sidebar-label">{t(label)}</span></button>)}
    </nav><button className="native-settings-entry" onClick={() => onOpenSettings()} aria-label={t("设置")} title={t("设置")}><Settings size={17} /><span className="native-sidebar-label">{t("设置")}</span><kbd>Ctrl ,</kbd></button></div>
  </aside>;
}
