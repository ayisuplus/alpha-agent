import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskActivity } from "../src/runtime/task-activity";
import { readSourceReviews, snapshotSource, snapshotSourceHashes, sourceChanges, writeSourceReview } from "../src/runtime/source-review";
import { TaskLedger, fingerprintSource } from "../src/runtime/task-ledger";
import { createGeneralWorkspace, verifyGeneralDeliverable } from "../src/runtime/general-work";
import { createDocument } from "../src/runtime/document-tool";
import { relative } from "node:path";
import { acceptCodeChange } from "../src/runtime/code-acceptance";
import { recordApprovedPlan } from "./support/approved-plan";

test("task activity survives a new reader and stays attached to its task", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-activity-"));
  try {
    const first = new TaskActivity(root, "task-one");
    await first.append({ operationId: "run-one", kind: "status", value: "构建中", contractVersion: 1, revision: "revision-one", previewId: null });
    await first.append({ operationId: "run-one", kind: "tool", value: "build · 通过", contractVersion: 1, revision: "revision-one", previewId: "preview-one" });
    const tool = first.create({ operationId: "run-one", kind: "tool", value: "edit · 开始", contractVersion: 1, revision: "revision-one", previewId: null, callId: "call-1", target: "src/app.js", intent: "Updating counter" });
    await first.write(tool);
    const restored = await new TaskActivity(root, "task-one").read();
    expect(restored.map(item => item.value)).toEqual(["构建中", "build · 通过", "edit · 开始"]);
    expect(restored.every(item => item.operationId === "run-one" && item.taskId === "task-one")).toBe(true);
    expect(restored.at(-1)).toEqual(tool);
    expect(await new TaskActivity(root, "task-two").read()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source review records text changes without bundling builds or binary media", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-review-"));
  try {
    const product = join(root, "product");
    await mkdir(join(product, "src"), { recursive: true });
    await mkdir(join(product, "dist"), { recursive: true });
    await writeFile(join(product, "src", "app.js"), "document.title = 'before';\n");
    const before = await snapshotSource(product);
    await writeFile(join(product, "src", "app.js"), "document.title = 'after';\n");
    await writeFile(join(product, "dist", "app.js"), "compiled");
    await writeFile(join(product, "src", "image.png"), new Uint8Array([0, 1, 2]));
    await writeFile(join(product, "src", ".env.json"), '{"token":"private"}');
    const operationId = "11111111-1111-4111-8111-111111111111";
    await writeSourceReview(root, { taskId: "task-one", operationId, contractVersion: 2, revision: "revision-two", before, after: await snapshotSource(product) });
    const restored = await readSourceReviews(root, "task-one");
    expect(restored).toHaveLength(1);
    expect(restored[0].changes).toEqual([{ path: "src/app.js", before: "document.title = 'before';\n", after: "document.title = 'after';\n" }]);
    expect(restored[0].contractVersion).toBe(2);
    const reviewFile = join(root, "reviews", "task-one", `${operationId}.json`);
    expect(JSON.parse(await readFile(reviewFile, "utf8"))).toMatchObject({ format: "reviews", version: 1 });
    // A legacy review document without the tag must still load.
    const legacy = JSON.parse(await readFile(reviewFile, "utf8")) as Record<string, unknown>;
    delete legacy.format;
    delete legacy.version;
    await writeFile(reviewFile, JSON.stringify(legacy));
    expect(await readSourceReviews(root, "task-one")).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("acceptance hashes detect Python and long-file edits while ignoring generated coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-source-hashes-"));
  try {
    await writeFile(join(root, "script.py"), "value = 1\n");
    await writeFile(join(root, "large.ts"), "x".repeat(260_000) + "old");
    const before = await snapshotSourceHashes(root);
    await writeFile(join(root, "script.py"), "value = 2\n");
    await writeFile(join(root, "large.ts"), "x".repeat(260_000) + "new");
    expect(sourceChanges(before, await snapshotSourceHashes(root)).map(item => item.path)).toEqual(["large.ts", "script.py"]);
    const revision = await fingerprintSource(root);
    await mkdir(join(root, "coverage"));
    await writeFile(join(root, "coverage", "result.json"), "{}");
    expect(await fingerprintSource(root)).toBe(revision);
    await mkdir(join(root, "src", "build"), { recursive: true });
    await writeFile(join(root, "src", "build", "index.ts"), "export const ready = true;\n");
    expect(await fingerprintSource(root)).not.toBe(revision);
    expect((await snapshotSourceHashes(root))["src/build/index.ts"]).toBeDefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy display snapshots cannot be accepted as complete source baselines", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-legacy-baseline-"));
  try {
    const product = join(root, "product");
    const dataRoot = join(root, "state");
    await mkdir(product);
    await writeFile(join(product, "script.py"), "value = 1\n");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Change Python code", projectRoot: product, taskType: "code-change", workspaceOrigin: { kind: "direct" }, criteria: [{ id: "change", description: "Source changed", kind: "asset" }] });
    await mkdir(join(dataRoot, "direct-baselines"));
    await writeFile(join(dataRoot, "direct-baselines", `${ledger.state.id}.json`), JSON.stringify(await snapshotSource(product)));
    await writeFile(join(product, "script.py"), "value = 2\n");
    await ledger.refreshRevision();
    await expect(acceptCodeChange({ ledger, dataRoot, runId: "legacy" })).rejects.toThrow("obsolete format");
    expect(ledger.state.status).toBe("active");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("running guidance keeps its delivery state after a ledger reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-guidance-"));
  try {
    const product = join(root, "product");
    await mkdir(product);
    const ledger = await TaskLedger.create(join(root, ".alpha"), { objective: "Build a small app", projectRoot: product, criteria: [{ id: "build", description: "Build", kind: "build" }] });
    const id = await ledger.recordGuidance("Keep the search field visible");
    expect((await TaskLedger.load(ledger.file)).state.guidanceHistory?.at(-1)?.status).toBe("recorded");
    await ledger.setGuidanceStatus(id, "delivered");
    await ledger.setGuidanceStatus(id, "processed");
    const restored = await TaskLedger.load(ledger.file);
    expect(restored.state.guidanceHistory?.at(-1)).toMatchObject({ id, instruction: "Keep the search field visible", status: "processed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workbench serves recorded evidence but refuses a ledger path outside its data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-evidence-api-"));
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const product = join(root, "products", "sample");
    const dataRoot = join(root, ".alpha");
    await mkdir(product, { recursive: true });
    await mkdir(join(dataRoot, "evidence"), { recursive: true });
    const ledger = await TaskLedger.create(dataRoot, { objective: "Review evidence", projectRoot: product, criteria: [{ id: "build", description: "Build", kind: "build" }, { id: "user-path", description: "Browser", kind: "browser" }] });
    const goodFile = join(dataRoot, "evidence", "build.log");
    const outsideFile = join(root, "private.log");
    await writeFile(goodFile, "build passed");
    await writeFile(outsideFile, "private text");
    const good = await ledger.recordEvidence({ criterionId: "build", kind: "build", passed: true, source: goodFile, revision: ledger.state.revision! });
    const outside = await ledger.recordEvidence({ criterionId: "build", kind: "build", passed: false, source: outsideFile, revision: ledger.state.revision! });
    const screenshot = join(dataRoot, "evidence", "browser.png");
    const browserLog = join(dataRoot, "evidence", "browser.json");
    await writeFile(screenshot, new Uint8Array([137, 80, 78, 71]));
    await writeFile(browserLog, JSON.stringify({ results: [{ index: 0, action: "click", passed: false }], screenshot }));
    await ledger.recordPreview({ id: "preview-one", revision: ledger.state.revision!, path: join(dataRoot, "previews", "preview-one"), url: "http://127.0.0.1:12345", taskId: ledger.state.id });
    const browser = await ledger.recordEvidence({ criterionId: "user-path", kind: "browser", passed: false, source: browserLog, previewId: "preview-one", revision: ledger.state.revision! });
    await ledger.stop("error", "Browser verification failed");
    child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "server.ts")], {
      cwd: root, env: { ...process.env, ALPHA_WORKSPACE_ROOT: root }, stdout: "pipe", stderr: "pipe",
    });
    if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output is not readable");
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let port: string | undefined;
    const timeout = setTimeout(() => child?.kill(), 6_000);
    while (!port) {
      const part = await reader.read();
      if (part.done) break;
      output += decoder.decode(part.value);
      port = /ALPHA_SERVER_READY (\d+)/.exec(output)?.[1];
    }
    clearTimeout(timeout);
    expect(port).toBeDefined();
    const base = `http://127.0.0.1:${port}`;
    const history = await fetch(`${base}/api/tasks/${ledger.state.id}/activity`).then(response => response.json()) as { entries: unknown[] };
    expect(history.entries).toEqual([]);
    const task = await fetch(`${base}/api/tasks/${ledger.state.id}`).then(response => response.json()) as { task: { evidence: Array<{ id: string; current: boolean }> } };
    expect(task.task.evidence.find(item => item.id === good.id)?.current).toBe(false);
    expect(task.task.evidence.find(item => item.id === outside.id)?.current).toBe(true);
    const goodResponse = await fetch(`${base}/api/tasks/${ledger.state.id}/evidence/${good.id}`);
    expect((await goodResponse.json() as { content: string }).content).toBe("build passed");
    expect((await fetch(`${base}/api/tasks/${ledger.state.id}/evidence/${outside.id}`)).status).toBe(404);
    const browserDetail = await fetch(`${base}/api/tasks/${ledger.state.id}/evidence/${browser.id}`).then(response => response.json()) as { screenshotUrl: string };
    expect(browserDetail.screenshotUrl.endsWith(`/evidence/${browser.id}/screenshot`)).toBe(true);
    const imageResponse = await fetch(`${base}${browserDetail.screenshotUrl}`);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await imageResponse.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    const summary = await fetch(`${base}/api/tasks`).then(response => response.json()) as { tasks: Array<{ id: string; originalObjective: string; createdAt: string }> };
    expect(summary.tasks[0]).toMatchObject({ id: ledger.state.id, originalObjective: "Review evidence", createdAt: ledger.state.createdAt });
    // Bun's WebSocket accepts request headers (the server checks Origin); the DOM typing here only knows protocols.
    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const socket = new BunWebSocket(`ws://127.0.0.1:${port}/events`, { headers: { origin: base } });
    const broadcast = new Promise<{ type: string; taskId: string; entry: { kind: string; value: string; id: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No activity broadcast")), 5_000);
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as { type: string; taskId: string; entry: { kind: string; value: string; id: string } };
        if (message.type === "activity") { clearTimeout(timer); resolve(message); }
      };
    });
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("WebSocket failed")); });
    const saved = await fetch(`${base}/api/tasks/${ledger.state.id}/guidance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Keep the screenshot visible on the next run" }) }).then(response => response.json()) as { status: string };
    expect(saved.status).toBe("recorded");
    const pushed = await broadcast;
    socket.close();
    expect(pushed).toMatchObject({ taskId: ledger.state.id, entry: { kind: "guidance", value: "补充要求已记录：Keep the screenshot visible on the next run" } });
    const persisted = await fetch(`${base}/api/tasks/${ledger.state.id}/activity`).then(response => response.json()) as { entries: Array<{ id: string }> };
    expect(persisted.entries.map(item => item.id)).toContain(pushed.entry.id);
    expect((await TaskLedger.load(ledger.file)).state.guidanceHistory?.at(-1)?.instruction).toBe("Keep the screenshot visible on the next run");

    // The durable timeline track comes from the event log, with a sequence cursor for incremental refreshes.
    const timeline = await fetch(`${base}/api/tasks/${ledger.state.id}/events`).then(response => response.json()) as { seq: number; events: Array<{ seq: number; type: string; label: string; detail?: string; runId: string | null }> };
    expect(timeline.events.at(-1)).toMatchObject({ type: "guidance/recorded", label: "用户补充", detail: "Keep the screenshot visible on the next run" });
    expect(timeline.seq).toBe(timeline.events.at(-1)!.seq);
    const tail = await fetch(`${base}/api/tasks/${ledger.state.id}/events?since=${timeline.seq - 1}`).then(response => response.json()) as { events: Array<{ seq: number }> };
    expect(tail.events.map(item => item.seq)).toEqual([timeline.seq]);
    expect((await fetch(`${base}/api/tasks/00000000-0000-4000-8000-000000000000/events`)).status).toBe(404);

    const put = (body: unknown, origin = base) => fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    expect((await fetch(`${base}/api/settings`).then(response => response.json()) as { settings: { budget: { maxToolCalls: number } } }).settings.budget.maxToolCalls).toBe(120);
    expect((await put({ budget: { maxToolCalls: 60 } }, "http://evil.example")).status).toBe(403);
    expect((await put({ generation: { comfyUrl: "http://example.com" } })).status).toBe(400);
    const updated = await put({ budget: { maxToolCalls: 60 }, ui: { sidebarCollapsed: true } }).then(response => response.json()) as { settings: { budget: { maxToolCalls: number }; ui: { sidebarCollapsed: boolean } } };
    expect(updated.settings).toMatchObject({ budget: { maxToolCalls: 60 }, ui: { sidebarCollapsed: true } });
    expect(JSON.parse(await readFile(join(dataRoot, "settings.json"), "utf8")).budget.maxToolCalls).toBe(60);
    const metaPath = `${base}/api/tasks/${ledger.state.id}/meta`;
    expect((await fetch(metaPath, { method: "PATCH", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify({ pinned: true }) })).status).toBe(403);
    const meta = await fetch(metaPath, { method: "PATCH", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ title: "  食谱任务  ", pinned: true, archived: true }) }).then(response => response.json()) as { task: { meta: { title: string; pinned: boolean; archived: boolean } } };
    expect(meta.task.meta).toEqual({ title: "食谱任务", pinned: true, archived: true });
    const listed = await fetch(`${base}/api/tasks`).then(response => response.json()) as { tasks: Array<{ meta: unknown }> };
    expect(listed.tasks[0].meta).toEqual(meta.task.meta);
    expect(JSON.parse(await readFile(join(dataRoot, "workbench.json"), "utf8")).tasks[ledger.state.id]).toEqual(meta.task.meta);
    expect((await TaskLedger.load(ledger.file)).state).not.toHaveProperty("meta");
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

async function startServer(root: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "server.ts")], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output is not readable");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let port: string | undefined;
  const timeout = setTimeout(() => child.kill(), 15_000);
  while (!port) {
    const part = await reader.read();
    if (part.done) break;
    output += decoder.decode(part.value);
    port = /ALPHA_SERVER_READY (\d+)/.exec(output)?.[1];
  }
  clearTimeout(timeout);
  if (!port) throw new Error(`Server did not start: ${output}`);
  return { child, base: `http://127.0.0.1:${port}` };
}

