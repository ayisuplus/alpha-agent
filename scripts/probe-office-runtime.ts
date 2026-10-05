// Packaging smoke for the alpha_office engine: prints {"status":"pass"} and exits 0.
// package-portable.ts runs this against the bundled LibreOffice with ProgramFiles redirected,
// so phase 1 proves the LibreOffice-missing gap while create xlsx and pdf actions still work,
// and phase 2 proves the UNO-backed chain on the bundled engine.
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  officeConvert,
  officeCreate,
  officeEdit,
  officeInspect,
  officePdf,
  officePreview,
  officeRuntimeStatus,
} from "../src/native/capabilities/office/office-runtime";
import { openOfficeView, renderOfficeView, closeOfficeView } from "../src/native/capabilities/office/office-view";

const root = await mkdtemp(join(tmpdir(), "alpha-office-probe-"));
const projectRoot = join(root, "project");
const artifacts: string[] = [];

function keep(path: string): string {
  artifacts.push(path);
  return join(projectRoot, path);
}

try {
  await mkdir(projectRoot, { recursive: true });

  // Phase 1: LibreOffice missing -> explicit gap; xlsx/pdf/png work anyway.
  process.env.ALPHA_OFFICE_NO_LIBREOFFICE = "1";
  assert.equal((await officeRuntimeStatus()).available, false);
  const book = await officeCreate({ projectRoot }, {
    kind: "xlsx",
    name: "probe-totals",
    data: { sheets: [{ name: "Data", headers: ["item", "value"], rows: [["a", 1], ["b", 2], ["sum", "=B2+B3"]] }] },
  });
  const xlsxPath = keep(book.artifacts[0].path);
  assert.equal((await readFile(xlsxPath)).subarray(0, 2).toString(), "PK", "create xlsx must produce a real xlsx without LibreOffice");
  for (const name of ["one", "two"]) {
    const pdf = await PDFDocument.create();
    pdf.addPage([240, 180]);
    await writeFile(join(projectRoot, `${name}.pdf`), await pdf.save());
  }
  const merged = await officePdf({ projectRoot }, { action: "merge", paths: ["one.pdf", "two.pdf"], name: "probe-merged" });
  assert.equal((await PDFDocument.load(await readFile(keep(merged.artifacts[0].path)))).getPageCount(), 2);
  const marked = await officePdf({ projectRoot }, { action: "watermark", paths: ["one.pdf"], name: "probe-marked", text: "内部资料 alpha" });
  assert.ok((await readFile(keep(marked.artifacts[0].path))).subarray(0, 4).toString() === "%PDF", "watermark must work without LibreOffice");
  assert.match(marked.summary, /系统字体|内置 Helvetica/, "font choice must be stated");
  const rendered = await officePreview({ projectRoot }, "two.pdf", [1]);
  assert.equal((await readFile(join(projectRoot, rendered.artifacts[0].path))).subarray(0, 4).toString("hex"), "89504e47", "PDF preview must render without LibreOffice");
  const gaps: Array<[string, () => Promise<unknown>]> = [
    ["inspect", () => officeInspect({ projectRoot }, "outputs/probe-totals.xlsx")],
    ["edit", () => officeEdit({ projectRoot }, "outputs/probe-totals.xlsx", [{ op: "set_cells", sheet: "Data", range: "A1", values: [["x"]] }])],
    ["create docx", () => officeCreate({ projectRoot }, { kind: "docx", name: "probe-report", content: "# 标题" })],
    ["create pptx", () => officeCreate({ projectRoot }, { kind: "pptx", name: "probe-deck", outline: [{ title: "第一页", bullets: ["A"] }] })],
    ["convert", () => officeConvert({ projectRoot }, "outputs/probe-totals.xlsx", "pdf")],
    ["preview office", () => officePreview({ projectRoot }, "outputs/probe-totals.xlsx")],
  ];
  for (const [label, attempt] of gaps) {
    await assert.rejects(attempt, (error: unknown) => String(error instanceof Error ? error.message : error).includes("LibreOffice"), `${label} must report the LibreOffice gap`);
  }
  delete process.env.ALPHA_OFFICE_NO_LIBREOFFICE;

  // Phase 2: engine present (bundled runtime in the portable package; system LibreOffice in dev).
  const status = await officeRuntimeStatus();
  assert.ok(status.available, "the bundled/system LibreOffice engine must be available in this phase");
  const created = await officeCreate({ projectRoot }, {
    kind: "docx",
    name: "probe-report",
    content: "# 标题\n\n第一段含 target 文本。\n\n- 要点一\n- 要点二\n\n**粗体** 与 *斜体*。",
  });
  const createdPath = keep(created.artifacts[0].path);
  const originalBytes = await readFile(createdPath);
  const inspected = await officeInspect({ projectRoot }, "outputs/probe-report.docx");
  const paragraphs = (inspected.doc as { paragraphs: Array<{ index: number; text: string }> }).paragraphs;
  const target = paragraphs.find(item => item.text.includes("target"));
  assert.ok(target, "inspect must list paragraphs with their text");
  await assert.rejects(
    officeEdit({ projectRoot }, "outputs/probe-report.docx", [{ op: "replace_text", paragraph: target.index, expected: "missing", replacement: "x" }]),
    /Expected text must occur exactly once/,
    "replace_text must fail loudly when expected does not match",
  );
  const edited = await officeEdit({ projectRoot }, "outputs/probe-report.docx", [{ op: "replace_text", paragraph: target.index, expected: "target", replacement: "updated" }]);
  const editedPath = keep(edited.artifacts[0].path);
  assert.match(editedPath, /probe-report\.alpha-v1\.docx$/, "edit output must take the alpha-v<N> name beside the original");
  assert.ok(edited.artifacts[0].preview && edited.artifacts[0].before, "edit must carry before/after previews");
  assert.deepEqual(await readFile(createdPath), originalBytes, "the original must stay untouched");
  const converted = await officeConvert({ projectRoot }, editedPath, "pdf");
  assert.equal((await readFile(keep(converted.artifacts[0].path))).subarray(0, 4).toString(), "%PDF");
  const deck = await officeCreate({ projectRoot }, {
    kind: "pptx",
    name: "probe-deck",
    outline: [{ title: "第一页", bullets: ["要点 A", "要点 B"] }, { title: "第二页", bullets: ["收尾"] }],
  });
  const deckPath = keep(deck.artifacts[0].path);
  const deckInspected = await officeInspect({ projectRoot }, "outputs/probe-deck.pptx");
  const slides = (deckInspected.doc as { slides: Array<{ title: string }> }).slides;
  assert.equal(slides.length, 2);
  assert.equal(slides[0].title, "第一页");
  const deckPreview = await officePreview({ projectRoot }, "outputs/probe-deck.pptx", [1]);
  keep(deckPreview.artifacts[0].path);
  const sheetEdit = await officeEdit({ projectRoot }, "outputs/probe-totals.xlsx", [{ op: "set_cells", sheet: "Data", range: "B2", values: [[10]] }]);
  keep(sheetEdit.artifacts[0].path);

  // Exercise the packaged original-format worker, interpreter and native DLLs, not only PDF conversion.
  for (const [path, kind] of [[createdPath, "text"], [xlsxPath, "spreadsheet"], [deckPath, "presentation"]] as const) {
    const before = await readFile(path);
    const view = await openOfficeView(path);
    try {
      assert.equal(view.kind, kind);
      assert.equal(view.readOnly, true);
      const tile = await renderOfficeView(view.id, { width: 320, height: 240 });
      const png = Buffer.from(tile.image, "base64");
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), 320);
      assert.equal(png.readUInt32BE(20), 240);
      if (kind === "presentation") assert.equal((await renderOfficeView(view.id, { part: 1, width: 320, height: 240 })).part, 1);
    } finally { await closeOfficeView(view.id); }
    assert.deepEqual(await readFile(path), before, "original preview must not save into its source");
  }

  console.log(JSON.stringify({ status: "pass", engine: status.location, originalPreview: ["docx", "xlsx", "pptx"], artifacts }));
} finally {
  delete process.env.ALPHA_OFFICE_NO_LIBREOFFICE;
  await rm(root, { recursive: true, force: true });
}
