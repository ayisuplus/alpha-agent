import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { CommentRangeEnd, CommentRangeStart, CommentReference, Document, Packer, Paragraph, TextRun } from "docx";

const root = import.meta.dir;
await mkdir(join(root, "fixtures"), { recursive: true });
const workbook = new ExcelJS.Workbook();
const visible = workbook.addWorksheet("Visible");
visible.getCell("A1").value = "ORIGINAL_XLSX_NATIVE_VIEW";
visible.getCell("A2").value = 7;
visible.getCell("B2").value = { formula: "A2*3", result: 21 };
visible.getCell("B2").note = { texts: [{ font: { name: "Calibri", size: 12 }, text: "FORMULA_REVIEW_COMMENT" }] };
visible.getCell("A20").value = "OUTSIDE_PRINT_AREA";
visible.getCell("A1").font = { name: "Calibri", size: 14, bold: true };
visible.getColumn(1).width = 35;
visible.getColumn(2).width = 20;
visible.pageSetup.printArea = "A1:B2";
const hidden = workbook.addWorksheet("Hidden", { state: "hidden" });
hidden.getCell("A1").value = "HIDDEN_SHEET_CONTENT";
const second = workbook.addWorksheet("Second");
second.getCell("A1").value = "SECOND_SHEET_NATIVE_CONTENT";
await workbook.xlsx.writeFile(join(root, "fixtures", "native-structure.xlsx"));
await copyFile(join(root, "../../..", "test", "fixtures", "office-tracked.docx"), join(root, "fixtures", "native-tracked.docx"));
await copyFile(join(root, "../../..", "test", "fixtures", "office-deck.pptx"), join(root, "fixtures", "native-deck.pptx"));
const commented = new Document({ comments: { children: [{ id: 0, author: "Alpha QA", initials: "AQ",
  date: new Date("2026-10-01T00:00:00Z"), children: [new Paragraph("WORD_NATIVE_COMMENT 中文批注正文")] }] },
  sections: [{ children: [new Paragraph({ children: [new CommentRangeStart(0), new TextRun("Comment target"), new CommentRangeEnd(0), new TextRun({ children: [new CommentReference(0)] })] })] }] });
await writeFile(join(root, "fixtures", "native-comments.docx"), await Packer.toBuffer(commented));
console.log(JSON.stringify({ fixtures: join(root, "fixtures") }));
