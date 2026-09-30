import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectSearch } from "../src/native/project-search";
import { ProjectShells } from "../src/native/project-shells";

test("desktop search uses native fuzzy paths and literal content with Unicode filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-search-"));
  try {
    await mkdir(join(root, "nested")); await mkdir(join(root, ".alpha"));
    await writeFile(join(root, "nested", "材料.txt"), "first\nLITERAL [x].* proof\nlast\n"); await writeFile(join(root, ".alpha", "private.txt"), "LITERAL [x].* proof");
    expect((await projectSearch(root, "材料", false, AbortSignal.timeout(10000))).matches.map(item => item.path)).toContain(join(root, "nested", "材料.txt"));
    const result = await projectSearch(root, "[x].*", true, AbortSignal.timeout(10000));
    expect(result.matches).toHaveLength(1); expect(result.matches[0]).toMatchObject({ lineNumber: 2, line: "LITERAL [x].* proof" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("independent native project terminals keep separate tabs, execute commands and reject another project's access", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-shell-")), data = join(root, ".alpha"); await mkdir(data);
  const events: unknown[] = [], shells = new ProjectShells(resolve(import.meta.dir, ".."), data, (_, frame) => events.push(frame));
  try {
    const first = await shells.create(root), second = await shells.create(root);
    for (let attempt = 0; attempt < 100 && shells.list(root).some(shell => !shell.output.includes("PS ")); attempt++) await Bun.sleep(100);
    shells.request(root, first.id, "input", { data: "Write-Output ('ALPHA' + '_PTY_PROOF'); Set-Content -LiteralPath 'terminal-proof.txt' -Value 'PTY_EFFECT'\r" });
    for (let attempt = 0; attempt < 100 && !await readFile(join(root, "terminal-proof.txt"), "utf8").then(value => value.includes("PTY_EFFECT"), () => false); attempt++) await Bun.sleep(100);
    expect(await readFile(join(root, "terminal-proof.txt"), "utf8")).toContain("PTY_EFFECT"); expect(shells.list(root)[0].output).toContain("ALPHA_PTY_PROOF"); expect(shells.list(root)).toHaveLength(2);
    expect(() => shells.request(tmpdir(), first.id, "input", { data: "ignored" })).toThrow("not found");
    shells.request(root, first.id, "close", {}); expect(shells.list(root)).toHaveLength(1); expect(events.length).toBeGreaterThan(0);
  } finally { shells.stop(); await Bun.sleep(200); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}, 45_000);

test("native desktop worktrees preserve source dirt, refuse dirty cleanup, and snapshots follow actual task settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-proof-")), project = join(root, "project"), profile = join(root, "profile"); await mkdir(project); await mkdir(profile);
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", ...args], { cwd: project, windowsHide: true }); if (result.exitCode) throw new Error(new TextDecoder().decode(result.stderr)); return new TextDecoder().decode(result.stdout); };
  git("init"); await writeFile(join(project, "keep.txt"), "BASE\r\n"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "baseline");
  await writeFile(join(project, "keep.txt"), "STAGED\r\n"); git("add", "keep.txt"); await writeFile(join(project, "keep.txt"), "USER_UNSTAGED\r\n"); await writeFile(join(project, "user.txt"), "USER_UNTRACKED");
  const index = git("ls-files", "--stage");
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = await request.json() as { messages: Array<{ role: string }> }; const called = input.messages.some(message => message.role === "tool");
    const delta = called ? { content: "PROJECT_TASK_COMPLETE" } : { tool_calls: [{ index: 0, id: "project-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "keep.txt", content: "AGENT_EFFECT\n" }) } }] };
    return new Response(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: called ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(profile, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.port}/v1`, auth: "none", models: [{ id: "local", contextWindow: 100000, maxTokens: 1000, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(profile, "config.yml"), "modelRoles:\n  default: fixture/local\nworktree:\n  clone: false\nlsp:\n  enabled: false\nstartup:\n  quiet: true\n  checkUpdate: false\nretry:\n  enabled: false\n");
  const child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: profile, ALPHA_WORKSPACE_ROOT: root, ALPHA_SERVER_TOKEN: "project-proof" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  let port = 0;
  const api = async (path: string, input?: unknown) => { const response = await fetch(`http://127.0.0.1:${port}/api/native/${path}`, { method: input === undefined ? "GET" : "POST", headers: { "x-alpha-token": "project-proof", "content-type": "application/json" }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result as any; };
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader(); let output = "";
    while (!port) { const chunk = await reader.read(); if (chunk.done) throw new Error("Server failed to start"); output += new TextDecoder().decode(chunk.value); port = Number(/ALPHA_SERVER_READY (\d+)/.exec(output)?.[1] ?? 0); }
    const { session } = await api("sessions", { cwd: project }), path = `sessions/${session.id}`; await api(`${path}/open`, {});
    const created = await api(`${path}/host/worktree`, { action: "create", branch: "alpha/parity-proof" });
    expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("USER_UNSTAGED\r\n"); expect(git("ls-files", "--stage")).toBe(index); expect(await readFile(join(project, "user.txt"), "utf8")).toBe("USER_UNTRACKED");
    expect(await readFile(join(created.path, "keep.txt"), "utf8")).toBe("USER_UNSTAGED\r\n");
    const managed = (await api("projects")).projects.find((item: any) => item.cwd === created.path); expect(managed.managed).toBe(true);
    expect(await api("projects", { action: "remove", id: managed.id }).catch(error => error.message)).toContain("停止清理");
    await api(`${path}/command`, { type: "prompt", message: "Update keep.txt" });
    let turns: any[] = [];
    for (let attempt = 0; attempt < 150; attempt++) { turns = (await api(`${path}/snapshots`)).turns; if (turns.some(turn => turn.settled)) break; await Bun.sleep(100); }
    expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("AGENT_EFFECT\n"); expect(turns[0].settled).toBe(true);
    expect((await api(`${path}/snapshots`, { action: "preview", id: turns[0].id })).conflicts).toEqual([]);
    expect((await api(`${path}/snapshots`, { action: "restore", id: turns[0].id })).restored).toBe(true);
    expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("USER_UNSTAGED\r\n"); expect(git("ls-files", "--stage")).toBe(index);
    const priorSession = (await api(`${path}/state`)).sessionId;
    await api(`${path}/terminal/start`, { cols: 100, rows: 30 });
    for (let attempt = 0; attempt < 100 && !(await api(`${path}/terminal`)).output.includes("Alpha"); attempt++) await Bun.sleep(100);
    await api(`${path}/terminal/input`, { data: "/new\r" }); await Bun.sleep(500);
    await api(`${path}/terminal/input`, { data: "TUI_PROOF\r" });
    for (let attempt = 0; attempt < 150; attempt++) { const rows = (await api("sessions")).sessions; if (rows.some((item: any) => item.id === session.id && item.ompSessionId !== priorSession) && (await api(`${path}/terminal`)).output.includes("PROJECT_TASK_COMPLETE")) break; await Bun.sleep(100); }
    await api(`${path}/terminal/stop`, {});
    for (let attempt = 0; attempt < 150 && (await api(`${path}/terminal`)).active; attempt++) await Bun.sleep(100);
    await api(`${path}/open`, {}); expect((await api(`${path}/state`)).sessionId).not.toBe(priorSession);
    expect((await api("sessions")).sessions.some((item: any) => item.ompSessionId === priorSession)).toBe(true);
    expect((await api(`${path}/snapshots`)).turns.every((turn: any) => turn.settled)).toBe(true);
  } finally { await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited; await child.exited; model.stop(true); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}, 120_000);
