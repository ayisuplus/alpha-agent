import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import puppeteer from "puppeteer-core";
import { TaskLedger } from "../src/runtime/task-ledger";
import { discoverBrowserWebSocket } from "../src/runtime/visible-browser";
import { VisibleBrowser } from "../src/runtime/visible-browser";
import { createBrowserTool } from "../src/runtime/browser-tool";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";

const appRoot = resolve(import.meta.dir, "..");
const workspace = await mkdtemp(join(tmpdir(), "alpha-visible-probe-"));
const portServer = createServer();
await new Promise<void>(resolveReady => portServer.listen(0, "127.0.0.1", resolveReady));
const address = portServer.address();
if (!address || typeof address === "string") throw new Error("Cannot choose CDP port");
const cdpPort = address.port;
await new Promise<void>(resolveReady => portServer.close(() => resolveReady()));

const product = join(workspace, "products", "probe-product");
const dataRoot = join(workspace, ".alpha");
await mkdir(product, { recursive: true });
const page = (fixed: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#fff;color:#111;font:18px Arial;padding:30px}button{background:#fff;color:#111;border:2px solid #111;padding:12px}</style></head><body><button id="go">Save</button><p id="count">Count: 0</p><p id="state">Ready</p><script>document.querySelector('#go').onclick=()=>{document.querySelector('#state').textContent='Saved';${fixed ? "document.querySelector('#count').textContent='Count: 1';" : ""}}</script></body></html>`;
await writeFile(join(product, "index.html"), page(false));
await writeFile(join(product, "build.ts"), "import { mkdir, copyFile } from 'node:fs/promises'; await mkdir('dist',{recursive:true}); await copyFile('index.html','dist/index.html');");
await writeFile(join(product, "package.json"), JSON.stringify({ scripts: { build: "bun run build.ts" } }));
await writeFile(join(product, "alpha-verification.json"), JSON.stringify({ steps: [
  { action: "click", selector: "#go" }, { action: "expectText", selector: "#count", text: "Count: 1" },
  { action: "expectText", selector: "#state", text: "Saved" }, { action: "viewport", width: 375, height: 800 },
  { action: "contrast", selector: "#go", minRatio: 4.5 },
] }));
const ledger = await TaskLedger.create(dataRoot, { objective: "Build a small interactive page", projectRoot: product, criteria: [
  { id: "build", description: "Build", kind: "build" }, { id: "user-path", description: "Browser", kind: "browser" },
] });

const electron = Bun.spawn([join(appRoot, "node_modules", "electron", "dist", "electron.exe"), join(appRoot, "desktop", "main.cjs")], {
  cwd: appRoot, env: { ...process.env, ALPHA_WORKSPACE_ROOT: workspace, ALPHA_CDP_PORT: String(cdpPort), ALPHA_BUN_PATH: process.execPath },
  stdout: "pipe", stderr: "pipe",
});
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
let success = false;
const stderr = new Response(electron.stderr).text();
try {
  const reader = electron.stdout.getReader();
  let output = "";
  const ready = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Desktop exited before ready: ${output}`);
      output += new TextDecoder().decode(chunk.value);
      const match = /ALPHA_DESKTOP_READY (\d+) (\d+)/.exec(output);
      if (match) return Number(match[1]);
    }
  })();
  const apiPort = await Promise.race([ready, Bun.sleep(25_000).then(() => { throw new Error("Desktop startup timed out"); })]);
  browser = await puppeteer.connect({ browserWSEndpoint: await discoverBrowserWebSocket(`http://127.0.0.1:${cdpPort}`) });
  const publish = async () => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/tasks/${ledger.state.id}/publish`, { method: "POST" });
    if (!response.ok) throw new Error(`Publish failed: ${response.status} ${await response.text()}`);
    return TaskLedger.load(ledger.file);
  };
  const failed = await publish();
  const first = failed.state.evidence.findLast(item => item.kind === "browser");
  if (failed.state.status !== "active" || !first || first.passed) throw new Error(`First browser attempt did not fail: ${JSON.stringify(failed.state)}`);
  const visible = await VisibleBrowser.connect(`http://127.0.0.1:${cdpPort}`, failed.state.preview!.url);
  try {
    let owned = true;
    const tool = createBrowserTool(() => owned ? visible : null, dataRoot, failed.state.preview!.url);
    const context = {} as CustomToolContext; // This tool does not use session context.
    const observed = await tool.execute(randomUUID(), { action: "observe" }, undefined, context);
    if (observed.isError || !JSON.stringify(observed.content).includes("Count: 0")) throw new Error("Agent browser tool cannot observe the visible preview");
    const outside = await tool.execute(randomUUID(), { action: "navigate", url: "https://example.com" }, undefined, context);
    if (!outside.isError) throw new Error("Agent browser tool navigated outside the assigned preview");
    owned = false;
    if (!(await tool.execute(randomUUID(), { action: "observe" }, undefined, context)).isError) throw new Error("Agent browser ignored user takeover");
  } finally { await visible.disconnect(); }
  await writeFile(join(product, "index.html"), page(true));
  const passed = await publish();
  const second = passed.state.evidence.findLast(item => item.kind === "browser");
  if (passed.state.status !== "complete" || !second?.passed || second.source === first.source) throw new Error(`Repair did not create passing new evidence: ${JSON.stringify(passed.state)}`);
  if (!(await readFile(first.source, "utf8")).includes(first.attemptId!)) throw new Error("Old attempt was overwritten");
  console.log(JSON.stringify({ desktop: "visible", firstAttempt: first.attemptId, secondAttempt: second.attemptId, status: passed.state.status }));
  success = true;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  else electron.kill();
  await Promise.race([electron.exited, Bun.sleep(5_000)]);
  if (!electron.killed) electron.kill();
  const actual = await realpath(workspace);
  if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error(`Unexpected probe workspace: ${actual}`);
  if (success) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  else console.error(JSON.stringify({ failedProbeWorkspace: actual, stderr: (await stderr).slice(-4000) }));
}
