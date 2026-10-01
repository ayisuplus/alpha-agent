import { t } from "./ui-language";
import { useEffect, useState } from "react";
import { desktopCommands, invokeDesktopCommand } from "./desktop-commands";
import { sessionRequest } from "./native-api";
import type { SessionController } from "./useSession";
import { NativeModal } from "./NativeModal";
import { shortcutFor } from "./desktop-preferences";

export function NativeCommands({ session, onClose }: { session: SessionController; onClose(): void }) {
  const [search, setSearch] = useState("");
  const [native, setNative] = useState<Array<{ name: string; description?: string }>>([]);
  useEffect(() => { if (session.selected && session.opened) void sessionRequest<{ data: { commands: typeof native } }>(session.selected, "command", { type: "get_available_commands" }).then(result => setNative(result.data.commands), cause => session.setError(String(cause))); }, [session.selected, session.opened]);
  return <NativeModal title={t("命令与技能")} onCancel={onClose}>
    <input autoFocus aria-label={t("搜索命令")} placeholder={t("搜索命令或输入 /skill:…")} value={search} onChange={event => setSearch(event.target.value)} />
    <div className="native-command-results">
      {desktopCommands.filter(item => `${item.name} ${item.description && t(item.description)}`.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.id} disabled={"session" in item && !session.opened} onClick={() => { onClose(); void invokeDesktopCommand(item.id); }}><span>{item.description && t(item.description)}</span><small>/{item.name} {shortcutFor(item)}</small></button>)}
      {native.filter(item => !desktopCommands.some(command => command.name === item.name) && `${item.name} ${item.description && t(item.description)}`.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.name} onClick={() => { session.prefill(`/${item.name} `); onClose(); }}><span>/{item.name}</span><small>{item.description && t(item.description)}</small></button>)}
    </div>
  </NativeModal>;
}
