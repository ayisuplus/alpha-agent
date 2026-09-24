import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("project API persists multiple mounts and records version changes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "alpha-project-api-"));
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const first = join(workspace, "first");
    const second = join(workspace, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/server.ts")], {
      cwd: workspace, env: { ...process.env, ALPHA_WORKSPACE_ROOT: workspace }, stdout: "pipe", stderr: "pipe",
    });
    if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output is unavailable");
    const reader = child.stdout.getReader();
    let output = "";
    let port: string | undefined;
    const timeout = setTimeout(() => child?.kill(), 10_000);
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
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await post("/api/projects", { name: "Direct project" }).then(response => response.json()) as { project: { id: string; version: number } };
    expect(created.project.version).toBe(1);
    const one = await post(`/api/projects/${created.project.id}/mounts`, { path: first }).then(response => response.json()) as { project: { version: number; mounts: Array<{ id: string; path: string }> } };
    const two = await post(`/api/projects/${created.project.id}/mounts`, { path: second }).then(response => response.json()) as { project: { version: number; mounts: Array<{ id: string; path: string }> } };
    expect(two.project.mounts.map(item => item.path)).toEqual([first, second]);
    expect(two.project.version).toBe(one.project.version + 1);
    const listed = await fetch(`${base}/api/projects`).then(response => response.json()) as { projects: Array<{ id: string }> };
    expect(listed.projects.map(item => item.id)).toContain(created.project.id);
    const removed = await fetch(`${base}/api/projects/${created.project.id}/mounts/${one.project.mounts[0]!.id}`, { method: "DELETE" }).then(response => response.json()) as { project: { version: number; mounts: Array<{ path: string }> } };
    expect(removed.project.mounts.map(item => item.path)).toEqual([second]);
    expect(removed.project.version).toBe(two.project.version + 1);
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
