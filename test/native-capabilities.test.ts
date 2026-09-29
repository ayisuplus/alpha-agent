import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import alphaCapabilities from "../src/native/capabilities/extension";
import { createComfyPlugin } from "../src/native/capabilities/comfyui/register";
import { mediaName, publishMedia } from "../src/native/capabilities/comfyui/media-integrity";
import { officeRuntimeStatus, LIBREOFFICE_GAP } from "../src/native/capabilities/office/office-runtime";
import { registerOfficeTools } from "../src/native/capabilities/office/register";

const leaked = ["ALPHA_BROWSER_BRIDGE_PORT", "ALPHA_BROWSER_BRIDGE_TOKEN", "ALPHA_CDP_PORT"] as const;
const saved = new Map<string, string | undefined>();

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { allows(value: unknown): boolean };
  execute(callId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>;
}

interface StubPi {
  pi: ExtensionAPI;
  tools: RegisteredTool[];
  entries: Array<{ customType: string; data: unknown }>;
}

function stubPi(): StubPi {
  const tools: RegisteredTool[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerTool(tool: RegisteredTool) { tools.push(tool); },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
    on() {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ExtensionAPI;
  return { pi, tools, entries };
}

async function withProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "alpha-office-suite-"));
  try {
    await mkdir(join(root, "outputs"), { recursive: true });
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function officeTool(pi: StubPi): RegisteredTool {
  const tool = pi.tools.find(item => item.name === "alpha_office");
  expect(tool).toBeDefined();
  return tool!;
}

async function call(tool: RegisteredTool, params: unknown): Promise<{ text: string; isError: boolean; value?: Record<string, unknown>; images: Array<{ type: string; data?: string; mimeType?: string }> }> {
  const result = await tool.execute(`call-${Math.random().toString(36).slice(2)}`, params, undefined, undefined, undefined);
  const text = result.content.find(item => item.type === "text")?.text ?? "";
  let value: Record<string, unknown> | undefined;
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { /* error text is not JSON */ }
  return { text, isError: Boolean(result.isError), value, images: result.content.filter(item => item.type === "image") };
}

async function makePdf(path: string, pages: number[] = [240, 240, 240]): Promise<void> {
  const pdf = await PDFDocument.create();
  for (const width of pages) pdf.addPage([width, 180]);
  await writeFile(path, await pdf.save());
}

function artifactsOf(value: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return (value?.artifacts as Array<Record<string, unknown>>) ?? [];
}

afterEach(() => {
  for (const key of leaked) {
    if (saved.has(key)) process.env[key] = saved.get(key);
    else delete process.env[key];
  }
  saved.clear();
});

describe("capability extension environment boundary", () => {
  test("reads the bridge token and CDP port, then scrubs them from process.env", () => {
    for (const key of leaked) { saved.set(key, process.env[key]); }
    process.env.ALPHA_BROWSER_BRIDGE_PORT = "41234";
    process.env.ALPHA_BROWSER_BRIDGE_TOKEN = "secret-bridge-token";
    process.env.ALPHA_CDP_PORT = "41235";
    const previousId = process.env.ALPHA_NATIVE_SESSION_ID;
    const previousRoot = process.env.ALPHA_DATA_ROOT;
    delete process.env.ALPHA_NATIVE_SESSION_ID;
    delete process.env.ALPHA_DATA_ROOT;
    try {
      alphaCapabilities(stubPi().pi);
      for (const key of leaked) expect(process.env[key]).toBeUndefined();
    } finally {
      if (previousId === undefined) delete process.env.ALPHA_NATIVE_SESSION_ID; else process.env.ALPHA_NATIVE_SESSION_ID = previousId;
      if (previousRoot === undefined) delete process.env.ALPHA_DATA_ROOT; else process.env.ALPHA_DATA_ROOT = previousRoot;
    }
  });
});

describe("capability tool registration surface", () => {
  test("registers exactly alpha_office and the three media generation tools", () => {
    const previousId = process.env.ALPHA_NATIVE_SESSION_ID;
    const previousRoot = process.env.ALPHA_DATA_ROOT;
    process.env.ALPHA_NATIVE_SESSION_ID = "suite-session";
    process.env.ALPHA_DATA_ROOT = join(tmpdir(), "alpha-suite-data");
    try {
      const stub = stubPi();
      alphaCapabilities(stub.pi);
      expect(stub.tools.map(tool => tool.name).sort()).toEqual([
        "alpha_generate_image",
        "alpha_generate_video",
        "alpha_generate_voice",
        "alpha_office",
      ]);
    } finally {
      if (previousId === undefined) delete process.env.ALPHA_NATIVE_SESSION_ID; else process.env.ALPHA_NATIVE_SESSION_ID = previousId;
      if (previousRoot === undefined) delete process.env.ALPHA_DATA_ROOT; else process.env.ALPHA_DATA_ROOT = previousRoot;
    }
  });

  test("retired office, document, browser, and status tools are gone", () => {
    const stub = stubPi();
    registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: join(tmpdir(), "alpha-suite-data"), projectRoot: tmpdir() });
    const names = stub.tools.map(tool => tool.name);
    for (const retired of ["alpha_office_attach", "alpha_office_read", "alpha_office_edit", "alpha_office_export", "alpha_office_status", "alpha_document", "alpha_browser"]) {
      expect(names).not.toContain(retired);
    }
    expect(names).toEqual(["alpha_office"]);
    expect(officeTool(stub).description).toContain("read tool");
  });
});

