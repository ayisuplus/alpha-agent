import type { AttachedImage } from "./useSession";

export const desktopCommands = [
  { id: "palette", name: "commands", description: "命令面板", key: "Ctrl+K" },
  { id: "new", name: "new", description: "新会话", key: "Ctrl+N" },
  { id: "settings", name: "settings", description: "设置", key: "Ctrl+," },
  { id: "files", name: "files", description: "项目文件", key: "Ctrl+Shift+F" },
  { id: "review", name: "review", description: "改动审查" },
  { id: "terminal", name: "terminal", description: "项目终端" },
  { id: "history", name: "history", description: "会话树与历史导航", session: true },
  { id: "progress", name: "progress", description: "Todo、子任务与消息队列", session: true },
  { id: "plan", name: "plan", description: "切换原生计划模式", session: true, key: "Ctrl+Shift+P" },
  { id: "planreview", name: "planreview", description: "审阅当前计划", session: true },
  { id: "compact", name: "compact", description: "压缩上下文", session: true },
  { id: "export", name: "export", description: "导出原生会话 HTML", session: true },
  { id: "skills", name: "skills", description: "技能管理" },
  { id: "mcp", name: "mcp", description: "MCP 管理" },
  { id: "plugins", name: "plugins", description: "插件管理" },
] as const;
export type DesktopCommandId = typeof desktopCommands[number]["id"];
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
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = `Ctrl+${event.shiftKey ? "Shift+" : ""}${event.key.length === 1 ? event.key.toUpperCase() : event.key}`;
  return desktopCommands.find(item => "key" in item && item.key === key)?.id;
}
