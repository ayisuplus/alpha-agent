import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astGrepBases, checkFileToolCall } from "../src/runtime/file-tool-guard";
import type { WorkOrder } from "../src/runtime/work-orders";

test("ast_grep targets are checked by their fixed directory prefix", () => {
  expect(astGrepBases({})).toEqual(["."]);
  expect(astGrepBases({ path: "src/**/*.ts; tests" })).toEqual(["src/", "tests"]);
  expect(astGrepBases({ path: "*.ts" })).toEqual(["."]);
  expect(() => astGrepBases({ path: "src/../../secrets/**" })).toThrow("Unsupported");
  expect(() => astGrepBases({ path: "pr://12" })).toThrow("Unsupported");
  expect(() => astGrepBases({ path: 42 })).toThrow("cannot be validated");
});

test("ast_grep stays inside the project and inside a worker's assigned paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-ast-guard-"));
  try {
    const project = join(root, "project");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "docs"), { recursive: true });
    await writeFile(join(project, "src", "app.ts"), "export const a = 1;\n");
    await checkFileToolCall("ast_grep", { path: "src/**/*.ts" }, project);
    await expect(checkFileToolCall("ast_grep", { path: join(root, "elsewhere") }, project)).rejects.toThrow("outside the assigned project");
    const order = { id: "w", objective: "x", mode: "investigate", ownedPaths: [], readPaths: ["src/"], resources: [] } as unknown as WorkOrder;
    await checkFileToolCall("ast_grep", { path: "src/**/*.ts" }, project, order);
    await expect(checkFileToolCall("ast_grep", { path: "docs" }, project, order)).rejects.toThrow("unassigned path");
    await expect(checkFileToolCall("ast_grep", {}, project, order)).rejects.toThrow("unassigned path");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lsp queries stay inside the project and a worker's assigned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-lsp-guard-"));
  try {
    const project = join(root, "project");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "app.ts"), "export const a = 1;\n");
    await writeFile(join(root, "outside.ts"), "export {};\n");
    await checkFileToolCall("lsp", { action: "hover", file: "src/app.ts", line: 1 }, project);
    await checkFileToolCall("lsp", { action: "diagnostics" }, project);
    await expect(checkFileToolCall("lsp", { action: "hover", file: join(root, "outside.ts") }, project)).rejects.toThrow("outside the assigned project");
    await expect(checkFileToolCall("lsp", { action: "hover", file: "pr://1" }, project)).rejects.toThrow("Unsupported");
    const order = { id: "w", objective: "x", mode: "investigate", ownedPaths: [], readPaths: ["src/app.ts"], resources: [] } as unknown as WorkOrder;
    await checkFileToolCall("lsp", { action: "definition", file: "src/app.ts" }, project, order);
    await expect(checkFileToolCall("lsp", { action: "symbols", query: "a" }, project, order)).rejects.toThrow("assigned file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
