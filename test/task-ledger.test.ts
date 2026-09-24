import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../src/runtime/task-ledger";
import { taskPrompt } from "../src/runtime/omp-runner";

test("a source change makes old evidence and preview ineligible for completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-ledger-test-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "v1");
    const ledger = await TaskLedger.create(join(root, "state"), {
      objective: "Build an inventory product",
      projectRoot: project,
      criteria: [{ id: "build", description: "Build passes", kind: "build" }],
    });
    const firstRevision = ledger.state.revision!;
    await ledger.recordEvidence({ criterionId: "build", kind: "build", passed: true, revision: firstRevision, source: "build.log" });
    await ledger.recordPreview({ id: "preview-1", revision: firstRevision, path: join(root, "preview-1"), url: "http://127.0.0.1:8123/" });
    expect(ledger.completionGaps()).toEqual([]);

    await writeFile(join(project, "app.txt"), "v2");
    expect(await ledger.refreshRevision()).toBe(true);
    expect(ledger.completionGaps()).toEqual(["build", "local-preview"]);
    await expect(ledger.recordEvidence({ criterionId: "build", kind: "build", passed: true, revision: firstRevision, source: "old.log" })).rejects.toThrow("stale");
    await expect(ledger.complete()).rejects.toThrow("build, local-preview");

    const resumed = await TaskLedger.load(ledger.file);
    expect(resumed.state.revision).toBe(ledger.state.revision);
    expect((await readFile(join(project, "app.txt"), "utf8"))).toBe("v2");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a completed task can be reopened when visual review finds a failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-reopen-test-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "source");
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Build", projectRoot: project, criteria: [{ id: "browser", description: "Visible path", kind: "browser" }] });
    const revision = ledger.state.revision!;
    await ledger.recordPreview({ id: "preview", revision, path: join(root, "preview"), url: "http://127.0.0.1:9000/" });
    await ledger.recordEvidence({ criterionId: "browser", kind: "browser", passed: true, revision, previewId: "preview", source: "first-review.json" });
    await ledger.complete();
    await ledger.reopen("Button label lacks contrast");
    await ledger.recordEvidence({ criterionId: "browser", kind: "browser", passed: false, revision, previewId: "preview", source: "contrast-failure.json" });
    expect(ledger.completionGaps()).toContain("browser");
    expect(ledger.state.evidence).toHaveLength(2);
    expect(ledger.state.status).toBe("active");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("browser evidence is tied to the actual preview instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-preview-evidence-test-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "source");
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Build", projectRoot: project, criteria: [{ id: "browser", description: "Visible path", kind: "browser" }] });
    const revision = ledger.state.revision!;
    await ledger.recordPreview({ id: "first", revision, path: join(root, "first"), url: "http://127.0.0.1:9000/" });
    await ledger.recordEvidence({ criterionId: "browser", kind: "browser", passed: true, revision, previewId: "first", source: "first.json" });
    expect(ledger.completionGaps()).toEqual([]);
    await ledger.recordPreview({ id: "second", revision, path: join(root, "second"), url: "http://127.0.0.1:9001/" });
    expect(ledger.completionGaps()).toEqual(["browser"]);
    await expect(ledger.recordEvidence({ criterionId: "browser", kind: "browser", passed: true, revision, previewId: "first", source: "stale.json" })).rejects.toThrow("current preview");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a stopped task retains its run budget record and can resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-resume-test-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "source");
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Build", projectRoot: project, criteria: [{ id: "build", description: "Build passes", kind: "build" }] });
    await ledger.stop();
    await ledger.recordRun({ model: "test/model", toolCalls: 3, maxToolCalls: 10, wallTimeMs: 10_000, elapsedMs: 500, outcome: "cancelled", failureReason: "User cancelled" });
    await ledger.resume("Continue after cancellation");
    const restored = await TaskLedger.load(ledger.file);
    expect(restored.state.status).toBe("active");
    expect(restored.state.runs?.[0]?.outcome).toBe("cancelled");
    expect(restored.state.runs?.[0]?.failureReason).toBe("User cancelled");
    expect(taskPrompt(restored, "Keep working")).toContain("Continue after cancellation");
    await restored.recordFailure("Transient model outage");
    await restored.clearFailure();
    expect((await TaskLedger.load(ledger.file)).state.lastFailure).toBeUndefined();
    expect((await TaskLedger.load(ledger.file)).state.runs?.[0]?.failureReason).toBe("User cancelled");
    expect(restored.completionGaps()).toEqual(["build", "local-preview"]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a revised objective invalidates old acceptance evidence without changing source", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-revision-test-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "source");
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Make a list", projectRoot: project, criteria: [{ id: "build", description: "Build passes", kind: "build" }] });
    const revision = ledger.state.revision!;
    await ledger.recordEvidence({ criterionId: "build", kind: "build", passed: true, revision, source: "old-build.log" });
    await ledger.recordPreview({ id: "old", revision, path: join(root, "old"), url: "http://127.0.0.1:9000/" });
    await ledger.recordFailure("An earlier browser attempt failed");
    await ledger.complete();
    expect(ledger.state.lastFailure).toBeUndefined();

    await ledger.reviseObjective("Make a list with filtering");
    expect(ledger.state.contractVersion).toBe(2);
    expect(ledger.state.status).toBe("active");
    expect(ledger.state.lastFailure).toBeUndefined();
    expect(ledger.state.revision).toBe(revision);
    expect(ledger.completionGaps()).toEqual(["build", "local-preview"]);
    await expect(ledger.complete()).rejects.toThrow("build, local-preview");
    await expect(ledger.reviseObjective("Make a list with filtering")).rejects.toThrow("changed");

    const restored = await TaskLedger.load(ledger.file);
    expect(restored.state.contractHistory?.[0]?.objective).toBe("Make a list");
    expect(restored.completionGaps()).toEqual(["build", "local-preview"]);
    const resumedPrompt = taskPrompt(restored, "Keep the original list and add filtering");
    expect(resumedPrompt).toContain("v1: Make a list");
    expect(resumedPrompt).toContain("v2: Make a list with filtering");
    await restored.recordGuidance("Do not delete existing items");
    const restarted = await TaskLedger.load(restored.file);
    expect(taskPrompt(restarted, "Repair the filter")).toContain("Do not delete existing items");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("CLI guidance survives a failed model start and a ledger reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-cli-guidance-test-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "source");
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "Keep existing data", projectRoot: project, criteria: [{ id: "build", description: "Build passes", kind: "build" }] });
    const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "cli.ts"), "resume", "--ledger", ledger.file, "--brief", "Do not delete the original data", "--model", "alpha-invalid/no-model"], {
      cwd: root, stdout: "ignore", stderr: "ignore",
    });
    let persisted = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = await TaskLedger.load(ledger.file);
      if (current.state.guidanceHistory?.some(item => item.instruction === "Do not delete the original data")) { persisted = true; break; }
      await Bun.sleep(100);
    }
    child.kill();
    await child.exited;
    expect(persisted).toBe(true);
    const restored = await TaskLedger.load(ledger.file);
    expect(restored.state.status).toBe("active");
    expect(taskPrompt(restored, "Continue")).toContain("Do not delete the original data");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a task remembers its own model across reloads until it is cleared", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-ledger-model-"));
  try {
    const product = join(root, "product");
    await mkdir(product);
    const ledger = await TaskLedger.create(join(root, ".alpha"), { objective: "Build", projectRoot: product, criteria: [{ id: "build", description: "Build", kind: "build" }], modelSelector: "openrouter/anthropic/claude" });
    expect((await TaskLedger.load(ledger.file)).state.modelSelector).toBe("openrouter/anthropic/claude");
    await ledger.setModel(null);
    expect((await TaskLedger.load(ledger.file)).state.modelSelector).toBeUndefined();
    await ledger.setModel("alibaba-token-plan/qwen3.6-flash");
    expect((await TaskLedger.load(ledger.file)).state.modelSelector).toBe("alibaba-token-plan/qwen3.6-flash");
  } finally { await rm(root, { recursive: true, force: true }); }
});
