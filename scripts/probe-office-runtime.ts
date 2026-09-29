import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { editOffice, readOffice, type OfficeWorkspace } from "../src/runtime/office-runtime";

const root = await mkdtemp(join(tmpdir(), "alpha-office-probe-"));
try {
  const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("First "), new TextRun("tar"), new TextRun({ text: "get", bold: true }), new TextRun(" last") ] })] }] }));
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Data");
  sheet.getCell("A1").value = 1;
  sheet.getCell("A2").value = 2;
  sheet.getCell("A3").value = { formula: "SUM(A1:A2)", result: 3 };
  const excel = new Uint8Array(await book.xlsx.writeBuffer());
  const dataRoot = join(root, "state");
  const projectRoot = join(root, "project");
  const inputsRoot = join(projectRoot, "inputs");
  await mkdir(inputsRoot, { recursive: true });
  const files = [
    { name: "letter.docx", bytes: word }, { name: "totals.xlsx", bytes: excel },
    { name: "deck.pptx", bytes: await readFile(join(import.meta.dir, "..", "test", "fixtures", "office-deck.pptx")) },
    { name: "replacement.png", bytes: await readFile(join(import.meta.dir, "..", "test", "fixtures", "office-replacement.png")) },
  ];
  const inputs = await Promise.all(files.map(async file => {
    const id = randomUUID();
    const path = join(inputsRoot, `${id}-${file.name}`);
    await writeFile(path, file.bytes);
    return { id, name: file.name, path, sha256: createHash("sha256").update(file.bytes).digest("hex"), mimeType: "", size: file.bytes.length, uploadedAt: new Date().toISOString() };
  }));
  const ledger: OfficeWorkspace = { state: { id: randomUUID(), projectRoot, inputs } };
  const [docxId, xlsxId, pptxId, imageId] = inputs.map(item => item.id);
  const beforeWord = await readOffice(ledger, dataRoot, docxId);
  assert.match(JSON.stringify(beforeWord.content), /First target last/);
  const editedWord = await editOffice(ledger, dataRoot, docxId, [{ paragraph: 0, expected: "target", replacement: "updated" }]);
  assert.match(JSON.stringify(editedWord.report), /First updated last/);
  assert.equal((await readFile(editedWord.previewPath)).subarray(0, 4).toString(), "%PDF");
  const editedExcel = await editOffice(ledger, dataRoot, xlsxId, [{ sheet: "Data", cell: "A1", expected: "1", replacement: 4 }]);
  const reread = await readOffice(ledger, dataRoot, editedExcel.id);
  assert.match(JSON.stringify(reread.content), /"value":6/);
  const editedSlides = await editOffice(ledger, dataRoot, pptxId, [{ slide: 1, shape: 0, expected: "Closing target", replacement: "Closing revised" }]);
  assert.match(JSON.stringify(editedSlides.report), /Closing revised/);
  assert.match(JSON.stringify(editedSlides.report), /Opening target/);
  const editedImage = await editOffice(ledger, dataRoot, editedSlides.id, [{ slide: 1, shape: 1, imageInputId: imageId }]);
  assert.notEqual(editedImage.sha256, editedSlides.sha256);
  console.log(JSON.stringify({ status: "pass", wordHash: editedWord.sha256, excelHash: editedExcel.sha256, pptHash: editedSlides.sha256, imageHash: editedImage.sha256 }));
} finally {
  await rm(root, { recursive: true, force: true });
}
