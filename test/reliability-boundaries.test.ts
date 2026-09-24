import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFileToolCall } from "../src/runtime/file-tool-guard";
import { OperationManager } from "../src/runtime/operation-manager";
import { SettingsStore, WorkbenchMeta } from "../src/runtime/settings";
import { TaskLedger } from "../src/runtime/task-ledger";

test("operation claim is synchronous and only its owner can release or cancel", () => {
  const seen: Array<string | null> = [];
  const manager = new OperationManager(snapshot => seen.push(snapshot?.id ?? null));
  const first = manager.claim("run");
  expect(first).not.toBeNull();
  expect(manager.claim("run")).toBeNull();
  expect(manager.claim("verify", "other")).toBeNull();
  expect(manager.cancel("wrong")).toBe(false);
  expect(manager.cancel(first!.id)).toBe(true);
  expect(first!.controller.signal.aborted).toBe(true);
  manager.release({ id: "wrong", controller: new AbortController() });
  expect(manager.snapshot()?.id).toBe(first!.id);
  manager.release(first!);
  expect(manager.claim("publish", "task")).not.toBeNull();
  expect(seen).toHaveLength(3);
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
