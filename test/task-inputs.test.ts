import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeneralWorkspace } from "../src/runtime/general-work";
import { addTaskInputs, createTaskInputTool } from "../src/runtime/task-inputs";

test("attachments are hashed, task-scoped, and cannot be read after replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-task-inputs-"));
  const productsRoot = join(root, "products");
  const dataRoot = join(root, "data");
  await mkdir(productsRoot);
  const a = await createGeneralWorkspace({ taskType: "general", objective: "A", productsRoot, dataRoot });
  const b = await createGeneralWorkspace({ taskType: "general", objective: "B", productsRoot, dataRoot });
  await addTaskInputs(a, dataRoot, [{ name: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private A") }]);
  const input = a.state.inputs![0];
  expect(b.state.inputs).toBeUndefined();
  const invoke = async (task: typeof a) => createTaskInputTool(task).execute("call", { id: input.id }, undefined as never, undefined as never, undefined as never);
  expect((await invoke(a)).content[0]).toMatchObject({ text: "private A" });
  expect((await invoke(b)).isError).toBe(true);
  expect((await readFile(input.path, "utf8"))).toBe("private A");
  await writeFile(input.path, "replaced");
  expect((await invoke(a)).isError).toBe(true);
});
