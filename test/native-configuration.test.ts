import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function list(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Row[] : [];
}
function findRow(value: unknown, match: Row): Row | undefined {
  return list(value).find(item => Object.entries(match).every(([key, expected]) => item[key] === expected));
}

test("desktop settings persist through OMP and a new RPC session uses the selected default", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-native-settings-"));
  const agentDir = join(root, "omp");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "config.yml"), "modelRoles:\n  slow: deepseek/deepseek-reasoner\nretry:\n  maxRetries: 3\n");
  const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], {
    cwd: resolve(import.meta.dir, ".."), env: { ...process.env, DEEPSEEK_API_KEY: "alpha-env-not-a-real-key", ALPHA_WORKSPACE_ROOT: root, PI_CODING_AGENT_DIR: agentDir },
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
        const readyMatch = /ALPHA_SERVER_READY (\d+)/.exec(output);
        const tokenMatch = /ALPHA_SERVER_TOKEN (\w+)/.exec(output);
        if (readyMatch && tokenMatch) return { port: Number(readyMatch[1]), token: tokenMatch[1] };
      }
    })();
    const { port, token } = await Promise.race([ready, Bun.sleep(30_000).then(() => { throw new Error("Settings server timed out"); })]);
    const request = async (path: string, input?: unknown): Promise<{ status: number; value: unknown }> => {
      const response = await fetch(`http://127.0.0.1:${port}/api/native/${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { "x-alpha-token": token, ...(input === undefined ? {} : { "content-type": "application/json" }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      return { status: response.status, value: await response.json() };
    };
    const before = await request("configuration");
    const config = row(before.value);
    expect(config.agentDir).toBe(agentDir);
    expect(JSON.stringify(config)).not.toContain("auth.broker.token");
    expect(JSON.stringify(config)).not.toContain("browser.cdpUrl");
    const envCatalog = row((await request("models")).value);
    expect(findRow(envCatalog.providers, { id: "deepseek" })?.available).toBe(0);
    expect((await request("credentials", { provider: "deepseek", key: "alpha-test-not-a-real-key", action: "save" })).status).toBe(200);
    const catalog = row((await request("models")).value);
    expect(JSON.stringify(catalog)).not.toContain("alpha-test-not-a-real-key");
    expect(findRow(catalog.providers, { id: "deepseek" })?.storedKey).toBe(true);
    const model = list(catalog.models).find(item => item.provider === "deepseek" && item.available === true);
    const selector = typeof model?.selector === "string" ? model.selector : "";
    expect(selector).not.toBe("");
    expect((await request("settings", { role: "default", model: selector })).status).toBe(200);
    expect((await request("settings", { id: "retry.maxRetries", value: 4 })).status).toBe(200);
    expect((await request("settings", { id: "compaction.enabled", value: "false" })).status).toBe(400);
    expect((await request("settings", { id: "auth.broker.token", value: "forbidden" })).status).toBe(400);
    // 结构化设置（数组/记录）走 JSON 编辑：形状不对拒绝，保存可读回，可重置。
    expect((await request("settings", { id: "tools.approval", value: ["bad"] })).status).toBe(400);
    expect((await request("settings", { id: "tools.approval", value: { bash: "allow" } })).status).toBe(200);
    const structured = row((await request("configuration")).value);
    expect(JSON.stringify(findRow(structured.settings, { id: "tools.approval" })?.value)).toContain('"bash":"allow"');
    expect((await request("settings", { id: "tools.approval", reset: true })).status).toBe(200);
    const persisted = await readFile(join(agentDir, "config.yml"), "utf8");
    expect(persisted).toContain(selector);
    expect(persisted).toContain("deepseek/deepseek-reasoner");
    const created = row(row((await request("sessions", { cwd: root, title: "Settings regression" })).value).session);
    const sessionId = typeof created.id === "string" ? created.id : "";
    expect(sessionId).not.toBe("");
    expect((await request(`sessions/${sessionId}/open`, {})).status).toBe(200);
    const state = await request(`sessions/${sessionId}/state`);
    expect(state.status).toBe(200);
    const model2 = row(row(state.value).model);
    expect(`${model2.provider}/${model2.id}`).toBe(selector);
    expect((await request(`sessions/${sessionId}`, { title: "Renamed regression", archived: true })).status).toBe(200);
    const renamed = findRow(row((await request("sessions")).value).sessions, { id: sessionId });
    expect(renamed?.title).toBe("Renamed regression");
    expect(renamed?.archived).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".alpha", "native", "sessions.json"), "utf8")).sessions[0].title).toBe("Renamed regression");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".hidden.txt"), "hidden");
    expect((await request(`sessions/${sessionId}/files?path=nested`)).status).toBe(200);
    expect((await request(`sessions/${sessionId}/files?path=..`)).status).toBe(400);
    expect((await request("credentials", { provider: "deepseek", action: "remove" })).status).toBe(200);
    const after = row((await request("models")).value);
    expect(findRow(after.providers, { id: "deepseek" })?.storedKey).toBe(false);
  } finally {
    if (process.platform === "win32") await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
    else child.kill();
    await child.exited;
    const actual = await realpath(root);
    if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error("Settings test directory left temp root");
    await rm(actual, { recursive: true, force: true });
  }
}, 120_000);
