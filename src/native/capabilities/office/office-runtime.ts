// alpha_office engine (plan 6.3): path in, path out, never overwrites originals.
// LibreOffice UNO covers inspect/edit/create-pptx; soffice CLI covers create docx/pdf and convert;
// exceljs covers create xlsx; pdf-lib covers pdf actions; pdfjs-dist + @napi-rs/canvas render previews.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import ExcelJS from "exceljs";
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont } from "pdf-lib";
// Node has no DOM canvas globals; pdfjs directs Node hosts to the legacy build.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

export type ArtifactKind = "docx" | "xlsx" | "pptx" | "pdf" | "png" | "html" | "md";
export interface OfficeArtifact {
  path: string;
  kind: ArtifactKind;
  sha256: string;
  preview?: string;
  before?: string;
}
export interface OfficeResult {
  summary: string;
  artifacts: OfficeArtifact[];
  unsupported?: string[];
  doc?: unknown;
}
export interface OfficeContext {
  projectRoot: string;
}
export type CreateKind = "docx" | "xlsx" | "pptx" | "pdf";
export type ConvertFormat = "docx" | "xlsx" | "pptx" | "pdf" | "html" | "odt" | "ods" | "odp";
export type SlideLayout = "title" | "title_content" | "blank";
export interface SheetSpec {
  name?: string;
  headers: string[];
  rows: unknown[][];
  widths?: number[];
}
export interface SlideSpec {
  title: string;
  bullets: string[];
  layout?: SlideLayout;
}
export type PdfParams =
  | { action: "merge"; paths: string[]; name?: string }
  | { action: "split"; paths: string[]; name?: string; ranges?: number[][] }
  | { action: "rotate"; paths: string[]; name?: string; pages?: number[]; degrees?: number }
  | { action: "watermark"; paths: string[]; name?: string; text: string; fontSize?: number; opacity?: number; degrees?: number }
  | { action: "extract"; paths: string[]; name?: string; pages: number[] };

/** Failures are returned to the model verbatim; gap messages name the missing engine. */
export class OfficeError extends Error {}
export const LIBREOFFICE_GAP = "本机缺少 LibreOffice，无法执行该动作；可用 alpha_office create xlsx 或 alpha_office pdf 处理 PDF";

const CONVERTIBLE_INPUTS: Record<string, true> = {
  docx: true, xlsx: true, pptx: true, pdf: true, odt: true, ods: true, odp: true, html: true, htm: true, csv: true, txt: true, rtf: true,
};

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(item => item.isFile()).catch(() => false);
}

