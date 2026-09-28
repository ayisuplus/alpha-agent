import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_MODEL_PROVIDERS, isAllowedModelSelector, isProviderId } from "./model-policy";
import { warnUnknownStoreVersion } from "./store-tag";

export type FontSize = "sm" | "md" | "lg";

export interface AlphaSettings {
  version: 1;
  format: "settings";
  revision?: number;
  /** `providers` lists the model services Alpha may use; model choices outside it are dropped. */
  model: { default: string | null; translation: string | null; providers: string[] };
  workerModels: { investigate: string | null; implement: string | null; review: string | null };
  /** maxParallelTasks bounds how many tasks run their models at the same time. */
  budget: { maxToolCalls: number; wallTimeMinutes: number; maxTotalToolCalls: number; totalWallTimeMinutes: number; maxParallelTasks: number };
  generation: { comfyUrl: string; image: boolean; voice: boolean; video: boolean };
  plugins: { comfyui: boolean };
  notifications: { enabled: boolean };
  ui: { scale: number; fontSize: FontSize; sidebarCollapsed: boolean; previewCollapsed: boolean; previewRatio: number };
}

export const DEFAULT_SETTINGS: AlphaSettings = {
  version: 1,
  revision: 0,
  model: { default: null, translation: null, providers: [...DEFAULT_MODEL_PROVIDERS] },
  workerModels: { investigate: null, implement: null, review: null },
  budget: { maxToolCalls: 120, wallTimeMinutes: 30, maxTotalToolCalls: 1200, totalWallTimeMinutes: 120, maxParallelTasks: 3 },
  generation: { comfyUrl: "http://127.0.0.1:8188", image: true, voice: true, video: true },
  plugins: { comfyui: true },
  notifications: { enabled: true },
  ui: { scale: 1, fontSize: "md", sidebarCollapsed: false, previewCollapsed: false, previewRatio: 0.46 },
  format: "settings",
};

export const LIMITS = {
  maxToolCalls: [20, 400],
  wallTimeMinutes: [1, 60],
  maxTotalToolCalls: [20, 10000],
  totalWallTimeMinutes: [1, 1440],
  maxParallelTasks: [1, 8],
  scale: [0.8, 1.5],
  previewRatio: [0.2, 0.8],
} as const;

export class SettingsError extends Error {}

const MODEL_SELECTOR = /^[^\s/]+\/\S+$/;

