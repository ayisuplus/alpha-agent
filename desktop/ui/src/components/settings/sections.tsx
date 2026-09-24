import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../../api/client";
import type { Settings, SkillPlugin } from "../../api/types";
import { SCALE_STEPS, SHORTCUTS } from "../../state/shortcuts";
import { useStore } from "../../state/store";
import { notify, previewLocked, store, updateSettings } from "../../state/workbench";
import { Badge, Button } from "../ui";
import { Field, NumberInput, SectionTitle, Segmented, Toggle } from "./controls";

function useSettings(): Settings {
  return useStore(store, state => state.settings)!;
}

export function RunSettings() {
  const settings = useSettings();
  return <section>
    <SectionTitle title="运行" description="限制每一轮模型运行的规模。超出上限时本轮会停止并记录为「达到预算」，之后可以继续修复。" />
    <Field label="单轮工具调用上限" description="读取、编辑、构建、生成等每次工具调用都计入。默认 120。">
      <NumberInput label="单轮工具调用上限" value={settings.budget.maxToolCalls} min={20} max={400} step={10} unit="次"
        onCommit={value => void updateSettings({ budget: { maxToolCalls: value } })} />
    </Field>
    <Field label="单轮时长上限" description="从模型开始工作算起，构建与浏览器验收不计入。默认 15 分钟。">
      <NumberInput label="单轮时长上限" value={settings.budget.wallTimeMinutes} min={1} max={60} unit="分钟"
        onCommit={value => void updateSettings({ budget: { wallTimeMinutes: value } })} />
    </Field>
    <Field label="任务总工具调用上限" description="跨恢复和修复轮次累计；达到上限后需调整预算才能继续。默认 1200。">
      <NumberInput label="任务总工具调用上限" value={settings.budget.maxTotalToolCalls} min={20} max={10000} step={100} unit="次"
        onCommit={value => void updateSettings({ budget: { maxTotalToolCalls: value } })} />
    </Field>
    <Field label="任务总模型时长上限" description="只累计模型运行时间。默认 120 分钟。">
      <NumberInput label="任务总模型时长上限" value={settings.budget.totalWallTimeMinutes} min={1} max={1440} step={10} unit="分钟"
        onCommit={value => void updateSettings({ budget: { totalWallTimeMinutes: value } })} />
    </Field>
  </section>;
}

