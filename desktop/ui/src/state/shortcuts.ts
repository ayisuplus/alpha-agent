export type ShortcutId =
  | "new-task" | "palette" | "settings" | "shortcuts" | "toggle-sidebar" | "toggle-preview"
  | "zoom-in" | "zoom-out" | "zoom-reset" | "send" | "close";

export interface Shortcut {
  id: ShortcutId;
  keys: string[];
  label: string;
  group: "任务" | "界面" | "输入";
  /** Shortcuts without a matcher are handled where they apply (e.g. the composer) and only listed here. */
  match?: (event: KeyboardEvent) => boolean;
}

const ctrl = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && !event.altKey;

export const SHORTCUTS: Shortcut[] = [
  { id: "new-task", keys: ["Ctrl", "N"], label: "新建任务", group: "任务", match: event => ctrl(event) && !event.shiftKey && event.code === "KeyN" },
  { id: "palette", keys: ["Ctrl", "K"], label: "命令面板：搜索任务和执行动作", group: "任务", match: event => ctrl(event) && !event.shiftKey && event.code === "KeyK" },
  { id: "send", keys: ["Ctrl", "Enter"], label: "发送 / 开始任务", group: "输入" },
  { id: "close", keys: ["Esc"], label: "关闭详情、设置或浮层", group: "输入" },
  { id: "toggle-sidebar", keys: ["Ctrl", "B"], label: "收起 / 展开任务栏", group: "界面", match: event => ctrl(event) && !event.shiftKey && event.code === "KeyB" },
  { id: "toggle-preview", keys: ["Ctrl", "Shift", "B"], label: "收起 / 展开预览栏", group: "界面", match: event => ctrl(event) && event.shiftKey && event.code === "KeyB" },
  { id: "settings", keys: ["Ctrl", ","], label: "打开设置", group: "界面", match: event => ctrl(event) && event.code === "Comma" },
  { id: "shortcuts", keys: ["Ctrl", "/"], label: "快捷键一览", group: "界面", match: event => ctrl(event) && event.code === "Slash" },
  { id: "zoom-in", keys: ["Ctrl", "="], label: "放大界面", group: "界面", match: event => ctrl(event) && (event.code === "Equal" || event.code === "NumpadAdd") },
  { id: "zoom-out", keys: ["Ctrl", "-"], label: "缩小界面", group: "界面", match: event => ctrl(event) && (event.code === "Minus" || event.code === "NumpadSubtract") },
  { id: "zoom-reset", keys: ["Ctrl", "0"], label: "恢复默认大小", group: "界面", match: event => ctrl(event) && (event.code === "Digit0" || event.code === "Numpad0") },
];

export function matchShortcut(event: KeyboardEvent): ShortcutId | null {
  return SHORTCUTS.find(shortcut => shortcut.match?.(event))?.id ?? null;
}

export const SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];

export function stepScale(current: number, direction: 1 | -1): number {
  const index = SCALE_STEPS.findIndex(step => step >= current - 0.001);
  const base = index < 0 ? SCALE_STEPS.length - 1 : index;
  const exact = Math.abs(SCALE_STEPS[base] - current) < 0.001;
  const next = direction > 0 ? (exact ? base + 1 : base) : base - 1;
  return SCALE_STEPS[Math.min(SCALE_STEPS.length - 1, Math.max(0, next))];
}
