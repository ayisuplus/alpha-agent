import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandApprovalStore } from "../src/runtime/command-approval";
import { createDirectFileTools } from "../src/runtime/direct-file-tools";
import { ProjectStore } from "../src/runtime/projects";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

test("outside file write waits for exact approval and executes only once", async () => {
  const data = await mkdtemp(join(tmpdir(), "alpha-direct-data-"));
  const root = await mkdtemp(join(tmpdir(), "alpha-direct-root-"));
  const outside = await mkdtemp(join(tmpdir(), "alpha-direct-outside-"));
  folders.push(data, root, outside);
  const projects = new ProjectStore(data);
  const project = await projects.create("test");
  const mounted = await projects.mount(project.id, root);
  const taskId = "direct-test";
  const questions: string[] = [];
  const tools = await createDirectFileTools({ taskId, projectId: project.id, projectVersion: mounted.version, projectRoot: root, dataRoot: data, mode: "ask", onNeedsInput: async reason => { questions.push(reason); } });
  const write = tools.find(item => item.name === "write")!;
  const target = join(outside, "result.txt");
  const args = { path: target, content: "approved exact content" };
  const first = await write.execute("call", args, undefined, {} as never, new AbortController().signal);
  expect(first.isError).toBe(true);
  expect(questions).toHaveLength(1);
  const approvals = commandApprovalStore(data);
  const pending = (await approvals.list(taskId))[0]!;
  expect(pending.exactAction?.arguments).toEqual(args);
  await approvals.decide(taskId, pending.id, true);
  const second = await write.execute("call", args, undefined, {} as never, new AbortController().signal);
  expect(second.isError).toBe(false);
  expect(await readFile(target, "utf8")).toBe(args.content);
  const repeat = await write.execute("call", args, undefined, {} as never, new AbortController().signal);
  expect(repeat.isError).toBe(true);
  expect((await approvals.list(taskId)).filter(item => item.status === "pending")).toHaveLength(1);
});

test("known credential read is stopped before worker access", async () => {
  const data = await mkdtemp(join(tmpdir(), "alpha-direct-data-"));
  const root = await mkdtemp(join(tmpdir(), "alpha-direct-root-"));
  folders.push(data, root);
  const projects = new ProjectStore(data);
  const project = await projects.create("test");
  const mounted = await projects.mount(project.id, root);
  await writeFile(join(root, ".env"), "secret");
  const tools = await createDirectFileTools({ taskId: "credential-test", projectId: project.id, projectVersion: mounted.version, projectRoot: root, dataRoot: data, mode: "full", onNeedsInput: async () => {} });
  const read = tools.find(item => item.name === "read")!;
  const result = await read.execute("call", { path: join(root, ".env") }, undefined, {} as never, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect((await commandApprovalStore(data).list("credential-test"))[0]?.risk).toBe("high");
});

test("approved credential read uses one exact host action", async () => {
  const data = await mkdtemp(join(tmpdir(), "alpha-direct-data-"));
  const root = await mkdtemp(join(tmpdir(), "alpha-direct-root-"));
  folders.push(data, root);
  const projects = new ProjectStore(data);
  const project = await projects.create("test");
  const mounted = await projects.mount(project.id, root);
  const secret = join(root, ".env");
  await writeFile(secret, "approved-secret");
  const taskId = "credential-approved";
  const tools = await createDirectFileTools({ taskId, projectId: project.id, projectVersion: mounted.version, projectRoot: root, dataRoot: data, mode: "ask", onNeedsInput: async () => {} });
  const read = tools.find(item => item.name === "read")!;
  const args = { path: secret };
  const first = await read.execute("call", args, undefined, {} as never, new AbortController().signal);
  expect(first.isError).toBe(true);
  const approvals = commandApprovalStore(data);
  const pending = (await approvals.list(taskId))[0]!;
  await approvals.decide(taskId, pending.id, true);
  const second = await read.execute("call", args, undefined, {} as never, new AbortController().signal);
  expect(second.isError).toBe(false);
  expect(second.content[0]?.type === "text" && second.content[0].text.includes("approved-secret")).toBe(true);
  const repeated = await read.execute("call", args, undefined, {} as never, new AbortController().signal);
  expect(repeated.isError).toBe(true);
});
