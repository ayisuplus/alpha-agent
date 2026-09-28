import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alphaContract, isCodeWork, sessionToolNames, type SessionFacts } from "../src/runtime/session-profile";
import { TaskLedger, type TaskType } from "../src/runtime/task-ledger";
import { overPromptBudget, promptFootprint } from "../src/runtime/prompt-budget";
import { ompAgentId } from "../src/runtime/omp-settings";

async function withFacts(taskType: TaskType, patch: Partial<SessionFacts>, check: (facts: SessionFacts) => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "alpha-session-profile-"));
  try {
    const criteria = taskType === "general" ? [] : [{ id: "build", description: "Build", kind: "build" as const }];
    const projectRoot = join(root, "products", "cart");
    await mkdir(projectRoot, { recursive: true });
    const ledger = await TaskLedger.create(join(root, ".alpha"), { objective: "Explain the cart", projectRoot, taskType, criteria });
    check({
      role: "coordinator", ledger, direct: false, agentPresets: [], skills: [], pluginToolNames: ["plugin_write"], pluginInstructions: [],
      mcpToolNames: ["mcp__alpha_x_write"], hooksLoaded: false, officeReadToolNames: [], canDispatch: true, browserConnected: false, ...patch,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const WRITING_TOOLS = ["edit", "write", "alpha_command", "alpha_build", "alpha_check", "alpha_document", "alpha_dispatch", "plugin_write", "mcp__alpha_x_write"];

test("an answer session can only read the task, whatever the task type", async () => {
  for (const taskType of ["code-change", "general", "web-product"] as const) {
    await withFacts(taskType, { role: "answer" }, facts => {
      const tools = sessionToolNames(facts);
      expect(tools).toContain("read");
      expect(tools).toContain("grep");
      for (const tool of WRITING_TOOLS) expect(tools).not.toContain(tool);
    });
  }
  // A direct project gets no LSP or AST search: only Alpha's sandbox proxies reach the mounted folder.
  await withFacts("code-change", { role: "answer", direct: true }, facts => {
    expect(sessionToolNames(facts)).not.toContain("lsp");
    expect(sessionToolNames(facts)).not.toContain("ast_grep");
  });
});

test("Alpha's contract is written to follow OMP's own prompt and states the answer boundary", async () => {
  await withFacts("code-change", { role: "answer" }, facts => {
    const contract = alphaContract(facts);
    expect(contract.startsWith("ALPHA RUNTIME CONTRACT")).toBe(true);
    expect(contract).toContain("guidance above");
    expect(contract).toContain("do not modify files");
  });
});

test("only code work pins Hashline edits", () => {
  expect(isCodeWork("code-change")).toBe(true);
  expect(isCodeWork("web-product")).toBe(true);
  for (const taskType of ["general", "research", "file-work"] as const) expect(isCodeWork(taskType)).toBe(false);
});

test("each task type keeps the coordinator tools it had before task profiles", async () => {
  const delivery = ["alpha_input", "alpha_check", "alpha_command", "alpha_document", "alpha_build", "alpha_spawn"];
  const expected: Array<[TaskType, boolean, string[]]> = [
    ["web-product", false, ["alpha_build", "alpha_spawn"]],
    ["code-change", false, ["alpha_check", "alpha_command", "alpha_spawn"]],
    ["research", false, ["alpha_document"]],
    ["file-work", false, ["alpha_document"]],
    ["general", false, ["alpha_input", "alpha_check", "alpha_command", "alpha_document", "alpha_build"]],
    ["general", true, ["alpha_input", "alpha_check", "alpha_command"]],
  ];
  for (const [taskType, direct, tools] of expected) {
    await withFacts(taskType, { role: "coordinator", direct }, facts => {
      expect(sessionToolNames(facts).filter(name => delivery.includes(name)).sort()).toEqual([...tools].sort());
    });
  }
});

test("the fixed prompt footprint is measured against the model's context window", () => {
  const state = { systemPrompt: ["You are a coding agent.".repeat(400)], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
  const small = promptFootprint(state, { contextWindow: 8_000 });
  expect(small.systemTokens).toBeGreaterThan(1_000);
  expect(small.toolTokens).toBeGreaterThan(0);
  expect(small.tools).toBe(1);
  expect(overPromptBudget(small)).toBe(true);
  const large = promptFootprint(state, { contextWindow: 1_000_000 });
  expect(overPromptBudget(large)).toBe(false);
  expect(promptFootprint(state, {}).contextShare).toBeNull();
});

test("every OMP session gets its own agent identity, so parallel sessions never replace each other", () => {
  const ids = new Set(Array.from({ length: 50 }, () => ompAgentId("coordinator")));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^alpha-coordinator-[0-9a-f]{8}$/);
});
