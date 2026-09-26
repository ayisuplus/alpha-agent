import type { ComponentType } from "react";
import { Bot, Gauge, HardDrive, Keyboard, MonitorCog, Sparkles, Stethoscope, Users, X, type LucideIcon } from "lucide-react";
import { useStore } from "../../state/store";
import { closePanel, openSettings, store, type SettingsSection } from "../../state/workbench";
import { IconButton, Spinner } from "../ui";
import { ModelSettings } from "./ModelSettings";
import { AgentPresetsSettings } from "./AgentPresetsSettings";
import { GenerationSettings, InterfaceSettings, RunSettings, ShortcutSettings } from "./sections";
import { DiagnosticsSettings, WorkspaceSettings } from "./WorkspaceSettings";
import "./settings.css";

interface SectionEntry { id: SettingsSection; label: string; icon: LucideIcon; render: ComponentType }

export const SECTIONS: SectionEntry[] = [
  { id: "model", label: "模型", icon: Bot, render: ModelSettings },
  { id: "run", label: "运行", icon: Gauge, render: RunSettings },
  { id: "agents", label: "角色预设", icon: Users, render: AgentPresetsSettings },
  { id: "generation", label: "插件", icon: Sparkles, render: GenerationSettings },
  { id: "interface", label: "界面", icon: MonitorCog, render: InterfaceSettings },
  { id: "workspace", label: "工作区与数据", icon: HardDrive, render: WorkspaceSettings },
  { id: "diagnostics", label: "诊断", icon: Stethoscope, render: DiagnosticsSettings },
  { id: "shortcuts", label: "快捷键", icon: Keyboard, render: ShortcutSettings },
];

export function SettingsView({ section }: { section: SettingsSection }) {
  const settings = useStore(store, state => state.settings);
  const entry = SECTIONS.find(item => item.id === section) ?? SECTIONS[0];
  const Body = entry.render;

  return <div className="settings-view" data-testid="settings-view">
    <header className="settings-header">
      <h1>设置</h1>
      <span className="settings-header-hint">一般设置自动保存；角色预设需点击保存</span>
      <IconButton icon={X} label="关闭设置 (Esc)" onClick={closePanel} />
    </header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分组">
        {SECTIONS.map(({ id, label, icon: Icon }) => <button key={id} aria-current={id === entry.id ? "page" : undefined} onClick={() => openSettings(id)}>
          <Icon size={15} aria-hidden />{label}
        </button>)}
      </nav>
      <div className="settings-content">
        {settings ? <><div hidden={entry.id !== "agents"}><AgentPresetsSettings /></div>{entry.id !== "agents" && <Body />}</> : <p className="settings-loading"><Spinner size={14} />正在读取设置…</p>}
      </div>
    </div>
  </div>;
}
