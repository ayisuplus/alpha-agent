import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("separate MCP store instances preserve concurrent write receipts and permission changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-mcp-concurrent-"));
  const first = new MCPPermissionStore(root);
  const second = new MCPPermissionStore(root);
  const name = "mcp__alpha_sample_echo__send";
  await first.set(name, "write");
  const [a, b] = await Promise.all([
    first.begin("task-a", name, "request-a", { body: "a" }),
    second.begin("task-b", name, "request-b", { body: "b" }),
  ]);
  expect([a.permission, b.permission]).toEqual(["write", "write"]);
  expect((await first.receipts("task-a")).map(item => item.requestId)).toEqual(["request-a"]);
  expect((await second.receipts("task-b")).map(item => item.requestId)).toEqual(["request-b"]);
  await Promise.all([first.finish("task-a", "request-a", { ok: true }), second.set(name, "deny")]);
  expect((await first.receipts("task-a"))[0].status).toBe("complete");
  expect((await second.list())[name]).toBe("deny");
});

test("separate processes retain both MCP receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-mcp-processes-"));
  const store = new MCPPermissionStore(root);
  await store.set("mcp__alpha_sample_echo__send", "write");
  const script = join(import.meta.dir, "fixtures", "mcp-receipt-child.ts");
  const children = ["task-a", "task-b"].map(taskId => Bun.spawn([process.execPath, "run", script, root, taskId], { stdout: "pipe", stderr: "pipe" }));
  const outcomes = await Promise.all(children.map(async child => Promise.all([child.exited, new Response(child.stderr).text()])));
  for (const [code, stderr] of outcomes) expect(code).toBe(0);
  expect((await store.receipts("task-a")).map(item => item.requestId)).toEqual(["request"]);
  expect((await store.receipts("task-b")).map(item => item.requestId)).toEqual(["request"]);
});

test("a damaged MCP policy is preserved and cannot be replaced by a new grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-mcp-damaged-"));
  const path = join(root, "mcp-permissions.json");
  await writeFile(path, "{damaged");
  await expect(new MCPPermissionStore(root).set("mcp__alpha_sample_echo__send", "write")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("{damaged");
});
