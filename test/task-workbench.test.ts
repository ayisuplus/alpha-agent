import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskActivity } from "../src/runtime/task-activity";
import { readSourceReviews, snapshotSource, writeSourceReview } from "../src/runtime/source-review";
import { TaskLedger } from "../src/runtime/task-ledger";

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
    const operationId = "11111111-1111-4111-8111-111111111111";
    await writeSourceReview(root, { taskId: "task-one", operationId, contractVersion: 2, revision: "revision-two", before, after: await snapshotSource(product) });
    const restored = await readSourceReviews(root, "task-one");
    expect(restored).toHaveLength(1);
    expect(restored[0].changes).toEqual([{ path: "src/app.js", before: "document.title = 'before';\n", after: "document.title = 'after';\n" }]);
    expect(restored[0].contractVersion).toBe(2);
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
    await ledger.stop();
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

    const put = (body: unknown, origin = base) => fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    expect((await fetch(`${base}/api/settings`).then(response => response.json()) as { settings: { budget: { maxToolCalls: number } } }).settings.budget.maxToolCalls).toBe(120);
    expect((await put({ budget: { maxToolCalls: 60 } }, "http://evil.example")).status).toBe(403);
    expect((await put({ generation: { comfyUrl: "http://example.com" } })).status).toBe(400);
    const updated = await put({ budget: { maxToolCalls: 60 }, ui: { sidebarCollapsed: true } }).then(response => response.json()) as { settings: { budget: { maxToolCalls: number }; ui: { sidebarCollapsed: boolean } } };
    expect(updated.settings).toMatchObject({ budget: { maxToolCalls: 60 }, ui: { sidebarCollapsed: true } });
    expect(JSON.parse(await readFile(join(dataRoot, "settings.json"), "utf8")).budget.maxToolCalls).toBe(60);
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
