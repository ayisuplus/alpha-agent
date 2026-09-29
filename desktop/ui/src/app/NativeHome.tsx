/** 首页：问候、工作目录、任务描述与模型选择（方案 8.2：界面只出现 Alpha 一个产品名）。 */

import { useState } from "react";
import { ArrowUp, FolderOpen, Settings } from "lucide-react";
import { Greeting } from "../components/Greeting";
import { Halftone } from "../components/Halftone";
import { NativeModelPicker } from "./NativeModelPicker";
import { modelPreference, type NativeCatalog, type NativeConfig } from "./native-api";
import type { SessionController } from "./useSession";
import "../components/NewTask.css";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function NativeHome({ session, catalog, config, projectPath, setProjectPath, onOpenSettings }: {
  session: SessionController;
  catalog: NativeCatalog | null;
  config: NativeConfig | null;
  projectPath: string;
  setProjectPath(value: string): void;
  onOpenSettings(): void;
}) {
  const [draft, setDraft] = useState(() => localStorage.getItem("alpha-new-task-draft") ?? "");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const defaultPreference = modelPreference(catalog?.models ?? [], config?.modelRoles.default ?? "");
  const chosenModel = model || defaultPreference.selector || catalog?.models.find(item => item.available)?.selector || "";
  const chosenThinking = thinking || (!model && defaultPreference.thinking) || String(config?.settings.find(item => item.id === "defaultThinkingLevel")?.value ?? "auto");
  const ready = session.busy || !draft.trim() || !catalog?.models.some(item => item.selector === chosenModel && item.available);
  const start = async () => {
    if (await session.startFromHome({ text: draft, cwd: projectPath, model: chosenModel, thinking: chosenThinking })) {
      setDraft("");
      localStorage.removeItem("alpha-new-task-draft");
    }
  };
  return <div className="new-task native-home" data-testid="new-task">
    <div className="new-task-hero"><Halftone className="new-task-halftone" /><Greeting lines={["你好，我是 Alpha", "想让我替你完成什么？"]} /></div>
    <label className="native-home-directory"><FolderOpen size={15} /><input aria-label="工作目录" value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="工作目录 · 留空使用 Alpha 工作区" /></label>
    <div className="native-home-composer">
      <textarea data-testid="brief" aria-label="描述任务目标" value={draft} onChange={event => { setDraft(event.target.value); localStorage.setItem("alpha-new-task-draft", event.target.value); }}
        onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); } }}
        placeholder="描述你要解决的问题、使用的材料和期望结果…" rows={5} />
      <div className="native-home-toolbar">
        <NativeModelPicker models={catalog?.models ?? []} value={chosenModel} onChange={setModel} />
        <select aria-label="任务思考强度" value={chosenThinking} onChange={event => setThinking(event.target.value)}>
          {THINKING_LEVELS.map(level => <option key={level}>{level}</option>)}
          <option value="auto">auto · 跟随全局默认</option>
        </select>
        <span>Ctrl + Enter</span>
        <button className="native-primary" disabled={ready} onClick={() => void start()}>{session.busy ? "正在启动…" : "开始任务"}<ArrowUp size={15} /></button>
      </div>
    </div>
    <button className="native-home-settings" onClick={onOpenSettings}><Settings size={14} /> 配置模型、API Key 和运行偏好</button>
  </div>;
}