describe("alpha_office parameter schema", () => {
  const stub = stubPi();
  registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: join(tmpdir(), "alpha-suite-data"), projectRoot: tmpdir() });
  const schema = officeTool(stub).parameters;

  test("accepts one valid variant for each of the six actions", () => {
    expect(schema.allows({ action: "inspect", path: "docs/a.docx" })).toBe(true);
    expect(schema.allows({ action: "edit", path: "docs/a.docx", ops: [{ op: "replace_text", paragraph: 0, expected: "x", replacement: "y" }] })).toBe(true);
    expect(schema.allows({ action: "create", kind: "xlsx", name: "report", data: { sheets: [{ name: "Data", headers: ["a"], rows: [[1]] }] } })).toBe(true);
    expect(schema.allows({ action: "convert", path: "docs/a.docx", to: "pdf" })).toBe(true);
    expect(schema.allows({ action: "pdf", pdf: { action: "merge", paths: ["a.pdf", "b.pdf"] } })).toBe(true);
    expect(schema.allows({ action: "preview", path: "docs/a.pdf", pages: [1, 2] })).toBe(true);
  });

  test("accepts every edit operation variant and pdf action variant", () => {
    expect(schema.allows({ action: "edit", path: "a.docx", ops: [{ op: "insert_paragraph", after: 0, text: "t", style: "Heading 1" }] })).toBe(true);
    expect(schema.allows({ action: "edit", path: "a.docx", ops: [{ op: "add_table_row", table: "Table1", cells: ["a", 1] }] })).toBe(true);
    expect(schema.allows({ action: "edit", path: "a.xlsx", ops: [{ op: "set_cells", sheet: "Data", range: "A1:B2", values: [[1, 2], ["=A1", null]] }] })).toBe(true);
    expect(schema.allows({ action: "edit", path: "a.pptx", ops: [{ op: "add_slide", after: 0, title: "t", bullets: ["b"], layout: "title_content" }] })).toBe(true);
    expect(schema.allows({ action: "edit", path: "a.pptx", ops: [{ op: "remove_slide", index: 1 }] })).toBe(true);
    expect(schema.allows({ action: "edit", path: "a.pptx", ops: [{ op: "duplicate_slide", index: 0, after: 1 }] })).toBe(true);
    expect(schema.allows({ action: "edit", path: "a.pptx", ops: [{ op: "set_shape", slide: 0, shape: 1, text: "t", image: "outputs/media/x.png" }] })).toBe(true);
    expect(schema.allows({ action: "pdf", pdf: { action: "split", paths: ["a.pdf"], ranges: [[1], [2, 3]] } })).toBe(true);
    expect(schema.allows({ action: "pdf", pdf: { action: "rotate", paths: ["a.pdf"], pages: [1], degrees: 90 } })).toBe(true);
    expect(schema.allows({ action: "pdf", pdf: { action: "watermark", paths: ["a.pdf"], text: "内部", opacity: 0.2 } })).toBe(true);
    expect(schema.allows({ action: "pdf", pdf: { action: "extract", paths: ["a.pdf"], pages: [1] } })).toBe(true);
  });

  test("rejects unknown actions, bad kinds, and malformed operations", () => {
    expect(schema.allows({ action: "destroy", path: "a.docx" })).toBe(false);
    expect(schema.allows({ action: "create", kind: "doc", name: "x" })).toBe(false);
    expect(schema.allows({ action: "convert", path: "a.docx", to: "mp4" })).toBe(false);
    expect(schema.allows({ action: "edit", path: "a.docx", ops: [{ op: "replace_text", paragraph: 0 }] })).toBe(false);
    expect(schema.allows({ action: "edit", path: "a.docx", ops: [{ op: "destroy_slide", index: 0 }] })).toBe(false);
    expect(schema.allows({ action: "pdf", pdf: { action: "merge" } })).toBe(false);
    expect(schema.allows({ action: "pdf", pdf: { action: "scramble", paths: ["a.pdf"] } })).toBe(false);
    expect(schema.allows({ action: "preview", path: "a.pdf", pages: "all" })).toBe(false);
    expect(schema.allows({})).toBe(false);
  });
});