function displayPath(projectRoot: string, abs: string): string {
  const rel = relative(projectRoot, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll(sep, "/") : abs;
}

async function resolveInput(projectRoot: string, path: unknown, label: string): Promise<string> {
  if (typeof path !== "string" || !path.trim()) throw new OfficeError(`缺少${label}路径`);
  const absolute = isAbsolute(path);
  const abs = absolute ? resolve(path) : resolve(projectRoot, path);
  if (!absolute && !inside(projectRoot, abs)) throw new OfficeError(`路径越出项目根目录（拒绝目录逃逸）：${path}`);
  const real = await realpath(abs).catch(() => { throw new OfficeError(`找不到${label}文件：${path}`); });
  if (!absolute && !inside(projectRoot, real)) throw new OfficeError(`路径越出项目根目录（拒绝目录逃逸）：${path}`);
  if (!(await exists(real))) throw new OfficeError(`找不到${label}文件：${path}`);
  return real;
}

function requireExt(path: string, allowed: Record<string, true>, label: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  if (!allowed[ext]) throw new OfficeError(`不支持的${label}格式：${ext || "（无扩展名）"}`);
  return ext;
}

function safeName(name: unknown, label: string): string {
  if (typeof name !== "string" || !name.trim()) throw new OfficeError(`缺少${label}名称`);
  const trimmed = name.trim();
  if (trimmed !== basename(trimmed) || trimmed.includes("..") || /[\\/:*?"<>|]/.test(trimmed)) {
    throw new OfficeError(`${label}名称不能包含路径分隔符或目录跳转`);
  }
  return trimmed;
}

/** edit outputs sit beside the original: <dir>/<base>.alpha-v<N><ext>, N grows, never overwrites. */
async function editTarget(original: string): Promise<string> {
  const dir = dirname(original);
  const ext = extname(original);
  // Editing an already-versioned file continues the same version chain.
  const base = basename(original, ext).replace(/\.alpha-v\d+$/, "");
  let highest = 0;
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.alpha-v(\\d+)${ext.replace(".", "\\.")}$`);
  for (const entry of await readdir(dir)) {
    const match = entry.match(pattern);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  for (let n = highest + 1; ; n++) {
    const candidate = join(dir, `${base}.alpha-v${n}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

/** create/convert/pdf outputs land in outputs/; collisions take -2, -3, ... */
async function uniqueOutput(outputsDir: string, base: string, ext: string): Promise<string> {
  await mkdir(outputsDir, { recursive: true });
  // A name that already carries the target extension (e.g. "fruits.xlsx") does not get it twice.
  const stem = base.toLowerCase().endsWith(`.${ext}`) ? base.slice(0, -(ext.length + 1)) : base;
  for (let n = 1; ; n++) {
    const candidate = join(outputsDir, n === 1 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `ao-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }).catch(() => undefined);
  }
}

async function makeArtifact(ctx: OfficeContext, abs: string, kind: ArtifactKind, extra?: Partial<OfficeArtifact>): Promise<OfficeArtifact> {
  return { path: displayPath(ctx.projectRoot, abs), kind, sha256: createHash("sha256").update(await readFile(abs)).digest("hex"), ...extra };
}

// ---------------------------------------------------------------------------
// LibreOffice detection and process management
// ---------------------------------------------------------------------------

export interface OfficeEngineStatus {
  available: boolean;
  version?: string;
  location?: "bundled" | "system";
  reason?: string;
}

function appRoot(): string {
  return resolve(import.meta.dir, "..", "..", "..", "..");
}

function engineRoots(): Array<["bundled" | "system", string]> {
  const root = appRoot();
  return [["bundled", join(root, "runtime", "libreoffice")], ["system", join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice")]];
}

async function probeInstall(root: string): Promise<{ version?: string } | undefined> {
  const python = join(root, "program", "python.exe");
  const office = join(root, "program", "soffice.exe");
  if (!(await exists(python)) || !(await exists(office))) return undefined;
  const version = (await readFile(join(root, "program", "version.ini"), "utf8").catch(() => "")).match(/^buildid=(.+)$/m)?.[1]?.trim();
  return { version };
}

export async function officeRuntimeStatus(): Promise<OfficeEngineStatus> {
  if (process.env.ALPHA_OFFICE_NO_LIBREOFFICE) {
    return { available: false, reason: "LibreOffice runtime is disabled for this run (ALPHA_OFFICE_NO_LIBREOFFICE)" };
  }
  const packaged = await exists(join(appRoot(), "release.json"));
  for (const [location, root] of engineRoots()) {
    if (packaged && location === "system") continue;
    const probed = await probeInstall(root);
    if (probed) return { available: true, version: probed.version, location };
  }
  return { available: false, reason: "LibreOffice runtime is missing" };
}

async function officeInstall(): Promise<{ root: string; python: string; office: string }> {
  const status = await officeRuntimeStatus();
  if (!status.available) throw new OfficeError(LIBREOFFICE_GAP);
  const packaged = await exists(join(appRoot(), "release.json"));
  for (const [location, root] of engineRoots()) {
    if (packaged && location === "system") continue;
    if (!(await probeInstall(root))) continue;
    return { root, python: join(root, "program", "python.exe"), office: join(root, "program", "soffice.exe") };
  }
  throw new OfficeError(LIBREOFFICE_GAP);
}

interface UnoOutcome {
  doc?: unknown;
  before?: unknown;
  unsupported?: string[];
  slides?: number;
}

/** One UNO job: headless soffice server on a private pipe plus the bundled Python worker. */
async function runUnoJob(job: Record<string, unknown>, signal?: AbortSignal): Promise<UnoOutcome> {
  signal?.throwIfAborted();
  const install = await officeInstall();
  return withTempDir(async profile => {
    const connection = `alpha_${Math.random().toString(36).slice(2, 12)}`;
    const server = Bun.spawn(
      [install.office, `-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--norestore", `--accept=pipe,name=${connection};urp;StarOffice.ServiceManager`],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true },
    );
    await Bun.sleep(800);
    if (server.exitCode !== null) throw new OfficeError(`${LIBREOFFICE_GAP}（LibreOffice 启动失败：${(await new Response(server.stderr).text()).trim()}）`);
    const script = join(import.meta.dir, "office-worker.py");
    const proc = Bun.spawn([install.python, "-B", "-u", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    proc.stdin.write(JSON.stringify({ ...job, connection }));
    proc.stdin.end();
    const stop = () => {
      for (const child of [proc, server]) {
        if (process.platform === "win32") Bun.spawn(["taskkill", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
        else child.kill();
      }
    };
    const timer = setTimeout(stop, 120_000);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      signal?.throwIfAborted();
      const result = JSON.parse(stdout.trim() || "{}") as { ok?: boolean; result?: UnoOutcome; error?: string };
      if (exit !== 0 || !result.ok || !result.result) {
        throw new OfficeError(result.error || stderr.trim() || "LibreOffice 任务失败");
      }
      return result.result;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof OfficeError) throw error;
      throw new OfficeError(`LibreOffice 任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (server.exitCode === null) {
        if (process.platform === "win32") {
          const killer = Bun.spawn(["taskkill", "/T", "/F", "/PID", String(server.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
          await killer.exited;
        } else server.kill();
        await server.exited;
      }
    }
  });
}

/** soffice --convert-to <to>; returns the produced file inside the caller's temp dir. */
async function sofficeConvert(input: string, to: ConvertFormat | "pdf", outDir: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const install = await officeInstall();
  return withTempDir(async profile => {
    await mkdir(outDir, { recursive: true });
    const server = Bun.spawn(
      [install.office, `-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--norestore",
        // HTML auto-detects as Writer/Web, which lacks the docx export filter; load it as a Writer document.
        ...(/\.html?$/i.test(input) ? ["--infilter=HTML (StarWriter)"] : []),
        "--convert-to", to, "--outdir", outDir, input],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    const stop = () => {
      if (process.platform === "win32") Bun.spawn(["taskkill", "/T", "/F", "/PID", String(server.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
      else server.kill();
    };
    const timer = setTimeout(stop, 120_000);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text(), server.exited]);
      signal?.throwIfAborted();
      const produced = join(outDir, `${basename(input, extname(input))}.${to}`);
      if (exit !== 0 || !(await exists(produced))) {
        throw new OfficeError(`LibreOffice 转换失败：${(stderr || stdout).trim() || `未生成 ${to}`}`);
      }
      return produced;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  });
}

// ---------------------------------------------------------------------------
// PDF page rendering (pdfjs-dist + the canvas backend pdfjs itself depends on)
// ---------------------------------------------------------------------------

async function standardFontUrl(): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const dir = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
    return (await exists(join(dir, "FoxitFixed.pfb"))) ? `${pathToFileURL(dir).href}/` : undefined;
  } catch {
    return undefined;
  }
}

async function renderPdfPages(pdfPath: string, outDir: string, baseName: string, pages: number[] | undefined, signal?: AbortSignal): Promise<Array<{ page: number; abs: string }>> {
  const bytes = new Uint8Array(await readFile(pdfPath));
  const standardFontDataUrl = await standardFontUrl();
  const doc = await getDocument({ data: bytes, ...(standardFontDataUrl ? { standardFontDataUrl } : {}) }).promise;
  try {
    const wanted = pages ?? Array.from({ length: doc.numPages }, (_, index) => index + 1);
    for (const page of wanted) {
      if (!Number.isInteger(page) || page < 1 || page > doc.numPages) {
        throw new OfficeError(`页码超出范围（共 ${doc.numPages} 页）：${page}`);
      }
    }
    await mkdir(outDir, { recursive: true });
    const rendered: Array<{ page: number; abs: string }> = [];
    for (const pageNumber of wanted) {
      signal?.throwIfAborted();
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      // Non-DOM canvas backend: pdfjs documents `canvas: null` for raw-context rendering.
      await page.render({ canvas: null, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      const abs = join(outDir, `${baseName}-p${pageNumber}.png`);
      await writeFile(abs, canvas.toBuffer("image/png"));
      rendered.push({ page: pageNumber, abs });
    }
    return rendered;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

async function previewArtifact(ctx: OfficeContext, pdfPath: string, stem: string, page = 1, before = false): Promise<Partial<OfficeArtifact>> {
  const outDir = join(ctx.projectRoot, "outputs", "previews");
  const [rendered] = await renderPdfPages(pdfPath, outDir, `${stem}${before ? "-before" : ""}`, [page]);
  const png = await makeArtifact(ctx, rendered.abs, "png");
  return before ? { before: png.path } : { preview: png.path };
}

// ---------------------------------------------------------------------------
// Markdown -> HTML (create docx/pdf via LibreOffice import)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inlineHtml(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const body: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean } | undefined;
  const flushParagraph = () => {
    if (paragraph.length) {
      body.push(`<p>${paragraph.map(inlineHtml).join("<br/>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      body.push(list.ordered ? "</ol>" : "</ul>");
      list = undefined;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      body.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      body.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      body.push("<hr/>");
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      body.push(`<blockquote><p>${inlineHtml(quote[1])}</p></blockquote>`);
      continue;
    }
    if (line.trimStart().startsWith("|") && lines[index + 1]?.trimStart().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
      flushParagraph();
      flushList();
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map(cell => inlineHtml(cell.trim()));
      const head = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trimStart().startsWith("|")) rows.push(cells(lines[index++]));
      index--;
      body.push(`<table><thead><tr>${head.map(cell => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      if (!list) {
        list = { ordered };
        body.push(ordered ? "<ol>" : "<ul>");
      }
      body.push(`<li>${inlineHtml((bullet ?? numbered)![1])}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"/>',
    "<style>",
    'body { font-family: "Microsoft YaHei", "SimSun", "Segoe UI", sans-serif; font-size: 12pt; line-height: 1.6; }',
    "table { border-collapse: collapse; } th, td { border: 1px solid #999999; padding: 4px 8px; } th { background: #f2f2f2; }",
    'pre, code { font-family: Consolas, "Courier New", monospace; background: #f5f5f5; } pre { padding: 8px; }',
    "blockquote { color: #555555; border-left: 3px solid #cccccc; margin-left: 0; padding-left: 12px; }",
    "</style></head><body>",
    ...body,
    "</body></html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// create xlsx (exceljs: styled headers, column widths, formulas)
// ---------------------------------------------------------------------------

function normalizeSheets(data: unknown): SheetSpec[] {
  const raw = data as { sheets?: unknown } & Record<string, unknown>;
  const specs: unknown[] = Array.isArray(raw?.sheets) ? raw.sheets : [raw];
  if (!specs.length) throw new OfficeError("create xlsx 需要 data.sheets");
  return specs.map((item, index) => {
    const sheet = item as SheetSpec;
    if (!sheet || !Array.isArray(sheet.headers) || !sheet.headers.length || !Array.isArray(sheet.rows)) {
      throw new OfficeError(`data.sheets[${index}] 需要 headers 与 rows`);
    }
    if (sheet.widths && (!Array.isArray(sheet.widths) || sheet.widths.some(width => typeof width !== "number"))) {
      throw new OfficeError(`data.sheets[${index}].widths 必须是数字数组`);
    }
    for (const [rowIndex, row] of sheet.rows.entries()) {
      if (!Array.isArray(row)) throw new OfficeError(`data.sheets[${index}].rows[${rowIndex}] 必须是数组`);
      if (row.length > sheet.headers.length) throw new OfficeError(`data.sheets[${index}].rows[${rowIndex}] 列数超过表头`);
    }
    return sheet;
  });
}

async function createXlsxFile(output: string, data: unknown): Promise<void> {
  const sheets = normalizeSheets(data);
  const book = new ExcelJS.Workbook();
  for (const [index, spec] of sheets.entries()) {
    const sheet = book.addWorksheet(spec.name?.trim() || `Sheet${index + 1}`);
    sheet.columns = spec.headers.map((header, column) => ({
      header: String(header),
      key: `c${column}`,
      width: spec.widths?.[column] ?? Math.min(40, Math.max(10, String(header).length + 6)),
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    for (const row of spec.rows) {
      const values = spec.headers.map((_, column) => {
        const value = row[column];
        if (value === undefined || value === null) return null;
        if (typeof value === "string" && value.startsWith("=")) return { formula: value.slice(1) };
        return value;
      });
      sheet.addRow(values as ExcelJS.CellValue[]);
    }
  }
  await writeFile(output, new Uint8Array(await book.xlsx.writeBuffer()), { flag: "wx" });
}

// ---------------------------------------------------------------------------
// watermark fonts (Chinese via system fonts; degrade with a note for Latin text)
// ---------------------------------------------------------------------------

const CJK_FONT_CANDIDATES = process.platform === "win32"
  ? [join(process.env.windir ?? "C:\\Windows", "Fonts", "simhei.ttf"), join(process.env.windir ?? "C:\\Windows", "Fonts", "msyh.ttc"), join(process.env.windir ?? "C:\\Windows", "Fonts", "simsun.ttc")]
  : ["/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"];

async function embedWatermarkFont(pdf: PDFDocument, text: string): Promise<{ font: PDFFont; note: string }> {
  const latinOnly = [...text].every(char => char.codePointAt(0)! < 256);
  if (latinOnly) {
    return { font: await pdf.embedFont(StandardFonts.Helvetica), note: "水印使用内置 Helvetica 字体（文本为拉丁字符）" };
  }
  for (const candidate of CJK_FONT_CANDIDATES) {
    const bytes = await readFile(candidate).catch(() => undefined);
    if (!bytes) continue;
    try {
      pdf.registerFontkit(fontkit);
      return { font: await pdf.embedFont(bytes, { subset: true }), note: `水印使用系统字体 ${basename(candidate)}` };
    } catch {
      continue;
    }
  }
  throw new OfficeError("水印文本包含非拉丁字符，但本机缺少中文字体（如 simhei）；请改用拉丁字符水印或先安装中文字体");
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

const OFFICE_FORMATS: Record<string, true> = { docx: true, xlsx: true, pptx: true };
const OFFICE_AND_PDF: Record<string, true> = { ...OFFICE_FORMATS, pdf: true };
const PREVIEWABLE: Record<string, true> = { ...OFFICE_AND_PDF, odt: true, ods: true, odp: true };

/** UNO-backed actions report the missing-engine gap before any input detail. */
async function requireLibreOffice(): Promise<void> {
  if (!(await officeRuntimeStatus()).available) throw new OfficeError(LIBREOFFICE_GAP);
}

export async function officeInspect(ctx: OfficeContext, path: string, signal?: AbortSignal): Promise<OfficeResult> {
  const input = await resolveInput(ctx.projectRoot, path, "文档");
  const ext = requireExt(input, OFFICE_AND_PDF, "文档");
  const name = basename(input);
  if (ext === "pdf") {
    return { summary: `已检查 ${name}：PDF 无 UNO 可编辑地址`, artifacts: [], doc: {}, unsupported: ["PDF 不支持 inspect；用 read 读取内容，用 pdf 动作处理页面"] };
  }
  const job = await runUnoJob({ job: "inspect", format: ext, input }, signal);
  const doc = job.doc as Record<string, unknown>;
  const counts = ext === "docx"
    ? `${(doc.paragraphs as unknown[])?.length ?? 0} 个段落、${(doc.tables as unknown[])?.length ?? 0} 张表格`
    : ext === "xlsx"
      ? `${(doc.sheets as unknown[])?.length ?? 0} 张工作表`
      : `${(doc.slides as unknown[])?.length ?? 0} 页幻灯片`;
  return {
    summary: `已检查 ${name}：${counts}`,
    artifacts: [],
    doc,
    unsupported: job.unsupported ?? [],
  };
}

export async function officeEdit(ctx: OfficeContext, path: string, ops: unknown[], signal?: AbortSignal): Promise<OfficeResult> {
  await requireLibreOffice();
  const input = await resolveInput(ctx.projectRoot, path, "文档");
  const ext = requireExt(input, OFFICE_FORMATS, "文档");
  if (!Array.isArray(ops) || !ops.length) throw new OfficeError("edit 需要 ops（1-100 项编辑）");
  const target = await editTarget(input);
  const stem = basename(target, extname(target));
  const outcome = await withTempDir(async dir => {
    const staged = join(dir, `input.${ext}`);
    await copyFile(input, staged);
    const draft = join(dir, `draft.${ext}`);
    const beforePdf = join(dir, "before.pdf");
    const afterPdf = join(dir, "after.pdf");
    const result = await runUnoJob({ job: "edit", format: ext, input: staged, output: draft, beforePreview: beforePdf, preview: afterPdf, ops }, signal);
    await copyFile(draft, target, constants.COPYFILE_EXCL);
    const [before, after] = await Promise.all([
      previewArtifact(ctx, beforePdf, stem, 1, true),
      previewArtifact(ctx, afterPdf, stem, 1, false),
    ]);
    return { result, extras: { ...before, ...after } };
  });
  const artifact = await makeArtifact(ctx, target, ext as ArtifactKind, outcome.extras);
  return {
    summary: `已在副本上应用 ${ops.length} 项编辑：${artifact.path}（原件未改动）`,
    artifacts: [artifact],
    unsupported: outcome.result.unsupported ?? [],
    doc: outcome.result.doc,
  };
}

export interface CreateParams {
  kind: CreateKind;
  name: string;
  content?: string;
  data?: unknown;
  outline?: SlideSpec[];
  layout?: SlideLayout;
}

export async function officeCreate(ctx: OfficeContext, params: CreateParams, signal?: AbortSignal): Promise<OfficeResult> {
  const outputsDir = join(ctx.projectRoot, "outputs");
  const name = safeName(params.name, "产物");
  const kind = params.kind;
  if (kind === "xlsx") {
    const output = await uniqueOutput(outputsDir, name, "xlsx");
    await createXlsxFile(output, params.data);
    const artifact = await makeArtifact(ctx, output, "xlsx");
    return { summary: `已创建 xlsx：${artifact.path}`, artifacts: [artifact] };
  }
  await requireLibreOffice();
  if (kind === "pptx") {
    const outline = params.outline;
    if (!Array.isArray(outline) || !outline.length) throw new OfficeError("create pptx 需要 outline（1-100 页）");
    const output = await uniqueOutput(outputsDir, name, "pptx");
    await runUnoJob({
      job: "create_pptx",
      output,
      slides: outline.map(slide => ({ ...slide, layout: slide.layout ?? params.layout })),
    }, signal);
    const extras = await withTempDir(async dir => {
      const pdf = await sofficeConvert(output, "pdf", dir, signal);
      return previewArtifact(ctx, pdf, name);
    }).catch(() => ({}));
    const artifact = await makeArtifact(ctx, output, "pptx", extras);
    return { summary: `已创建 pptx：${artifact.path}`, artifacts: [artifact] };
  }
  if (typeof params.content !== "string" || !params.content.trim()) throw new OfficeError(`create ${kind} 需要 content（Markdown）`);
  const output = await uniqueOutput(outputsDir, name, kind);
  const extras = await withTempDir(async dir => {
    const html = join(dir, `${name}.html`);
    await writeFile(html, markdownToHtml(params.content!), "utf8");
    const converted = await sofficeConvert(html, kind === "docx" ? "docx" : "pdf", dir, signal);
    await copyFile(converted, output, constants.COPYFILE_EXCL);
    if (kind === "pdf") return previewArtifact(ctx, output, name);
    return withTempDir(async pdfDir => {
      const pdf = await sofficeConvert(output, "pdf", pdfDir, signal);
      return previewArtifact(ctx, pdf, name);
    });
  });
  const artifact = await makeArtifact(ctx, output, kind, extras);
  return { summary: `已创建 ${kind}：${artifact.path}`, artifacts: [artifact] };
}

export async function officeConvert(ctx: OfficeContext, path: string, to: ConvertFormat, name?: string, signal?: AbortSignal): Promise<OfficeResult> {
  await requireLibreOffice();
  const input = await resolveInput(ctx.projectRoot, path, "文档");
  const from = requireExt(input, CONVERTIBLE_INPUTS, "文档");
  if (from === to || (from === "htm" && to === "html")) throw new OfficeError("转换格式与源格式相同");
  const stem = name === undefined ? basename(input, extname(input)) : safeName(name, "产物");
  const outputsDir = join(ctx.projectRoot, "outputs");
  const output = await uniqueOutput(outputsDir, stem, to);
  const extras = await withTempDir(async dir => {
    const converted = await sofficeConvert(input, to, dir, signal);
    await copyFile(converted, output, constants.COPYFILE_EXCL);
    if (to === "html") {
      const companion = join(dir, `${basename(input, extname(input))}_files`);
      if (await stat(companion).then(item => item.isDirectory()).catch(() => false)) {
        await cp(companion, join(outputsDir, `${basename(output, ".html")}_files`), { recursive: true });
      }
    }
    if (to === "pdf") return previewArtifact(ctx, output, basename(output, ".pdf"));
    return withTempDir(async pdfDir => {
      const pdf = await sofficeConvert(output, "pdf", pdfDir, signal);
      return previewArtifact(ctx, pdf, basename(output, extname(output)));
    });
  });
  const kindByFormat: Record<string, ArtifactKind> = { odt: "docx", ods: "xlsx", odp: "pptx" };
  const artifact = await makeArtifact(ctx, output, kindByFormat[to] ?? (to as ArtifactKind), extras);
  return { summary: `已转换为 ${to}：${artifact.path}`, artifacts: [artifact] };
}

export async function officePdf(ctx: OfficeContext, params: PdfParams, signal?: AbortSignal): Promise<OfficeResult> {
  signal?.throwIfAborted();
  const inputs = await Promise.all((params.paths ?? []).map(p => resolveInput(ctx.projectRoot, p, "PDF")));
  if (!inputs.length) throw new OfficeError("pdf 动作需要 paths");
  for (const input of inputs) requireExt(input, { pdf: true }, "PDF");
  const outputsDir = join(ctx.projectRoot, "outputs");
  const first = inputs[0];
  const defaultName = `${basename(first, ".pdf")}-${params.action}`;
  const name = params.name === undefined ? defaultName : safeName(params.name, "产物");
  const artifacts: OfficeArtifact[] = [];
  const notes: string[] = [];

  if (params.action === "merge") {
    if (inputs.length < 2) throw new OfficeError("merge 需要至少两个 PDF");
    const merged = await PDFDocument.create();
    for (const input of inputs) {
      const source = await PDFDocument.load(await readFile(input));
      for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
    }
    const output = await uniqueOutput(outputsDir, name, "pdf");
    await writeFile(output, await merged.save(), { flag: "wx" });
    artifacts.push(await makeArtifact(ctx, output, "pdf"));
  } else if (params.action === "split") {
    if (inputs.length !== 1) throw new OfficeError("split 需要一个 PDF");
    const source = await PDFDocument.load(await readFile(first));
    const total = source.getPageCount();
    const ranges = params.ranges?.length
      ? params.ranges
      : Array.from({ length: total }, (_, index) => [index + 1]);
    for (const [part, range] of ranges.entries()) {
      if (!Array.isArray(range) || !range.length) throw new OfficeError(`split 第 ${part + 1} 组页码为空`);
      const output = await uniqueOutput(outputsDir, `${name}-part${part + 1}`, "pdf");
      const target = await PDFDocument.create();
      for (const page of range) {
        if (!Number.isInteger(page) || page < 1 || page > total) throw new OfficeError(`页码超出范围（共 ${total} 页）：${page}`);
      }
      for (const page of await target.copyPages(source, range.map(p => p - 1))) target.addPage(page);
      await writeFile(output, await target.save(), { flag: "wx" });
      artifacts.push(await makeArtifact(ctx, output, "pdf"));
    }
  } else if (params.action === "rotate") {
    if (inputs.length !== 1) throw new OfficeError("rotate 需要一个 PDF");
    const amount = params.degrees ?? 0;
    if (![90, 180, 270].includes(amount)) throw new OfficeError("rotate 的 degrees 必须是 90、180 或 270");
    const pdf = await PDFDocument.load(await readFile(first));
    const total = pdf.getPageCount();
    const pages = params.pages?.length ? params.pages : Array.from({ length: total }, (_, index) => index + 1);
    for (const page of pages) {
      if (!Number.isInteger(page) || page < 1 || page > total) throw new OfficeError(`页码超出范围（共 ${total} 页）：${page}`);
      const target = pdf.getPage(page - 1);
      target.setRotation(degrees((target.getRotation().angle + amount) % 360));
    }
    const output = await uniqueOutput(outputsDir, name, "pdf");
    await writeFile(output, await pdf.save(), { flag: "wx" });
    artifacts.push(await makeArtifact(ctx, output, "pdf"));
  } else if (params.action === "watermark") {
    if (inputs.length !== 1) throw new OfficeError("watermark 需要一个 PDF");
    if (typeof params.text !== "string" || !params.text) throw new OfficeError("watermark 需要 text");
    const pdf = await PDFDocument.load(await readFile(first));
    const { font, note } = await embedWatermarkFont(pdf, params.text);
    notes.push(note);
    const size = params.fontSize ?? 36;
    const opacity = Math.min(1, Math.max(0, params.opacity ?? 0.2));
    const angle = params.degrees ?? 45;
    const radians = (angle * Math.PI) / 180;
    for (const page of pdf.getPages()) {
      const width = page.getWidth();
      const height = page.getHeight();
      const textWidth = font.widthOfTextAtSize(params.text, size);
      const x = width / 2 - (textWidth / 2) * Math.cos(radians);
      const y = height / 2 - (textWidth / 2) * Math.sin(radians);
      page.drawText(params.text, { x, y, size, font, opacity, color: rgb(0.6, 0.6, 0.6), rotate: degrees(angle) });
    }
    const output = await uniqueOutput(outputsDir, name, "pdf");
    await writeFile(output, await pdf.save(), { flag: "wx" });
    artifacts.push(await makeArtifact(ctx, output, "pdf"));
  } else {
    if (inputs.length !== 1) throw new OfficeError("extract 需要一个 PDF");
    const pages = params.pages ?? [];
    if (!Array.isArray(pages) || !pages.length) throw new OfficeError("extract 需要 pages");
    const source = await PDFDocument.load(await readFile(first));
    const total = source.getPageCount();
    for (const page of pages) {
      if (!Number.isInteger(page) || page < 1 || page > total) throw new OfficeError(`页码超出范围（共 ${total} 页）：${page}`);
    }
    const target = await PDFDocument.create();
    for (const page of await target.copyPages(source, pages.map(p => p - 1))) target.addPage(page);
    const output = await uniqueOutput(outputsDir, name, "pdf");
    await writeFile(output, await target.save(), { flag: "wx" });
    artifacts.push(await makeArtifact(ctx, output, "pdf"));
  }

  for (const artifact of artifacts) {
    const abs = resolve(ctx.projectRoot, artifact.path);
    try {
      Object.assign(artifact, await previewArtifact(ctx, abs, basename(abs, ".pdf")));
    } catch {
      notes.push(`未生成 ${artifact.path} 的预览`);
    }
  }
  const summary = `已${{ merge: "合并", split: "拆分", rotate: "旋转", watermark: "加水印", extract: "提取" }[params.action]} PDF：${artifacts.map(item => item.path).join("、")}${notes.length ? `（${notes.join("；")}）` : ""}`;
  return { summary, artifacts };
}

export async function officePreview(ctx: OfficeContext, path: string, pages?: number[], signal?: AbortSignal): Promise<OfficeResult> {
  const input = await resolveInput(ctx.projectRoot, path, "文档");
  const ext = requireExt(input, PREVIEWABLE, "文档");
  const stem = basename(input, extname(input));
  const outDir = join(ctx.projectRoot, "outputs", "previews");
  const rendered = ext === "pdf"
    ? await renderPdfPages(input, outDir, stem, pages, signal)
    : await withTempDir(async dir => {
        const pdf = await sofficeConvert(input, "pdf", dir, signal);
        return renderPdfPages(pdf, outDir, stem, pages, signal);
      });
  const artifacts = await Promise.all(rendered.map(item => makeArtifact(ctx, item.abs, "png")));
  return { summary: `已渲染 ${artifacts.length} 页预览：${artifacts.map(item => item.path).join("、")}`, artifacts };
}
