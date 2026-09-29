import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

test("lists both historical ledger formats and continues without modifying them", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-native-legacy-"));
  const tasks = join(root, ".alpha", "tasks");
  await mkdir(tasks, { recursive: true });
  const direct = randomUUID(), wrapped = randomUUID();
  const directFile = join(tasks, `${direct}.json`), wrappedFile = join(tasks, `${wrapped}.json`);
  await writeFile(directFile, JSON.stringify({ id: direct, objective: "Direct objective", status: "stopped", projectRoot: root }));
  await writeFile(wrappedFile, JSON.stringify({ state: { id: wrapped, objective: "Wrapped objective", status: "stopped", projectRoot: root } }));
  const original = await readFile(directFile, "utf8");
  const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], { cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, ALPHA_WORKSPACE_ROOT: root }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  try {
    const reader = child.stdout.getReader();
    const { port, token } = await Promise.race([(async () => {
      let output = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Native server exited before ready: ${output}`);
        output += new TextDecoder().decode(chunk.value);
        const readyMatch = /ALPHA_SERVER_READY (\d+)/.exec(output);
        const tokenMatch = /ALPHA_SERVER_TOKEN (\w+)/.exec(output);
        if (readyMatch && tokenMatch) return { port: Number(readyMatch[1]), token: tokenMatch[1] };
      }
    })(),
      Bun.sleep(20_000).then(() => { throw new Error("Native server did not become ready"); })]);
    const base = `http://127.0.0.1:${port}`;
    const auth = { "x-alpha-token": token };
    const listed = await fetch(`${base}/api/native/legacy`, { headers: auth }).then(response => response.json()) as { tasks: Array<{ id: string }> };
    expect(listed.tasks.map(item => item.id).sort()).toEqual([direct, wrapped].sort());
    const continued = await fetch(`${base}/api/native/legacy/${direct}/continue`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{}" }).then(response => response.json()) as { draft: string; session: { legacyTaskId: string } };
    expect(continued.session.legacyTaskId).toBe(direct);
    expect(continued.draft).toContain("Direct objective");
    expect(await readFile(directFile, "utf8")).toBe(original);
  } finally {
    child.kill();
    await child.exited;
    const actual = await realpath(root);
    if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error("Legacy test directory left temp root");
    await rm(actual, { recursive: true, force: true });
  }
}, 30_000);
