import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an unusable local data path fails before the server announces readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-workspace-preflight-"));
  try {
    const blocked = join(root, "blocked-file");
    await writeFile(blocked, "not a directory");
    const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "server.ts")], {
      cwd: root, env: { ...process.env, ALPHA_WORKSPACE_ROOT: blocked }, stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 4_000);
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(timeout);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("Alpha local workspace is not writable");
    expect(stdout).not.toContain("ALPHA_SERVER_READY");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
