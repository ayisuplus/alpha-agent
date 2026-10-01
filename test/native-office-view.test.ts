import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeOfficeView, getOfficeView, isOfficeViewOpen, openOfficeView, renderOfficeView, selectOfficeView } from "../src/native/capabilities/office/office-view";
import { officeRuntimeStatus } from "../src/native/capabilities/office/office-runtime";

test("native Writer view keeps tracked revisions, renders original document pixels and closes without saving", async () => {
  if (!(await officeRuntimeStatus()).available) return;
  const path = join(import.meta.dir, "fixtures", "office-tracked.docx");
  const hash = async () => createHash("sha256").update(await readFile(path)).digest("hex");
  const before = await hash();
  const view = await openOfficeView(path);
  try {
    expect(isOfficeViewOpen(view.id)).toBe(true);
    expect(view.readOnly).toBe(true);
    expect(view.kind).toBe("text");
    expect(view.width).toBeGreaterThan(0);
    expect(view.height).toBeGreaterThan(0);
    expect(view.revisions.some(item => item.author === "Alpha QA" && item.type === "Insert")).toBe(true);
    const tile = await renderOfficeView(view.id, { width: 800, height: 600 });
    const bytes = Buffer.from(tile.image, "base64");
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.readUInt32BE(16)).toBe(800);
    expect(bytes.readUInt32BE(20)).toBe(600);
    const blank = await renderOfficeView(view.id, { x: 9000, y: 12000, width: 200, height: 100 });
    const content = await renderOfficeView(view.id, { x: 2000, y: 1500, width: 200, height: 100 });
    expect(blank.image).not.toBe(content.image);
    const selection = await selectOfficeView(view.id, { x: 2500, y: 1840, count: 2 });
    expect(selection.selection.trim()).toBe("Original");
    expect((await getOfficeView(view.id)).part).toBe(0);
    await expect(renderOfficeView(view.id, { width: 5000 })).rejects.toThrow("像素");
  } finally {
    await closeOfficeView(view.id);
  }
  expect(await hash()).toBe(before);
  expect(isOfficeViewOpen(view.id)).toBe(false);
  await expect(getOfficeView(view.id)).rejects.toThrow("已关闭");
}, 60_000);

test("native Office open honors cancellation before launching a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(openOfficeView(join(import.meta.dir, "fixtures", "office-tracked.docx"), controller.signal)).rejects.toThrow("aborted");
});

test("unverified Windows Writer formats fail immediately with an explicit original-app choice", async () => {
  if (process.platform !== "win32") return;
  for (const extension of ["odt", "rtf"]) {
    const started = Date.now();
    let message = "";
    try { await openOfficeView(`unverified.${extension}`); } catch (error) { message = String(error); }
    expect(message).toContain("尚未通过验证");
    expect(message).toContain("原应用");
    expect(Date.now() - started).toBeLessThan(1000);
  }
});

test("native Calc view exposes original sheets, formula and comment and renders outside the print area", async () => {
  if (!(await officeRuntimeStatus()).available) return;
  const path = join(import.meta.dir, "..", "docs", "audits", "2026-10-01-office-native", "fixtures", "native-structure.xlsx");
  const before = createHash("sha256").update(await readFile(path)).digest("hex");
  const view = await openOfficeView(path);
  try {
    expect(view.kind).toBe("spreadsheet");
    expect(view.readOnly).toBe(true);
    expect(view.parts.map(part => [part.name, part.hidden])).toEqual([["Visible", false], ["Hidden", true], ["Second", false]]);
    const cell = await selectOfficeView(view.id, { x: 4000, y: 400 });
    expect(cell.formula).toBe("=A2*3");
    expect(cell.cellAddress).toBe("B2");
    expect(view.comments.some(comment => comment.text === "FORMULA_REVIEW_COMMENT" && comment.cellAddress === "B2")).toBe(true);
    const content = await renderOfficeView(view.id, { x: 0, y: 5800, width: 700, height: 150 });
    const empty = await renderOfficeView(view.id, { x: 0, y: 6800, width: 700, height: 150 });
    expect(content.image).not.toBe(empty.image);
    expect((await selectOfficeView(view.id, { x: 100, y: 5900 })).selection).toBe("OUTSIDE_PRINT_AREA");
    const zoomed = await renderOfficeView(view.id, { x: 3770, y: 340, width: 300, height: 100, scale: 2 });
    expect(Buffer.from(zoomed.image, "base64").readUInt32BE(16)).toBe(300);
    expect(Buffer.from(zoomed.image, "base64").readUInt32BE(20)).toBe(100);
    expect((await selectOfficeView(view.id, { x: 4000, y: 400 })).cellAddress).toBe("B2");
    const first = await renderOfficeView(view.id, { width: 700, height: 150 });
    const second = await renderOfficeView(view.id, { part: 2, width: 700, height: 150 });
    expect(second.part).toBe(2);
    expect(second.image).not.toBe(first.image);
    expect((await getOfficeView(view.id)).part).toBe(2);
    const hiddenStart = Date.now();
    let hiddenError = "";
    try { await renderOfficeView(view.id, { part: 1 }); } catch (error) { hiddenError = String(error); }
    expect(hiddenError).toContain("隐藏");
    expect(Date.now() - hiddenStart).toBeLessThan(5000);
    expect((await getOfficeView(view.id)).part).toBe(2);
  } finally {
    await closeOfficeView(view.id);
  }
  expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(before);
}, 60_000);