export function GenerationSettings() {
  const settings = useSettings();
  const generation = settings.generation;
  const enabled = settings.plugins.comfyui;
  const [url, setUrl] = useState(generation.comfyUrl);
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "online" | "offline" }>({ state: "idle" });
  const [skillPlugins, setSkillPlugins] = useState<SkillPlugin[]>([]);
  const [pluginSource, setPluginSource] = useState("");
  const [mcpTools, setMcpTools] = useState<Record<string, string[]>>({});
  const [mcpPermissions, setMcpPermissions] = useState<Record<string, "deny" | "read" | "write">>({});
  const [installing, setInstalling] = useState(false);
  useEffect(() => { void api.plugins().then(setSkillPlugins).catch(error => notify(error instanceof Error ? error.message : String(error))); }, []);

  const installPlugin = async () => {
    if (!pluginSource.trim()) return;
    setInstalling(true);
    try {
      const plugin = await api.installPlugin(pluginSource.trim());
      setSkillPlugins(current => [...current.filter(item => item.id !== plugin.id), plugin]);
      setPluginSource("");
      notify(`${plugin.name} 已安装：${plugin.skillCount} 个 Skills、${plugin.hookCount} 个 Pi Hook、${plugin.mcpCount} 个 MCP 服务`, "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setInstalling(false); }
  };

  const togglePlugin = async (plugin: SkillPlugin, enabled: boolean) => {
    try {
      const updated = await api.setPluginEnabled(plugin.id, enabled);
      setSkillPlugins(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const toggleHooks = async (plugin: SkillPlugin, hooksEnabled: boolean) => {
    try {
      const updated = await api.setPluginHooksEnabled(plugin.id, hooksEnabled);
      setSkillPlugins(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const toggleMCP = async (plugin: SkillPlugin, mcpEnabled: boolean) => {
    try {
      const updated = await api.setPluginMCPEnabled(plugin.id, mcpEnabled);
      setSkillPlugins(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const checkMCP = async (plugin: SkillPlugin) => {
    try {
      const result = await api.checkPluginMCP(plugin.id);
      setMcpTools(current => ({ ...current, [plugin.id]: result.tools }));
      setMcpPermissions(await api.mcpPermissions(plugin.id));
      notify(result.errors.length ? `MCP 连接失败：${result.errors.join("; ")}` : `MCP 已连接，发现 ${result.tools.length} 个工具`, result.errors.length ? "error" : "info");
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };

  const commitUrl = async () => {
    const next = url.trim();
    if (!next || next === generation.comfyUrl) { setUrl(generation.comfyUrl); return; }
    const saved = await updateSettings({ generation: { comfyUrl: next } });
    setUrl(saved ? store.get().settings!.generation.comfyUrl : generation.comfyUrl);
    setCheck({ state: "idle" });
  };

  const runCheck = async () => {
    setCheck({ state: "checking" });
    try {
      const result = await api.checkGeneration(url.trim() || generation.comfyUrl);
      setCheck({ state: result.online ? "online" : "offline" });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      setCheck({ state: "idle" });
    }
  };

  return <section>
    <SectionTitle title="插件" description="内置插件在下一轮任务开始时装载。" />
    <Field stacked label="ComfyUI" description="内置插件，提供本机图片、配音和视频生成。关闭后模型不会得到它的工具。">
      <Toggle label="启用 ComfyUI 插件" checked={enabled} onChange={value => void updateSettings({ plugins: { comfyui: value } })} />
    </Field>
    <Field stacked label="第三方插件" description="从 GitHub 仓库导入 Skills、Pi Hook 和 .mcp.json。Hook 与 MCP 独立启用；启用后会运行插件代码或连接它声明的服务，请只对信任的插件使用。变更在下一轮任务生效。">
      <div className="settings-inline">
        <input className="settings-text" aria-label="插件 GitHub 地址" placeholder="https://github.com/owner/repo.git" value={pluginSource} spellCheck={false}
          onChange={event => setPluginSource(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void installPlugin(); }} />
        <Button size="sm" busy={installing} disabled={installing || !pluginSource.trim()} onClick={() => void installPlugin()}>安装</Button>
      </div>
      {skillPlugins.map(plugin => <div className="provider-row" key={plugin.id}>
        <div className="provider-main">
          <strong className="provider-name">{plugin.name}</strong>
          <span className="provider-meta">{plugin.skillCount} 个 Skills · {plugin.hookCount} 个 Pi Hook · {plugin.mcpCount} 个 MCP 服务 · {plugin.revision.slice(0, 8)} · {plugin.source}</span>
        </div>
        <span className="provider-meta">插件</span><Toggle label={`启用 ${plugin.name} 插件`} checked={plugin.enabled} onChange={value => void togglePlugin(plugin, value)} />
        {plugin.hookCount > 0 && <><span className="provider-meta">Hook</span><Toggle label={`启用 ${plugin.name} Hook`} checked={plugin.hooksEnabled} disabled={!plugin.enabled} onChange={value => void toggleHooks(plugin, value)} /></>}
        {plugin.mcpCount > 0 && <><span className="provider-meta">MCP</span><Toggle label={`启用 ${plugin.name} MCP`} checked={plugin.mcpEnabled} disabled={!plugin.enabled} onChange={value => void toggleMCP(plugin, value)} />{plugin.mcpEnabled && <Button size="sm" onClick={() => void checkMCP(plugin)}>检测</Button>}</>}
        {(mcpTools[plugin.id] ?? []).map(tool => <label className="provider-meta" key={tool}>{tool}：
          <select aria-label={`${tool} 权限`} value={mcpPermissions[tool] ?? "deny"} onChange={event => {
            const permission = event.target.value as "deny" | "read" | "write";
            void api.setMCPPermission(plugin.id, tool, permission).then(setMcpPermissions).catch(error => notify(error instanceof Error ? error.message : String(error)));
          }}>
            <option value="deny">禁止</option><option value="read">只读</option><option value="write">外部写入（记录回执）</option>
          </select>
        </label>)}
      </div>)}
    </Field>
    <Field stacked label="ComfyUI 地址" description="只能是本机地址。服务需要你自己保持运行；Alpha 不会换用其他生成服务。" disabled={!enabled}>
      <span className="settings-inline">
        <input className="settings-text" value={url} aria-label="ComfyUI 地址" spellCheck={false} disabled={!enabled}
          onChange={event => setUrl(event.target.value)} onBlur={() => void commitUrl()} onKeyDown={event => { if (event.key === "Enter") void commitUrl(); }} />
        <Button size="sm" onClick={() => void runCheck()} busy={check.state === "checking"} disabled={!enabled}>检测</Button>
        {check.state === "online" && <Badge tone="success">在线</Badge>}
        {check.state === "offline" && <Badge tone="warning">未连接</Badge>}
      </span>
    </Field>
    <Field stacked label="图片生成" description="插画、封面、背景等。视频的参考图也依赖它。" disabled={!enabled}>
      <Toggle label="图片生成" checked={generation.image} disabled={!enabled} onChange={value => void updateSettings({ generation: { image: value } })} />
    </Field>
    <Field stacked label="语音生成" description="旁白、欢迎语等配音。" disabled={!enabled}>
      <Toggle label="语音生成" checked={generation.voice} disabled={!enabled} onChange={value => void updateSettings({ generation: { voice: value } })} />
    </Field>
    <Field stacked label="视频生成" description={generation.image ? "从生成的横版参考图制作短视频，耗时较长。" : "视频需要先生成参考图；图片生成关闭时不可用。"} disabled={!enabled || !generation.image}>
      <Toggle label="视频生成" checked={generation.video && generation.image} disabled={!enabled || !generation.image} onChange={value => void updateSettings({ generation: { video: value } })} />
    </Field>
  </section>;
}

export function InterfaceSettings() {
  const settings = useSettings();
  const ui = settings.ui;
  return <section>
    <SectionTitle title="界面" description="只影响工作台本身；产品预览始终按原始大小显示，避免干扰浏览器验收。" />
    <Field label="界面缩放" description="也可以用 Ctrl + = / Ctrl + - 调整，Ctrl + 0 恢复。">
      <Segmented label="界面缩放" value={ui.scale} onChange={value => void updateSettings({ ui: { scale: value } })}
        options={SCALE_STEPS.map(step => ({ value: step, label: `${Math.round(step * 100)}%` }))} />
    </Field>
    <Field label="文字大小" description="调整正文、输入框和列表的字号，界面布局不变。">
      <Segmented label="文字大小" value={ui.fontSize} onChange={value => void updateSettings({ ui: { fontSize: value } })}
        options={[{ value: "sm", label: "小" }, { value: "md", label: "标准" }, { value: "lg", label: "大" }]} />
    </Field>
    <Field label="桌面通知" description="工作台不在前台时，任务完成、待验收或需要接管会提醒你。">
      <Toggle label="桌面通知" checked={settings.notifications.enabled} onChange={value => void updateSettings({ notifications: { enabled: value } })} />
    </Field>
    <Field label="收起任务栏" description="Ctrl + B。窗口较窄时会自动收起。">
      <Toggle label="收起任务栏" checked={ui.sidebarCollapsed} onChange={value => void updateSettings({ ui: { sidebarCollapsed: value } })} />
    </Field>
    <Field label="收起预览栏" description="Ctrl + Shift + B。发布预览或浏览器验收时会自动展开。">
      <Toggle label="收起预览栏" checked={ui.previewCollapsed} onChange={value => {
        if (value && previewLocked(store.get())) notify("浏览器正在使用预览，操作结束后才能收起", "info");
        else void updateSettings({ ui: { previewCollapsed: value } });
      }} />
    </Field>
    <Field label="恢复默认布局" description="100% 缩放、标准字号、两侧展开，预览宽度复位。">
      <Button size="sm" icon={RotateCcw} onClick={() => void updateSettings({ ui: { scale: 1, fontSize: "md", sidebarCollapsed: false, previewCollapsed: false, previewRatio: 0.46 } })}>恢复</Button>
    </Field>
  </section>;
}

export function ShortcutSettings() {
  const groups = ["任务", "输入", "界面"] as const;
  return <section>
    <SectionTitle title="快捷键" />
    {groups.map(group => <div key={group} className="settings-shortcut-group">
      <h3>{group}</h3>
      {SHORTCUTS.filter(shortcut => shortcut.group === group).map(shortcut => <div key={shortcut.id} className="settings-shortcut">
        <span>{shortcut.label}</span>
        <span className="settings-keys">{shortcut.keys.map(key => <kbd key={key}>{key}</kbd>)}</span>
      </div>)}
    </div>)}
  </section>;
}
