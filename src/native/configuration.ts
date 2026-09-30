import { join } from "node:path";
import { discoverAuthStorage, getAgentDir, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import "@oh-my-pi/pi-coding-agent/config/all-settings";
import { all, lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";

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

  async catalog() {
    const auth = await discoverAuthStorage(this.agentDir);
    try {
      const registry = new ModelRegistry(auth, join(this.agentDir, "models.yml"), { settings: await this.settings() });
      const available = new Set(registry.getAvailable().map(model => `${model.provider}/${model.id}`));
      const models = registry.getAll("chat").map(model => ({
        provider: model.provider, id: model.id, name: model.name || model.id,
        selector: `${model.provider}/${model.id}`, reasoning: model.reasoning,
        contextWindow: model.contextWindow, available: available.has(`${model.provider}/${model.id}`),
      }));
      const providers = [...new Set(models.map(model => model.provider))].sort().map(id => ({
        id, origin: auth.keys.source(id)?.kind ?? null,
        storedKey: auth.credentials.list(id).some(row => row.credential.type === "api_key"),
        oauth: auth.credentials.hasOAuth(id),
        available: models.filter(model => model.provider === id && model.available).length,
      }));
      return { models, providers, error: registry.getError()?.message ?? null };
    } finally { auth.close(); }
  }

  async read() {
    const settings = await this.settings();
    return { agentDir: this.agentDir, modelRoles: settings.getModelRoles(), settings: all().filter(editable).map(setting => ({
      id: setting.id, type: setting.type, value: setting.get(settings) ?? null,
      label: setting.ui?.label ?? setting.id, description: setting.ui?.description ?? "",
      tab: setting.ui?.tab ?? "model", group: setting.ui?.group ?? "OMP",
      values: setting.enumValues, provenance: settings.getProvenance(setting),
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

  async update(input: Record<string, unknown>) {
    const settings = await this.settings();
    if (input.role === "default") {
      if (typeof input.model !== "string") throw new Error("请选择默认模型");
      if (input.model && !(await this.catalog()).models.some(model => model.selector === input.model && model.available)) throw new Error("这个模型尚未配置可用凭据");
      settings.setModelRole("default", input.model || undefined);
    } else {
      const setting = typeof input.id === "string" ? lookup(input.id) : undefined;
      if (!setting || !editable(setting)) throw new Error("不支持编辑这个设置");
      if (input.reset === true) setting.unset(settings);
      else {
        if (setting.type === "array" && !Array.isArray(input.value)) throw new Error("这个设置需要 JSON 数组");
        if (setting.type === "record" && (!input.value || typeof input.value !== "object" || Array.isArray(input.value))) throw new Error("这个设置需要 JSON 对象");
        setting.set(settings, input.value);
      }
    }
    await settings.flush();
    return this.read();
  }

  async credential(input: Record<string, unknown>) {
    if (typeof input.provider !== "string" || !(await this.catalog()).providers.some(provider => provider.id === input.provider)) throw new Error("未知模型服务商");
    const auth = await discoverAuthStorage(this.agentDir);
    try {
      const rows = auth.credentials.list(input.provider);
      if (input.action === "remove") {
        for (const row of rows) if (row.credential.type === "api_key") await auth.credentials.removeById(input.provider, row.id);
      } else {
        if (rows.some(row => row.credential.type === "oauth")) throw new Error("已有 OAuth 凭据，请勿用 API Key 覆盖");
        if (typeof input.key !== "string" || !input.key.trim() || /\s/.test(input.key.trim())) throw new Error("请输入有效的 API Key");
        await auth.credentials.set(input.provider, { type: "api_key", key: input.key.trim() });
      }
    } finally { auth.close(); }
  }
}
