import type { PermissionMode } from "../api/types";
import { createStore } from "./store";
import { newTask } from "./workbench";

interface NewTaskDraft {
  files: File[];
  skillIds: string[];
  pluginIds: string[];
  projectId: string;
  mountId: string;
  permissionMode: PermissionMode;
  expertId: string;
  startMode: "plan" | "execute";
  continueUntilAccepted: boolean;
}

const saved = (() => { try { return JSON.parse(localStorage.getItem("alpha-new-task-selection") ?? "{}") as Partial<NewTaskDraft>; } catch { return {}; } })();

export const newTaskDraft = createStore<NewTaskDraft>({
  files: [],
  skillIds: saved.skillIds ?? [],
  pluginIds: saved.pluginIds ?? [],
  projectId: saved.projectId ?? "",
  mountId: saved.mountId ?? "",
  permissionMode: "ask",
  expertId: "",
  startMode: saved.startMode ?? "execute",
  continueUntilAccepted: saved.continueUntilAccepted ?? false,
});

newTaskDraft.subscribe(() => {
  const { files: _files, ...selection } = newTaskDraft.get();
  localStorage.setItem("alpha-new-task-selection", JSON.stringify(selection));
});

export function selectNewTaskProject(projectId: string, mountId = ""): void {
  newTaskDraft.set({ projectId, mountId });
  newTask();
}
