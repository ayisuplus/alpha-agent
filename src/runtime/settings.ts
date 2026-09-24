import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type FontSize = "sm" | "md" | "lg";

export interface AlphaSettings {
  version: 1;
  model: { default: string | null };
  budget: { maxToolCalls: number; wallTimeMinutes: number };
  generation: { comfyUrl: string; image: boolean; voice: boolean; video: boolean };
  notifications: { enabled: boolean };
  ui: { scale: number; fontSize: FontSize; sidebarCollapsed: boolean; previewCollapsed: boolean; previewRatio: number };
}

export const DEFAULT_SETTINGS: AlphaSettings = {
  version: 1,
  model: { default: null },
  budget: { maxToolCalls: 120, wallTimeMinutes: 15 },
  generation: { comfyUrl: "http://127.0.0.1:8188", image: true, voice: true, video: true },
  notifications: { enabled: true },
  ui: { scale: 1, fontSize: "md", sidebarCollapsed: false, previewCollapsed: false, previewRatio: 0.46 },
};

export const LIMITS = {
  maxToolCalls: [20, 400],
  wallTimeMinutes: [1, 60],
  scale: [0.8, 1.5],
  previewRatio: [0.2, 0.8],
} as const;

export class SettingsError extends Error {}

const MODEL_SELECTOR = /^[^\s/]+\/\S+$/;

export function isModelSelector(value: unknown): value is string {
  return typeof value === "string" && MODEL_SELECTOR.test(value);
}

/** ComfyUI must stay on this machine; a remote generation service is never configured from the workbench. */
export function normalizeComfyUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new SettingsError("ComfyUI 地址格式不正确"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new SettingsError("ComfyUI 只能使用本机地址（127.0.0.1 或 localhost）");
  // The ComfyUI client only talks to 127.0.0.1, so localhost is stored in that form.
  url.hostname = "127.0.0.1";
  return url.origin;
}

type Section = Record<string, unknown>;

function section(value: unknown, name: string, strict: boolean): Section {
  if (value === undefined) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Section;
  if (strict) throw new SettingsError(`设置项 ${name} 格式不正确`);
  return {};
}

function pick<T>(patch: Section, key: string, current: T, parse: (value: unknown) => T | undefined, strict: boolean, label: string): T {
  if (!(key in patch)) return current;
  const parsed = parse(patch[key]);
  if (parsed === undefined) {
    if (strict) throw new SettingsError(`设置项 ${label} 的值不正确`);
    return current;
  }
  return parsed;
}

const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
const number = (min: number, max: number, integer: boolean) => (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(max, Math.max(min, value));
  return integer ? Math.round(clamped) : clamped;
};

/**
 * Applies a partial update. Numbers are clamped into their ranges; with `strict`, wrong types and invalid values are
 * rejected (for API updates), otherwise they fall back to the current value (for tolerant loading of an edited file).
 */
