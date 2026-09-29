// Moved from src/runtime/office-runtime.ts: behavior preserved as-is; M2 extends it with the alpha_office create/pdf surface.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { pdfToMarkdown } from "@oh-my-pi/pi-natives";
import { degrees, PDFDocument } from "pdf-lib";
export interface OfficeWorkspace {
  state: { id: string; projectRoot: string; inputs?: Array<{ id: string; name: string; path: string; sha256: string; mimeType: string; size?: number; uploadedAt: string }> };
}

type OfficeFormat = "docx" | "xlsx" | "pptx" | "pdf";
type OfficeSource = { id: string; name: string; path: string; format: OfficeFormat; sha256: string };
type OfficeJob = { mode: "read" | "edit"; format: Exclude<OfficeFormat, "pdf">; input: string; profile: string; output?: string; preview?: string; beforePreview?: string; edits?: unknown[]; connection?: string };

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

export async function officeRuntimeStatus(): Promise<{ available: boolean; version?: string; location?: "bundled" | "system"; reason?: string }> {
  const appRoot = resolve(import.meta.dir, "..", "..", "..", "..");
  const bundled = join(appRoot, "runtime", "libreoffice");
  const system = join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice");
  const packaged = await stat(join(appRoot, "release.json")).then(item => item.isFile()).catch(() => false);
  for (const [root, location] of (packaged ? [[bundled, "bundled"]] : [[bundled, "bundled"], [system, "system"]]) as Array<[string, "bundled" | "system"]>) {
    const python = join(root, "program", "python.exe");
    const office = join(root, "program", "soffice.com");
    if (await stat(python).then(item => item.isFile()).catch(() => false) && await stat(office).then(item => item.isFile()).catch(() => false)) {
      const version = (await readFile(join(root, "program", "version.ini"), "utf8").catch(() => "")).match(/^buildid=(.+)$/m)?.[1]?.trim();
      return { available: true, version, location };
    }
  }
  return { available: false, reason: "LibreOffice runtime is missing" };
}

async function officePython(): Promise<string> {
  const appRoot = resolve(import.meta.dir, "..", "..", "..", "..");
  const bundled = join(appRoot, "runtime", "libreoffice", "program", "python.exe");
  if (await stat(bundled).then(item => item.isFile()).catch(() => false)) return bundled;
  if (await stat(join(appRoot, "release.json")).then(item => item.isFile()).catch(() => false)) throw new Error("Bundled LibreOffice runtime is missing");
  const system = join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice", "program", "python.exe");
  if (await stat(system).then(item => item.isFile()).catch(() => false)) return system;
  throw new Error("LibreOffice runtime is missing");
}

