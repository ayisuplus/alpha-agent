import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { RpcProcess } from "../src/native/rpc-process";

test("tracks pending shell work and awaits the correlated prompt receipt plus async settlement", async () => {
  const child = new RpcProcess({ cwd: process.cwd(), argv: [resolve(import.meta.dir, "fixtures/native-rpc-worker.ts")], env: { ...process.env } as Record<string, string> });
  try {
    await child.ready;
    const shell = child.command({ type: "bash", command: "test" });
    await Bun.sleep(10);
    expect(child.hasPendingWork).toBe(true);
    await shell;
    expect(child.hasPendingWork).toBe(false);
    let complete = false;
    const prompt = child.promptAndWait("test").then(receipt => { complete = true; return receipt; });
    await Bun.sleep(50);
    expect(complete).toBe(false);
    expect(child.hasPendingWork).toBe(true);
    const receipt = await prompt;
    expect(receipt.status).toBe("error");
    expect((receipt.error as { message: string }).message).toBe("model failed");
    expect(child.hasPendingWork).toBe(false);
  } finally { await child.stop(); }
});