test("workbench serves frozen file evidence and saves a local schedule", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-general-api-"));
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const productsRoot = join(root, "products");
    const dataRoot = join(root, ".alpha");
    await mkdir(productsRoot);
    const ledger = await createGeneralWorkspace({ taskType: "file-work", objective: "Create a document", productsRoot, dataRoot, files: [{ name: "source.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("input") }] });
    await recordApprovedPlan(ledger);
    const document = await createDocument(ledger.state.projectRoot, dataRoot, ledger.state.id, "docx", "result", "Result", "content");
    await writeFile(join(ledger.state.projectRoot, "alpha-deliverable.json"), JSON.stringify({ outputs: [{ path: relative(ledger.state.projectRoot, document.path).replaceAll("\\", "/") }] }));
    await ledger.refreshRevision();
    await verifyGeneralDeliverable(ledger, dataRoot);
    const server = await startServer(root, { ...process.env, ALPHA_WORKSPACE_ROOT: root, ALPHA_OMP_AGENT_DIR: join(root, "omp-agent") });
    child = server.child;
    const { base } = server;
    const detail = await fetch(`${base}/api/tasks/${ledger.state.id}/evidence/${ledger.state.evidence[0].id}`).then(response => response.json()) as { artifactUrl: string };
    const output = await fetch(`${base}${detail.artifactUrl}`);
    expect(output.status).toBe(200);
    expect((await output.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const input = await fetch(`${base}/api/tasks/${ledger.state.id}/inputs/${ledger.state.inputs![0].id}`);
    expect(await input.text()).toBe("input");
    const nextRunAt = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await fetch(`${base}/api/schedules`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ taskId: ledger.state.id, instruction: "Update document", nextRunAt, intervalMinutes: null }) });
    expect(scheduled.status).toBe(200);
    expect((await fetch(`${base}/api/queue`, { method: "POST", headers: { origin: "http://untrusted.example", "content-type": "text/plain" }, body: JSON.stringify({ taskId: "invalid", instruction: "ignored" }) })).status).toBe(403);
    expect((await fetch(`${base}/api/schedules`, { method: "POST", headers: { origin: "http://untrusted.example", "content-type": "text/plain" }, body: JSON.stringify({ taskId: "invalid", instruction: "ignored", nextRunAt, intervalMinutes: null }) })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks/11111111-1111-4111-8111-111111111111/workers/22222222-2222-4222-8222-222222222222/cancel`, { method: "POST", headers: { origin: "http://untrusted.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/schedules`).then(response => response.json()) as { schedules: Array<{ taskId: string; nextRunAt: string }> }).schedules[0]).toMatchObject({ taskId: ledger.state.id, nextRunAt });
  } finally { child?.kill(); if (child) await child.exited; await rm(root, { recursive: true, force: true }); }
});

