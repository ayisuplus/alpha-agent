import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentPresetStore } from "../src/runtime/agent-presets";
import { createSkillResourceTool } from "../src/runtime/skill-resource-tool";

const { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const model = modelRegistry.getAvailable().find(item => item.provider === "xiaomi-token-plan-cn" && item.id === "mimo-v2.6-flash");
if (!model) throw new Error("MiMo V2.6 Flash is unavailable; no fallback model selected");
const root = resolve(".alpha", "probes", `core-experts-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(root, { recursive: true });
const store = new AgentPresetStore(join(root, "state"));
const cases = [
  { id: "backend", prompt: "请审查这段修改是否可合入，不修改源码。契约：只有文档所有者可以删除。代码：app.delete('/docs/:id', requireLogin, async (req,res) => { await db.query('DELETE FROM docs WHERE id = ?', [req.params.id]); res.sendStatus(204); }); 现有测试只验证已登录账号删除自己的文档返回 204。数据库字段：docs(id, owner_id)。给出结论、依据和必要验证。" },
  { id: "data-analyst", prompt: "请审查统计方案。A、B 两个模型在同一测试集上各训练 3 个配对种子，每种子保存 100 个 epoch 的准确率；作者把每个模型的 300 行视为独立样本做 t 检验，并选择在该测试集上最高的 checkpoint 报结果，声称显著优于 B。现在只给你方案，没有原始分数。请建议如何报告和修正。" },
  { id: "visual-director", prompt: "请交付 15 秒短片的下一步制作方案。已确认剧本：少女推开窗，望见雨中的庭院。有原始角色图，但此轮尚未提供；还没有收集摄影参考。用户指定只用本地 ComfyUI 的既定工作流，当前服务不可访问。不要启动服务。本轮可用工具只有读取随包 Skill。" },
];
const results: Array<Record<string, unknown>> = [];
for (const item of cases) {
  const prompt = `${item.prompt}\n请控制在 500 字以内，聚焦请求的审查或方案，不额外生成代码。`;
  const expert = await store.get(item.id);
  const skills = await store.loadBundledSkills(expert);
  const calls: string[] = [];
  const { session } = await createAgentSession({
    cwd: root, agentDir: join(root, "agent"), authStorage, modelRegistry, model,
    sessionManager: SessionManager.inMemory(root), systemPrompt: expert.instructions,
    toolNames: ["alpha_skill_read"], restrictToolNames: true, allowRestrictedCustomTools: true, customTools: [createSkillResourceTool(skills)],
    disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void session.abort(); }, 90_000);
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start") { calls.push(event.toolName); if (calls.length > 6) void session.abort(); }
  });
  try {
    if (session.getActiveToolNames().join(",") !== "alpha_skill_read") throw new Error("Probe tool registration failed");
    await session.prompt(prompt);
    const answer = session.state.messages.filter(message => message.role === "assistant").flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text)).join("\n").trim();
    const skillRead = calls.includes("alpha_skill_read");
    results.push({ expert: item.id, hash: expert.hash, prompt, calls, skillRead, timedOut, answer });
    if (!skillRead || timedOut || calls.length > 6 || !answer) process.exitCode = 1;
  } catch (error) {
    results.push({ expert: item.id, calls, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    clearTimeout(timer); unsubscribe(); await session.dispose();
    await writeFile(join(root, "report.json"), JSON.stringify({ model: `${model.provider}/${model.id}`, results, note: "Skill loading is checked automatically; answer quality requires review." }, null, 2));
  }
  console.log(JSON.stringify({ expert: item.id, calls, report: join(root, "report.json") }));
}
