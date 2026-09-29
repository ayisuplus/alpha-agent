// C1–C3 automation run modes (token-cost-reduction): `checked()` guards the three tiers, a notice run finishes
// without touching the model and records the reminder text as its result, and a light task skips the plan skeleton and
// the heavy contract/tools.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore } from "../src/runtime/automations";
import type { AutomationInput } from "../src/runtime/automations";
import { TaskLedger } from "../src/runtime/task-ledger";
import { readEvents, taskLogDir } from "../src/runtime/task-events";
import { alphaContract, sessionToolNames } from "../src/runtime/session-profile";
import type { SessionFacts } from "../src/runtime/session-profile";
import { createServerContext } from "../src/server/context";
import { drainAutomations } from "../src/server/runs";

const reminder = "该喝水了，休息一下。";
const input = (overrides: Partial<AutomationInput> = {}): AutomationInput => ({
  name: "喝水提醒", prompt: reminder, kind: "cron",
  schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
  modelSelector: null, notificationPolicy: "failures", ...overrides,
});

async function projectDir(root: string): Promise<string> {
  const project = join(root, "project");
  await mkdir(project);
  return project;
}

test("checked() refuses impossible run-mode combinations and stores valid ones verbatim", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-automation-modes-"));
  try {
    const store = new AutomationStore(root);
    await expect(store.create(input({ runMode: "turbo" as never }))).rejects.toThrow("执行档位只能是 notice、light 或 full");
    await expect(store.create(input({ runMode: "notice", kind: "heartbeat", targetTaskId: "task-1" }))).rejects.toThrow("执行档位只支持 cron 类型的自动化");
    await expect(store.create(input({ runMode: "notice", projectId: "project-1" }))).rejects.toThrow("提醒档不读写项目目录");
    // Heartbeat follows the target task at full depth; a plain cron automation may pick any tier.
    expect((await store.create(input({ kind: "heartbeat", targetTaskId: "task-1" }))).runMode).toBeUndefined();
    expect((await store.create(input({ runMode: "light" }))).runMode).toBe("light");
    expect((await store.create(input({ runMode: "notice" }))).runMode).toBe("notice");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a notice run finishes with the reminder text and never reaches the model entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-automation-notice-"));
  const previous = process.env.ALPHA_WORKSPACE_ROOT;
  process.env.ALPHA_WORKSPACE_ROOT = root;
  try {
    const ctx = await createServerContext();
    // The model entry stub counts any attempt to schedule a model run; a notice run must never get there.
    let modelCalls = 0;
    ctx.configuredRun = (async () => { modelCalls++; throw new Error("a notice run must not reach the model"); }) as typeof ctx.configuredRun;
    const automation = await ctx.automationStore.create(input({ runMode: "notice" }));
    const run = await ctx.automationStore.runNow(automation.id);
    await drainAutomations(ctx);
    const finished = (await ctx.automationStore.list()).runs.find(item => item.id === run.id)!;
    expect(finished.status).toBe("complete");
    expect(finished.result).toBe(reminder);
    expect(modelCalls).toBe(0);
    const task = await ctx.loadLedger(finished.taskId!);
    expect(task?.state.status).toBe("complete");
  } finally {
    if (previous === undefined) delete process.env.ALPHA_WORKSPACE_ROOT;
    else process.env.ALPHA_WORKSPACE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a light task records the light flag and never writes the plan skeleton", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-light-ledger-"));
  try {
    const project = await projectDir(root);
    const ledger = await TaskLedger.create(join(root, "state"), { objective: reminder, projectRoot: project, taskType: "general", criteria: [], light: true });
    expect(ledger.state.light).toBe(true);
    // No plan lane: the run executes and finishes in one go, so acceptance can complete it without a recorded plan.
    expect(ledger.state.phase).toBe("execute");
    const types = (await readEvents(taskLogDir(ledger.file))).map(event => event.type);
    expect(types).toContain("task/created");
    expect(types).not.toContain("graph/skeleton-created");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("light facts get the single-run contract and tool list without plan or dispatch tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-light-contract-"));
  try {
    const project = await projectDir(root);
    const ledger = await TaskLedger.create(join(root, "state"), { objective: "直接回答这个问题", projectRoot: project, taskType: "general", criteria: [], light: true });
    const facts: SessionFacts = {
      role: "coordinator", ledger, direct: false, experts: [], skills: [], pluginToolNames: [], pluginInstructions: [],
      mcpToolNames: [], hooksLoaded: false, officeReadToolNames: [], canDispatch: true, browserConnected: false,
    };
    const contract = alphaContract(facts);
    expect(contract).not.toContain("alpha_plan");
    expect(contract).toContain("lightweight run");
    const tools = sessionToolNames(facts);
    expect(tools).toContain("alpha_check");
    expect(tools).toContain("edit");
    for (const absent of ["alpha_plan", "alpha_step", "alpha_spawn", "alpha_expert_search", "alpha_document", "alpha_command", "alpha_browser"]) {
      expect(tools).not.toContain(absent);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