describe("alpha_office path rules", () => {
  test("rejects directory escape on inputs and names", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      const escaped = await call(tool, { action: "inspect", path: "../outside.docx" });
      expect(escaped.isError).toBe(true);
      expect(escaped.text).toContain("目录逃逸");
      const named = await call(tool, { action: "create", kind: "xlsx", name: "../evil", data: { sheets: [{ name: "D", headers: ["a"], rows: [[1]] }] } });
      expect(named.isError).toBe(true);
      expect(named.text).toContain("名称");
      const ranged = await call(tool, { action: "pdf", pdf: { action: "merge", paths: ["../one.pdf", "../two.pdf"] } });
      expect(ranged.isError).toBe(true);
      expect(ranged.text).toContain("目录逃逸");
    });
  });

  test("create xlsx lands in outputs/, never overwrites, and keeps formulas and header style", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      const data = { sheets: [{ name: "Data", headers: ["item", "value"], rows: [["a", 1], ["b", 2], ["sum", "=SUM(B2:B3)"]] }] };
      const first = await call(tool, { action: "create", kind: "xlsx", name: "report", data });
      expect(first.isError).toBe(false);
      const firstPath = join(projectRoot, artifactsOf(first.value)[0].path as string);
      expect(artifactsOf(first.value)[0].path).toBe("outputs/report.xlsx");
      expect((await readFile(firstPath)).subarray(0, 2).toString()).toBe("PK");
      const second = await call(tool, { action: "create", kind: "xlsx", name: "report", data });
      expect(artifactsOf(second.value)[0].path).toBe("outputs/report-2.xlsx");
      expect((await readFile(firstPath)).subarray(0, 2).toString()).toBe("PK");
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(firstPath);
      const sheet = book.getWorksheet("Data")!;
      expect(sheet.getCell("A1").value).toBe("item");
      expect(sheet.getRow(1).font?.bold).toBe(true);
      expect((sheet.getCell("B4").value as { formula: string }).formula).toBe("SUM(B2:B3)");
    });
  });

  test("edit writes alpha-v<N> beside the original and never touches the original", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      const engine = await officeRuntimeStatus();
      if (!engine.available) {
        const gap = await call(tool, { action: "edit", path: "outputs/letter.docx", ops: [{ op: "replace_text", paragraph: 0, expected: "x", replacement: "y" }] });
        expect(gap.isError).toBe(true);
        expect(gap.text).toContain("LibreOffice");
        return;
      }
      const created = await call(tool, { action: "create", kind: "docx", name: "letter", content: "# 标题\n\nHello target world." });
      const createdPath = join(projectRoot, "outputs", "letter.docx");
      const original = await readFile(createdPath);
      expect(artifactsOf(created.value)[0].path).toBe("outputs/letter.docx");
      const inspected = await call(tool, { action: "inspect", path: "outputs/letter.docx" });
      const paragraphs = (inspected.value?.doc as { paragraphs: Array<{ index: number; text: string }> }).paragraphs;
      const index = paragraphs.find(item => item.text.includes("target"))!.index;
      const edited = await call(tool, { action: "edit", path: "outputs/letter.docx", ops: [{ op: "replace_text", paragraph: index, expected: "target", replacement: "updated" }] });
      expect(edited.isError).toBe(false);
      const artifact = artifactsOf(edited.value)[0];
      expect(artifact.path).toBe("outputs/letter.alpha-v1.docx");
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.preview).toBeDefined();
      expect(artifact.before).toBeDefined();
      expect(edited.images.map(item => item.mimeType)).toEqual(["image/png", "image/png"]);
      expect(Buffer.from(edited.images[1].data!, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");
      expect((await readFile(join(projectRoot, artifact.preview as string))).subarray(0, 4).toString("hex")).toBe("89504e47");
      expect((await readFile(join(projectRoot, artifact.before as string))).subarray(0, 4).toString("hex")).toBe("89504e47");
      expect(await readFile(createdPath)).toEqual(original);
      const secondEdit = await call(tool, { action: "edit", path: "outputs/letter.docx", ops: [{ op: "replace_text", paragraph: index, expected: "target", replacement: "again" }] });
      expect(artifactsOf(secondEdit.value)[0].path).toBe("outputs/letter.alpha-v2.docx");
    });
  }, 120_000);

  test("convert and pdf outputs land in outputs/ without overwriting sources", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      await makePdf(join(projectRoot, "a.pdf"));
      await makePdf(join(projectRoot, "b.pdf"));
      const beforeA = await readFile(join(projectRoot, "a.pdf"));
      const merged = await call(tool, { action: "pdf", pdf: { action: "merge", paths: ["a.pdf", "b.pdf"], name: "combined" } });
      expect(merged.isError).toBe(false);
      expect(artifactsOf(merged.value)[0].path).toBe("outputs/combined.pdf");
      expect(await readFile(join(projectRoot, "a.pdf"))).toEqual(beforeA);
      const engine = await officeRuntimeStatus();
      if (!engine.available) return;
      const created = await call(tool, { action: "create", kind: "docx", name: "memo", content: "# 备忘" });
      expect(created.isError).toBe(false);
      const converted = await call(tool, { action: "convert", path: "outputs/memo.docx", to: "pdf" });
      expect(converted.isError).toBe(false);
      expect(artifactsOf(converted.value)[0].path).toBe("outputs/memo.pdf");
      expect((await readFile(join(projectRoot, "outputs", "memo.pdf"))).subarray(0, 4).toString()).toBe("%PDF");
      expect(await stat(join(projectRoot, "outputs", "memo.docx"))).toBeDefined();
    });
  }, 120_000);
});

