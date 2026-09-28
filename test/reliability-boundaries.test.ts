import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFileToolCall } from "../src/runtime/file-tool-guard";
import { BrowserLock, OperationManager } from "../src/runtime/operation-manager";
import { SettingsStore, WorkbenchMeta } from "../src/runtime/settings";
import { TaskLedger } from "../src/runtime/task-ledger";
import { uiHashes, verifyUiHashes } from "../scripts/portable-ui";

test("operations on different tasks run side by side; shared tasks, folders and projects are refused", () => {
  const seen: number[] = [];
  const manager = new OperationManager(snapshots => seen.push(snapshots.length));
  const first = manager.claim("run", { taskId: "a", projectId: "p", roots: ["E:\\work\\app"] });
  expect(first).not.toBeNull();
  expect(manager.claim("run", { taskId: "a" })).toBeNull();
  expect(manager.claim("verify", { taskId: "b", roots: ["E:\\WORK\\app\\src"] })).toBeNull();
  const second = manager.claim("run", { taskId: "b", projectId: "p", roots: ["E:\\work\\other"] });
  expect(second).not.toBeNull();
  expect(manager.claim("mount", { projectId: "p", exclusiveProject: true })).toBeNull();
  expect(manager.claim("answer", { taskId: "c", runLimit: 2 })).toBeNull();
  expect(manager.claim("cleanup", { exclusive: true })).toBeNull();
  expect(manager.forTask("b")?.id).toBe(second!.id);
  expect(manager.cancel("wrong")).toBe(false);
  expect(manager.cancel(first!.id)).toBe(true);
  expect(first!.controller.signal.aborted).toBe(true);
  manager.release({ id: first!.id, controller: new AbortController() });
  expect(manager.snapshots()).toHaveLength(2);
  manager.release(first!);
  manager.release(second!);
  const cleanup = manager.claim("cleanup", { exclusive: true });
  expect(cleanup).not.toBeNull();
  expect(manager.claim("run", { taskId: "d" })).toBeNull();
  expect(seen).toEqual([1, 2, 1, 0, 1]);
});

test("the visible browser is handed to waiting operations in order", async () => {
  const lock = new BrowserLock();
  const releaseFirst = await lock.acquire("first", new AbortController().signal);
  const order: string[] = [];
  const second = lock.acquire("second", new AbortController().signal).then(release => { order.push("second"); return release; });
  const cancelled = new AbortController();
  const third = lock.acquire("third", cancelled.signal).catch(() => order.push("third cancelled"));
  cancelled.abort();
  await third;
  expect(lock.owner).toBe("first");
  releaseFirst();
  (await second)();
  expect(order).toEqual(["third cancelled", "second"]);
  expect(lock.owner).toBeNull();
});

test("portable UI manifest rejects a changed or incomplete renderer", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-portable-ui-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), '<script src="/ui/assets/app.js"></script>');
    await writeFile(join(root, "assets", "app.js"), "document.title = 'Alpha';");
    const hashes = await uiHashes(root);
    await verifyUiHashes(root, hashes);
    await writeFile(join(root, "assets", "app.js"), "document.title = 'Changed';");
    await expect(verifyUiHashes(root, hashes)).rejects.toThrow("differs from the fresh build");
    await rm(join(root, "assets", "app.js"));
    await expect(uiHashes(root)).rejects.toThrow("incomplete");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OMP file targets reject escapes, links and unowned worker writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-file-guard-"));
  try {
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(project, "src", "own.txt"), "okay");
    await writeFile(join(outside, "secret.txt"), "secret");
    await checkFileToolCall("read", { path: "src/own.txt:1-1" }, project);
    await expect(checkFileToolCall("read", { path: "../outside/secret.txt" }, project)).rejects.toThrow("outside");
    await expect(checkFileToolCall("grep", { pattern: "secret", path: outside }, project)).rejects.toThrow("outside");
    await expect(checkFileToolCall("write", { path: join(outside, "secret.txt") }, project)).rejects.toThrow("outside");
    await expect(checkFileToolCall("edit", { input: "patch" }, project)).rejects.toThrow("cannot be validated");
    const order = { id: "worker", objective: "edit own file", ownedPaths: ["src/own.txt"], resources: [] };
    await checkFileToolCall("write", { path: "src/own.txt" }, project, order);
    await expect(checkFileToolCall("write", { path: "src/other.txt" }, project, order)).rejects.toThrow("does not own");
    try {
      await symlink(outside, join(project, "linked"), "junction");
      await expect(checkFileToolCall("read", { path: "linked/secret.txt" }, project)).rejects.toThrow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("serial settings and metadata updates preserve both simultaneous patches", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-store-race-"));
  try {
    const settings = new SettingsStore(root);
    const [first, second] = await Promise.all([
      settings.update({ ui: { sidebarCollapsed: true } }),
      settings.update({ notifications: { enabled: false } }),
    ]);
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect((await new SettingsStore(root).get()).ui.sidebarCollapsed).toBe(true);
    expect((await new SettingsStore(root).get()).notifications.enabled).toBe(false);
    const meta = new WorkbenchMeta(root);
    await Promise.all([meta.update("one", { pinned: true }), meta.update("two", { title: "Two" })]);
    expect(await new WorkbenchMeta(root).all()).toEqual({ one: { pinned: true }, two: { title: "Two" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed source cannot complete against earlier build and browser evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-completion-race-"));
  try {
    const product = join(root, "product");
    await mkdir(product);
    await writeFile(join(product, "index.html"), "old");
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Product", projectRoot: product, criteria: [
      { id: "build", description: "Build", kind: "build" }, { id: "user-path", description: "Browser", kind: "browser" },
    ] });
    const revision = ledger.state.revision!;
    await ledger.recordEvidence({ criterionId: "build", kind: "build", revision, passed: true, source: "build.log" });
    await ledger.recordPreview({ id: "preview", revision, path: join(root, "preview"), url: "http://127.0.0.1:3456" });
    await ledger.recordEvidence({ attemptId: "attempt-1", criterionId: "user-path", kind: "browser", revision, previewId: "preview", passed: true, source: "browser.json" });
    await writeFile(join(product, "index.html"), "changed");
    await expect(ledger.complete()).rejects.toThrow("source changed");
    expect((await TaskLedger.load(ledger.file)).state.status).toBe("active");
  } finally { await rm(root, { recursive: true, force: true }); }
});
