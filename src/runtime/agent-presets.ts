import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const builtinRoot = resolve(import.meta.dir, "..", "..", "presets", "agents");
const sourceUrl = "https://github.com/msitarzewski/agency-agents";
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface AgentPresetSnapshot {
  id: string;
  name: string;
  description: string;
  instructions: string;
  hash: string;
  source?: { url: string; revision: string; path: string };
  basedOn?: string;
}

export interface AgentPreset extends AgentPresetSnapshot {
  enabled: boolean;
  builtin: boolean;
}

type Stored = { enabled: Record<string, boolean>; custom: AgentPresetSnapshot[] };
type BuiltinIndex = { revision: string; presets: Array<{ id: string; name: string; description: string; file: string; sourcePath?: string }> };

function hash(name: string, description: string, instructions: string): string {
  return createHash("sha256").update(JSON.stringify([name, description, instructions])).digest("hex");
}

function field(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}不能为空或超过 ${max} 字`);
  return value.trim();
}

export function presetSnapshot(preset: AgentPreset): AgentPresetSnapshot {
  const { id, name, description, instructions, hash, source, basedOn } = preset;
  return { id, name, description, instructions, hash, ...(source ? { source } : {}), ...(basedOn ? { basedOn } : {}) };
}

export function verifyPresetSnapshot(preset: AgentPresetSnapshot): void {
  if (!idPattern.test(preset.id) || hash(preset.name, preset.description, preset.instructions) !== preset.hash) throw new Error(`角色预设快照无效：${preset.id}`);
}

export class AgentPresetStore {
  private readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string, private readonly root = builtinRoot) {
    this.file = join(dataRoot, "agent-presets.json");
  }

  private async stored(): Promise<Stored> {
    const raw = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!raw) return { enabled: {}, custom: [] };
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || typeof parsed !== "object" || !parsed.enabled || typeof parsed.enabled !== "object" || !Array.isArray(parsed.custom)) throw new Error("角色预设数据格式无效");
    return parsed;
  }

  private async builtins(): Promise<AgentPresetSnapshot[]> {
    const index = JSON.parse(await readFile(join(this.root, "index.json"), "utf8")) as BuiltinIndex;
    return Promise.all(index.presets.map(async item => {
      if (!idPattern.test(item.id) || !/^[a-z0-9-]+\.md$/.test(item.file)) throw new Error("内置角色清单格式无效");
      const instructions = (await readFile(join(this.root, item.file), "utf8")).trim();
      return {
        id: item.id, name: item.name, description: item.description, instructions, hash: hash(item.name, item.description, instructions),
        ...(item.sourcePath ? { source: { url: sourceUrl, revision: index.revision, path: item.sourcePath } } : {}),
      };
    }));
  }

  private async from(stored: Stored): Promise<AgentPreset[]> {
    const builtins = (await this.builtins()).map(item => ({ ...item, builtin: true, enabled: item.id === "general" || stored.enabled[item.id] !== false }));
    const custom = stored.custom.map(item => ({ ...item, builtin: false, enabled: stored.enabled[item.id] !== false }));
    return [...builtins, ...custom];
  }

  async list(): Promise<AgentPreset[]> {
    await this.pending;
    return this.from(await this.stored());
  }

  async get(id: string): Promise<AgentPreset> {
    const preset = (await this.list()).find(item => item.id === id);
    if (!preset) throw new Error(`角色预设不存在：${id}`);
    return preset;
  }

  async enabled(): Promise<AgentPresetSnapshot[]> {
    return (await this.list()).filter(item => item.enabled).map(presetSnapshot);
  }

  private mutate<T>(change: (stored: Stored, all: AgentPreset[]) => Promise<T> | T): Promise<T> {
    const work = this.pending.then(async () => {
      const stored = await this.stored();
      const result = await change(stored, await this.from(stored));
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(stored, null, 2));
      await rename(temporary, this.file);
      return result;
    });
    this.pending = work.catch(() => undefined);
    return work;
  }

  setEnabled(id: string, enabled: boolean): Promise<AgentPreset> {
    if (typeof enabled !== "boolean") throw new Error("启用状态必须是布尔值");
    return this.mutate((stored, all) => {
      const preset = all.find(item => item.id === id);
      if (!preset) throw new Error(`角色预设不存在：${id}`);
      if (id === "general" && !enabled) throw new Error("通用 worker 必须保持可用");
      stored.enabled[id] = enabled;
      return { ...preset, enabled };
    });
  }

  copy(id: string): Promise<AgentPreset> {
    return this.mutate((stored, all) => {
      const base = all.find(item => item.id === id);
      if (!base) throw new Error(`角色预设不存在：${id}`);
      const copy: AgentPresetSnapshot = { ...presetSnapshot(base), id: `custom-${randomUUID()}`, name: `${base.name} 副本`, basedOn: id };
      copy.hash = hash(copy.name, copy.description, copy.instructions);
      stored.custom.push(copy);
      return { ...copy, builtin: false, enabled: true };
    });
  }

  update(id: string, patch: { name?: unknown; description?: unknown; instructions?: unknown }): Promise<AgentPreset> {
    return this.mutate((stored, all) => {
      const current = all.find(item => item.id === id);
      if (!current) throw new Error(`角色预设不存在：${id}`);
      if (current.builtin) throw new Error("内置角色请先复制再修改");
      const item = stored.custom.find(item => item.id === id)!;
      if (patch.name !== undefined) item.name = field(patch.name, "角色名称", 80);
      if (patch.description !== undefined) item.description = field(patch.description, "适用说明", 240);
      if (patch.instructions !== undefined) item.instructions = field(patch.instructions, "角色指令", 20_000);
      item.hash = hash(item.name, item.description, item.instructions);
      return { ...item, builtin: false, enabled: stored.enabled[id] !== false };
    });
  }
}