describe("alpha_office unified return shape", () => {
  test("returns {summary, artifacts[{path, kind, sha256, preview?}]} for pure-JS actions", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      await makePdf(join(projectRoot, "a.pdf"));
      const watermarked = await call(tool, { action: "pdf", pdf: { action: "watermark", paths: ["a.pdf"], name: "marked", text: "内部资料" } });
      expect(watermarked.isError).toBe(false);
      const value = watermarked.value!;
      expect(typeof value.summary).toBe("string");
      const [artifact] = artifactsOf(value);
      expect(artifact.path).toBe("outputs/marked.pdf");
      expect(artifact.kind).toBe("pdf");
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.preview).toBeDefined();
      expect((await readFile(join(projectRoot, artifact.preview as string))).subarray(0, 4).toString("hex")).toBe("89504e47");
      expect(String(value.summary)).toContain("水印");
      expect(watermarked.images.length).toBeGreaterThanOrEqual(1);
      expect(watermarked.images[0].mimeType).toBe("image/png");
      expect(Buffer.from(watermarked.images[0].data!, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");
    });
  });
});

describe("LibreOffice gap branch", () => {
  test("UNO-backed actions report the gap while create xlsx, pdf, and PDF preview still work", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      await makePdf(join(projectRoot, "a.pdf"));
      await makePdf(join(projectRoot, "b.pdf"));
      process.env.ALPHA_OFFICE_NO_LIBREOFFICE = "1";
      try {
        expect((await officeRuntimeStatus()).available).toBe(false);
        const book = await call(tool, { action: "create", kind: "xlsx", name: "solo", data: { sheets: [{ name: "D", headers: ["a"], rows: [[1]] }] } });
        expect(book.isError).toBe(false);
        expect((await readFile(join(projectRoot, "outputs", "solo.xlsx"))).subarray(0, 2).toString()).toBe("PK");
        for (const [label, params] of [
          ["inspect office", { action: "inspect", path: "outputs/solo.xlsx" }],
          ["edit", { action: "edit", path: "outputs/solo.xlsx", ops: [{ op: "set_cells", sheet: "D", range: "A1", values: [["x"]] }] }],
          ["create docx", { action: "create", kind: "docx", name: "report", content: "# t" }],
          ["create pdf", { action: "create", kind: "pdf", name: "report", content: "# t" }],
          ["create pptx", { action: "create", kind: "pptx", name: "deck", outline: [{ title: "t", bullets: ["b"] }] }],
          ["convert", { action: "convert", path: "outputs/solo.xlsx", to: "pdf" }],
          ["preview office", { action: "preview", path: "outputs/solo.xlsx" }],
        ] as Array<[string, Record<string, unknown>]>) {
          const outcome = await call(tool, params);
          expect(outcome.isError, label).toBe(true);
          expect(outcome.text, label).toContain("LibreOffice");
        }
        expect(LIBREOFFICE_GAP).toContain("alpha_office create xlsx");
        const merged = await call(tool, { action: "pdf", pdf: { action: "merge", paths: ["a.pdf", "b.pdf"] } });
        expect(merged.isError).toBe(false);
        expect((await readFile(join(projectRoot, artifactsOf(merged.value)[0].path as string))).subarray(0, 4).toString()).toBe("%PDF");
        const rendered = await call(tool, { action: "preview", path: "a.pdf", pages: [1] });
        expect(rendered.isError).toBe(false);
        expect((await readFile(join(projectRoot, artifactsOf(rendered.value)[0].path as string))).subarray(0, 4).toString("hex")).toBe("89504e47");
      } finally {
        delete process.env.ALPHA_OFFICE_NO_LIBREOFFICE;
      }
    });
  });
});

