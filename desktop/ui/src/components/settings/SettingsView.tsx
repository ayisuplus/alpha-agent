import type { ComponentType } from "react";
import { Gauge, Keyboard, MonitorCog, Sparkles, X, type LucideIcon } from "lucide-react";
import { useStore } from "../../state/store";
import { closePanel, openSettings, store, type SettingsSection } from "../../state/workbench";
import { IconButton, Spinner } from "../ui";
import { GenerationSettings, InterfaceSettings, RunSettings, ShortcutSettings } from "./sections";
import "./settings.css";

interface SectionEntry { id: SettingsSection; label: string; icon: LucideIcon; render: ComponentType }

export const SECTIONS: SectionEntry[] = [
  { id: "run", label: "运行", icon: Gauge, render: RunSettings },
  { id: "generation", label: "生成服务", icon: Sparkles, render: GenerationSettings },
  { id: "interface", label: "界面", icon: MonitorCog, render: InterfaceSettings },
  { id: "shortcuts", label: "快捷键", icon: Keyboard, render: ShortcutSettings },
];

export function SettingsView({ section }: { section: SettingsSection }) {
  const settings = useStore(store, state => state.settings);
  const entry = SECTIONS.find(item => item.id === section) ?? SECTIONS[0];
  const Body = entry.render;

  return <div className="settings-view" data-testid="settings-view">
    <header className="settings-header">
      <h1>设置</h1>
      <span className="settings-header-hint">修改会立即保存，下一轮运行时生效</span>
      <IconButton icon={X} label="关闭设置 (Esc)" onClick={closePanel} />
    </header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分组">
        {SECTIONS.map(({ id, label, icon: Icon }) => <button key={id} aria-current={id === entry.id ? "page" : undefined} onClick={() => openSettings(id)}>
          <Icon size={15} aria-hidden />{label}
        </button>)}
      </nav>
      <div className="settings-content" key={entry.id}>
        {settings ? <Body /> : <p className="settings-loading"><Spinner size={14} />正在读取设置…</p>}
      </div>
    </div>
  </div>;
}
