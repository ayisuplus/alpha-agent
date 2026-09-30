import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { officeDocumentPdf } from "./capabilities/office/office-runtime";

const TEXT_LIMIT = 1024 * 1024;
const DOCUMENT_LIMIT = 50 * 1024 * 1024;
const MEDIA: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  pdf: "application/pdf",
};
const OFFICE = new Set(["docx", "xlsx", "pptx", "doc", "xls", "ppt", "odt", "ods", "odp", "rtf"]);

export async function projectFile(rootPath: string, path: string) {
  const root = await realpath(rootPath);
  const resolved = await realpath(resolve(root, path));
  const part = relative(root, resolved);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("只能预览会话项目目录内的文件");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("请选择文件，目录不能预览");
  return { path: resolved, relative: part, name: basename(resolved), size: info.size, extension: extname(resolved).slice(1).toLowerCase() };
}

export async function projectFilePreview(root: string, path: string) {
  const file = await projectFile(root, path);
  const mime = MEDIA[file.extension];
  const kind = OFFICE.has(file.extension) ? "office" : mime?.split("/")[0] === "image" ? "image" : mime?.startsWith("video/") ? "video" : mime?.startsWith("audio/") ? "audio" : file.extension === "pdf" ? "pdf" : "text";
  if ((kind === "pdf" || kind === "office") && file.size > DOCUMENT_LIMIT || kind === "image" && file.size > DOCUMENT_LIMIT) return { ...file, kind: "unsupported", reason: "文件超过 50 MB，暂不提供内嵌预览，请下载或在系统应用中打开。" };
  if (kind !== "text") return { ...file, kind, mime };
  const bytes = new Uint8Array(await Bun.file(file.path).slice(0, TEXT_LIMIT).arrayBuffer());
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff;
  let text: string;
  try {
    text = new TextDecoder(utf16 ? bytes[0] === 0xff ? "utf-16le" : "utf-16be" : "utf-8", { fatal: true }).decode(bytes, { stream: file.size > TEXT_LIMIT });
  } catch { return { ...file, kind: "unsupported", reason: "暂不支持此文本编码，请下载或在系统应用中打开。" }; }
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) return { ...file, kind: "unsupported", reason: "暂不支持此二进制文件，请下载或在系统应用中打开。" };
  return { ...file, kind: /^(md|markdown)$/.test(file.extension) ? "markdown" : /^(html|htm)$/.test(file.extension) ? "html" : "text", text, truncated: file.size > TEXT_LIMIT };
}

/** Media is streamed with ranges; HTML/SVG and unknown files are download-only on this origin. */
export async function projectFileContent(root: string, path: string, request: Request, preview = false): Promise<Response> {
  const file = await projectFile(root, path);
  const data = Bun.file(file.path);
  const mime = MEDIA[file.extension] ?? "application/octet-stream";
  if (preview && OFFICE.has(file.extension)) {
    if (file.size > DOCUMENT_LIMIT) throw new Error("文档超过 50 MB，无法生成预览");
    const bytes = await officeDocumentPdf(file.path, request.signal);
    return new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": "application/pdf", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  const headers = new Headers({ "content-type": mime, "cache-control": "no-store", "accept-ranges": "bytes", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" });
  if (new URL(request.url).searchParams.has("download") || !mime.startsWith("audio/") && !mime.startsWith("video/") && !mime.startsWith("image/") && mime !== "application/pdf" || file.extension === "svg") {
    headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  }
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, file.size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
    if (!match || !match[1] && !match[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) {
      headers.set("content-range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(data.slice(start, end + 1), { status: 206, headers });
  }
  headers.set("content-length", String(file.size));
  return new Response(data, { headers });
}
