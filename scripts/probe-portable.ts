import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { verifyPayloadHashes, verifyUiHashes } from "./portable-ui";
import { verifyUpdatePayload } from "./apply-app-update";

const portable = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2] || !await Bun.file(join(portable, "release.json")).exists()) throw new Error("Pass a built portable release directory");
const release = JSON.parse(await readFile(join(portable, "release.json"), "utf8")) as { format?: number; gitSha?: string; sources?: Record<string, string>; ui?: { files?: Record<string, string> } };
if (release.format === 2 || release.format === 3) {
  if (!release.ui?.files || typeof release.ui.files !== "object") throw new Error("Portable UI manifest is missing");
  await verifyUiHashes(join(portable, "desktop", "dist"), release.ui.files);
}
if (release.format === 3) {
  await verifyUpdatePayload(portable);
  if (!release.sources || !release.gitSha) throw new Error("Portable source manifest is missing");
  await verifyPayloadHashes(portable, release.sources);
}
const workspace = await mkdtemp(join(tmpdir(), "alpha-portable-probe-"));
const agentDir = join(workspace, "agent");
await mkdir(agentDir);
const child = Bun.spawn([join(portable, "runtime", "bun.exe"), "run", "src/native/server.ts"], {
  cwd: portable,
  env: { ...process.env, ALPHA_WORKSPACE_ROOT: workspace, PI_CODING_AGENT_DIR: agentDir, ALPHA_SERVER_TOKEN: "portable-probe-token" },
  stdout: "pipe",
  stderr: "pipe",
});
try {
  const reader = child.stdout.getReader();
  let output = "";
  const ready = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Portable server exited before ready: ${output}`);
      output += new TextDecoder().decode(chunk.value);
      const match = /ALPHA_SERVER_READY (\d+)/.exec(output);
      if (match) return Number(match[1]);
    }
  })();
  const port = await Promise.race([ready, Bun.sleep(60_000).then(() => { throw new Error("Portable server startup timed out"); })]);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error("Portable health probe failed");
  const page = await fetch(`http://127.0.0.1:${port}/ui/`);
  if (!page.ok) throw new Error("Portable desktop UI did not load");
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/ui\/assets\/[^"]+)"/g)].map(match => match[1]!);
  if (!html.includes('id="root"') || !assets.some(asset => asset.endsWith(".js"))) throw new Error("Portable desktop UI entry is incomplete");
  for (const asset of assets) {
    const response = await fetch(`http://127.0.0.1:${port}${asset}`);
    if (!response.ok || (await response.arrayBuffer()).byteLength === 0) throw new Error(`Portable desktop UI asset failed: ${asset}`);
  }
  const auth = { "x-alpha-token": "portable-probe-token" };
  const post = (path: string, input: unknown) => fetch(`http://127.0.0.1:${port}/api/native/${path}`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(input) });
  if (!(await post("credentials", { provider: "deepseek", action: "save", key: "alpha-probe-not-a-real-key" })).ok) throw new Error("Isolated probe credentials failed");
  const catalog = await fetch(`http://127.0.0.1:${port}/api/native/models`, { headers: auth }).then(response => response.json()) as { models: Array<{ provider: string; available: boolean; selector: string }> };
  const model = catalog.models.find(item => item.provider === "deepseek" && item.available);
  if (!model || !(await post("settings", { role: "default", model: model.selector })).ok) throw new Error("Isolated probe model configuration failed");
  const created = await fetch(`http://127.0.0.1:${port}/api/native/sessions`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ cwd: workspace, title: "Portable smoke" }) });
  if (!created.ok) throw new Error(`Portable session creation failed: ${await created.text()}`);
  const id = (await created.json() as { session: { id: string } }).session.id;
  const opened = await fetch(`http://127.0.0.1:${port}/api/native/sessions/${id}/open`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{}" });
  if (!opened.ok) throw new Error(`Portable session open failed: ${await opened.text()}`);
  const state = await fetch(`http://127.0.0.1:${port}/api/native/sessions/${id}/state`, { headers: auth });
  if (!state.ok || !(await state.json() as { sessionId?: string }).sessionId) throw new Error("Bundled OMP RPC did not start");
  console.log(JSON.stringify({ portable, port, health: "ok", ui: "ok", omp: "ok", assets: assets.length, manifest: release.format === 3 ? "source-and-ui-verified" : release.format === 2 ? "ui-verified" : "legacy", gitSha: release.gitSha, credentials: "isolated-fake-key" }));
} finally {
  if (process.platform === "win32") {
    const kill = Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    await kill.exited;
  } else child.kill();
  await child.exited;
  const actual = await realpath(workspace);
  if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error(`Refusing to remove unexpected probe directory: ${actual}`);
  await rm(actual, { recursive: true, force: true });
}
