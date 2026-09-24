import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPPermissionStore, guardMCPTools } from "../src/runtime/mcp-permissions";

test("MCP tools require a per-tool grant and external writes keep an idempotent receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-mcp-permission-"));
  const store = new MCPPermissionStore(root);
  let calls = 0;
  let question = "";
  const tool = { name: "mcp__alpha_sample_echo__send", label: "send", description: "send", parameters: {} as never,
    async execute() { calls++; return { content: [{ type: "text" as const, text: "sent" }] }; } };
  const [wrapped] = guardMCPTools([tool as never], store, "task", async value => { question = value; });
  const denied = await wrapped.execute("call-1", {}, undefined, {} as never);
  expect(denied.isError).toBe(true);
  expect(question).toContain("尚未逐项授权");
  expect(calls).toBe(0);
  await store.set(tool.name, "write");
  const first = await wrapped.execute("call-1", { message: "hello" }, undefined, {} as never);
  const repeated = await wrapped.execute("call-1", { message: "hello" }, undefined, {} as never);
  expect(first.content).toEqual(repeated.content);
  expect(calls).toBe(1);
  expect((await store.receipts("task"))[0]).toMatchObject({ requestId: "call-1", status: "complete" });
  const mismatch = await wrapped.execute("call-1", { message: "different" }, undefined, {} as never);
  expect(mismatch.isError).toBe(true);
  expect(calls).toBe(1);
});

test("an interrupted external MCP action is not replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-mcp-uncertain-"));
  const store = new MCPPermissionStore(root);
  const name = "mcp__alpha_sample_echo__send";
  await store.set(name, "write");
  await store.begin("task", name, "request", { body: "x" });
  await expect(store.begin("task", name, "request", { body: "x" })).rejects.toThrow("uncertain");
  expect((await store.receipts("task"))[0].status).toBe("running");
});
