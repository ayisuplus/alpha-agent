import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../../api/client";
import type { Settings } from "../../api/types";
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
  </section>;
}

export function GenerationSettings() {
  const settings = useSettings();
  const generation = settings.generation;
  const [url, setUrl] = useState(generation.comfyUrl);
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "online" | "offline" }>({ state: "idle" });

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
    <SectionTitle title="生成服务" description="任务需要原创图片、配音或视频时，Alpha 会主动调用本机的 ComfyUI。关闭某一项后，模型不会得到对应的工具。" />
    <Field stacked label="ComfyUI 地址" description="只能是本机地址。服务需要你自己保持运行；Alpha 不会换用其他生成服务。">
      <span className="settings-inline">
        <input className="settings-text" value={url} aria-label="ComfyUI 地址" spellCheck={false}
          onChange={event => setUrl(event.target.value)} onBlur={() => void commitUrl()} onKeyDown={event => { if (event.key === "Enter") void commitUrl(); }} />
        <Button size="sm" onClick={() => void runCheck()} busy={check.state === "checking"}>检测</Button>
        {check.state === "online" && <Badge tone="success">在线</Badge>}
        {check.state === "offline" && <Badge tone="warning">未连接</Badge>}
      </span>
    </Field>
    <Field label="图片生成" description="插画、封面、背景等。视频的参考图也依赖它。">
      <Toggle label="图片生成" checked={generation.image} onChange={value => void updateSettings({ generation: { image: value } })} />
    </Field>
    <Field label="语音生成" description="旁白、欢迎语等配音。">
      <Toggle label="语音生成" checked={generation.voice} onChange={value => void updateSettings({ generation: { voice: value } })} />
    </Field>
    <Field label="视频生成" description={generation.image ? "从生成的横版参考图制作短视频，耗时较长。" : "视频需要先生成参考图；图片生成关闭时不可用。"} disabled={!generation.image}>
      <Toggle label="视频生成" checked={generation.video && generation.image} disabled={!generation.image} onChange={value => void updateSettings({ generation: { video: value } })} />
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