describe("pdf actions (no LibreOffice required)", () => {
  test("merge, split, rotate, extract, and watermark operate on real pages and reject out-of-range pages", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      await makePdf(join(projectRoot, "src.pdf"), [200, 210, 220]);
      const merged = await call(tool, { action: "pdf", pdf: { action: "merge", paths: ["src.pdf", "src.pdf"], name: "merged" } });
      expect((await PDFDocument.load(await readFile(join(projectRoot, "outputs", "merged.pdf")))).getPageCount()).toBe(6);
      const split = await call(tool, { action: "pdf", pdf: { action: "split", paths: ["src.pdf"], name: "split", ranges: [[1, 2], [3]] } });
      const splitPaths = artifactsOf(split.value).map(item => item.path as string);
      expect(splitPaths).toEqual(["outputs/split-part1.pdf", "outputs/split-part2.pdf"]);
      expect((await PDFDocument.load(await readFile(join(projectRoot, splitPaths[0])))).getPageCount()).toBe(2);
      expect((await PDFDocument.load(await readFile(join(projectRoot, splitPaths[1])))).getPageCount()).toBe(1);
      const extracted = await call(tool, { action: "pdf", pdf: { action: "extract", paths: ["src.pdf"], name: "page3", pages: [3] } });
      const picked = await PDFDocument.load(await readFile(join(projectRoot, "outputs", "page3.pdf")));
      expect(picked.getPageCount()).toBe(1);
      expect(picked.getPage(0).getWidth()).toBe(220);
      const rotated = await call(tool, { action: "pdf", pdf: { action: "rotate", paths: ["src.pdf"], name: "turned", pages: [1], degrees: 90 } });
      const turned = await PDFDocument.load(await readFile(join(projectRoot, "outputs", "turned.pdf")));
      expect(turned.getPage(0).getRotation().angle).toBe(90);
      expect(turned.getPage(1).getRotation().angle).toBe(0);
      const watermarked = await call(tool, { action: "pdf", pdf: { action: "watermark", paths: ["src.pdf"], name: "stamped", text: "DRAFT 2026" } });
      expect(watermarked.isError).toBe(false);
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const renderedDoc = await getDocument({ data: new Uint8Array(await readFile(join(projectRoot, "outputs", "stamped.pdf"))) }).promise;
      const page = await renderedDoc.getPage(1);
      const text = (await page.getTextContent()).items.map(item => ("str" in item ? item.str : "")).join("");
      await renderedDoc.destroy();
      expect(text).toContain("DRAFT 2026");
      const bad = await call(tool, { action: "pdf", pdf: { action: "extract", paths: ["src.pdf"], name: "bad", pages: [9] } });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("页码超出范围");
      const renamed = await call(tool, { action: "pdf", pdf: { action: "merge", paths: ["src.pdf", "src.pdf"], name: "merged" } });
      expect(artifactsOf(renamed.value)[0].path).toBe("outputs/merged-2.pdf");
    });
  }, 60_000);
});