export function mergeSettings(current: AlphaSettings, input: unknown, strict = true): AlphaSettings {
  const patch = section(input, "settings", strict);
  const model = section(patch.model, "model", strict);
  const budget = section(patch.budget, "budget", strict);
  const generation = section(patch.generation, "generation", strict);
  const notifications = section(patch.notifications, "notifications", strict);
  const ui = section(patch.ui, "ui", strict);
  return {
    version: 1,
    model: {
      default: pick(model, "default", current.model.default, value => value === null ? null : isModelSelector(value) ? value : undefined, strict, "默认模型"),
    },
    budget: {
      maxToolCalls: pick(budget, "maxToolCalls", current.budget.maxToolCalls, number(...LIMITS.maxToolCalls, true), strict, "工具调用上限"),
      wallTimeMinutes: pick(budget, "wallTimeMinutes", current.budget.wallTimeMinutes, number(...LIMITS.wallTimeMinutes, true), strict, "单轮时长上限"),
    },
    generation: {
      comfyUrl: pick(generation, "comfyUrl", current.generation.comfyUrl, value => {
        if (typeof value !== "string") return undefined;
        try { return normalizeComfyUrl(value); } catch (error) { if (strict) throw error; return undefined; }
      }, strict, "ComfyUI 地址"),
      image: pick(generation, "image", current.generation.image, bool, strict, "图片生成"),
      voice: pick(generation, "voice", current.generation.voice, bool, strict, "语音生成"),
      video: pick(generation, "video", current.generation.video, bool, strict, "视频生成"),
    },
    notifications: {
      enabled: pick(notifications, "enabled", current.notifications.enabled, bool, strict, "通知"),
    },
    ui: {
      scale: pick(ui, "scale", current.ui.scale, number(...LIMITS.scale, false), strict, "界面缩放"),
      fontSize: pick(ui, "fontSize", current.ui.fontSize, value => value === "sm" || value === "md" || value === "lg" ? value : undefined, strict, "字号"),
      sidebarCollapsed: pick(ui, "sidebarCollapsed", current.ui.sidebarCollapsed, bool, strict, "侧栏"),
      previewCollapsed: pick(ui, "previewCollapsed", current.ui.previewCollapsed, bool, strict, "预览栏"),
      previewRatio: pick(ui, "previewRatio", current.ui.previewRatio, number(...LIMITS.previewRatio, false), strict, "预览宽度"),
    },
  };
}

/** Serializes writes of one small JSON file and replaces it atomically, like the task ledger does. */
class JsonFile<T> {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly file: string) {}

  async read(): Promise<unknown> {
    await this.queue;
    try { return JSON.parse(await readFile(this.file, "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  write(value: T): Promise<void> {
    const contents = JSON.stringify(value, null, 2);
    this.queue = this.queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents);
      await rename(temporary, this.file);
    });
    return this.queue;
  }
}

export class SettingsStore {
  private readonly json: JsonFile<AlphaSettings>;
  private cached: AlphaSettings | null = null;

  constructor(dataRoot: string) {
    this.json = new JsonFile(join(dataRoot, "settings.json"));
  }

  async get(): Promise<AlphaSettings> {
    this.cached ??= mergeSettings(DEFAULT_SETTINGS, await this.json.read() ?? {}, false);
    return this.cached;
  }

  async update(patch: unknown): Promise<AlphaSettings> {
    const next = mergeSettings(await this.get(), patch, true);
    this.cached = next;
    await this.json.write(next);
    return next;
  }
}

export interface TaskMeta {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

/** Workbench-only annotations for tasks (display title, pinning, archiving); the task ledger is never touched. */
export class WorkbenchMeta {
  private readonly json: JsonFile<{ tasks: Record<string, TaskMeta> }>;
  private cached: Record<string, TaskMeta> | null = null;

  constructor(dataRoot: string) {
    this.json = new JsonFile(join(dataRoot, "workbench.json"));
  }

  async all(): Promise<Record<string, TaskMeta>> {
    if (!this.cached) {
      const stored = await this.json.read() as { tasks?: unknown } | undefined;
      this.cached = stored?.tasks && typeof stored.tasks === "object" ? stored.tasks as Record<string, TaskMeta> : {};
    }
    return this.cached;
  }

  async get(taskId: string): Promise<TaskMeta> {
    return (await this.all())[taskId] ?? {};
  }

  async update(taskId: string, input: unknown): Promise<TaskMeta> {
    const patch = section(input, "meta", true);
    const next: TaskMeta = { ...await this.get(taskId) };
    if ("title" in patch) {
      if (patch.title !== null && typeof patch.title !== "string") throw new SettingsError("标题必须是文字");
      const title = typeof patch.title === "string" ? patch.title.trim().replace(/\s+/g, " ").slice(0, 80) : "";
      if (title) next.title = title;
      else delete next.title;
    }
    for (const key of ["pinned", "archived"] as const) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== "boolean") throw new SettingsError(`${key} 必须是布尔值`);
      if (patch[key]) next[key] = true;
      else delete next[key];
    }
    const tasks = { ...await this.all() };
    if (Object.keys(next).length) tasks[taskId] = next;
    else delete tasks[taskId];
    this.cached = tasks;
    await this.json.write({ tasks });
    return next;
  }
}