test("model endpoints work against an isolated OMP store and never return keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-models-api-"));
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const product = join(root, "products", "sample");
    const dataRoot = join(root, ".alpha");
    await mkdir(product, { recursive: true });
    const ledger = await TaskLedger.create(dataRoot, { objective: "Pick a model", projectRoot: product, criteria: [{ id: "build", description: "Build", kind: "build" }] });
    // A temporary agent directory and no broker variables keep the test away from the real credential store.
    const env: Record<string, string | undefined> = { ...process.env, ALPHA_WORKSPACE_ROOT: root, ALPHA_OMP_AGENT_DIR: join(root, "omp-agent") };
    delete env.OMP_AUTH_BROKER_URL;
    delete env.OMP_AUTH_BROKER_TOKEN;
    const server = await startServer(root, env);
    child = server.child;
    const { base } = server;
    const json = { "content-type": "application/json", origin: base };
    type Catalog = { models: Array<{ selector: string; provider: string; available: boolean }>; providers: Array<{ id: string; origin: string | null; storedKey: boolean; allowed: boolean; models: number }>; builtin: string };

    const catalog = await fetch(`${base}/api/models`).then(response => response.json()) as Catalog;
    expect(catalog.builtin).toBe("xiaomi-token-plan-cn/mimo-v2.6-flash");
    // Every OMP provider is listed so it can be allowed; only allowed ones contribute selectable models.
    expect(catalog.providers.filter(item => item.allowed).map(item => item.id).sort()).toEqual(["deepseek", "xiaomi-token-plan-cn"]);
    expect(catalog.providers.some(item => item.id === "alibaba-token-plan" && !item.allowed)).toBe(true);
    expect(catalog.models.every(item => ["deepseek", "xiaomi-token-plan-cn"].includes(item.provider))).toBe(true);
    const provider = catalog.providers.find(item => item.allowed && item.origin === null && item.models > 0);
    expect(provider).toBeDefined();
    const key = "sk-alpha-test-0123456789";
    const saved = await fetch(`${base}/api/providers/${provider!.id}/key`, { method: "PUT", headers: json, body: JSON.stringify({ apiKey: key }) });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(key);
    expect((await fetch(`${base}/api/providers/${provider!.id}/key`, { method: "PUT", headers: json, body: JSON.stringify({ apiKey: "short" }) })).status).toBe(400);
    expect((await fetch(`${base}/api/providers/no-such-provider/key`, { method: "PUT", headers: json, body: JSON.stringify({ apiKey: key }) })).status).toBe(400);

    const afterText = await fetch(`${base}/api/models`).then(response => response.text());
    expect(afterText).not.toContain(key);
    const after = JSON.parse(afterText) as Catalog;
    expect(after.providers.find(item => item.id === provider!.id)).toMatchObject({ origin: "api_key", storedKey: true });
    const selector = after.models.find(item => item.provider === provider!.id && item.available)?.selector;
    expect(selector).toBeDefined();

    const setModel = (model: unknown) => fetch(`${base}/api/tasks/${ledger.state.id}/model`, { method: "POST", headers: json, body: JSON.stringify({ model }) });
    expect((await setModel(selector)).status).toBe(200);
    expect((await TaskLedger.load(ledger.file)).state.modelSelector).toBe(selector);
    expect((await setModel(`${provider!.id}/not-a-real-model`)).status).toBe(400);
    expect((await setModel("alibaba-token-plan/qwen3.6-flash")).status).toBe(400);
    expect((await fetch(`${base}/api/providers/alibaba-token-plan/key`, { method: "PUT", headers: json, body: JSON.stringify({ apiKey: key }) })).status).toBe(400);
    expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ model: { default: `${provider!.id}/not-a-real-model` } }) })).status).toBe(400);
    expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ model: { translation: `${provider!.id}/not-a-real-model` } }) })).status).toBe(400);
    expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ workerModels: { implement: `${provider!.id}/not-a-real-model` } }) })).status).toBe(400);
    expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ model: { default: selector } }) })).status).toBe(200);
    expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ model: { translation: selector } }) })).status).toBe(200);
    expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ workerModels: { implement: selector } }) })).status).toBe(200);
    expect((await fetch(`${base}/api/prompts/refine`, { method: "POST", headers: json, body: JSON.stringify({ prompt: "" }) })).status).toBe(400);

    expect(await fetch(`${base}/api/providers/${provider!.id}/key`, { method: "DELETE", headers: { origin: base } }).then(response => response.json())).toEqual({ removed: 1 });
    const cleared = await fetch(`${base}/api/models`).then(response => response.json()) as Catalog;
    expect(cleared.providers.find(item => item.id === provider!.id)?.origin).toBeNull();
    expect((await setModel(null)).status).toBe(200);
    expect((await TaskLedger.load(ledger.file)).state.modelSelector).toBeUndefined();
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);

