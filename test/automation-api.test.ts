import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("automation API creates, pauses and preserves independent schedules", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "alpha-automation-api-"));
  const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/server.ts")], {
    cwd: workspace, env: { ...process.env, ALPHA_WORKSPACE_ROOT: workspace }, stdout: "pipe", stderr: "pipe",
  });
  try {
    if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output is unavailable");
    const reader = child.stdout.getReader();
    let output = "", port: string | undefined;
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      while (!port) {
        const part = await reader.read();
        if (part.done) break;
        output += new TextDecoder().decode(part.value);
        port = /ALPHA_SERVER_READY (\d+)/.exec(output)?.[1];
      }
    } finally { clearTimeout(timeout); reader.releaseLock(); }
    if (!port) throw new Error(`Server did not start: ${output.slice(-500)}`);
    const base = `http://127.0.0.1:${port}`;
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const created = await fetch(`${base}/api/automations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Review", prompt: "Review task status", kind: "cron", schedule: { kind: "once", at }, modelSelector: null, notificationPolicy: "failures" }) });
    expect(created.status).toBe(200);
    const { automation } = await created.json() as { automation: { id: string; nextRunAt: string; status: string } };
    expect(automation.nextRunAt).toBe(at);
    const paused = await fetch(`${base}/api/automations/${automation.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "PAUSED", id: "tampered" }) });
    expect(paused.status).toBe(200);
    const listed = await fetch(`${base}/api/automations`).then(response => response.json()) as { automations: Array<{ id: string; status: string }>; runs: unknown[] };
    expect(listed.automations).toEqual([expect.objectContaining({ id: automation.id, status: "PAUSED" })]);
    expect(listed.runs).toEqual([]);
  } finally {
    child.kill(); await child.exited;
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
