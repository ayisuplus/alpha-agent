import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { createExpertPackage, loadExpertPackageSkills, personaText, type ExpertPackage } from "./expert-package";

const builtinRoot = resolve(import.meta.dir, "..", "..", "presets", "agents");
const sourceUrl = "https://github.com/msitarzewski/agency-agents";
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface AgentPresetSnapshot {
  id: string;
  name: string;
  description: string;
  instructions: string;
  skillIds?: string[];
  package?: ExpertPackage;
  hash: string;
  source?: { url: string; revision: string; path: string };
  basedOn?: string;
}

export interface AgentPreset extends AgentPresetSnapshot {
  enabled: boolean;
  builtin: boolean;
}

export interface LocalExpertImport {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: { url: string; revision: string; path: string };
  skills: Array<{ id: string; source: string }>;
}

type Stored = { enabled: Record<string, boolean>; custom: AgentPresetSnapshot[] };
type BuiltinIndex = { revision: string; presets: Array<{ id: string; name: string; description: string; file: string; sourcePath?: string }> };

function hash(name: string, description: string, instructions: string, skillIds?: string[], bundle?: ExpertPackage): string {
  return createHash("sha256").update(JSON.stringify(bundle ? [name, description, instructions, skillIds ?? [], bundle] : skillIds ? [name, description, instructions, skillIds] : [name, description, instructions])).digest("hex");
}

