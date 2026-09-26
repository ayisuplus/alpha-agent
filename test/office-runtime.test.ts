import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { createGeneralWorkspace, verifyGeneralDeliverable } from "../src/runtime/general-work";
import { editOffice, officeRuntimeStatus, readOffice } from "../src/runtime/office-runtime";
import { createOfficePlugin } from "../src/plugins/office";

test("Office runtime edits a Word run and recalculates an Excel formula without changing inputs", async () => {
  if (!(await officeRuntimeStatus()).available) return;
  const root = await mkdtemp(join(tmpdir(), "alpha-office-"));
  try {
    const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("First "), new TextRun("tar"), new TextRun({ text: "get", bold: true }), new TextRun(" last") ] })] }] }));
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Data");
    sheet.getCell("A1").value = 1;
    sheet.getCell("A2").value = 2;
    sheet.getCell("A3").value = { formula: "SUM(A1:A2)", result: 3 };
    const excel = new Uint8Array(await book.xlsx.writeBuffer());
    const dataRoot = join(root, "state");
    const ledger = await createGeneralWorkspace({ taskType: "file-work", objective: "Edit documents", productsRoot: join(root, "products"), dataRoot,
      files: [{ name: "letter.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: word },
        { name: "totals.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: excel }] });
    const [docxId, xlsxId] = ledger.state.inputs!.map(item => item.id);
    const beforeWord = await readOffice(ledger, dataRoot, docxId);
    expect(JSON.stringify(beforeWord.content)).toContain("First target last");
    const editedWord = await editOffice(ledger, dataRoot, docxId, [{ paragraph: 0, expected: "target", replacement: "updated" }]);
    expect(JSON.stringify(editedWord.report)).toContain("First updated last");
    expect((await readFile(editedWord.previewPath)).subarray(0, 4).toString()).toBe("%PDF");
    const editedExcel = await editOffice(ledger, dataRoot, xlsxId, [{ sheet: "Data", cell: "A1", expected: "1", replacement: 4 }]);
    const result = await readOffice(ledger, dataRoot, editedExcel.id);
    expect(JSON.stringify(result.content)).toContain('"value":6');
    expect(ledger.state.inputs?.map(item => item.sha256)).toEqual([hash(word), hash(excel)]);
    expect((await PDFDocument.load(await readFile(editedExcel.previewPath))).getPageCount()).toBeGreaterThan(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

test("PDF page operations preserve the source and reject out-of-range pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-office-pdf-"));
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    pdf.addPage([210, 200]);
    pdf.addPage([220, 200]);
    const bytes = await pdf.save();
    const dataRoot = join(root, "state");
    const ledger = await createGeneralWorkspace({ taskType: "file-work", objective: "Reorder pages", productsRoot: join(root, "products"), dataRoot,
      files: [{ name: "source.pdf", mimeType: "application/pdf", bytes }] });
    const id = ledger.state.inputs![0].id;
    const reading = await readOffice(ledger, dataRoot, id);
    expect(reading.pagesNeedingOcr).toEqual([1, 2, 3]);
    await expect(editOffice(ledger, dataRoot, id, [{ kind: "select", pages: [4] }])).rejects.toThrow("Invalid PDF page selection");
    const result = await editOffice(ledger, dataRoot, id, [{ kind: "reorder", pages: [3, 1] }, { kind: "rotate", pages: [1], degrees: 90 }]);
    const changed = await PDFDocument.load(await readFile(result.path));
    expect(changed.getPageCount()).toBe(2);
    expect(changed.getPage(0).getWidth()).toBe(220);
    expect(changed.getPage(0).getRotation().angle).toBe(90);
    expect(result.beforePreviewPath).toBeDefined();
    expect(hash(await readFile(ledger.state.inputs![0].path))).toBe(ledger.state.inputs![0].sha256);
    await writeFile(join(ledger.state.projectRoot, "alpha-deliverable.json"), JSON.stringify({ outputs: [{ path: relative(ledger.state.projectRoot, result.path).replaceAll("\\", "/") }] }));
    await ledger.refreshRevision();
    await verifyGeneralDeliverable(ledger, dataRoot);
    expect(ledger.state.evidence.filter(item => item.kind === "artifact")).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tracked Word changes stay readable but refuse automatic editing", async () => {
  if (!(await officeRuntimeStatus()).available) return;
  const root = await mkdtemp(join(tmpdir(), "alpha-office-tracked-"));
  try {
    const dataRoot = join(root, "state");
    const ledger = await createGeneralWorkspace({ taskType: "file-work", objective: "Inspect revisions", productsRoot: join(root, "products"), dataRoot,
      files: [{ name: "tracked.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: await readFile(join(import.meta.dir, "fixtures", "office-tracked.docx")) }] });
    const id = ledger.state.inputs![0].id;
    const reading = await readOffice(ledger, dataRoot, id);
    expect(reading.unsupported).toContain("tracked changes");
    await expect(editOffice(ledger, dataRoot, id, [{ paragraph: 0, expected: "Original", replacement: "Changed" }])).rejects.toThrow("Editing paused for unsupported features");
    expect(hash(await readFile(ledger.state.inputs![0].path))).toBe(ledger.state.inputs![0].sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

function hash(bytes: Uint8Array) { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); }

test("Office tools are callable in file tasks and read-only during planning", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-office-tool-"));
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const dataRoot = join(root, "state");
    const ledger = await createGeneralWorkspace({ taskType: "file-work", objective: "Handle PDF", productsRoot: join(root, "products"), dataRoot,
      files: [{ name: "source.pdf", mimeType: "application/pdf", bytes: await pdf.save() }] });
    const tools = createOfficePlugin({ ledger, dataRoot }).tools;
    expect(tools.map(tool => tool.name)).toEqual(["alpha_office_status", "alpha_office_read", "alpha_office_edit", "alpha_office_export"]);
    const read = tools.find(tool => tool.name === "alpha_office_read")!;
    const reading = await read.execute("office-read", { id: ledger.state.inputs![0].id }, undefined, {} as never);
    expect(reading.isError).toBeUndefined();
    expect(reading.content.find(item => item.type === "text")?.text).toContain('"format":"pdf"');
    expect(createOfficePlugin({ ledger, dataRoot, readOnly: true }).tools.map(tool => tool.name)).toEqual(["alpha_office_status", "alpha_office_read"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