export function isModelSelector(value: unknown, providers?: Iterable<string>): value is string {
  return typeof value === "string" && MODEL_SELECTOR.test(value) && isAllowedModelSelector(value, providers);
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
  const workerModels = section(patch.workerModels, "workerModels", strict);
  const budget = section(patch.budget, "budget", strict);
  const generation = section(patch.generation, "generation", strict);
  const plugins = section(patch.plugins, "plugins", strict);
  const notifications = section(patch.notifications, "notifications", strict);
  const ui = section(patch.ui, "ui", strict);
  // Providers first: every model choice below is checked against the list this update produces.
  const providers = pick(model, "providers", current.model.providers ?? [...DEFAULT_MODEL_PROVIDERS],
    value => Array.isArray(value) && value.length > 0 && value.length <= 40 && value.every(isProviderId) && new Set(value).size === value.length ? [...value] : undefined,
    strict, "允许的模型服务商");
  const selector = (value: unknown) => value === null ? null : isModelSelector(value, providers) ? value : undefined;
  // A choice whose provider was just disallowed falls back to its default instead of pointing at an unusable model.
  const kept = (value: string | null) => value !== null && !isAllowedModelSelector(value, providers) ? null : value;
  return {
    version: 1,
    revision: current.revision ?? 0,
    model: {
      default: kept(pick(model, "default", current.model.default, selector, strict, "默认模型")),
      translation: kept(pick(model, "translation", current.model.translation, selector, strict, "翻译模型")),
      providers,
    },
    workerModels: {
      investigate: kept(pick(workerModels, "investigate", current.workerModels.investigate, selector, strict, "调查子代理模型")),
      implement: kept(pick(workerModels, "implement", current.workerModels.implement, selector, strict, "实现子代理模型")),
      review: kept(pick(workerModels, "review", current.workerModels.review, selector, strict, "审查子代理模型")),
    },
    budget: {
      maxToolCalls: pick(budget, "maxToolCalls", current.budget.maxToolCalls, number(...LIMITS.maxToolCalls, true), strict, "工具调用上限"),
      wallTimeMinutes: pick(budget, "wallTimeMinutes", current.budget.wallTimeMinutes, number(...LIMITS.wallTimeMinutes, true), strict, "单轮时长上限"),
      maxTotalToolCalls: pick(budget, "maxTotalToolCalls", current.budget.maxTotalToolCalls, number(...LIMITS.maxTotalToolCalls, true), strict, "任务总工具调用上限"),
      totalWallTimeMinutes: pick(budget, "totalWallTimeMinutes", current.budget.totalWallTimeMinutes, number(...LIMITS.totalWallTimeMinutes, true), strict, "任务总时长上限"),
      maxParallelTasks: pick(budget, "maxParallelTasks", current.budget.maxParallelTasks ?? DEFAULT_SETTINGS.budget.maxParallelTasks, number(...LIMITS.maxParallelTasks, true), strict, "同时运行的任务数"),
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
    plugins: {
      comfyui: pick(plugins, "comfyui", current.plugins.comfyui, bool, strict, "ComfyUI 插件"),
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
    format: "settings",
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
  private updates: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.json = new JsonFile(join(dataRoot, "settings.json"));
  }

  async get(): Promise<AlphaSettings> {
    if (!this.cached) {
      const stored = await this.json.read() ?? {};
      warnUnknownStoreVersion("settings", stored);
      this.cached = mergeSettings(DEFAULT_SETTINGS, stored, false);
      const revision = (stored as { revision?: unknown }).revision;
      this.cached.revision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    }
    return this.cached;
  }

  // .alpha/settings.json (settings store): v1 = AlphaSettings plus its format tag; a version bump must migrate inside mergeSettings, the only document loader.
  async update(patch: unknown): Promise<AlphaSettings> {
    const run = this.updates.then(async () => {
      const next = mergeSettings(await this.get(), patch, true);
      next.revision = (next.revision ?? 0) + 1;
      await this.json.write(next);
      this.cached = next;
      return next;
    });
    this.updates = run.then(() => undefined, () => undefined);
    return run;
  }
}

export interface TaskMeta {
  title?: string;
  /** Short name generated from the objective at creation; a title the person sets always wins. */
  autoTitle?: string;
  pinned?: boolean;
  archived?: boolean;
}

/** Workbench-only annotations for tasks (display title, pinning, archiving); the task ledger is never touched. */
// .alpha/workbench.json (workbench store): v1 = {tasks, format, version}; a version bump must migrate in all() before caching.
type WorkbenchFile = { tasks: Record<string, TaskMeta>; format: "workbench"; version: 1 };

export class WorkbenchMeta {
  private readonly json: JsonFile<WorkbenchFile>;
  private cached: Record<string, TaskMeta> | null = null;
  private updates: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.json = new JsonFile(join(dataRoot, "workbench.json"));
  }

  async all(): Promise<Record<string, TaskMeta>> {
    if (!this.cached) {
      const stored = await this.json.read() as { tasks?: unknown; version?: number } | undefined;
      if (stored) warnUnknownStoreVersion("workbench", stored);
      this.cached = stored?.tasks && typeof stored.tasks === "object" ? stored.tasks as Record<string, TaskMeta> : {};
    }
    return this.cached;
  }

  async get(taskId: string): Promise<TaskMeta> {
    return (await this.all())[taskId] ?? {};
  }

  async update(taskId: string, input: unknown): Promise<TaskMeta> {
    const run = this.updates.then(() => this.applyUpdate(taskId, input));
    this.updates = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Runtime-only: people rename through `update`, which never touches the generated title. */
  async setAutoTitle(taskId: string, autoTitle: string): Promise<TaskMeta> {
    const run = this.updates.then(async () => {
      const next: TaskMeta = { ...await this.get(taskId), autoTitle: autoTitle.trim().replace(/\s+/g, " ").slice(0, 80) };
      const tasks = { ...await this.all(), [taskId]: next };
      await this.json.write({ tasks, format: "workbench", version: 1 });
      this.cached = tasks;
      return next;
    });
    this.updates = run.then(() => undefined, () => undefined);
    return run;
  }

  private async applyUpdate(taskId: string, input: unknown): Promise<TaskMeta> {
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
    await this.json.write({ tasks, format: "workbench", version: 1 });
    this.cached = tasks;
    return next;
  }
}
