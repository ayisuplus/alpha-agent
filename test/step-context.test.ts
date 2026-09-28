import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptBlobPath, promptHash, readPromptBlob, writePromptBlob } from "../src/runtime/prompt-blobs";
import { TaskLedger } from "../src/runtime/task-ledger";
import { summarizeTaskEvents } from "../src/runtime/task-event-summary";
import { readEvents, taskLogDir } from "../src/runtime/task-events";

test("prompt blobs are content addressed and stored once", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-prompt-blobs-"));
  try {
    const text = "Current objective v1: Fix the cart total\nCurrent incomplete criteria: check";
    const first = await writePromptBlob(root, text);
    const second = await writePromptBlob(root, text);
    expect(first.hash).toBe(promptHash(text));
    expect(second.hash).toBe(first.hash);
    expect(second.path).toBe(promptBlobPath(root, first.hash));
    expect(first.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(await readPromptBlob(root, first.hash)).toBe(text);
    expect(await readPromptBlob(root, "0".repeat(64))).toBeNull();

    const other = await writePromptBlob(root, `${text}\nCurrent instruction: continue`);
    expect(other.hash).not.toBe(first.hash);
    expect(await readPromptBlob(root, first.hash)).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("step contexts are logged with their hashes and summarized for the timeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-step-context-"));
  try {
    const projectRoot = join(root, "project");
    await Bun.write(join(projectRoot, "cart.ts"), "export const total = 0;\n");
    const dataRoot = join(root, "data");
    const ledger = await TaskLedger.create(dataRoot, {
      objective: "Fix the cart total", projectRoot, taskType: "code-change",
      criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }],
    });
    const context = "Current objective v1: Fix the cart total\nCurrent incomplete criteria: check";
    const blob = await writePromptBlob(dataRoot, context);
    ledger.bindRun("run-1");
    await ledger.recordStepContext({
      stage: "coordinator", model: "test/model",
      promptHash: promptHash(`contract\n\n${context}\n\ntools`), taskContextHash: blob.hash, taskContextBytes: blob.bytes,
      systemTokens: 4_900, toolTokens: 4_700, contextShare: 0.1, toolNames: ["read", "grep", "alpha_check"],
    });

    const events = await readEvents(taskLogDir(ledger.file));
    const contextEvent = events.find(event => event.type === "step/context");
    expect(contextEvent).toMatchObject({ runId: "run-1", payload: { stage: "coordinator", model: "test/model", taskContextHash: blob.hash, toolNames: ["read", "grep", "alpha_check"] } });
    // The state keeps the summary; the text lives only in the blob store, referenced by hash.
    expect(ledger.state.stepContexts).toHaveLength(1);
    expect(ledger.state.stepContexts?.[0]).toMatchObject({ stage: "coordinator", taskContextBytes: blob.bytes, tools: 3, systemTokens: 4_900 });
    expect(JSON.stringify(ledger.state)).not.toContain("Current incomplete criteria");

    const rows = summarizeTaskEvents(events);
    const row = rows.find(item => item.type === "step/context");
    expect(row?.label).toBe("模型上下文 · coordinator · 9.6k tokens");
    expect(row?.detail).toContain("任务块");
    expect(row?.runId).toBe("run-1");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
