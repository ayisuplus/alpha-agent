/** Isolated real Alpha UI fixture; no cloud model request or user document is used. */
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const root = resolve(import.meta.dir, "../../.."), temp = await mkdtemp(join(tmpdir(), "alpha-office-workbench-"));
const profile = join(temp, "profile"), project = join(temp, "project"); await mkdir(profile); await mkdir(project);
await writeFile(join(profile, "config.yml"), "startup:\n  checkUpdate: false\n");
for (const name of ["native-tracked.docx", "native-structure.xlsx", "native-notes-deck.pptx"]) await copyFile(join(import.meta.dir, "fixtures", name), join(project, name));
const token = "isolated-office-preview";
const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: profile, ALPHA_WORKSPACE_ROOT: temp, ALPHA_SERVER_TOKEN: token, ALPHA_BROWSER_CDP_URL: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader(); let output = "", port = 0;
while (!port) { const chunk = await reader.read(); if (chunk.done) throw Error("Preview server failed to start"); output += new TextDecoder().decode(chunk.value); port = Number(/ALPHA_SERVER_READY (\d+)/.exec(output)?.[1] ?? 0); }
const post = (path: string, data: unknown) => fetch(`http://127.0.0.1:${port}/api/native/${path}`, { method: "POST", headers: { "x-alpha-token": token, "content-type": "application/json" }, body: JSON.stringify(data) });
// A dummy key lets OMP initialize its static catalog; this fixture never submits a model prompt.
await post("credentials", { provider: "deepseek", action: "save", key: "isolated-preview-not-a-real-key" });
const catalog = await fetch(`http://127.0.0.1:${port}/api/native/models`, { headers: { "x-alpha-token": token } }).then(response => response.json()) as { models: Array<{ provider: string; available: boolean; selector: string }> };
const model = catalog.models.find(item => item.provider === "deepseek" && item.available);
if (!model) throw Error("Isolated preview catalog unavailable");
await post("settings", { role: "default", model: model.selector });
const response = await fetch(`http://127.0.0.1:${port}/api/native/sessions`, { method: "POST", headers: { "x-alpha-token": token, "content-type": "application/json" }, body: JSON.stringify({ cwd: project, title: "原格式预览验证" }) });
const { session } = await response.json() as { session: { id: string } };
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/ui/?token=${token}`, sessionId: session.id, project, childPid: child.pid }));
const stop = async () => { await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdout: "ignore", stderr: "ignore" }).exited; await child.exited;
  const actual = await realpath(temp); if (!actual.startsWith(resolve(tmpdir()) + sep)) throw Error("Fixture cleanup escaped temp directory"); await rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); process.exit(0); };
process.on("SIGINT", () => void stop());
setTimeout(() => void stop(), 20 * 60_000);
await new Promise(() => {});
