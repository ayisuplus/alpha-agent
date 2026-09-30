/** Isolated UI fixture: real Alpha server/OMP/tools, deterministic loopback model, no user credentials. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const appRoot = resolve(import.meta.dir, "..");
const evidence = resolve(process.argv[2] ?? join(appRoot, "artifacts", "workbench-polish-2026-09-30"));
await mkdir(evidence, { recursive: true });
const workspace = await mkdtemp(join(evidence, "preview-"));
const agentDir = join(workspace, "omp");
const project = join(workspace, "示例项目");
await mkdir(agentDir); await mkdir(project);
await writeFile(join(project, "材料.txt"), "# 产品体验\n\n草稿、阅读与交付应保持连续。\n");
await writeFile(join(project, "app.ts"), 'export const greeting = "你好";\n');
for (const args of [["init"], ["add", "."], ["-c", "user.name=Alpha UI fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture baseline"]]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: project, windowsHide: true });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
await writeFile(join(project, "材料.txt"), "# 产品体验\n\n草稿在设置往返后保留。\n阅读历史时不会跳到最新。\n");

const captures: Array<{ model: string; user: string; hasImage: boolean; tools: string[] }> = [];
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/captures") return Response.json(captures);
  const body = await request.json() as { model: string; messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
  const userIndex = body.messages.findLastIndex(item => item.role === "user" && !JSON.stringify(item.content).includes("Attached image(s) from tool result:"));
  const user = JSON.stringify(body.messages[userIndex]?.content ?? "");
  const toolResults = body.messages.slice(userIndex + 1).filter(item => item.role === "tool").length;
  captures.push({ model: body.model, user: user.slice(0, 180), hasImage: user.includes("image_url"), tools: body.tools?.map(item => item.function.name) ?? [] });
  await writeFile(join(evidence, "model-captures.json"), JSON.stringify(captures, null, 2));
  if (user.includes("验证错误")) return Response.json({ error: { message: "401 fixture: invalid API key", type: "authentication_error" } }, { status: 401 });
  const call = user.includes("验证提问") && toolResults === 0
    ? { name: "ask", arguments: JSON.stringify({ questions: [{ id: "style", question: "选择文档风格", options: [{ label: "简洁" }, { label: "完整" }] }] }) }
    : user.includes("验证代码") && toolResults < 2
      ? toolResults === 0 ? { name: "read", arguments: JSON.stringify({ path: "app.ts" }) }
        : { name: "write", arguments: JSON.stringify({ path: "app.ts", content: 'export const greeting = "你好，Alpha";\n' }) }
    : user.includes("验证工具") && toolResults < 2
      ? toolResults === 0 ? { name: "read", arguments: JSON.stringify({ path: "材料.txt" }) }
        : { name: "alpha_office", arguments: JSON.stringify({ action: "create", kind: "docx", name: "体验改进", content: "# 体验改进\n\n验证草稿保存、流式阅读、文件审查和文档预览。\n" }) }
      : null;
  const stream = new ReadableStream({ async start(controller) {
    const push = (delta: unknown, finish: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));
    try {
      push({ role: "assistant" });
      if (call) { push({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: call }] }); push({}, "tool_calls"); }
      else if (user.includes("验证滚动")) {
        for (let index = 1; index <= 140; index++) { push({ content: `段落 ${index}：这是用于验证阅读连续性的本机固定流。上翻后应保留位置，点击回到最新恢复跟随。\n\n` }); await Bun.sleep(300); }
        push({}, "stop");
      } else { push({ content: user.includes("验证代码") ? "已修改 [示例代码](app.ts)。" : user.includes("验证工具") ? "已读取材料并生成 [体验改进文档](outputs/体验改进.docx)。" : "本机测试响应已完成。这段固定输出仅用于验证界面和请求链路。" }); push({}, "stop"); }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close();
    } catch { /* The UI may abort the fixture stream. */ }
  } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
} });
const models = [
  { id: "vision", name: "本机测试 · 图片", input: ["text", "image"] },
  { id: "text", name: "本机测试 · 文字", input: ["text"] },
].map(model => ({ ...model, contextWindow: 100000, maxTokens: 10000, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
await writeFile(join(agentDir, "models.yml"), JSON.stringify({ providers: { "ui-fixture": { baseUrl: `http://127.0.0.1:${fixture.port}/v1`, api: "openai-completions", auth: "none", apiKey: "local-fixture-only", models } } }));
await writeFile(join(agentDir, "config.yml"), "modelRoles:\n  default: ui-fixture/vision\ndefaultThinkingLevel: off\nstartup:\n  setupWizard: false\n  checkUpdate: false\nretry:\n  enabled: false\n");
const token = randomBytes(24).toString("hex");
const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], { cwd: appRoot, env: { ...process.env, ALPHA_WORKSPACE_ROOT: workspace, PI_CODING_AGENT_DIR: agentDir, ALPHA_SERVER_TOKEN: token }, stdout: "pipe", stderr: "pipe", windowsHide: true });
void (async () => {
  const errors = child.stderr.getReader();
  for (;;) { const chunk = await errors.read(); if (chunk.done) return; await writeFile(join(evidence, "server-stderr.txt"), chunk.value, { flag: "a" }); }
})();
const reader = child.stdout.getReader();
let output = "";
while (!/ALPHA_SERVER_READY (\d+)/.test(output)) {
  const chunk = await reader.read();
  if (chunk.done) throw new Error("Preview server exited before startup");
  output += new TextDecoder().decode(chunk.value);
}
const port = Number(/ALPHA_SERVER_READY (\d+)/.exec(output)![1]);
const api = async (path: string, input: unknown) => {
  const result = await fetch(`http://127.0.0.1:${port}/api/native/${path}`, { method: "POST", headers: { "x-alpha-token": token, "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!result.ok) throw new Error(await result.text());
  return result.json() as Promise<{ session: { id: string } }>;
};
const first = await api("sessions", { cwd: project, title: "产品体验验证" });
const second = await api("sessions", { cwd: project, title: "另一份草稿" });
const third = await api("sessions", { cwd: workspace, title: "另一个项目" });
await writeFile(join(evidence, "startup.json"), JSON.stringify({ port, token, workspace, project, ids: [first.session.id, second.session.id, third.session.id] }, null, 2));
console.log(JSON.stringify({ port, workspace, evidence }));
const stop = async () => {
  fixture.stop(true);
  if (process.platform === "win32") await Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
  else child.kill();
  await child.exited; process.exit(0);
};
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
await child.exited;
