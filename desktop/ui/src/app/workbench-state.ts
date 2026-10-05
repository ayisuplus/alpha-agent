import type { NativeMessage, SessionItem } from "./native-api";
import type { AttachedImage } from "./useSession";
import { t } from "./ui-language";

export interface ComposerDraft { text: string; paths: string[]; image?: AttachedImage; images?: AttachedImage[]; model?: string; thinking?: string; cwd?: string }
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
// The desktop storage namespace persists drafts and bounded image attachments on disk.
const drafts = new Map<string, ComposerDraft>();
const versions = new Map<string, number>();
const listeners = new Map<string, Set<(draft: ComposerDraft) => void>>();
const draftKey = (scope: string) => `alpha-composer:${scope}`;

export const draftVersion = (scope: string) => versions.get(scope) ?? 0;
export function subscribeDraft(scope: string, listener: (draft: ComposerDraft) => void) {
  const subscribers = listeners.get(scope) ?? new Set();
  subscribers.add(listener); listeners.set(scope, subscribers);
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(scope); };
}

export function readDraft(scope: string, storage: DraftStorage): ComposerDraft {
  const live = drafts.get(scope);
  if (live) return live;
  try {
    const saved = JSON.parse(storage.getItem(draftKey(scope)) ?? "null");
    if (saved && typeof saved.text === "string" && Array.isArray(saved.paths)) {
      const validImage = (image: AttachedImage) => image && typeof image.data === "string" && image.data.length <= 5_400_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data) && /^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) && typeof image.name === "string";
      const image = validImage(saved.image) ? saved.image : undefined;
      const images = Array.isArray(saved.images) && saved.images.length <= 8 && saved.images.every(validImage) && saved.images.reduce((size: number, item: AttachedImage) => size + item.data.length, 0) <= 6_000_000 ? saved.images : undefined;
      return { text: saved.text, paths: saved.paths.filter((path: unknown) => typeof path === "string"), model: typeof saved.model === "string" ? saved.model : undefined, thinking: typeof saved.thinking === "string" ? saved.thinking : undefined, cwd: typeof saved.cwd === "string" ? saved.cwd : undefined, ...(image ? { image } : {}), ...(images ? { images } : {}) };
    }
    if (scope === "home") return { text: storage.getItem("alpha-new-task-draft") ?? "", paths: [] };
  } catch { /* A malformed draft must not prevent opening the workbench. */ }
  return { text: "", paths: [] };
}

export function writeDraft(scope: string, draft: ComposerDraft, storage: DraftStorage): boolean {
  drafts.set(scope, draft);
  versions.set(scope, draftVersion(scope) + 1);
  listeners.get(scope)?.forEach(listener => listener(draft));
  try {
    storage.setItem(draftKey(scope), JSON.stringify(draft));
    if (scope === "home") storage.removeItem("alpha-new-task-draft");
    return true;
  } catch { return false; }
}

export function clearSentDraft(scope: string, version: number, storage: DraftStorage): boolean | null {
  if (draftVersion(scope) !== version) return null;
  return writeDraft(scope, { ...readDraft(scope, storage), text: "", paths: [], image: undefined, images: undefined }, storage);
}

export function promptText(draft: ComposerDraft): string {
  const text = draft.text.trim() || (draft.image || draft.images?.length ? "请分析这张图片。" : draft.paths.length ? "请读取附件" : "");
  return draft.paths.length ? `${text}\n\n用户选择的本机附件（请用 read 读取；修改前先检查文件支持范围）：\n${draft.paths.map(path => `- ${JSON.stringify(path)}`).join("\n")}` : text;
}

export function shouldSubmit(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.isComposing;
}

export const atBottom = (top: number, height: number, viewport: number) => height - viewport - top <= 48;

export function withLiveMessage(history: NativeMessage[], live: NativeMessage | null): NativeMessage[] {
  if (!live) return history;
  const index = live.timestamp === undefined ? -1 : history.findIndex(message => message.role === "assistant" && message.timestamp === live.timestamp);
  return index < 0 ? [...history, live] : history.map((message, position) => position === index ? live : message);
}

export function groupSessions(sessions: SessionItem[], pinned: string[]) {
  const groups = new Map<string, SessionItem[]>();
  for (const session of sessions) {
    const cwd = session.cwd.replace(/\\/g, "/").replace(/\/$/, "");
    const key = /^[A-Za-z]:/.test(cwd) ? cwd.toLowerCase() : cwd;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, path: rows[0].cwd, rows: rows.sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) || b.updatedAt.localeCompare(a.updatedAt)) }));
}

export function toolLabel(name: string, running: boolean, ok: boolean): string {
  const action = ({ read: "读取文件", write: "写入文件", edit: "修改文件", bash: "运行命令", shell: "运行命令", grep: "搜索内容", glob: "查找文件", find: "查找文件", ask: "询问用户", browser: "浏览网页", web_search: "搜索网页", fetch: "读取网页", alpha_office: "处理文档", alpha_generate_image: "生成图片", alpha_generate_voice: "生成语音", alpha_generate_video: "生成视频" } as Record<string, string>)[name] ?? name;
  return running ? `正在${action}` : `${action}${ok ? "完成" : "失败"}`;
}

export function toolTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const fields = args as Record<string, unknown>;
  return [fields.path, fields.file_path, fields.name, fields.query, fields.command, fields.cmd, fields.url].find(value => typeof value === "string") as string ?? "";
}

/** Display only: never rewrite messages, tool records, or third-party content. */
export function evidenceLabel(text: string): string {
  return text.replace(/^▌\s*/, "").replace(/^【(?:天枢|检查建议)】\s*/, "").replace(/^天枢(?=\s|$)/, "运行检查").replace(/^运行检查(?=\s|$)/, () => t("运行检查"));
}

export function errorHelp(message: string): { title: string; hint: string; section?: string } {
  if (/模型.*不支持图片/.test(message)) return { title: "当前模型不支持图片", hint: "请选择标有“支持图片”的模型后再发送，图片仍保留。" };
  if (/请选择不超过.*图片|无法读取图片/.test(message)) return { title: "图片无法添加", hint: message };
  if (/401|403|api.?key|凭据|unauthorized|authentication/i.test(message)) return { title: "模型或服务授权需要处理", hint: "检查服务商与凭据，再确认当前模型可用。", section: "model" };
  if (/ComfyUI|LibreOffice|引擎|工作流/i.test(message)) return { title: "本机能力暂时不可用", hint: "查看连接状态与具体能力要求，再继续任务。", section: "capabilities" };
  if (/连接|重连|network|fetch|timeout/i.test(message)) return { title: "连接中断", hint: "发送结果可能尚未确认，请先刷新状态并查看会话记录，再决定是否重新发送。" };
  return { title: "操作未完成", hint: "查看具体原因；草稿仍保留，可以刷新状态后继续。" };
}

export interface DiffFile { path: string; lines: string[]; added: number; removed: number }
export function diffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files.push({ path: line.replace(/^diff --git .* b\//, ""), lines: [], added: 0, removed: 0 });
    const file = files.at(-1);
    if (!file) continue;
    file.lines.push(line);
    if (line.startsWith("+++ b/")) file.path = line.slice(6);
    if (line.startsWith("+") && !line.startsWith("+++")) file.added++;
    if (line.startsWith("-") && !line.startsWith("---")) file.removed++;
  }
  return files;
}
