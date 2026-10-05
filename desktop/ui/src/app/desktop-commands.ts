import type { AttachedImage } from "./useSession";
import { shortcutFor } from "./desktop-preferences";

import commandCatalog from "../../../commands.json";
export type DesktopCommandId = "palette" | "new" | "window" | "settings" | "projects" | "files" | "review" | "terminal" | "history" | "progress" | "plan" | "planreview" | "compact" | "export" | "skills" | "mcp" | "plugins" | "definitions" | "permissions" | "lsp";
export const desktopCommands = commandCatalog as ReadonlyArray<{ id: DesktopCommandId; name: string; description: string; en: string; key?: string; session?: boolean }>;
export type DesktopCommandEvent = { id: DesktopCommandId; args?: string; image?: AttachedImage | AttachedImage[]; resolve?(success: boolean): void };
export function desktopCommand(text: string) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = match && desktopCommands.find(item => item.name === match[1] && (!match[2] || item.id === "plan"));
  return command ? { ...command, args: match![2] ?? "" } : null;
}
export function invokeDesktopCommand(id: DesktopCommandId, args?: string, image?: AttachedImage | AttachedImage[]): Promise<boolean> {
  return new Promise(resolve => {
    const event = new CustomEvent<DesktopCommandEvent>("alpha-command", { detail: { id, args, image, resolve }, cancelable: true });
    window.dispatchEvent(event); if (!event.defaultPrevented) resolve(false);
  });
}
export function shortcutCommand(event: KeyboardEvent): DesktopCommandId | undefined {
  if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
  const key = `${event.ctrlKey || event.metaKey ? "Ctrl+" : ""}${event.shiftKey ? "Shift+" : ""}${event.altKey ? "Alt+" : ""}${event.key.length === 1 ? event.key.toUpperCase() : event.key}`;
  return desktopCommands.find(item => shortcutFor(item) === key)?.id;
}