function field(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}不能为空或超过 ${max} 字`);
  return value.trim();
}

export function presetSnapshot(preset: AgentPreset): AgentPresetSnapshot {
  const { id, name, description, instructions, skillIds, hash, source, basedOn, package: bundle } = preset;
  return { id, name, description, instructions, ...(skillIds ? { skillIds: [...skillIds] } : {}), ...(bundle ? { package: { revision: bundle.revision, skills: bundle.skills.map(item => ({ ...item })) } } : {}), hash, ...(source ? { source } : {}), ...(basedOn ? { basedOn } : {}) };
}

export function verifyPresetSnapshot(preset: AgentPresetSnapshot): void {
  if (preset.package) {
    const skills = preset.package.skills;
    if (!Array.isArray(skills) || skills.some(item => !item || typeof item.id !== "string" || typeof item.hash !== "string" || !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(item.id) || !/^[0-9a-f]{64}$/.test(item.hash))) throw new Error(`专家包清单无效：${preset.id}`);
    const packageHash = createHash("sha256").update(JSON.stringify([personaText(preset.name, preset.description, preset.instructions), skills.map(item => [item.id, item.hash])])).digest("hex");
    if (skills.length !== (preset.skillIds?.length ?? 0) || JSON.stringify(skills.map(item => item.id)) !== JSON.stringify(preset.skillIds ?? []) || packageHash !== preset.package.revision) throw new Error(`专家包清单无效：${preset.id}`);
  }
  if (!idPattern.test(preset.id) || hash(preset.name, preset.description, preset.instructions, preset.skillIds, preset.package) !== preset.hash) throw new Error(`专家快照无效：${preset.id}`);
}

function skillIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20 || !value.every(item => typeof item === "string" && /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(item)) || new Set(value).size !== value.length) throw new Error("关联 Skill 列表无效");
  return [...value];
}

export class AgentPresetStore {
  private readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataRoot: string, private readonly root = builtinRoot) {
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

  private from(stored: Stored): AgentPreset[] {
    return stored.custom.map(item => ({ ...item, builtin: false, enabled: stored.enabled[item.id] !== false }));
  }

  async templates(): Promise<AgentPreset[]> {
    return (await this.builtins()).filter(item => item.id !== "general").map(item => ({ ...item, builtin: true, enabled: false }));
  }

  async list(): Promise<AgentPreset[]> {
    await this.pending;
    return this.from(await this.stored());
  }

  async get(id: string): Promise<AgentPreset> {
    const preset = (await this.list()).find(item => item.id === id) ?? (await this.templates()).find(item => item.id === id);
    if (!preset) throw new Error(`角色预设不存在：${id}`);
    return preset;
  }

  async enabled(): Promise<AgentPresetSnapshot[]> {
    return (await this.list()).filter(item => item.enabled).map(presetSnapshot);
  }

  loadBundledSkills(preset: AgentPresetSnapshot): Promise<Skill[]> {
    verifyPresetSnapshot(preset);
    return loadExpertPackageSkills(this.dataRoot, preset);
  }

  private mutate<T>(change: (stored: Stored, all: AgentPreset[]) => Promise<T> | T): Promise<T> {
    const work = this.pending.then(async () => {
      const stored = await this.stored();
      const result = await change(stored, this.from(stored));
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
      stored.enabled[id] = enabled;
      return { ...preset, enabled };
    });
  }

  copy(id: string): Promise<AgentPreset> {
    return this.mutate(async (stored, all) => {
      const base = all.find(item => item.id === id) ?? (await this.templates()).find(item => item.id === id);
      if (!base) throw new Error(`角色预设不存在：${id}`);
      verifyPresetSnapshot(base);
      const copy: AgentPresetSnapshot = { ...presetSnapshot(base), id: `custom-${randomUUID()}`, name: `${base.name} 副本`, basedOn: id };
      copy.package = await createExpertPackage(this.dataRoot, copy.id, copy.name, copy.description, copy.instructions, copy.skillIds ?? [], base);
      copy.hash = hash(copy.name, copy.description, copy.instructions, copy.skillIds, copy.package);
      stored.custom.push(copy);
      return { ...copy, builtin: false, enabled: true };
    });
  }

  create(input: { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown }): Promise<AgentPreset> {
    return this.mutate(async stored => {
      const name = field(input.name, "专家名称", 80);
      const description = field(input.description, "适用范围", 240);
      const instructions = field(input.instructions, "专业方法", 20_000);
      const skills = input.skillIds === undefined ? undefined : skillIds(input.skillIds);
      const id = `expert-${randomUUID()}`;
      const bundle = await createExpertPackage(this.dataRoot, id, name, description, instructions, skills ?? []);
      const item: AgentPresetSnapshot = { id, name, description, instructions, ...(skills ? { skillIds: skills } : {}), package: bundle, hash: hash(name, description, instructions, skills, bundle) };
      stored.custom.push(item);
      return { ...item, builtin: false, enabled: true };
    });
  }

  importLocalBatch(records: LocalExpertImport[]): Promise<AgentPreset[]> {
    return this.mutate(async stored => {
      if (new Set(records.map(item => item.id)).size !== records.length) throw new Error("导入专家 ID 重复");
      const imported: AgentPreset[] = [];
      for (const record of records) {
        if (!idPattern.test(record.id)) throw new Error(`导入专家 ID 无效：${record.id}`);
        const name = field(record.name, "专家名称", 80);
        const description = field(record.description, "适用范围", 240);
        const instructions = field(record.instructions, "专业方法", 100_000);
        const ids = skillIds(record.skills.map(item => item.id));
        const existing = stored.custom.find(item => item.id === record.id);
        if (existing && (existing.source?.url !== record.source.url || existing.source.path !== record.source.path)) throw new Error(`专家 ID 来源冲突：${record.id}`);
        if (existing) {
          verifyPresetSnapshot(existing);
          imported.push({ ...existing, enabled: stored.enabled[existing.id] !== false, builtin: false });
          continue;
        }
        const bundle = await createExpertPackage(this.dataRoot, record.id, name, description, instructions, ids, existing, record.skills);
        const item: AgentPresetSnapshot = { id: record.id, name, description, instructions, skillIds: ids, package: bundle, source: record.source, hash: hash(name, description, instructions, ids, bundle) };
        stored.custom.push(item);
        imported.push({ ...item, enabled: stored.enabled[item.id] !== false, builtin: false });
      }
      return imported;
    });
  }

  delete(id: string): Promise<void> {
    return this.mutate(stored => {
      const index = stored.custom.findIndex(item => item.id === id);
      if (index < 0) throw new Error(`专家不存在：${id}`);
      stored.custom.splice(index, 1);
      delete stored.enabled[id];
    });
  }

  update(id: string, patch: { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown }): Promise<AgentPreset> {
    return this.mutate(async (stored, all) => {
      const current = all.find(item => item.id === id);
      if (!current && (await this.templates()).some(item => item.id === id)) throw new Error("内置角色请先复制再修改");
      if (!current) throw new Error(`角色预设不存在：${id}`);
      if (current.builtin) throw new Error("内置角色请先复制再修改");
      verifyPresetSnapshot(current);
      const item = stored.custom.find(item => item.id === id)!;
      if (patch.name !== undefined) item.name = field(patch.name, "角色名称", 80);
      if (patch.description !== undefined) item.description = field(patch.description, "适用说明", 240);
      if (patch.instructions !== undefined) item.instructions = field(patch.instructions, "角色指令", 20_000);
      if (patch.skillIds !== undefined) item.skillIds = skillIds(patch.skillIds);
      item.package = await createExpertPackage(this.dataRoot, item.id, item.name, item.description, item.instructions, item.skillIds ?? [], current);
      item.hash = hash(item.name, item.description, item.instructions, item.skillIds, item.package);
      return { ...item, builtin: false, enabled: stored.enabled[id] !== false };
    });
  }
}
