import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcProcess } from "../src/native/rpc-process";
import type { PlanView } from "../src/native/host-types";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alpha-plan-proof-"));
  const cwd = join(root, "project"), agent = join(root, "profile"), sessions = join(root, "sessions");
  await mkdir(cwd); await mkdir(agent); await writeFile(join(cwd, "keep.txt"), "USER_WORK_MUST_SURVIVE\n");
  let stage = 0, executing = false, delaySummary = false, summaryStarted = false, wroteExecution = false;
  const executions: Array<{ model: string; text: string }> = [];
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; stream?: boolean };
    const user = JSON.stringify(body.messages.findLast(message => message.role === "user")?.content ?? "");
    const summary = !body.tools?.length;
    if (summary) { summaryStarted = true; if (delaySummary) await Bun.sleep(3000); }
    let call: { name: string; arguments: string } | null = null;
    if (!summary && !executing && body.model === "planner" && stage < 5) {
      const steps = [
        { name: "write", arguments: JSON.stringify({ path: "blocked.txt", content: "FORBIDDEN" }) },
        { name: "edit", arguments: JSON.stringify({ path: "keep.txt", old_string: "USER_WORK_MUST_SURVIVE", new_string: "FORBIDDEN" }) },
        { name: "write", arguments: JSON.stringify({ path: "local://native-proof-plan.md", content: "# Native proof\n\n## Implementation\nPreserve user work and use native tools.\n" }) },
        { name: "write", arguments: JSON.stringify({ path: "local://notes.txt", content: "DURABLE_SCRATCH_EVIDENCE" }) },
        { name: "write", arguments: JSON.stringify({ path: "xd://propose", content: "native-proof" }) },
      ]; call = steps[stage++];
    }
    if (executing && !summary) executions.push({ model: body.model, text: user });
    if (executing && !summary && !wroteExecution) { wroteExecution = true; call = { name: "write", arguments: JSON.stringify({ path: "execution-proof.txt", content: "NATIVE_WRITE_RESTORED" }) }; }
    const text = summary ? "Native summary: preserve the approved durable plan and user work." : "NATIVE_PLAN_EXECUTION_EVIDENCE";
    const delta = call ? { tool_calls: [{ index: 0, id: `plan-${stage}`, type: "function", function: call }] } : { content: text };
    if (body.stream === false) return Response.json({ id: "plan-fixture", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 } });
    return new Response(`data: ${JSON.stringify({ id: "plan-fixture", model: body.model, choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const models = ["executor", "planner"].map(id => ({ id, name: id, contextWindow: 100000, maxTokens: 1000, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.port}/v1`, auth: "none", apiKey: "fixture-only", models } } }));
  await writeFile(join(agent, "config.yml"), "modelRoles:\n  default: fixture/executor\n  plan: fixture/planner:high\n  smol: fixture/executor\ndefaultThinkingLevel: off\nedit:\n  mode: replace\nlsp:\n  enabled: false\nstartup:\n  setupWizard: false\n  quiet: true\n  checkUpdate: false\nretry:\n  enabled: false\ncompaction:\n  enabled: false\n  methodOrder: [soft]\n  keepRecentTokens: 128\n  reserveTokens: 1024\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions } as Record<string, string>;
  let child: RpcProcess;
  const start = async (id?: string) => { child = new RpcProcess({ cwd, env, argv: [resolve("src/native/omp-host.ts"), "--mode", "rpc-ui", ...(id ? ["--resume", id] : [])] }); await child.ready; return child; };
  await start();
  return {
    cwd, executions, get child() { return child; }, start,
    mode: () => child.hostCommand("mode") as Promise<PlanView>,
    async draft() {
      stage = 0; executing = false; summaryStarted = false;
      await child.hostCommand("plan", { action: "resume" });
      await child.promptAndWait("DRAFT native plan and submit it for review.");
      for (let attempt = 0; attempt < 60; attempt++) { const view = await child.hostCommand("mode") as PlanView; if (view.phase === "review") return view; await Bun.sleep(50); }
      throw new Error("Native proposal did not reach desktop review");
    },
    execute() { executing = true; }, delay() { delaySummary = true; }, summary: () => summaryStarted,
    async waitExecution() { for (let attempt = 0; attempt < 100 && !executions.length; attempt++) await Bun.sleep(50); expect(executions.length).toBeGreaterThan(0); },
    async close() { await child.stop(); model.stop(true); await rm(root, { recursive: true, force: true }); },
  };
}

