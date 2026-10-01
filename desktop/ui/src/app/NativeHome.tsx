import { t } from "./ui-language";
/** 首页：问候、工作目录、任务描述与模型选择（方案 8.2：界面只出现 Alpha 一个产品名）。 */

import { desktopStorage } from "./desktop-storage";
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
  const [model, setModel] = useState(() => readDraft("home", desktopStorage).model ?? "");
  const [thinking, setThinking] = useState(() => readDraft("home", desktopStorage).thinking ?? "");
  const defaultPreference = modelPreference(catalog?.models ?? [], config?.modelRoles.default ?? "");
  const chosenModel = model || defaultPreference.selector || catalog?.models.find(item => item.available)?.selector || "";
  const chosenThinking = thinking || (!model && defaultPreference.thinking) || String(config?.settings.find(item => item.id === "defaultThinkingLevel")?.value ?? "auto");
  return <div className="native-home" data-testid="new-task">
    <div className="native-home-hero"><span className="native-home-wordmark">Alpha</span><h1>{t("今天，一起完成点什么？")}</h1><p>{t("说说你的想法，我们从这里开始。")}</p></div>
    <NativeComposer home session={session} models={catalog?.models ?? []} model={chosenModel} thinking={chosenThinking}
      onModel={value => { setModel(value); writeDraft("home", { ...readDraft("home", desktopStorage), model: value }, desktopStorage); }}
      onThinking={value => { setThinking(value); writeDraft("home", { ...readDraft("home", desktopStorage), thinking: value }, desktopStorage); }}
      projectPath={projectPath} setProjectPath={value => { setProjectPath(value); writeDraft("home", { ...readDraft("home", desktopStorage), cwd: value }, desktopStorage); }} onOpenSettings={onOpenSettings} />
  </div>;
}
