/** 首页：问候、工作目录、任务描述与模型选择（方案 8.2：界面只出现 Alpha 一个产品名）。 */

import { useState } from "react";
import { NativeComposer } from "./NativeComposer";
import { readDraft, writeDraft } from "./workbench-state";
import { modelPreference, type NativeCatalog, type NativeConfig } from "./native-api";
import type { SessionController } from "./useSession";

export function NativeHome({ session, catalog, config, projectPath, setProjectPath, onOpenSettings }: {
  session: SessionController;
  catalog: NativeCatalog | null;
  config: NativeConfig | null;
  projectPath: string;
  setProjectPath(value: string): void;
  onOpenSettings(): void;
}) {
  const [model, setModel] = useState(() => readDraft("home", localStorage).model ?? "");
  const [thinking, setThinking] = useState(() => readDraft("home", localStorage).thinking ?? "");
  const defaultPreference = modelPreference(catalog?.models ?? [], config?.modelRoles.default ?? "");
  const chosenModel = model || defaultPreference.selector || catalog?.models.find(item => item.available)?.selector || "";
  const chosenThinking = thinking || (!model && defaultPreference.thinking) || String(config?.settings.find(item => item.id === "defaultThinkingLevel")?.value ?? "auto");
  return <div className="native-home" data-testid="new-task">
    <div className="native-home-hero"><span className="native-home-wordmark">Alpha</span><h1>今天，想完成什么？</h1><p>从一个想法开始，把事情交给 Alpha。</p></div>
    <NativeComposer home session={session} models={catalog?.models ?? []} model={chosenModel} thinking={chosenThinking}
      onModel={value => { setModel(value); writeDraft("home", { ...readDraft("home", localStorage), model: value }, localStorage); }}
      onThinking={value => { setThinking(value); writeDraft("home", { ...readDraft("home", localStorage), thinking: value }, localStorage); }}
      projectPath={projectPath} setProjectPath={value => { setProjectPath(value); writeDraft("home", { ...readDraft("home", localStorage), cwd: value }, localStorage); }} onOpenSettings={onOpenSettings} />
  </div>;
}
