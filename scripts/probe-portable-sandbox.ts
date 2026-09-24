import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2]) throw new Error("Usage: bun scripts/probe-portable-sandbox.ts <portable-directory>");
const runtime = join(packageRoot, "runtime", "bun.exe");
const sandbox = join(packageRoot, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
for (const file of [runtime, sandbox]) if (!(await stat(file)).isFile()) throw new Error(`Missing portable component: ${file}`);
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const env = {
  SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${join(systemRoot, "System32")};${systemRoot}`,
  USERPROFILE: process.env.USERPROFILE ?? "", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
  TEMP: process.env.TEMP ?? tmpdir(), TMP: process.env.TMP ?? tmpdir(),
};
const help = Bun.spawn([sandbox, "sandbox", "--help"], { cwd: packageRoot, env, stdout: "pipe", stderr: "pipe" });
if (await help.exited !== 0) throw new Error("Bundled sandbox runner failed without global PATH entries");
const workspace = await mkdtemp(join(tmpdir(), "alpha-portable-probe-"));
const child = Bun.spawn([runtime, "run", "src/server.ts"], { cwd: packageRoot, env: { ...env, ALPHA_WORKSPACE_ROOT: workspace }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const timer = setTimeout(() => child.kill(), 25_000);
try {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("Portable server output is unavailable");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let port: number | null = null;
  while (output.length < 20_000) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    const match = /ALPHA_SERVER_READY (\d+)/.exec(output);
    if (match) { port = Number(match[1]); break; }
  }
  reader.releaseLock();
  if (!port) throw new Error(`Portable sidecar did not become ready: ${output.slice(-1000)}`);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json()) as { ok?: boolean };
  const projects = await fetch(`http://127.0.0.1:${port}/api/projects`).then(response => response.json()) as { projects?: unknown[] };
  if (health.ok !== true || !Array.isArray(projects.projects)) throw new Error("Portable sidecar health or project API failed");
  console.log(JSON.stringify({ packageRoot, runtime: true, sandboxRunner: true, health, projectApi: true, globalCodexOnPath: false }));
} finally {
  clearTimeout(timer);
  child.kill();
  await child.exited;
  await rm(workspace, { recursive: true, force: true });
}