describe("UNO-backed actions (LibreOffice when available)", () => {
  test("create docx/pptx, inspect addresses, and edit ops round-trip with expected-value checks", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      const engine = await officeRuntimeStatus();
      if (!engine.available) {
        for (const params of [
          { action: "create", kind: "docx", name: "report", content: "# t" },
          { action: "create", kind: "pptx", name: "deck", outline: [{ title: "t", bullets: ["b"] }] },
        ]) {
          const outcome = await call(tool, params);
          expect(outcome.isError).toBe(true);
          expect(outcome.text).toContain("LibreOffice");
        }
        return;
      }
      const docx = await call(tool, {
        action: "create",
        kind: "docx",
        name: "report",
        content: "# 标题\n\nHello target world.\n\n- 要点一\n- 要点二\n\n**粗体** 与 *斜体*。",
      });
      expect(docx.isError).toBe(false);
      const docxArtifact = artifactsOf(docx.value)[0];
      expect(docxArtifact.path).toBe("outputs/report.docx");
      expect(docxArtifact.preview).toBeDefined();
      const inspected = await call(tool, { action: "inspect", path: "outputs/report.docx" });
      const doc = inspected.value!.doc as { paragraphs: Array<{ index: number; style: string; text: string }>; tables: unknown[] };
      expect(inspected.value!.summary).toContain("段落");
      const target = doc.paragraphs.find(item => item.text.includes("target"))!;
      expect(target.style).toBeTruthy();
      const wrong = await call(tool, { action: "edit", path: "outputs/report.docx", ops: [{ op: "replace_text", paragraph: target.index, expected: "absent", replacement: "x" }] });
      expect(wrong.isError).toBe(true);
      expect(wrong.text).toContain("Expected text must occur exactly once");
      const edited = await call(tool, {
        action: "edit",
        path: "outputs/report.docx",
        ops: [
          { op: "replace_text", paragraph: target.index, expected: "target", replacement: "updated" },
          { op: "insert_paragraph", after: target.index, text: "插入的段落", style: "Heading 2" },
        ],
      });
      expect(edited.isError).toBe(false);
      expect((edited.value!.doc as { paragraphs: Array<{ text: string; style: string }> }).paragraphs)
        .toContainEqual(expect.objectContaining({ text: "插入的段落", style: "Heading 2" }));
      const deck = await call(tool, {
        action: "create",
        kind: "pptx",
        name: "deck",
        outline: [{ title: "第一页", bullets: ["要点 A", "要点 B"], layout: "title_content" }, { title: "第二页", bullets: ["收尾"] }],
      });
      expect(deck.isError).toBe(false);
      const deckInspected = await call(tool, { action: "inspect", path: "outputs/deck.pptx" });
      const slides = (deckInspected.value!.doc as { slides: Array<{ index: number; title: string; shapes: Array<{ index: number; type: string; text: string }> }> }).slides;
      expect(slides.map(slide => slide.title)).toEqual(["第一页", "第二页"]);
      expect(slides[0].shapes.some(shape => shape.text.includes("要点 A"))).toBe(true);
      expect((deckInspected.value!.unsupported ?? [])).toEqual([]);
      const grown = await call(tool, { action: "edit", path: "outputs/deck.pptx", ops: [{ op: "add_slide", after: 1, title: "第三页", bullets: ["新要点"], layout: "title_content" }] });
      expect((grown.value!.doc as { slides: unknown[] }).slides).toHaveLength(3);
      const copied = await call(tool, { action: "edit", path: "outputs/deck.alpha-v1.pptx", ops: [{ op: "duplicate_slide", index: 0, after: 2 }] });
      const copiedSlides = (copied.value!.doc as { slides: Array<{ title: string }> }).slides;
      expect(copiedSlides.map(slide => slide.title)).toEqual(["第一页", "第二页", "第三页", "第一页"]);
      const shaped = await call(tool, { action: "edit", path: "outputs/deck.alpha-v2.pptx", ops: [{ op: "set_shape", slide: 0, shape: 0, text: "改过的标题" }] });
      const shapedSlides = (shaped.value!.doc as { slides: Array<{ shapes: Array<{ text: string }> }> }).slides;
      expect(shapedSlides[0].shapes[0].text).toBe("改过的标题");
      const trimmed = await call(tool, { action: "edit", path: "outputs/deck.alpha-v3.pptx", ops: [{ op: "remove_slide", index: 3 }] });
      expect((trimmed.value!.doc as { slides: unknown[] }).slides).toHaveLength(3);
      expect(await stat(join(projectRoot, "outputs", "deck.pptx"))).toBeDefined();
    });
  }, 120_000);

  test("tracked-changes documents are reported as unsupported and refuse editing", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      const engine = await officeRuntimeStatus();
      const fixture = join(import.meta.dir, "fixtures", "office-tracked.docx");
      if (!engine.available) {
        const gap = await call(tool, { action: "inspect", path: fixture });
        expect(gap.isError).toBe(true);
        expect(gap.text).toContain("LibreOffice");
        return;
      }
      const inspected = await call(tool, { action: "inspect", path: fixture });
      expect(inspected.isError).toBe(false);
      expect(inspected.value!.unsupported).toContain("tracked changes");
      const refused = await call(tool, { action: "edit", path: fixture, ops: [{ op: "replace_text", paragraph: 0, expected: "Original", replacement: "Changed" }] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Editing paused for unsupported features");
    });
  }, 120_000);

  test("set_cells writes values and formulas and LibreOffice recalculates on save", async () => {
    await withProject(async projectRoot => {
      const stub = stubPi();
      registerOfficeTools(stub.pi, { sessionId: "suite", dataRoot: projectRoot, projectRoot });
      const tool = officeTool(stub);
      const engine = await officeRuntimeStatus();
      if (!engine.available) {
        const gap = await call(tool, { action: "edit", path: "outputs/totals.xlsx", ops: [{ op: "set_cells", sheet: "Data", range: "A1", values: [[1]] }] });
        expect(gap.isError).toBe(true);
        expect(gap.text).toContain("LibreOffice");
        return;
      }
      await call(tool, {
        action: "create",
        kind: "xlsx",
        name: "totals",
        data: { sheets: [{ name: "Data", headers: ["item", "value"], rows: [["a", 1], ["b", 2], ["sum", "=SUM(B2:B3)"]] }] },
      });
      const edited = await call(tool, { action: "edit", path: "outputs/totals.xlsx", ops: [{ op: "set_cells", sheet: "Data", range: "B3", values: [[10]] }] });
      expect(edited.isError).toBe(false);
      expect(artifactsOf(edited.value)[0].path).toBe("outputs/totals.alpha-v1.xlsx");
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(join(projectRoot, "outputs", "totals.alpha-v1.xlsx"));
      const cell = book.getWorksheet("Data")!.getCell("B4").value as { formula: string; result: number };
      expect(cell.formula).toContain("SUM");
      expect(cell.result).toBe(11);
    });
  }, 120_000);
});