test("native plan guards, review edits, dismissal, pause, reentry and process restore preserve the plan and execution model", async () => {
  const f = await fixture();
  try {
    let view = await f.draft();
    expect(await stat(join(f.cwd, "blocked.txt")).then(() => true, () => false)).toBe(false);
    expect(await readFile(join(f.cwd, "keep.txt"), "utf8")).toBe("USER_WORK_MUST_SURVIVE\n");
    expect(view.content).toContain("Native proof"); expect(view.planFilePath).toBe("local://native-proof-plan.md");
    const state = await f.child.command({ type: "get_state" }); expect(JSON.stringify(state)).toContain("planner");
    await f.child.hostCommand("session", { action: "role", role: "plan", model: "fixture/executor:low" });
    for (let attempt = 0; attempt < 60 && JSON.stringify(await f.child.command({ type: "get_state" })).includes('"id":"planner"'); attempt++) await Bun.sleep(50);
    expect(JSON.stringify(await f.child.command({ type: "get_state" }))).toContain('"id":"executor"');
    await f.child.hostCommand("session", { action: "role", role: "plan", model: "fixture/planner:high" });
    const edited = view.content + "\nREVIEW_EDIT_EVIDENCE\n";
    await f.child.hostCommand("plan", { action: "edit", content: edited, previous: view.content, feedback: { Implementation: "FEEDBACK: Keep existing work" } });
    await f.child.hostCommand("plan", { action: "dismiss" }); expect((await f.mode()).phase).toBe("active");
    await f.child.hostCommand("plan", { action: "review" });
    const conflict = await f.child.hostCommand("plan", { action: "edit", content: "stale", previous: view.content }).catch(error => error.message); expect(conflict).toContain("changed since opening");
    await f.child.hostCommand("plan", { action: "toggle" }); expect((await f.mode()).phase).toBe("paused");
    expect(JSON.stringify(await f.child.command({ type: "get_state" }))).toContain("executor");
    const persisted = await f.child.command({ type: "get_state" }); const id = (persisted as { data: { sessionId: string } }).data.sessionId;
    await f.child.stop(); await f.start(id); expect((await f.mode()).phase).toBe("paused");
    await f.child.hostCommand("plan", { action: "resume" }); view = await f.mode(); expect(view.content).toContain("REVIEW_EDIT_EVIDENCE");
    await f.child.hostCommand("plan", { action: "review" });
    await f.child.stop(); await f.start(id); expect((await f.mode()).phase).toBe("review");
    await f.child.hostCommand("plan", { action: "refine", feedback: { Implementation: "FEEDBACK: Keep existing work" } }); expect((await f.mode()).phase).toBe("active");
    await f.child.command({ type: "abort" });
    await f.child.hostCommand("plan", { action: "toggle" }); await f.child.hostCommand("plan", { action: "toggle" }); expect((await f.mode()).phase).toBe("off");
    expect(JSON.stringify(await f.child.command({ type: "get_state" }))).toContain("executor");
  } finally { await f.close(); }
}, 120_000);

for (const action of ["approve-clear", "approve-keep", "approve-compact"] as const) test(`native ${action} dispatches approved content with restored tools and model`, async () => {
  const f = await fixture();
  try {
    await f.child.promptAndWait("Warm context. " + "Keep verified user constraints and implementation context. ".repeat(300));
    const view = await f.draft(); const prior = await f.child.command({ type: "get_state" });
    f.execute(); await f.child.hostCommand("plan", { action }); await f.waitExecution();
    for (let attempt = 0; attempt < 100 && !await stat(join(f.cwd, "execution-proof.txt")).then(() => true, () => false); attempt++) await Bun.sleep(50);
    expect(await readFile(join(f.cwd, "execution-proof.txt"), "utf8")).toBe("NATIVE_WRITE_RESTORED");
    expect(f.executions.some(entry => entry.text.includes("Plan approved."))).toBe(true);
    expect(f.executions.at(-1)?.model).toBe("executor");
    const after = await f.mode(); expect(after.phase).toBe("off"); expect(after.content).toBe(view.content);
    expect(await readFile(join(f.cwd, "keep.txt"), "utf8")).toBe("USER_WORK_MUST_SURVIVE\n");
    if (action === "approve-clear") { const current = await f.child.command({ type: "get_state" }); expect((current as { data: { sessionId: string } }).data.sessionId).not.toBe((prior as { data: { sessionId: string } }).data.sessionId); expect(after.physicalPath).not.toBe(view.physicalPath); }
  } finally { await f.close(); }
}, 120_000);

test("cancelled plan compaction never dispatches execution; save-new requires completed saving", async () => {
  const f = await fixture();
  try {
    await f.child.promptAndWait("Warm context. " + "Keep verified user constraints and implementation context. ".repeat(300));
    await f.draft(); f.delay(); f.execute();
    const approval = f.child.hostCommand("plan", { action: "approve-compact" });
    for (let attempt = 0; attempt < 100 && !f.summary(); attempt++) await Bun.sleep(50);
    expect(f.summary()).toBe(true); await f.child.hostCommand("plan", { action: "cancel-compaction" }); await approval;
    expect(f.executions.length).toBe(0); expect((await f.mode()).error).toContain("execution was not started");
    await f.draft();
    const failure = await f.child.hostCommand("plan", { action: "save-new" }).catch(error => error.message); expect(failure).toContain("Save dialog"); expect((await f.mode()).phase).toBe("review");
    await f.child.hostCommand("plan", { action: "save-new", saved: true }); expect((await f.mode()).phase).toBe("off");
  } finally { await f.close(); }
}, 120_000);
