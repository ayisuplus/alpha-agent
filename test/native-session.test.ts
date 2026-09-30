import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop native branching, history, tags, full-text search, export and cold restart retain distinct session identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-session-proof-")), profile = join(root, "profile");
  await mkdir(profile);
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"SESSION_SEARCH_EVIDENCE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(profile, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.port}/v1`, auth: "none", apiKey: "fixture-only", models: [{ id: "local", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(profile, "config.yml"), "modelRoles:\n  default: fixture/local\nlsp:\n  enabled: false\nstartup:\n  quiet: true\n  checkUpdate: false\nretry:\n  enabled: false\n");
  let child: ReturnType<typeof Bun.spawn>, port = 0;
  const start = async () => {
    child = Bun.spawn([process.execPath, "run", "src/native/server.ts"], { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: profile, ALPHA_WORKSPACE_ROOT: root, ALPHA_SERVER_TOKEN: "session-proof" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader(); let output = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) throw new Error("Server exited before readiness"); output += new TextDecoder().decode(chunk.value); const match = /ALPHA_SERVER_READY (\d+)/.exec(output); if (match) { port = Number(match[1]); return; } }
  };
  const stop = async () => { if (process.platform === "win32") await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited; else child.kill(); await child.exited; };
  const api = async (path: string, data?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/native/${path}`, { method: data === undefined ? "GET" : "POST", headers: { "x-alpha-token": "session-proof", "content-type": "application/json" }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result as any;
  };
  try {
    await start(); const { session } = await api("sessions", { cwd: root, title: "History test" }); const path = `sessions/${session.id}`;
    await api(`${path}/open`, {});
    await api(`${path}/command`, { type: "prompt", message: "Keep my material", images: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" }] });
    for (let attempt = 0; attempt < 100; attempt++) { if ((await api(`${path}/state`)).isSettled) break; await Bun.sleep(50); }
    expect((await api("sessions?search=SESSION_SEARCH_EVIDENCE")).sessions.map((item: any) => item.id)).toContain(session.id);
    await api(path, { tags: ["证据", "证据", "native"] }); expect((await api("sessions?search=证据")).sessions[0].tags).toEqual(["证据", "native"]);
    const oldId = (await api(`${path}/state`)).sessionId;
    const tree = (await api(`${path}/command`, { type: "get_tree" })).data;
    const user = tree.tree.flatMap(function nodes(node: any): any[] { return [node, ...node.children.flatMap(nodes)]; }).find((node: any) => node.entry.type === "message" && node.entry.message.role === "user");
    await api(`${path}/host/session`, { action: "label", entryId: user.entry.id, label: "Original material" });
    const navigation = await api(`${path}/host/navigate`, { entryId: user.entry.id }); expect(navigation.cancelled).not.toBe(true);
    const result = await api(`${path}/host/session`, { action: "branch", entryId: user.entry.id });
    expect(result.cancelled).toBe(false); expect(result.selectedText).toBe("Keep my material"); expect(result.selectedImages).toHaveLength(1);
    const newId = (await api(`${path}/state`)).sessionId; expect(newId).not.toBe(oldId);
    const sessions = (await api("sessions")).sessions;
    const original = sessions.find((item: any) => item.ompSessionId === oldId); expect(original.id).not.toBe(session.id);
    expect(sessions.find((item: any) => item.id === session.id).ompSessionId).toBe(newId);
    const exported = await api(`${path}/export`, {}); expect(exported.name).toEndWith(".html"); expect(exported.content).toContain("<!DOCTYPE html>");
    await api(`${path}/host/plan`, { action: "resume" });
    const plan = await api(`${path}/host/mode`); await mkdir(join(plan.physicalPath, ".."), { recursive: true }); await writeFile(plan.physicalPath, "LOCAL_ARTIFACT_PREVIEW_EVIDENCE");
    expect((await api(`${path}/file?path=${encodeURIComponent(plan.planFilePath)}`)).text).toBe("LOCAL_ARTIFACT_PREVIEW_EVIDENCE");
    expect(await api(`${path}/file?path=${encodeURIComponent("local://../../escape.txt")}`).catch(error => error.message)).toContain("Path traversal");
    await stop(); await start();
    await api(`${path}/open`, {}); expect((await api(`${path}/state`)).sessionId).toBe(newId); expect((await api(`${path}/host/mode`)).phase).toBe("active");
    await api(`sessions/${original.id}/open`, {}); expect((await api(`sessions/${original.id}/state`)).sessionId).toBe(oldId);
    const saved = JSON.parse(await readFile(join(root, ".alpha", "native", "sessions.json"), "utf8")); expect(saved.sessions).toHaveLength(2);
  } finally { if (child!) await stop(); model.stop(true); await rm(root, { recursive: true, force: true }); }
}, 120_000);
