import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocument } from "../src/runtime/document-tool";

test("PDF, DOCX and XLSX outputs are versioned and readable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-document-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    const pdf = await createDocument(project, join(root, "state"), "task", "pdf", "report", "报告", "中文内容\nSecond line");
    const docx = await createDocument(project, join(root, "state"), "task", "docx", "notes", "Notes", "First\nSecond");
    const xlsx = await createDocument(project, join(root, "state"), "task", "xlsx", "table", "Data", '[["Name","Value"],["A",1]]');
    expect((await readFile(pdf.path)).subarray(0, 4).toString()).toBe("%PDF");
    expect((await readFile(docx.path)).subarray(0, 2).toString()).toBe("PK");
    expect((await readFile(xlsx.path)).subarray(0, 2).toString()).toBe("PK");
    expect(pdf.sha256).toHaveLength(64);
    expect(JSON.parse(await readFile(join(root, "state", "artifacts", "task", `${pdf.id}.json`), "utf8")).sha256).toBe(pdf.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
