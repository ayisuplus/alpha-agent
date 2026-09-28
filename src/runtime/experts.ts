import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { createExpertPackage, loadExpertPackageSkills, personaText, type ExpertPackage } from "./expert-package";
import { warnUnknownStoreVersion } from "./store-tag";

const builtinRoot = resolve(import.meta.dir, "..", "..", "presets", "agents");
const sourceUrl = "https://github.com/msitarzewski/agency-agents";
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface ExpertSnapshot {
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

export const EXPERT_LINES = ["development", "research", "content", "game", "office", "general"] as const;
export type ExpertLine = typeof EXPERT_LINES[number];

export interface Expert extends ExpertSnapshot {
  enabled: boolean;
  builtin: boolean;
  /** Business line of the core template the expert derives from; display grouping only, never hashed or snapshotted. */
  line?: ExpertLine;
}

export interface LocalExpertImport {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: { url: string; revision: string; path: string };
  skills: Array<{ id: string; source: string }>;
}

type Stored = { enabled: Record<string, boolean>; custom: ExpertSnapshot[] };
type BuiltinIndex = { revision: string; presets: Array<{ id: string; name: string; description: string; line?: ExpertLine; file: string; sourcePath?: string; skill?: string }> };

function hash(name: string, description: string, instructions: string, skillIds?: string[], bundle?: ExpertPackage): string {
  return createHash("sha256").update(JSON.stringify(bundle ? [name, description, instructions, skillIds ?? [], bundle] : skillIds ? [name, description, instructions, skillIds] : [name, description, instructions])).digest("hex");
}

function field(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}不能为空或超过 ${max} 字`);
  return value.trim();
}

export function snapshotExpert(preset: Expert): ExpertSnapshot {
  const { id, name, description, instructions, skillIds, hash, source, basedOn, package: bundle } = preset;
  return { id, name, description, instructions, ...(skillIds ? { skillIds: [...skillIds] } : {}), ...(bundle ? { package: { revision: bundle.revision, skills: bundle.skills.map(item => ({ ...item })) } } : {}), hash, ...(source ? { source } : {}), ...(basedOn ? { basedOn } : {}) };
}

export function verifyExpertSnapshot(preset: ExpertSnapshot): void {
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

export class ExpertStore {
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
    warnUnknownStoreVersion("agent-presets", parsed);
    return parsed;
  }

  private async index(): Promise<BuiltinIndex> {
    const index = JSON.parse(await readFile(join(this.root, "index.json"), "utf8")) as BuiltinIndex;
    if (index.presets.some(item => item.line !== undefined && !EXPERT_LINES.includes(item.line))) throw new Error("内置角色清单业务线无效");
    return index;
  }

  /** Resolves each expert's line through its basedOn chain; imported or hand-written experts have none. */
  private async withLines(presets: Expert[]): Promise<Expert[]> {
    const lines = new Map((await this.index()).presets.flatMap(item => item.line ? [[item.id, item.line] as const] : []));
    const byId = new Map(presets.map(item => [item.id, item]));
    const lineOf = (preset: Expert): ExpertLine | undefined => {
      let current: Expert | undefined = preset;
      for (let depth = 0; current && depth < 8; depth++) {
        const found = lines.get(current.id) ?? (current.basedOn ? lines.get(current.basedOn) : undefined);
        if (found) return found;
        current = current.basedOn ? byId.get(current.basedOn) : undefined;
      }
      return undefined;
    };
    return presets.map(item => { const line = lineOf(item); return line ? { ...item, line } : item; });
  }

  private async builtins(): Promise<ExpertSnapshot[]> {
    const index = await this.index();
    return Promise.all(index.presets.map(async item => {
      if (!idPattern.test(item.id) || !/^[a-z0-9-]+\.md$/.test(item.file)) throw new Error("内置角色清单格式无效");
      const instructions = (await readFile(join(this.root, item.file), "utf8")).trim();
      if (item.skill && !idPattern.test(item.skill)) throw new Error("内置 Skill 名称无效");
      const skills = item.skill ? [`alpha-core:${item.skill}`] : undefined;
      const bundle = item.skill ? await createExpertPackage(this.dataRoot, item.id, item.name, item.description, instructions, skills!, undefined, [{ id: skills![0], source: join(this.root, "skills", item.skill) }]) : undefined;
      return {
        id: item.id, name: item.name, description: item.description, instructions, ...(skills ? { skillIds: skills, package: bundle } : {}), hash: hash(item.name, item.description, instructions, skills, bundle),
        ...(item.sourcePath ? { source: { url: sourceUrl, revision: index.revision, path: item.sourcePath } } : {}),
      };
    }));
  }

  private from(stored: Stored): Expert[] {
    return stored.custom.map(item => ({ ...item, builtin: false, enabled: stored.enabled[item.id] !== false }));
  }

  async templates(): Promise<Expert[]> {
    return this.withLines((await this.builtins()).filter(item => item.id !== "general").map(item => ({ ...item, builtin: true, enabled: false })));
  }

  /** Explicit curation only; opening the library never changes the user's roster. */
  installCoreExperts(retireIds: string[]): Promise<Expert[]> {
    return this.mutate(async (stored, all) => {
      const templates = await this.templates();
      for (const template of templates) {
        verifyExpertSnapshot(template);
        if (!template.package?.skills.length) throw new Error(`核心专家缺少 Skill：${template.id}`);
        await this.loadBundledSkills(template);
        const existing = all.find(item => item.id === `core-${template.id}`);
        if (existing && existing.basedOn !== template.id) throw new Error(`核心专家 ID 冲突：${existing.id}`);
        if (existing) { verifyExpertSnapshot(existing); await this.loadBundledSkills(existing); }
      }
      for (const id of retireIds) {
        if (!all.some(item => item.id === id) || templates.some(item => `core-${item.id}` === id)) throw new Error(`停用专家 ID 无效：${id}`);
      }
      for (const template of templates) {
        const id = `core-${template.id}`;
        if (all.some(item => item.id === id)) continue;
        const bundle = await createExpertPackage(this.dataRoot, id, template.name, template.description, template.instructions, template.skillIds!, template);
        stored.custom.push({ ...snapshotExpert(template), id, basedOn: template.id, package: bundle, hash: hash(template.name, template.description, template.instructions, template.skillIds, bundle) });
      }
      for (const id of retireIds) stored.enabled[id] = false;
      return this.from(stored).filter(item => templates.some(template => item.id === `core-${template.id}`));
    });
  }

  /**
   * Brings the named core experts to the current template version, adding any that are not installed yet. Explicit
   * only: the caller decides which installed copies are unedited. Enabled state is kept, and earlier package
   * revisions stay on disk for the tasks that froze them.
   */
  syncCoreExperts(templateIds: string[]): Promise<Expert[]> {
    return this.mutate(async (stored, all) => {
      const templates = await this.templates();
      const targets = await Promise.all([...new Set(templateIds)].map(async templateId => {
        const template = templates.find(item => item.id === templateId);
        if (!template?.package?.skills.length) throw new Error(`核心专家模板不存在：${templateId}`);
        verifyExpertSnapshot(template);
        await this.loadBundledSkills(template);
        const existing = all.find(item => item.id === `core-${templateId}`);
        if (existing && existing.basedOn !== templateId) throw new Error(`核心专家 ID 冲突：${existing.id}`);
        return template;
      }));
      for (const template of targets) {
        const id = `core-${template.id}`;
        const bundle = await createExpertPackage(this.dataRoot, id, template.name, template.description, template.instructions, template.skillIds!, template);
        const next: ExpertSnapshot = { ...snapshotExpert(template), id, basedOn: template.id, package: bundle, hash: hash(template.name, template.description, template.instructions, template.skillIds, bundle) };
        const index = stored.custom.findIndex(item => item.id === id);
        if (index < 0) stored.custom.push(next);
        else stored.custom[index] = next;
      }
      return this.from(stored).filter(item => targets.some(template => item.id === `core-${template.id}`));
    });
  }

  async list(): Promise<Expert[]> {
    await this.pending;
    return this.from(await this.stored());
  }

  /** The library as shown in the workbench: every stored expert with its display line. */
  async catalog(): Promise<Expert[]> {
    return this.withLines(await this.list());
  }

  async get(id: string): Promise<Expert> {
    const preset = (await this.list()).find(item => item.id === id) ?? (await this.templates()).find(item => item.id === id);
    if (!preset) throw new Error(`角色预设不存在：${id}`);
    return preset;
  }

  async enabled(): Promise<ExpertSnapshot[]> {
    return (await this.list()).filter(item => item.enabled).map(snapshotExpert);
  }

  loadBundledSkills(preset: ExpertSnapshot): Promise<Skill[]> {
    verifyExpertSnapshot(preset);
    return loadExpertPackageSkills(this.dataRoot, preset);
  }

  private mutate<T>(change: (stored: Stored, all: Expert[]) => Promise<T> | T): Promise<T> {
    const work = this.pending.then(async () => {
      const stored = await this.stored();
      const result = await change(stored, this.from(stored));
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      // .alpha/agent-presets.json (agent-presets store): v1 = {enabled, custom, format, version}; a version bump must migrate in stored().
      await writeFile(temporary, JSON.stringify({ ...stored, format: "agent-presets", version: 1 }, null, 2));
      await rename(temporary, this.file);
      return result;
    });
    this.pending = work.catch(() => undefined);
    return work;
  }

  setEnabled(id: string, enabled: boolean): Promise<Expert> {
    if (typeof enabled !== "boolean") throw new Error("启用状态必须是布尔值");
    return this.mutate((stored, all) => {
      const preset = all.find(item => item.id === id);
      if (!preset) throw new Error(`角色预设不存在：${id}`);
      stored.enabled[id] = enabled;
      return { ...preset, enabled };
    });
  }

  copy(id: string): Promise<Expert> {
    return this.mutate(async (stored, all) => {
      const base = all.find(item => item.id === id) ?? (await this.templates()).find(item => item.id === id);
      if (!base) throw new Error(`角色预设不存在：${id}`);
      verifyExpertSnapshot(base);
      const copy: ExpertSnapshot = { ...snapshotExpert(base), id: `custom-${randomUUID()}`, name: `${base.name} 副本`, basedOn: id };
      copy.package = await createExpertPackage(this.dataRoot, copy.id, copy.name, copy.description, copy.instructions, copy.skillIds ?? [], base);
      copy.hash = hash(copy.name, copy.description, copy.instructions, copy.skillIds, copy.package);
      stored.custom.push(copy);
      return { ...copy, builtin: false, enabled: true };
    });
  }

  create(input: { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown }): Promise<Expert> {
    return this.mutate(async stored => {
      const name = field(input.name, "专家名称", 80);
      const description = field(input.description, "适用范围", 240);
      const instructions = field(input.instructions, "专业方法", 20_000);
      const skills = input.skillIds === undefined ? undefined : skillIds(input.skillIds);
      const id = `expert-${randomUUID()}`;
      const bundle = await createExpertPackage(this.dataRoot, id, name, description, instructions, skills ?? []);
      const item: ExpertSnapshot = { id, name, description, instructions, ...(skills ? { skillIds: skills } : {}), package: bundle, hash: hash(name, description, instructions, skills, bundle) };
      stored.custom.push(item);
      return { ...item, builtin: false, enabled: true };
    });
  }

  importLocalBatch(records: LocalExpertImport[]): Promise<Expert[]> {
    return this.mutate(async stored => {
      if (new Set(records.map(item => item.id)).size !== records.length) throw new Error("导入专家 ID 重复");
      const imported: Expert[] = [];
      for (const record of records) {
        if (!idPattern.test(record.id)) throw new Error(`导入专家 ID 无效：${record.id}`);
        const name = field(record.name, "专家名称", 80);
        const description = field(record.description, "适用范围", 240);
        const instructions = field(record.instructions, "专业方法", 100_000);
        const ids = skillIds(record.skills.map(item => item.id));
        const existing = stored.custom.find(item => item.id === record.id);
        if (existing && (existing.source?.url !== record.source.url || existing.source.path !== record.source.path)) throw new Error(`专家 ID 来源冲突：${record.id}`);
        if (existing) {
          verifyExpertSnapshot(existing);
          imported.push({ ...existing, enabled: stored.enabled[existing.id] !== false, builtin: false });
          continue;
        }
        const bundle = await createExpertPackage(this.dataRoot, record.id, name, description, instructions, ids, existing, record.skills);
        const item: ExpertSnapshot = { id: record.id, name, description, instructions, skillIds: ids, package: bundle, source: record.source, hash: hash(name, description, instructions, ids, bundle) };
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

  update(id: string, patch: { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown }): Promise<Expert> {
    return this.mutate(async (stored, all) => {
      const current = all.find(item => item.id === id);
      if (!current && (await this.templates()).some(item => item.id === id)) throw new Error("内置角色请先复制再修改");
      if (!current) throw new Error(`角色预设不存在：${id}`);
      if (current.builtin) throw new Error("内置角色请先复制再修改");
      verifyExpertSnapshot(current);
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
