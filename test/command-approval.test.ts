import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandApprovalStore } from "../src/runtime/command-approval";

test("an exact command waits for approval, runs once, and keeps its receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-command-approval-"));
  try {
    const store = new CommandApprovalStore(root);
    const taskId = "11111111-1111-4111-8111-111111111111";
    const argv = [process.execPath, "-e", "console.log('approved')"];
    const pending = await store.execute(taskId, root, argv, "check");
    expect(pending.status).toBe("pending");
    expect((await store.request(taskId, root, argv, "check")).id).toBe(pending.id);
    await store.decide(taskId, pending.id, true);
    const done = await store.execute(taskId, root, argv, "check");
    expect(done.status).toBe("complete");
    expect(await readFile(done.result!.logPath, "utf8")).toContain("approved");
    const repeated = await store.execute(taskId, root, argv, "check");
    expect(repeated.status).toBe("pending");
    expect(repeated.id).not.toBe(done.id);
    const denied = await store.request(taskId, root, [process.execPath, "-e", "console.log('other')"], "other");
    expect((await store.decide(taskId, denied.id, false)).status).toBe("denied");
    expect((await store.execute(taskId, root, denied.argv, "other")).status).toBe("denied");
  } finally { await rm(root, { recursive: true, force: true }); }
});
