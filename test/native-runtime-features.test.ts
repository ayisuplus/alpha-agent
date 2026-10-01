import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcProcess } from "../src/native/rpc-process";
import { redactLog } from "../src/native/logs";

async function profile(fetch: (request: Request) => Response | Promise<Response>, extra = "") {
  const root = await mkdtemp(join(tmpdir(), "alpha-native-runtime-")), agent = join(root, "profile"), cwd = join(root, "project"); await mkdir(agent); await mkdir(cwd);
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", auth: "none", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: "local", input: ["text", "image"], contextWindow: 100000, maxTokens: 1000 }] } } }));
  await writeFile(join(agent, "config.yml"), "modelRoles:\n  default: fixture/local\ndefaultThinkingLevel: off\nretry:\n  enabled: false\nstartup:\n  quiet: true\n  checkUpdate: false\n" + extra);
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") } as Record<string, string>;
  const launch = (id?: string) => new RpcProcess({ cwd, env, argv: [resolve("src/native/omp-host.ts"), "--mode", "rpc-ui", ...(id ? ["--resume", id] : [])] });
  return { root, cwd, launch, async close(child: RpcProcess) { await child.stop(); model.stop(true); await rm(root, { recursive: true, force: true }); } };
}
function response(delta: unknown, finish = "stop") { return new Response(`data: ${JSON.stringify({ id: "fixture", model: "local", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }

test("native queue dequeue preserves original images before removal and survives host restart", async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let first = true;
  const f = await profile(async () => { if (first) { first = false; started.resolve(); await release.promise; } return response({ content: "QUEUE_NATIVE_PROOF" }); }, "lsp:\n  enabled: false\n");
  let child = f.launch();
  const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
  try {
    await child.ready; const { completion } = await child.startPrompt("Hold the active turn."); await started.promise;
    await child.command({ type: "follow_up", message: "FOLLOWUP_MUST_REMAIN" });
    await child.command({ type: "steer", message: "STEER_WITH_IMAGE", images: [image] });
    const queues = await child.hostCommand("session", { action: "queues" }) as { steering: string[]; followUp: string[] };
    expect(queues.followUp).toContain("FOLLOWUP_MUST_REMAIN"); expect(queues.steering).toContain("STEER_WITH_IMAGE");
    const draft = await child.hostCommand("session", { action: "pop-queue" }) as { text: string; images: Array<{ data: string }>; path: string; savedPaths: string[] };
    expect(draft.text).toBe("STEER_WITH_IMAGE"); expect(draft.images[0]!.data).toBe(image.data);
    expect(await readFile(draft.savedPaths[0]!)).toEqual(Buffer.from(image.data, "base64"));
    expect(await readFile(join(draft.path, "..", "native-queue.json"), "utf8")).toContain(image.data);
    expect((await child.hostCommand("session", { action: "queues" }) as typeof queues).followUp).toContain("FOLLOWUP_MUST_REMAIN");
    release.resolve(); await completion;
    for (let count = 0; count < 100 && !JSON.stringify(await child.command({ type: "get_messages" })).includes("FOLLOWUP_MUST_REMAIN"); count++) await Bun.sleep(50);
    expect(JSON.stringify(await child.command({ type: "get_messages" }))).toContain("FOLLOWUP_MUST_REMAIN");
    const state = await child.command({ type: "get_state" }) as { data: { sessionId: string } }; await child.stop(); child = f.launch(state.data.sessionId); await child.ready;
    expect((await child.hostCommand("session", { action: "queue-drafts" }) as Array<{ path: string }>).map(row => row.path)).toContain(draft.path);
    expect(await readFile(draft.path, "utf8")).toContain(image.data);
    const logs = await child.hostCommand("session", { action: "logs" }) as { entries: Array<{ name: string }> };
    if (logs.entries[0]) expect((await child.hostCommand("session", { action: "logs", name: logs.entries[0].name }) as { text: string }).text).toBeString();
    expect(await child.hostCommand("session", { action: "logs", name: "../credentials" }).catch(String)).toContain("catalog");
  } finally { release.resolve(); await f.close(child); }
}, 60_000);

test("native LSP configuration initializes, formats a real write, stops, reconnects and reloads", async () => {
  let wrote = false;
  const f = await profile(() => { if (!wrote) { wrote = true; return response({ tool_calls: [{ index: 0, id: "write-lsp", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "example.alpha", content: "UNFORMATTED\n" }) } }] }, "tool_calls"); } return response({ content: "LSP_WRITE_FINISHED" }); }, "lsp:\n  enabled: true\n  shared: false\n  formatOnWrite: true\n  diagnosticsOnWrite: true\n");
  let child = f.launch(); const trace = join(f.root, "lsp-requests.txt");
  try {
    await child.ready;
    const initial = await child.hostCommand("definitions", { action: "lsp-read", scope: "project" }) as { revision: string };
    await child.hostCommand("definitions", { action: "lsp-save", scope: "project", revision: initial.revision, config: { servers: { "alpha-fixture": { command: process.execPath, args: ["run", resolve("test/fixtures/native-lsp-service.ts"), trace], fileTypes: [".alpha"], rootMarkers: ["."], languageId: "alpha" } } } });
    expect(await child.hostCommand("definitions", { action: "lsp-save", scope: "project", revision: initial.revision, config: {} }).catch(String)).toContain("changed");
    const catalog = await child.hostCommand("definitions", { action: "lsp-start" }) as { lsp: { active: Array<{ name: string; status: string; fileTypes: string[] }> } };
    expect(catalog.lsp.active.some(row => row.fileTypes.includes(".alpha") && row.status === "ready")).toBe(true);
    await child.promptAndWait("Write the Alpha file and apply native formatting.");
    expect(await readFile(join(f.cwd, "example.alpha"), "utf8")).toBe("FORMATTED_BY_NATIVE_LSP\n");
    expect(await readFile(trace, "utf8")).toContain("textDocument/formatting");
    await child.hostCommand("definitions", { action: "lsp-stop" });
    expect((await child.hostCommand("definitions", { action: "list" }) as typeof catalog).lsp.active).toHaveLength(0);
    expect((await child.hostCommand("definitions", { action: "lsp-start" }) as typeof catalog).lsp.active.some(row => row.status === "ready")).toBe(true);
    await child.stop(); child = f.launch(); await child.ready;
    expect(JSON.stringify(await child.hostCommand("definitions", { action: "lsp-read", scope: "project" }))).toContain("alpha-fixture");
  } finally { await f.close(child); }
}, 60_000);

test("native diagnostic tails mask JSON, authorization and URL credentials", () => {
  const text = redactLog('{"apiKey":"key-secret","nested":{"password":"password-secret"}}\nBearer bearer-secret\napi_key=plain-secret\nhttps://user:secret@example.com/log?token=query-secret');
  for (const secret of ["key-secret", "password-secret", "bearer-secret", "plain-secret", "query-secret", "user:secret"]) expect(text).not.toContain(secret);
});

test("native todo and parallel child sessions expose persisted transcripts through RPC", async () => {
  let stage = 0, active = 0, peak = 0;
  const f = await profile(async request => {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }> };
    if (body.messages.some(message => message.role === "system" && JSON.stringify(message.content).includes("SUBAGENT_PROFILE_ONLY"))) {
      active++; peak = Math.max(peak, active); await Bun.sleep(300); active--; return response({ content: "SUBAGENT_NATIVE_EVIDENCE" });
    }
    const calls = stage++ === 0 ? [{ name: "todo", arguments: JSON.stringify({ op: "init", list: [{ phase: "Proof", items: ["Native child proof"] }] }) }]
      : stage === 2 ? ["one", "two"].map(name => ({ name: "task", arguments: JSON.stringify({ name, agent: "parity-helper", task: "Return SUBAGENT_NATIVE_EVIDENCE", solutionSpace: "Use the fixture response", isolated: false }) })) : [];
    return calls.length ? response({ tool_calls: calls.map((call, index) => ({ index, id: `native-${stage}-${index}`, type: "function", function: call })) }, "tool_calls") : response({ content: "PARENT_NATIVE_FINISHED" });
  }, "lsp:\n  enabled: false\ntask:\n  isolation:\n    enabled: false\n");
  await mkdir(join(f.cwd, ".omp", "agents"), { recursive: true });
  await writeFile(join(f.cwd, ".omp", "agents", "parity-helper.md"), "---\nname: parity-helper\ndescription: Native parity test helper\nmodel: fixture/local\ntools: [read]\n---\nSUBAGENT_PROFILE_ONLY\n");
  let child = f.launch();
  try {
    await child.ready; await child.promptAndWait("Run the native todo and two native child tasks.");
    const state = await child.command({ type: "get_state" }); expect(JSON.stringify(state)).toContain("Native child proof");
    const agents = await child.hostCommand("session", { action: "subagent-history" }) as Array<{ id: string; sessionFile: string }>;
    expect(agents.length).toBe(2); expect(peak).toBe(2);
    const nativeState = state as { data: { sessionId: string } };
    await child.stop(); child = f.launch(nativeState.data.sessionId); await child.ready;
    expect((await child.hostCommand("session", { action: "subagent-history" }) as unknown[]).length).toBe(2);
    for (const agent of agents) {
      const transcript = await child.hostCommand("session", { action: "subagent-transcript", subagentId: agent.id }) as { messages: unknown[] };
      expect(JSON.stringify(transcript.messages)).toContain("SUBAGENT_NATIVE_EVIDENCE");
    }
  } finally { await f.close(child); }
}, 120_000);
