import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import fontkit from "@pdf-lib/fontkit";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";

const parameters = type({ format: "'pdf' | 'docx' | 'xlsx'", name: "string", title: "string", content: "string" });
export interface ArtifactRecord { id: string; taskId: string; path: string; format: "pdf" | "docx" | "xlsx"; sha256: string; createdAt: string }

function outputName(name: string, format: ArtifactRecord["format"]): string {
  const base = name.trim().replace(/\.(pdf|docx|xlsx)$/i, "");
  if (!base || base === "." || base === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(base) || base.length > 100) throw new Error("Invalid document name");
  return `${base}.${format}`;
}

async function pdfBytes(title: string, content: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontPath = join(process.env.SystemRoot ?? "C:\\Windows", "Fonts", "simhei.ttf");
  const font = await pdf.embedFont(await readFile(fontPath));
  const lines = [title, "", ...content.split(/\r?\n/).flatMap(line => line.length ? line.match(/.{1,55}/gu) ?? [line] : [""])];
  let page = pdf.addPage([595, 842]);
  let y = 790;
  for (const line of lines) {
    if (y < 55) { page = pdf.addPage([595, 842]); y = 790; }
    if (line) page.drawText(line, { x: 45, y, size: 12, font });
    y -= 21;
  }
  return pdf.save();
}

async function documentBytes(format: ArtifactRecord["format"], title: string, content: string): Promise<Uint8Array> {
  if (format === "pdf") return pdfBytes(title, content);
  if (format === "docx") {
    const document = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 32 })] }), ...content.split(/\r?\n/).map(line => new Paragraph(line))] }] });
    return Packer.toBuffer(document);
  }
  let rows: unknown;
  try { rows = JSON.parse(content); } catch { throw new Error("XLSX content must be a JSON array of rows"); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 10_000 || !rows.every(row => Array.isArray(row) && row.length <= 100 && row.every(cell => typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" || cell === null))) throw new Error("XLSX rows are invalid");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31) || "Sheet1");
  for (const row of rows) sheet.addRow(row);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export async function createDocument(projectRoot: string, dataRoot: string, taskId: string, format: ArtifactRecord["format"], name: string, title: string, content: string): Promise<ArtifactRecord> {
  if (!title.trim() || !content.trim() || content.length > 1_000_000) throw new Error("Document title or content is invalid");
  const bytes = await documentBytes(format, title, content);
  const directory = join(projectRoot, "outputs");
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const path = join(directory, `${id}-${outputName(name, format)}`);
  await writeFile(path, bytes, { flag: "wx" });
  const record: ArtifactRecord = { id, taskId, path, format, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString() };
  const recordsDir = join(dataRoot, "artifacts", taskId);
  await mkdir(recordsDir, { recursive: true });
  await writeFile(join(recordsDir, `${record.id}.json`), JSON.stringify(record, null, 2), { flag: "wx" });
  return record;
}

export function createDocumentTool(projectRoot: string, dataRoot: string, taskId: string): CustomTool<typeof parameters> {
  return {
    name: "alpha_document", label: "Create a reviewable document",
    description: "Create PDF or DOCX from text, or XLSX from JSON rows. Outputs stay in the task workspace and have an archived content hash.",
    parameters, loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        signal?.throwIfAborted();
        const record = await createDocument(projectRoot, dataRoot, taskId, args.format, args.name, args.title, args.content);
        return { content: [{ type: "text", text: JSON.stringify(record) }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
