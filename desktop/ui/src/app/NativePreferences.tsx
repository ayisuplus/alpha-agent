import { tf, t } from "./ui-language";
import { useState } from "react";
import { Field, Toggle } from "../components/settings/controls";
import { desktopCommands } from "./desktop-commands";
import { shortcutFor, updateDesktopPreferences, useDesktopPreferences, validShortcut } from "./desktop-preferences";

export function NativePreferences() {
  const preferences = useDesktopPreferences();
  const [shortcuts, setShortcuts] = useState(() => Object.fromEntries(desktopCommands.map(command => [command.id, shortcutFor(command)])));
  const [editor, setEditor] = useState(preferences.editor);
  const [error, setError] = useState("");
  const savePreferences: typeof updateDesktopPreferences = input => {
    try { const value = updateDesktopPreferences(input); setError(""); return value; }
    catch (cause) { setError(String(cause)); return preferences; }
  };
  return <>
    {error && <p role="alert">{t(error)}</p>}
    <Field label={t("语言")}><select aria-label={t("界面语言")} value={preferences.language} onChange={event => savePreferences({ language: event.target.value === "en" ? "en" : "zh" })}><option value="zh">{t("中文")}</option><option value="en">English</option></select></Field>
    <Field label={t("字体")}><select aria-label={t("界面字体")} value={preferences.font} onChange={event => savePreferences({ font: event.target.value as typeof preferences.font })}><option value="system">{t("系统默认")}</option><option value="segoe">Segoe UI</option><option value="yahei">Microsoft YaHei UI</option></select></Field>
    <Field label={t("桌面通知")} description={t("任务完成、失败或需要输入时提醒；工作台在前台时不弹出系统通知。")}><Toggle label={t("启用桌面通知")} checked={preferences.notifications} onChange={notifications => savePreferences({ notifications })} /></Field>
    <Field label={t("通知声音")} description={t("由 Windows 通知设置控制声音。")}><Toggle label={t("启用通知声音")} checked={preferences.sound} onChange={sound => savePreferences({ sound })} /></Field>
    <Field label={t("外部编辑器")} description={t("填写可执行文件的完整路径。留空使用 VISUAL、EDITOR 或记事本。")}><input aria-label={t("外部编辑器路径")} value={editor} onChange={event => setEditor(event.target.value)} /><button onClick={() => savePreferences({ editor: editor.trim() })}>{t("保存")}</button></Field>
    <details><summary>{t("自定义快捷键")}</summary>
      {desktopCommands.map(command => <Field key={command.id} label={command.description}><input aria-label={tf`快捷键 ${command.name}`} placeholder={"key" in command ? command.key : "Ctrl+Shift+X"} value={shortcuts[command.id] ?? ""} onChange={event => setShortcuts(current => ({ ...current, [command.id]: event.target.value }))} /></Field>)}
      <button onClick={() => {
        if (Object.values(shortcuts).some(value => !validShortcut(value))) { setError("使用 Ctrl、Shift、Alt 加单个按键；留空取消绑定。"); return; }
        const nonempty = Object.values(shortcuts).filter(Boolean);
        if (new Set(nonempty).size !== nonempty.length) { setError("不同命令不能绑定相同快捷键。"); return; }
        setError(""); savePreferences({ shortcuts });
      }}>{t("保存快捷键")}</button>
      <button onClick={() => { savePreferences({ shortcuts: {} }); setShortcuts(Object.fromEntries(desktopCommands.map(command => [command.id, command.key ?? ""]))); setError(""); }}>{t("恢复默认快捷键")}</button>
    </details>
    <button onClick={() => void window.alpha?.newWindow?.().catch(cause => setError(String(cause)))}>{t("打开新窗口")}</button>
  </>;
}
