import { useEffect, useState } from "react";
import { desktopStorage } from "./desktop-storage";

export interface DesktopPreferences { language: "zh" | "en"; font: "system" | "segoe" | "yahei"; notifications: boolean; sound: boolean; shortcuts: Record<string, string>; editor: string }
const defaults: DesktopPreferences = { language: "zh", font: "system", notifications: true, sound: false, shortcuts: {}, editor: "" };
export function desktopPreferences(): DesktopPreferences {
  try {
    const value = JSON.parse(desktopStorage.getItem("alpha-ui-preferences") ?? "{}");
    return { language: value.language === "en" ? "en" : "zh", font: ["segoe", "yahei"].includes(value.font) ? value.font : "system", notifications: value.notifications !== false, sound: value.sound === true, shortcuts: value.shortcuts && typeof value.shortcuts === "object" && !Array.isArray(value.shortcuts) ? value.shortcuts : {}, editor: typeof value.editor === "string" ? value.editor : "" };
  } catch { return defaults; }
}
export function updateDesktopPreferences(change: Partial<DesktopPreferences>) {
  desktopStorage.setItem("alpha-ui-preferences", JSON.stringify({ ...desktopPreferences(), ...change }));
  window.dispatchEvent(new Event("alpha-preferences"));
}
export function useDesktopPreferences() {
  const [value, setValue] = useState(desktopPreferences);
  useEffect(() => {
    const refresh = () => setValue(desktopPreferences());
    window.addEventListener("alpha-preferences", refresh);
    const off = window.alpha?.onStorageChanged?.(change => { if (change.key === "alpha-ui-preferences") refresh(); });
    return () => { window.removeEventListener("alpha-preferences", refresh); off?.(); };
  }, []);
  return value;
}
export function shortcutFor(command: { id: string; key?: string }) { return desktopPreferences().shortcuts[command.id] ?? command.key ?? ""; }
export function validShortcut(value: string): boolean { return value === "" || /^(Ctrl\+)?(Shift\+)?(Alt\+)?(?:[A-Z0-9,./;\[\]\\]|F(?:[1-9]|1[0-2]))$/.test(value) && /Ctrl\+|Alt\+/.test(value); }