test("native Writer view reads original comment body and author", async () => {
  if (!(await officeRuntimeStatus()).available) return;
  const path = join(import.meta.dir, "..", "docs", "audits", "2026-10-01-office-native", "fixtures", "native-comments.docx");
  const view = await openOfficeView(path);
  try {
    expect(view.comments.some(comment => comment.author === "Alpha QA" && String(comment.text).includes("WORD_NATIVE_COMMENT 中文批注正文"))).toBe(true);
  } finally {
    await closeOfficeView(view.id);
  }
}, 60_000);

test("canceling a native Office load exits its worker and removes its private document copy", async () => {
  if (!(await officeRuntimeStatus()).available) return;
  const directory = await mkdtemp(join(tmpdir(), "alpha-office-cancel-test-"));
  const filename = `cancel-${randomUUID()}.docx`;
  const path = join(directory, filename);
  const source = join(import.meta.dir, "fixtures", "office-tracked.docx");
  await copyFile(source, path);
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(new Error("native preview canceled during load")), 250);
  try {
    let message = "";
    try { await openOfficeView(path, controller.signal); } catch (error) { message = String(error); }
    expect(message).toContain("native preview canceled during load");
    expect(Date.now() - started).toBeLessThan(8000);
    const possible = (await readdir(tmpdir())).filter(name => name.startsWith("alpha-office-view-"));
    const retained = await Promise.all(possible.map(name => stat(join(tmpdir(), name, filename)).then(() => true).catch(() => false)));
    expect(retained.some(Boolean)).toBe(false);
  } finally {
    clearTimeout(timer);
    if (!directory.startsWith(join(tmpdir(), "alpha-office-cancel-test-"))) throw new Error("unexpected test directory");
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("native Impress view renders each original slide and returns its native text and complete notes", async () => {
  if (!(await officeRuntimeStatus()).available) return;
  const path = join(import.meta.dir, "..", "docs", "audits", "2026-10-01-office-native", "fixtures", "native-notes-deck.pptx");
  const before = createHash("sha256").update(await readFile(path)).digest("hex");
  const view = await openOfficeView(path);
  try {
    expect(view.kind).toBe("presentation");
    expect(view.parts).toHaveLength(2);
    expect(view.notes).toEqual([{ part: 0, text: "Native speaker note 1\n中文第二段笔记" }, { part: 1, text: "Native speaker note 2\n中文第二段笔记" }]);
    const first = await renderOfficeView(view.id, { width: 800, height: 600 });
    const second = await renderOfficeView(view.id, { part: 1, width: 800, height: 600 });
    expect(second.part).toBe(1);
    expect(second.image).not.toBe(first.image);
    expect(Buffer.from(second.image, "base64").readUInt32BE(16)).toBe(800);
    const selection = await selectOfficeView(view.id, { part: 0, x: 4000, y: 2400 });
    expect(selection.selection).toContain("Opening target");
  } finally {
    await closeOfficeView(view.id);
  }
  expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(before);
}, 60_000);
