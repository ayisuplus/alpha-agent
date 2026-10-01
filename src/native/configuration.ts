import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { YAML } from "bun";
import { discoverAuthStorage, getAgentDir, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import "@oh-my-pi/pi-coding-agent/config/all-settings";
import { all, lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { getKnownRoleIds, getRoleInfo, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { redact, preserveRedacted } from "./config-redaction";

const revision = (value: string | null) => createHash("sha256").update(value === null ? "absent" : value).digest("hex");
const readOptional = (path: string) => readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
export async function assertProjectConfigurationScope(cwd: string) {
  const directory = join(cwd, ".omp");
  await mkdir(directory, { recursive: true });
  const part = relative(await realpath(cwd), await realpath(directory));
  if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part)) throw new Error("Project configuration directory is outside the project");
}
export async function replaceNativeConfiguration(path: string, content: string, previous: string | null) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (await readOptional(path) !== previous) throw new Error("Configuration changed since opening; reload before saving");
    await replaceFileAtomically(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const editable = (setting: AnySetting) => !setting.isCredential &&
  // Scalars render as native controls; arrays/records with UI metadata render as JSON editing.
  ["boolean", "number", "string", "enum", "array", "record"].includes(setting.type) &&
  // browser.cdpUrl is Alpha's generated wiring to the browser host (per launch overlay);
  // user edits there could never take effect, so it stays out of the settings surface.
  setting.id !== "browser.cdpUrl" &&
  (!!setting.ui || ["retry.enabled", "defaultThinkingLevel", "compaction.enabled"].includes(setting.id));

/** The desktop edits OMP's own settings and credential store, not an Alpha model whitelist. */
export class NativeConfiguration {
  readonly agentDir: string;
  #settings: Promise<Settings> | undefined;
  constructor(agentDir = getAgentDir()) { this.agentDir = agentDir; }
  private settings() {
    return this.#settings ??= Settings.loadIsolated({ agentDir: this.agentDir, cwd: this.agentDir });
  }

  async catalog(settings?: Settings, currentRegistry?: ModelRegistry) {
    const auth = currentRegistry?.authStorage ?? await discoverAuthStorage(this.agentDir);
    try {
      settings ??= await this.settings();
      const registry = currentRegistry ?? new ModelRegistry(auth, join(this.agentDir, "models.yml"), { settings });
      const available = new Set(registry.getAvailable("all").map(model => `${model.provider}/${model.id}`));
      const mapModel = (model: ReturnType<ModelRegistry["getAll"]>[number]) => ({
        provider: model.provider, id: model.id, name: model.name || model.id,
        selector: `${model.provider}/${model.id}`, reasoning: model.reasoning, input: model.input,
        contextWindow: model.contextWindow, available: available.has(`${model.provider}/${model.id}`) &&
          (auth.keys.source(model.provider)?.kind !== "env" || auth.credentials.list(model.provider).length > 0),
      });
      const models = registry.getAll("chat").map(mapModel);
      const roleModels = registry.getAll("all").map(mapModel);
      const roles = getKnownRoleIds(settings).map(id => ({ id, name: getRoleInfo(id, settings!).name, candidates: roleCandidatePool(id, settings!, registry).map(model => `${model.provider}/${model.id}`).filter(selector => roleModels.some(model => model.selector === selector && model.available)) }));
      const oauth = getOAuthProviders();
      const providers = [...new Set(models.map(model => model.provider))].sort().map(id => ({
        id, origin: auth.keys.source(id)?.kind ?? null,
        storedKey: auth.credentials.list(id).some(row => row.credential.type === "api_key"),
        oauth: auth.credentials.hasOAuth(id),
        available: models.filter(model => model.provider === id && model.available).length,
        login: oauth.some(provider => provider.id === id),
      }));
      for (const provider of oauth) if (!providers.some(item => item.id === provider.id)) providers.push({ id: provider.id, origin: null, storedKey: false, oauth: auth.credentials.hasOAuth(provider.id), available: 0, login: true });
      return { models, roleModels, roles, providers, error: registry.getError()?.message ?? null };
    } finally { if (!currentRegistry) auth.close(); }
  }

  async read(settings?: Settings) {
    settings ??= await this.settings();
    await settings.reloadFromDisk();
    return { agentDir: this.agentDir, modelRoles: settings.getModelRoles(),
      roles: getKnownRoleIds(settings).map(id => ({ id, name: getRoleInfo(id, settings!).name, provenance: settings!.getModelRoleProvenance(id) })),
      settings: all().filter(editable).map(setting => ({
      id: setting.id, type: setting.type, value: setting.get(settings) ?? null,
      label: setting.ui?.label ?? setting.id, description: setting.ui?.description ?? "",
      tab: setting.ui?.tab ?? "model", group: setting.ui?.group ?? "OMP",
      values: setting.enumValues, provenance: settings!.getProvenance(setting),
    })) };
  }

  /** True when the user has no theme of their own; Alpha may then offer its bundled terminal theme. */
  async themeUnset(): Promise<boolean> {
    const settings = await this.settings();
    for (const id of ["theme.dark", "theme.light"]) {
      const setting = lookup(id);
      if (setting && settings.getProvenance(setting) !== "default") return false;
    }
    return true;
  }

  async update(input: Record<string, unknown>, settings?: Settings, cwd?: string) {
    settings ??= await this.settings();
    await settings.reloadFromDisk();
    const project = input.scope === "project";
    if (project && !cwd) throw new Error("Project settings require a runtime session");
    if (project) await assertProjectConfigurationScope(cwd!);
    if (typeof input.role === "string") {
      if (!getKnownRoleIds(settings).includes(input.role)) throw new Error("Unknown native model role");
      if (typeof input.model !== "string") throw new Error("请选择默认模型");
      const catalog = await this.catalog(settings);
      if (input.model && !catalog.roles.find(role => role.id === input.role)?.candidates.includes(input.model)) throw new Error("Model is unavailable or incompatible with this native role");
      if (project) { if (input.model) settings.setProjectModelRole(input.role, input.model); else settings.clearProjectModelRole(input.role); }
      else settings.setModelRole(input.role, input.model || undefined);
    } else {
      const setting = typeof input.id === "string" ? lookup(input.id) : undefined;
      if (!setting || !editable(setting)) throw new Error("不支持编辑这个设置");
      if (input.reset !== true && setting.id === "tools.approval" && input.value && typeof input.value === "object") {
        if (Object.entries(input.value).some(([name, policy]) => !name.trim() || !["allow", "prompt", "deny"].includes(String(policy)))) throw new Error("Tool permissions must be allow, prompt or deny");
      }
      if (project) {
        // The registry validates values; OMP exposes project persistence only for model roles.
        if (input.reset !== true) {
          const validation = await Settings.loadReadOnly({ agentDir: this.agentDir, cwd });
          setting.override(validation, input.value);
        }
        const path = join(cwd!, ".omp", "config.yml");
        const previous = await readOptional(path);
        if (typeof input.revision !== "string" || input.revision !== revision(previous)) throw new Error("Reload project configuration before saving");
        const value = previous === null ? {} : YAML.parse(previous) as Record<string, unknown>;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project configuration must be a YAML mapping");
        const parts = setting.id.split("."); let parent = value;
        for (const part of parts.slice(0, -1)) { const child = parent[part]; if (child !== undefined && (!child || typeof child !== "object" || Array.isArray(child))) throw new Error("Invalid project setting parent"); parent = (parent[part] ??= {}) as Record<string, unknown>; }
        if (input.reset) delete parent[parts.at(-1)!]; else parent[parts.at(-1)!] = input.value;
        await replaceNativeConfiguration(path, YAML.stringify(value), previous);
        await settings.reloadFromDisk();
      } else if (input.reset === true) setting.unset(settings);
      else {
        if (setting.type === "array" && !Array.isArray(input.value)) throw new Error("这个设置需要 JSON 数组");
        if (setting.type === "record" && (!input.value || typeof input.value !== "object" || Array.isArray(input.value))) throw new Error("这个设置需要 JSON 对象");
        setting.set(settings, input.value);
      }
    }
    await settings.flush();
    return this.read(settings);
  }

  async projectRevision(cwd: string) { return revision(await readOptional(join(cwd, ".omp", "config.yml"))); }

  async providers(input?: Record<string, unknown>): Promise<{ path: string; config: unknown; revision: string }> {
    const config = ModelsConfigFile.relocate(join(this.agentDir, "models.yml"));
    const loaded = config.tryLoad();
    if (loaded.status === "error") throw loaded.error;
    const path = config.path(), previous = await readOptional(path), value = loaded.value ?? { providers: {} };
    if (input) {
      if (input.revision !== revision(previous)) throw new Error("Provider configuration changed; reload before saving");
      const next = preserveRedacted(input.config, value);
      await mkdir(this.agentDir, { recursive: true });
      const temporary = join(this.agentDir, "alpha-validate-" + randomUUID() + ".yml");
      try {
        await writeFile(temporary, YAML.stringify(next), { encoding: "utf8", flag: "wx", mode: 0o600 });
        const candidate = ModelsConfigFile.relocate(temporary).tryLoad();
        if (candidate.status !== "ok") throw candidate.error ?? new Error("Invalid model configuration");
        await replaceNativeConfiguration(path, YAML.stringify(next), previous);
      } finally { await rm(temporary, { force: true }); }
      return this.providers();
    }
    return { path, config: redact(value), revision: revision(previous) };
  }

  async credential(input: Record<string, unknown>) {
    if (typeof input.provider !== "string" || !(await this.catalog()).providers.some(provider => provider.id === input.provider)) throw new Error("未知模型服务商");
    const auth = await discoverAuthStorage(this.agentDir);
    try {
      const rows = auth.credentials.list(input.provider);
      if (input.action === "remove") {
        for (const row of rows) if (input.oauth === true ? row.credential.type === "oauth" : row.credential.type === "api_key") await auth.credentials.removeById(input.provider, row.id);
      } else {
        if (rows.some(row => row.credential.type === "oauth")) throw new Error("已有 OAuth 凭据，请勿用 API Key 覆盖");
        if (typeof input.key !== "string" || !input.key.trim() || /\s/.test(input.key.trim())) throw new Error("请输入有效的 API Key");
        await auth.credentials.set(input.provider, { type: "api_key", key: input.key.trim() });
      }
    } finally { auth.close(); }
  }
}