test("storage API preserves current previews and reports local diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-storage-api-"));
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const dataRoot = join(root, ".alpha");
    const product = join(root, "products", "sample");
    await mkdir(product, { recursive: true });
    const ledger = await TaskLedger.create(dataRoot, { objective: "Keep current preview", projectRoot: product, criteria: [{ id: "build", description: "Build", kind: "build" }] });
    await ledger.refreshRevision();
    const current = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const stale = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    for (const id of [current, stale]) {
      const path = join(dataRoot, "previews", id);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "preview.json"), JSON.stringify({ id }));
    }
    await ledger.recordPreview({ id: current, revision: ledger.state.revision!, path: join(dataRoot, "previews", current), url: "http://127.0.0.1:5000/" });
    await writeFile(join(dataRoot, "settings.json"), JSON.stringify({ generation: { comfyUrl: "http://127.0.0.1:1" } }));
    const env: Record<string, string | undefined> = { ...process.env, ALPHA_WORKSPACE_ROOT: root, ALPHA_OMP_AGENT_DIR: join(root, "omp-agent") };
    delete env.OMP_AUTH_BROKER_URL;
    delete env.OMP_AUTH_BROKER_TOKEN;
    const server = await startServer(root, env);
    child = server.child;
    const { base } = server;
    const before = await fetch(`${base}/api/storage`).then(response => response.json()) as { cleanup: { count: number } };
    expect(before.cleanup.count).toBe(1);
    expect((await fetch(`${base}/api/storage/cleanup-previews`, { method: "POST", headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect(await fetch(`${base}/api/storage/cleanup-previews`, { method: "POST", headers: { origin: base } }).then(response => response.json())).toMatchObject({ removed: 1 });
    expect((await fetch(`${base}/api/storage`).then(response => response.json()) as { cleanup: { count: number } }).cleanup.count).toBe(0);
    expect((await readFile(join(dataRoot, "previews", current, "preview.json"), "utf8"))).toContain(current);
    const diagnostics = await fetch(`${base}/api/diagnostics`).then(response => response.json()) as { checks: Array<{ id: string; ok: boolean }>; versions: { bun: string } };
    expect(diagnostics.versions.bun).toBeTruthy();
    expect(diagnostics.checks.find(item => item.id === "workspace")?.ok).toBe(true);
    expect(diagnostics.checks.find(item => item.id === "comfy")?.ok).toBe(false);
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);

test("follow-up questions are validated and the task list reports every run in progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-ask-api-"));
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const product = join(root, "products", "sample");
    await mkdir(product, { recursive: true });
    const ledger = await TaskLedger.create(join(root, ".alpha"), { objective: "Explain the sample", projectRoot: product, criteria: [{ id: "build", description: "Build", kind: "build" }] });
    const env: Record<string, string | undefined> = { ...process.env, ALPHA_WORKSPACE_ROOT: root, ALPHA_OMP_AGENT_DIR: join(root, "omp-agent") };
    delete env.OMP_AUTH_BROKER_URL;
    delete env.OMP_AUTH_BROKER_TOKEN;
    const server = await startServer(root, env);
    child = server.child;
    const { base } = server;
    const ask = (id: string, question: unknown) => fetch(`${base}/api/tasks/${id}/ask`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ question }) });
    expect((await ask(ledger.state.id, "  ")).status).toBe(400);
    expect((await ask(ledger.state.id, "x".repeat(8_001))).status).toBe(400);
    expect((await ask("11111111-1111-4111-8111-111111111111", "What changed?")).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/${ledger.state.id}/ask`, { method: "POST", headers: { origin: "http://untrusted.example", "content-type": "text/plain" }, body: JSON.stringify({ question: "ignored" }) })).status).toBe(403);
    const list = await fetch(`${base}/api/tasks`).then(response => response.json()) as { tasks: Array<{ id: string; running: boolean; runKind: string | null }>; runs: unknown[]; operations: unknown[] };
    expect(list.runs).toEqual([]);
    expect(list.operations).toEqual([]);
    expect(list.tasks.find(task => task.id === ledger.state.id)).toMatchObject({ running: false, runKind: null });
  } finally { child?.kill(); if (child) await child.exited; await rm(root, { recursive: true, force: true }); }
}, 60_000);
