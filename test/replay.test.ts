import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptBlobPath, promptHash, writePromptBlob } from "../src/runtime/prompt-blobs";
import { taskPrompt } from "../src/runtime/session-profile";
import { TaskLedger, type TaskState } from "../src/runtime/task-ledger";
import { replayTaskContexts } from "../src/runtime/task-replay";

async function withTask(run: (ledger: TaskLedger, dataRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "alpha-replay-"));
  try {
    const projectRoot = join(root, "products", "cart");
    await mkdir(projectRoot, { recursive: true });
    const ledger = await TaskLedger.create(join(root, ".alpha"), {
      objective: "Ship the cart checkout",
      projectRoot,
      criteria: [{ id: "build", description: "Build passes", kind: "build" }],
    });
    await run(ledger, join(root, ".alpha"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Records one `step/context` row whose stored block is exactly what the model would see for the current state. */
async function recordContext(ledger: TaskLedger, dataRoot: string, correction: string): Promise<{ hash: string; state: TaskState }> {
  const text = taskPrompt(ledger.state, correction);
  const blob = await writePromptBlob(dataRoot, text);
  await ledger.recordStepContext({
    stage: "coordinator",
    model: "xiaomi/mimo-v2.6-pro",
    promptHash: promptHash(["ALPHA RUNTIME CONTRACT", text, "tool definitions"].join("\n\n")),
    taskContextHash: blob.hash,
    taskContextBytes: blob.bytes,
    systemTokens: 1200,
    toolTokens: 800,
    contextShare: 0.25,
    toolNames: ["read", "grep"],
  });
  return { hash: blob.hash, state: structuredClone(ledger.state) };
}

test("replay rebuilds each step's state and verifies its stored block", async () => {
  await withTask(async (ledger, dataRoot) => {
    const first = await recordContext(ledger, dataRoot, "correction 1");
    await ledger.reviseObjective("Ship the cart checkout with receipts");
    const second = await recordContext(ledger, dataRoot, "correction 2");

    const rows = await replayTaskContexts(dataRoot, ledger.state.id);
    // One row per recorded context, in log order; the absolute seqs are event wiring, not the contract.
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBeLessThan(rows[1].seq);
    for (const row of rows) {
      expect(row.verified).toBe(true);
      expect(row.problem).toBeUndefined();
      expect(row.toolNames).toEqual(["read", "grep"]);
      expect(row.preview).toBe("Preserve earlier task requirements unless the user explicitly superseded them.");
    }
    // Each row shows the state its own step ran on, not the state at replay time.
    expect(rows[0].taskContextHash).toBe(first.hash);
    expect(rows[1].taskContextHash).toBe(second.hash);
    expect(rows[0].state.objective).toBe("Ship the cart checkout");
    expect(rows[0].state.contractVersion).toBe(1);
    expect(rows[1].state.objective).toBe("Ship the cart checkout with receipts");
    expect(rows[1].state.contractVersion).toBe(2);
    expect(rows[0].state.gaps).toContain("build");

    // A later mutation does not disturb the replay of earlier steps.
    await ledger.recordFailure("Review rejected the first cut");
    const afterFailure = await replayTaskContexts(dataRoot, ledger.state.id);
    expect(afterFailure[1].verified).toBe(true);
    expect(afterFailure[1].state.objective).toBe(second.state.objective);

    // Tampering with the stored block of the second step turns only that row unverified, with a concrete reason.
    await writeFile(promptBlobPath(dataRoot, second.hash), `${taskPrompt(ledger.state, "correction 2")}\n篡改者追加的一行\n`);
    const tampered = await replayTaskContexts(dataRoot, ledger.state.id);
    expect(tampered[0].verified).toBe(true);
    expect(tampered[1].verified).toBe(false);
    expect(tampered[1].problem).toContain("哈希不符");
    expect(tampered[1].problem).not.toContain("缺少目标行");
  });
});

test("a task without step/context events replays to an empty list", async () => {
  await withTask(async (ledger, dataRoot) => {
    expect(await replayTaskContexts(dataRoot, ledger.state.id)).toEqual([]);
    await expect(replayTaskContexts(dataRoot, "no-such-task")).rejects.toThrow("任务事件日志不存在");
  });
});

test("a missing stored block is reported as a problem instead of throwing", async () => {
  await withTask(async (ledger, dataRoot) => {
    const stored = await recordContext(ledger, dataRoot, "correction 1");
    await rm(promptBlobPath(dataRoot, stored.hash));
    const rows = await replayTaskContexts(dataRoot, ledger.state.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].verified).toBe(false);
    expect(rows[0].problem).toContain("缺失");
    expect(rows[0].preview).toBe("");
  });
});

test("the replay CLI prints one line per step and exits 0 when everything is verified", async () => {
  await withTask(async (ledger, dataRoot) => {
    await recordContext(ledger, dataRoot, "correction 1");
    await recordContext(ledger, dataRoot, "correction 2");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "scripts/replay.ts", ledger.state.id, "--data", dataRoot],
      cwd: join(import.meta.dir, ".."),
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    // One verified line per recorded step; the printed event numbers are wiring, not the contract.
    expect(output.split("\n").filter(line => line.includes("已核对"))).toHaveLength(2);
    expect(output).toContain("共 2 步");
    expect(output).toContain("核对通过 2 步");
  });
});
