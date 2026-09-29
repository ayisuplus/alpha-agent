import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

test("desktop settings persist through OMP and a new RPC session uses the selected default", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-native-settings-"));
  const agentDir = join(root, "omp");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "config.yml"), "modelRoles:\n  slow: deepseek/deepseek-reasoner\nretry:\n  maxRetries: 3\n");
  const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], {
    cwd: resolve(import.meta.dir, ".."), env: { ...process.env, ALPHA_WORKSPACE_ROOT: root, PI_CODING_AGENT_DIR: agentDir },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const errors = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    const ready = (async () => {
      let output = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Server exited: ${await errors}`);
        output += new TextDecoder().decode(chunk.value);
        const match = /ALPHA_SERVER_READY (\d+)/.exec(output);
        if (match) return Number(match[1]);
      }
    })();
    const port = await Promise.race([ready, Bun.sleep(30_000).then(() => { throw new Error("Settings server timed out"); })]);
    const request = async (path: string, input?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/native/${path}`, input === undefined ? undefined : {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      return { status: response.status, value: await response.json() as any };
    };
    const before = await request("configuration");
    expect(before.value.agentDir).toBe(agentDir);
    expect(before.value.settings.some((item: any) => item.id === "auth.broker.token")).toBe(false);
    expect((await request("credentials", { provider: "deepseek", key: "alpha-test-not-a-real-key", action: "save" })).status).toBe(200);
    const catalog = (await request("models")).value;
    expect(JSON.stringify(catalog)).not.toContain("alpha-test-not-a-real-key");
    expect(catalog.providers.find((item: any) => item.id === "deepseek").storedKey).toBe(true);
    const model = catalog.models.find((item: any) => item.provider === "deepseek" && item.available);
    expect(model).toBeDefined();
    expect((await request("settings", { role: "default", model: model.selector })).status).toBe(200);
    expect((await request("settings", { id: "retry.maxRetries", value: 4 })).status).toBe(200);
    expect((await request("settings", { id: "compaction.enabled", value: "false" })).status).toBe(400);
    expect((await request("settings", { id: "auth.broker.token", value: "forbidden" })).status).toBe(400);
    const persisted = await readFile(join(agentDir, "config.yml"), "utf8");
    expect(persisted).toContain(model.selector);
    expect(persisted).toContain("deepseek/deepseek-reasoner");
    const created = (await request("sessions", { cwd: root, title: "Settings regression" })).value;
    const state = await request(`sessions/${created.session.id}/state`);
    expect(state.status).toBe(200);
    expect(`${state.value.model.provider}/${state.value.model.id}`).toBe(model.selector);
    expect((await request("credentials", { provider: "deepseek", action: "remove" })).status).toBe(200);
    const after = (await request("models")).value;
    expect(after.providers.find((item: any) => item.id === "deepseek").storedKey).toBe(false);
  } finally {
    if (process.platform === "win32") await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
    else child.kill();
    await child.exited;
    const actual = await realpath(root);
    if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error("Settings test directory left temp root");
    await rm(actual, { recursive: true, force: true });
  }
}, 120_000);
