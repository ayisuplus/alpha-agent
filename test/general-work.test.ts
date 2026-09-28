import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createDocument } from "../src/runtime/document-tool";
import { createGeneralWorkspace, verifyGeneralDeliverable } from "../src/runtime/general-work";
import { requestedOutput } from "../src/runtime/requested-output";

test("file-work keeps input and artifact hashes and completes without a web preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-general-file-"));
  const productsRoot = join(root, "products");
  const dataRoot = join(root, "data");
  await mkdir(productsRoot);
  const ledger = await createGeneralWorkspace({ taskType: "file-work", objective: "Make a report", productsRoot, dataRoot, files: [{ name: "notes.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("input") }] });
  const document = await createDocument(ledger.state.projectRoot, dataRoot, ledger.state.id, "docx", "report", "Report", "From input");
  await writeFile(join(ledger.state.projectRoot, "alpha-deliverable.json"), JSON.stringify({ outputs: [{ path: relative(ledger.state.projectRoot, document.path).replaceAll("\\", "/") }] }));
  await ledger.refreshRevision();
  await verifyGeneralDeliverable(ledger, dataRoot);
  expect(ledger.state.status).toBe("complete");
  expect(ledger.state.evidence[0]).toMatchObject({ kind: "artifact", contentHash: document.sha256 });
  expect(ledger.completionGaps()).toEqual([]);
  await writeFile(document.path, "changed after completion");
  expect((await readFile(ledger.state.evidence[0].source)).subarray(0, 2).toString()).toBe("PK");
  const input = ledger.state.inputs![0];
  expect(createHash("sha256").update(await readFile(input.path)).digest("hex")).toBe(input.sha256);
});

test("research validates supplied citations and permits local-only material", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-general-research-"));
  const productsRoot = join(root, "products");
  const dataRoot = join(root, "data");
  await mkdir(productsRoot);
  const ledger = await createGeneralWorkspace({ taskType: "research", objective: "Investigate", productsRoot, dataRoot, files: [{ name: "input.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("original") }] });
  await writeFile(join(ledger.state.projectRoot, "outputs", "report.md"), "Report");
  await writeFile(join(ledger.state.projectRoot, "alpha-deliverable.json"), JSON.stringify({ outputs: [{ path: "outputs/report.md", sourceIds: ["missing"] }] }));
  await ledger.refreshRevision();
  await expect(verifyGeneralDeliverable(ledger, dataRoot)).rejects.toThrow("unknown source");
  const sourceId = "12345678-1234-1234-1234-123456789012";
  await mkdir(join(dataRoot, "sources", ledger.state.id), { recursive: true });
  await writeFile(join(dataRoot, "sources", ledger.state.id, `${sourceId}.json`), JSON.stringify({ id: sourceId, taskId: ledger.state.id, url: "https://example.org", visitedAt: new Date().toISOString(), title: "Example", text: "Evidence", sha256: createHash("sha256").update("Evidence").digest("hex"), rawSha256: "a".repeat(64) }));
  await writeFile(join(ledger.state.projectRoot, "alpha-deliverable.json"), JSON.stringify({ outputs: [{ path: "outputs/report.md", sourceIds: [sourceId] }] }));
  await ledger.refreshRevision();
  await verifyGeneralDeliverable(ledger, dataRoot);
  expect(ledger.state.status).toBe("complete");

  const local = await createGeneralWorkspace({ taskType: "research", objective: "Summarize local notes", productsRoot, dataRoot, files: [{ name: "notes.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("local") }] });
  await writeFile(join(local.state.projectRoot, "outputs", "summary.csv"), "finding,source\nlocal,notes.txt\n");
  await writeFile(join(local.state.projectRoot, "alpha-deliverable.json"), JSON.stringify({ outputs: [{ path: "outputs/summary.csv" }] }));
  await local.refreshRevision();
  await verifyGeneralDeliverable(local, dataRoot);
  expect(local.state.status).toBe("complete");
});

test("a general answer is checked against the outputs the objective asks for, ignoring declined ones", () => {
  expect(requestedOutput("按地区汇总金额，告诉我最高的地区。直接回答即可，不需要生成文件。")).toEqual({ deliverable: false, sourceChange: false, webProduct: false });
  expect(requestedOutput("根据附件生成一份 XLSX 报告")).toMatchObject({ deliverable: true });
  expect(requestedOutput("解释这个模块的设计，不用修改代码")).toMatchObject({ sourceChange: false });
  expect(requestedOutput("帮我修复登录模块的 bug，无需生成文档")).toEqual({ deliverable: false, sourceChange: true, webProduct: false });
  expect(requestedOutput("创建一个记账网页")).toMatchObject({ webProduct: true });
});