describe("media tools (office-spec 媒体契约)", () => {
  const onePixelPng = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

  test("publishMedia writes outputs/media/<slug>.<ext>, never overwrites, and honors user paths", async () => {
    await withProject(async projectRoot => {
      const name = mediaName("一张蓝色叶子 Blue Leaf!", "generated");
      expect(name).toMatch(/blue-leaf/);
      const first = await publishMedia({ projectRoot, name: "一张蓝色叶子 Blue Leaf!", kind: "png", bytes: onePixelPng });
      expect(first.path).toBe(`outputs/media/${name}.png`);
      expect((await readFile(join(projectRoot, first.path))).subarray(0, 4).toString("hex")).toBe("89504e47");
      const second = await publishMedia({ projectRoot, name: "一张蓝色叶子 Blue Leaf!", kind: "png", bytes: onePixelPng });
      expect(second.path).toBe(`outputs/media/${name}-2.png`);
      const custom = await publishMedia({ projectRoot, outputPath: "outputs/media/custom-name.png", name: "x", kind: "png", bytes: onePixelPng });
      expect(custom.path).toBe("outputs/media/custom-name.png");
    });
  });

  test("media generation reports an explicit gap when ComfyUI is unavailable", async () => {
    await withProject(async projectRoot => {
      const plugin = createComfyPlugin({ projectRoot, dataRoot: join(projectRoot, "state"), url: "http://127.0.0.1:9" });
      const names = plugin.tools.map(tool => tool.name);
      expect(names.sort()).toEqual(["alpha_generate_image", "alpha_generate_video", "alpha_generate_voice"]);
      const image = plugin.tools.find(tool => tool.name === "alpha_generate_image")!;
      const ctx = { sessionManager: { appendCustomEntry() {} } } as never;
      const result = await image.execute("call-media", { prompt: "a blue leaf", aspect: "square" }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content.find(item => item.type === "text")?.text ?? "").toContain("ComfyUI is unavailable");
    });
  });
});