async function runOfficeJob(job: OfficeJob, signal?: AbortSignal): Promise<{ before: unknown; after: unknown; unsupported: string[] }> {
  signal?.throwIfAborted();
  const python = await officePython();
  const office = join(dirname(python), "soffice.exe");
  const connection = `alpha_${randomUUID().replaceAll("-", "")}`;
  await mkdir(job.profile, { recursive: true });
  const server = Bun.spawn([office, `-env:UserInstallation=${pathToFileURL(job.profile).href}`, "--headless", "--nologo", "--nodefault", "--norestore", `--accept=pipe,name=${connection};urp;StarOffice.ServiceManager`], { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true });
  await Bun.sleep(1000);
  if (server.exitCode !== null) throw new Error(`LibreOffice startup exited ${server.exitCode}: ${(await new Response(server.stderr).text()).trim()}`);
  const script = join(import.meta.dir, "office-worker.py");
  const proc = Bun.spawn([python, "-B", "-u", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
    const result = JSON.parse(stdout.trim()) as { ok: boolean; result?: { before: unknown; after: unknown; unsupported: string[] }; error?: string };
    if (exit !== 0 || !result.ok || !result.result) {
      const officeError = server.exitCode === null ? "" : await new Response(server.stderr).text();
      throw new Error(`${result.error ?? stderr.trim() ?? "LibreOffice job failed"} (office exit ${server.exitCode}: ${officeError.trim()})`);
    }
    return result.result;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Office job failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (server.exitCode === null && process.platform === "win32") {
      const killer = Bun.spawn(["taskkill", "/T", "/F", "/PID", String(server.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
      await killer.exited;
    } else if (server.exitCode === null) server.kill();
    await server.exited;
    if (inside(tmpdir(), job.profile) && basename(job.profile).startsWith("ao-")) await rm(job.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }).catch(() => undefined);
  }
}

export async function officeSource(ledger: OfficeWorkspace, dataRoot: string, id: string): Promise<OfficeSource> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid document ID");
  let item = ledger.state.inputs?.find(input => input.id === id);
  if (!item) {
    const file = join(dataRoot, "artifacts", ledger.state.id, `${id}.json`);
    const record = JSON.parse(await readFile(file, "utf8")) as { id: string; taskId: string; path: string; sha256: string };
    if (record.id !== id || record.taskId !== ledger.state.id) throw new Error("Document is not attached to this task");
    const path = await realpath(record.path);
    if (!inside(resolve(ledger.state.projectRoot, "outputs"), path)) throw new Error("Document path leaves task outputs");
    item = { id, name: basename(path), path, sha256: record.sha256, mimeType: "", size: 0, uploadedAt: "" };
  }
  const format = extname(item.name).slice(1).toLowerCase();
  if (!["docx", "xlsx", "pptx", "pdf"].includes(format)) throw new Error("Unsupported office format");
  const path = await realpath(item.path);
  const inputRoot = await realpath(join(ledger.state.projectRoot, "inputs")).catch(() => null);
  const extraRoot = await realpath(join(dataRoot, "task-inputs", ledger.state.id)).catch(() => null);
  const outputRoot = await realpath(join(ledger.state.projectRoot, "outputs")).catch(() => null);
  if (![inputRoot, extraRoot, outputRoot].some(root => root && inside(root, path))) throw new Error("Document path leaves task workspace");
  if (hash(await readFile(path)) !== item.sha256) throw new Error("Document changed after upload or creation");
  return { id, name: item.name, path, format: format as OfficeFormat, sha256: item.sha256 };
}

async function stage(ledger: OfficeWorkspace, dataRoot: string, source: OfficeSource) {
  const directory = join(dataRoot, "office-jobs", ledger.state.id, randomUUID());
  await mkdir(directory, { recursive: true });
  const input = join(directory, `input.${source.format}`);
  await copyFile(source.path, input);
  if (hash(await readFile(input)) !== source.sha256) throw new Error("Document changed while staging");
  return { directory, input, profile: join(tmpdir(), `ao-${randomUUID().slice(0, 8)}`) };
}

export async function readOffice(ledger: OfficeWorkspace, dataRoot: string, id: string, preview = false, signal?: AbortSignal) {
  const source = await officeSource(ledger, dataRoot, id);
  const job = await stage(ledger, dataRoot, source);
  if (source.format === "pdf") {
    const result = await pdfToMarkdown(await readFile(job.input));
    return { source: { id, name: source.name, sha256: source.sha256 }, format: "pdf", content: result.markdown.slice(0, 100_000), pages: result.pageCount, pagesNeedingOcr: result.pagesNeedingOcr, hasEncodingIssues: result.hasEncodingIssues };
  }
  const previewPath = preview ? join(job.directory, "preview.pdf") : undefined;
  const result = await runOfficeJob({ mode: "read", format: source.format, input: job.input, profile: job.profile, preview: previewPath }, signal);
  return { source: { id, name: source.name, sha256: source.sha256 }, format: source.format, content: result.before, unsupported: result.unsupported, previewPath };
}

export async function editOffice(ledger: OfficeWorkspace, dataRoot: string, id: string, edits: unknown[], signal?: AbortSignal) {
  const source = await officeSource(ledger, dataRoot, id);
  if (source.format === "pdf") return editPdf(ledger, dataRoot, source, edits);
  const job = await stage(ledger, dataRoot, source);
  const draft = join(job.directory, `draft.${source.format}`);
  const preview = join(job.directory, "preview.pdf");
  const beforePreview = join(job.directory, "before.pdf");
  const verifiedEdits = await Promise.all(edits.map(async (raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each edit must be an object");
    const edit = raw as Record<string, unknown>;
    if ("image" in edit) throw new Error("Images must be selected by attachment ID");
    if (!("imageInputId" in edit)) return edit;
    if (source.format !== "pptx" || typeof edit.imageInputId !== "string") throw new Error("Image replacement requires a PPTX and image attachment ID");
    const image = ledger.state.inputs?.find(item => item.id === edit.imageInputId);
    if (!image || !/\.(png|jpe?g)$/i.test(image.name)) throw new Error("Image must be attached to this task");
    const imagePath = await realpath(image.path);
    const inputRoot = await realpath(join(ledger.state.projectRoot, "inputs")).catch(() => null);
    const extraRoot = await realpath(join(dataRoot, "task-inputs", ledger.state.id)).catch(() => null);
    if (![inputRoot, extraRoot].some(root => root && inside(root, imagePath))) throw new Error("Image path leaves task inputs");
    const bytes = await readFile(imagePath);
    if (hash(bytes) !== image.sha256) throw new Error("Image attachment changed after upload");
    const staged = join(job.directory, `image-${index}${extname(image.name).toLowerCase()}`);
    await writeFile(staged, bytes, { flag: "wx" });
    const { imageInputId: _imageInputId, ...rest } = edit;
    return { ...rest, image: staged };
  }));
  const result = await runOfficeJob({ mode: "edit", format: source.format, input: job.input, profile: job.profile, output: draft, preview, beforePreview, edits: verifiedEdits }, signal);
  const verified = await runOfficeJob({ mode: "read", format: source.format, input: draft, profile: join(tmpdir(), `ao-${randomUUID().slice(0, 8)}`) }, signal);
  if (JSON.stringify(result.after) !== JSON.stringify(verified.before)) throw new Error("Saved document differs from verified content");
  if ((await readFile(preview)).subarray(0, 4).toString() !== "%PDF") throw new Error("Preview export failed");
  return publishOffice(ledger, dataRoot, source, draft, preview, { before: result.before, after: verified.before, unsupported: result.unsupported }, beforePreview);
}

export async function exportOfficePdf(ledger: OfficeWorkspace, dataRoot: string, id: string, signal?: AbortSignal) {
  const source = await officeSource(ledger, dataRoot, id);
  if (source.format === "pdf") throw new Error("This document is already a PDF");
  const job = await stage(ledger, dataRoot, source);
  const draft = join(job.directory, "render.pdf");
  const result = await runOfficeJob({ mode: "read", format: source.format, input: job.input, profile: job.profile, preview: draft }, signal);
  if ((await readFile(draft)).subarray(0, 4).toString() !== "%PDF") throw new Error("PDF export failed");
  const output = join(ledger.state.projectRoot, "outputs", `${randomUUID()}-${basename(source.name, `.${source.format}`)}.pdf`);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(draft, output, constants.COPYFILE_EXCL);
  const record = { id: randomUUID(), taskId: ledger.state.id, path: output, format: "pdf" as const, sha256: hash(await readFile(output)), sourceId: id, sourceSha256: source.sha256, previewPath: output, engine: await officeRuntimeStatus(), report: { unsupported: result.unsupported }, createdAt: new Date().toISOString() };
  const recordsDir = join(dataRoot, "artifacts", ledger.state.id);
  await mkdir(recordsDir, { recursive: true });
  await writeFile(join(recordsDir, `${record.id}.json`), JSON.stringify(record, null, 2), { flag: "wx" });
  return record;
}

async function editPdf(ledger: OfficeWorkspace, dataRoot: string, source: OfficeSource, edits: unknown[]) {
  const original = await PDFDocument.load(await readFile(source.path));
  const output = await PDFDocument.create();
  let pages = Array.from({ length: original.getPageCount() }, (_, index) => index);
  if (!Array.isArray(edits) || !edits.length) throw new Error("PDF page operations are required");
  for (const raw of edits) {
    const edit = raw as { kind?: string; pages?: number[]; degrees?: number; ids?: string[] };
    if (edit.kind === "select" || edit.kind === "reorder") {
      if (!Array.isArray(edit.pages) || !edit.pages.length || edit.pages.some(page => !Number.isInteger(page) || page < 1 || page > original.getPageCount())) throw new Error("Invalid PDF page selection");
      pages = edit.pages.map(page => page - 1);
    } else if (edit.kind !== "rotate" && edit.kind !== "merge") throw new Error("Unsupported PDF page operation");
  }
  const copied = await output.copyPages(original, pages);
  copied.forEach(page => output.addPage(page));
  for (const raw of edits) {
    const edit = raw as { kind: string; pages?: number[]; degrees?: number; ids?: string[] };
    if (edit.kind === "rotate") {
      if (![90, 180, 270].includes(edit.degrees ?? -1)) throw new Error("Rotation must be 90, 180 or 270 degrees");
      for (const page of edit.pages ?? Array.from({ length: output.getPageCount() }, (_, index) => index + 1)) {
        if (!Number.isInteger(page) || page < 1 || page > output.getPageCount()) throw new Error("Invalid output page");
        const current = output.getPage(page - 1);
        current.setRotation(degrees((current.getRotation().angle + edit.degrees!) % 360));
      }
    } else if (edit.kind === "merge") {
      if (!Array.isArray(edit.ids) || !edit.ids.length) throw new Error("Merge requires attached PDF IDs");
      for (const id of edit.ids) {
        const other = await officeSource(ledger, dataRoot, id);
        if (other.format !== "pdf") throw new Error("Merge source must be a PDF");
        const pdf = await PDFDocument.load(await readFile(other.path));
        for (const page of await output.copyPages(pdf, pdf.getPageIndices())) output.addPage(page);
      }
    }
  }
  const job = await stage(ledger, dataRoot, source);
  const draft = join(job.directory, "draft.pdf");
  await writeFile(draft, await output.save(), { flag: "wx" });
  if ((await PDFDocument.load(await readFile(draft))).getPageCount() !== output.getPageCount()) throw new Error("PDF page verification failed");
  return publishOffice(ledger, dataRoot, source, draft, draft, { before: { pages: original.getPageCount() }, after: { pages: output.getPageCount() }, unsupported: [] }, source.path);
}

async function publishOffice(ledger: OfficeWorkspace, dataRoot: string, source: OfficeSource, draft: string, preview: string, report: unknown, beforePreview?: string) {
  if (hash(await readFile(source.path)) !== source.sha256) throw new Error("Original document changed during editing");
  const id = randomUUID();
  const directory = join(ledger.state.projectRoot, "outputs");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${id}-${basename(source.name)}`);
  await copyFile(draft, path, constants.COPYFILE_EXCL);
  const previewPath = source.format === "pdf" ? path : join(directory, `${id}-preview.pdf`);
  if (previewPath !== path) await copyFile(preview, previewPath, constants.COPYFILE_EXCL);
  const beforePreviewPath = beforePreview ? join(directory, `${id}-before.pdf`) : undefined;
  if (beforePreview && beforePreviewPath) await copyFile(beforePreview, beforePreviewPath, constants.COPYFILE_EXCL);
  const bytes = await readFile(path);
  const record = { id, taskId: ledger.state.id, path, format: source.format, sha256: hash(bytes), sourceId: source.id, sourceSha256: source.sha256, previewPath, previewSha256: hash(await readFile(previewPath)), beforePreviewPath, beforePreviewSha256: beforePreviewPath ? hash(await readFile(beforePreviewPath)) : undefined, engine: source.format === "pdf" ? undefined : await officeRuntimeStatus(), report, createdAt: new Date().toISOString() };
  const recordsDir = join(dataRoot, "artifacts", ledger.state.id);
  await mkdir(recordsDir, { recursive: true });
  await writeFile(join(recordsDir, `${id}.json`), JSON.stringify(record, null, 2), { flag: "wx" });
  return record;
}
