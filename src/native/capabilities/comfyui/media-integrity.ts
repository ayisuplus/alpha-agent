import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { warnUnknownStoreVersion } from "./store-tag";

export type MediaKind = "png" | "flac" | "mp4";

/** C4 output contract: a generated file, its hash, and an optional thumbnail preview. */
export interface MediaArtifact {
  /** Project-relative with forward slashes, or the absolute path the user asked for. */
  path: string;
  kind: MediaKind;
  sha256: string;
  /** Thumbnail PNG for images and videos, when it could be produced. */
  preview?: string;
}

/** C4 provenance: recorded into the session as `pi.appendEntry("alpha-media", ...)`. */
export interface MediaEntry {
  tool: string;
  input: Record<string, unknown>;
  artifacts: MediaArtifact[];
}

interface MediaJob {
  projectRoot?: string;
  promptId?: string;
  state?: string;
  asset?: string;
  candidateAsset?: string;
  imageSha256?: string;
  audioSha256?: string;
  videoSha256?: string;
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const PREVIEW_SUFFIX = "-preview.png";
const FALLBACK_NAME: Record<MediaKind, string> = { png: "image", flac: "voice", mp4: "video" };
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/** Records written before outputs moved to outputs/media/ point at the retired public/alpha-assets layout. */
const LEGACY_ASSET = /^\/alpha-assets\/[0-9a-f]{64}\.(png|flac|mp4)$/;

/** Characters a Windows/macOS/Linux file name may never contain, plus control characters. */
const UNSAFE_NAME_CHARS = "<>:\"/\\|?*";

/** Readable, filesystem-safe output name derived from the generation input (C3). */
export function mediaName(source: string, fallback: string): string {
  let cleaned = "";
  for (const char of source.trim().toLowerCase()) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && !UNSAFE_NAME_CHARS.includes(char)) cleaned += char;
  }
  const slug = cleaned
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 60)
    .replace(/[.\-]+$/g, "");
  const name = slug || fallback;
  return RESERVED_WINDOWS_NAME.test(name) ? `media-${name}` : name;
}

/** Whether a job record still points at the retired public/alpha-assets output layout. */
export function isLegacyMediaAsset(asset: string | undefined): boolean {
  return typeof asset === "string" && asset.startsWith("/alpha-assets/");
}

function displayMediaPath(projectRoot: string, target: string): string {
  const rel = relative(projectRoot, target);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : target;
}

function previewTargetFor(target: string): string {
  return join(dirname(target), `${basename(target, extname(target))}${PREVIEW_SUFFIX}`);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/**
 * Publishes a freshly generated media file under `outputs/media/<name>.<ext>` (or at the user's
 * explicit `outputPath`), never overwriting: taken names advance to `-2`, `-3`, ... The returned
 * artifact follows the C4 shape and carries a thumbnail preview when one can be produced.
 */
export async function publishMedia(options: { projectRoot: string; outputPath?: string; name: string; kind: MediaKind; bytes: Uint8Array }): Promise<MediaArtifact> {
  const projectRoot = resolve(options.projectRoot);
  const extension = `.${options.kind}`;
  let directory: string;
  let stem: string;
  const requested = options.outputPath?.trim();
  if (requested) {
    if (!requested.toLowerCase().endsWith(extension)) throw new Error(`Output path must end with ${extension}`);
    const target = isAbsolute(requested) ? resolve(requested) : resolve(projectRoot, requested);
    directory = dirname(target);
    stem = basename(target, extname(target));
  } else {
    directory = join(projectRoot, "outputs", "media");
    stem = mediaName(options.name, FALLBACK_NAME[options.kind]);
  }
  await mkdir(directory, { recursive: true });
  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const target = join(directory, `${stem}${suffix}${extension}`);
    if (await exists(target) || await exists(previewTargetFor(target))) continue;
    let handle;
    try {
      handle = await open(target, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(options.bytes);
    } finally {
      await handle.close();
    }
    await chmod(target, 0o444);
    const preview = await ensureMediaPreview(projectRoot, target, options.kind);
    return { path: displayMediaPath(projectRoot, target), kind: options.kind, sha256: sha(options.bytes), ...(preview ? { preview } : {}) };
  }
  throw new Error(`Could not find a free output name for ${stem}${extension}`);
}

/**
 * Restores a recorded generated file to its recorded hash (crash recovery and integrity repair).
 * The file is Alpha's own output from an earlier job state, never a user original.
 */
export async function ensureGeneratedAsset(path: string, expectedSha256: string, obtain: () => Promise<Uint8Array>): Promise<void> {
  const existing = await readFile(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing && sha(existing) === expectedSha256) {
    await chmod(path, 0o444);
    return;
  }
  const bytes = await obtain();
  if (sha(bytes) !== expectedSha256) throw new Error("ComfyUI output does not match the recorded generated asset hash");
  await mkdir(dirname(path), { recursive: true });
  await chmod(path, 0o666).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await writeFile(path, bytes);
  await chmod(path, 0o444);
}

/**
 * Returns the display path of an artifact's thumbnail (`<stem>-preview.png`), producing it when
 * missing. Audio has no preview; a missing or unproducible preview never blocks the artifact.
 */
export async function ensureMediaPreview(projectRoot: string, target: string, kind: MediaKind): Promise<string | undefined> {
  if (kind === "flac") return undefined;
  const previewTarget = previewTargetFor(target);
  const display = displayMediaPath(projectRoot, previewTarget);
  if (await exists(previewTarget)) return display;
  let thumbnail: Uint8Array | null = null;
  try {
    thumbnail = await generateThumbnail(kind, target);
  } catch {
    thumbnail = null;
  }
  if (!thumbnail) return undefined;
  try {
    const handle = await open(previewTarget, "wx");
    try {
      await handle.writeFile(thumbnail);
    } finally {
      await handle.close();
    }
    await chmod(previewTarget, 0o444);
    return display;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? display : undefined;
  }
}

/** Build preflight: every completed generated media job must still match its recorded hash. */
export async function assertGeneratedAssetsIntact(projectRoot: string, dataRoot: string): Promise<void> {
  const jobsDir = join(dataRoot, "comfy-jobs");
  const entries = await readdir(jobsDir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of entries.filter(name => name.endsWith(".json") && !name.endsWith(".workflow.json"))) {
    const job = JSON.parse(await readFile(join(jobsDir, name), "utf8")) as MediaJob;
    warnUnknownStoreVersion("comfy-jobs", job);
    if (job.projectRoot !== resolve(projectRoot) || job.state !== "completed") continue;
    const asset = job.asset ?? job.candidateAsset;
    const expected = job.imageSha256 ?? job.audioSha256 ?? job.videoSha256;
    const wellFormed = typeof asset === "string" && /\.(png|flac|mp4)$/i.test(asset)
      && (isLegacyMediaAsset(asset) ? LEGACY_ASSET.test(asset) : !asset.split(/[\\/]/).includes(".."));
    if (!wellFormed || !expected) throw new Error(`Generated media job ${job.promptId ?? name} has incomplete provenance`);
    const target = isLegacyMediaAsset(asset) ? join(projectRoot, "public", asset.slice(1)) : resolve(projectRoot, asset as string);
    const bytes = await readFile(target).catch(() => null);
    const actual = bytes ? sha(bytes) : null;
    if (actual !== expected) throw new Error(`Generated media asset changed after ComfyUI job ${job.promptId ?? name}: ${asset}`);
  }
}

type SessionRecorder = {
  appendCustomEntry?: (customType: string, data?: unknown) => void;
  appendEntry?: (customType: string, data?: unknown) => void;
};

/**
 * Records media provenance into the session. `pi.appendEntry(customType, data)` is wired by the
 * host to `sessionManager.appendCustomEntry(customType, data)`, which is the channel available to
 * a tool's execute context; a pi-shaped recorder is accepted for hosts that hand tools the API
 * directly. Recording failures never invalidate a completed generation.
 */
export function recordMediaEntry(ctx: unknown, entry: MediaEntry): void {
  const context = ctx as { sessionManager?: SessionRecorder; pi?: SessionRecorder } | null | undefined;
  const recorder = context?.sessionManager ?? context?.pi;
  const append = recorder?.appendCustomEntry ?? recorder?.appendEntry;
  if (!append) return;
  try {
    append.call(recorder, "alpha-media", entry);
  } catch (error) {
    console.error("ALPHA_MEDIA_ENTRY_FAILED", error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Thumbnail generation: PNG decode/downscale/encode in-process, video frames
// via the locally installed ffmpeg when present. Both are best-effort; the
// artifact itself is complete without them.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const THUMBNAIL_WIDTH = 320;

interface RawImage {
  width: number;
  height: number;
  /** RGBA8 */
  data: Uint8Array;
}

async function generateThumbnail(kind: MediaKind, target: string): Promise<Uint8Array | null> {
  if (kind === "png") return pngThumbnail(await readFile(target));
  if (kind === "mp4") {
    const frame = await videoFrame(target);
    return frame ? pngThumbnail(frame) : null;
  }
  return null;
}

function videoFrame(target: string): Promise<Uint8Array | null> {
  return new Promise(done => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-i", target, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      (error, stdout) => {
        const frame = stdout as Buffer;
        done(!error && frame.length > 8 && frame[0] === 137 ? new Uint8Array(frame) : null);
      },
    );
  });
}

function pngThumbnail(bytes: Uint8Array): Uint8Array | null {
  const image = decodePng(bytes);
  if (!image) return null;
  return encodePng(image.width > THUMBNAIL_WIDTH ? boxScale(image, THUMBNAIL_WIDTH) : image);
}

const u32 = (bytes: Uint8Array, offset: number) => ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

function decodePng(bytes: Uint8Array): RawImage | null {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  let pos = 8;
  let header: { width: number; height: number; bitDepth: number; colorType: number } | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const length = u32(bytes, pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const start = pos + 8;
    if (start + length + 4 > bytes.length) return null;
    const chunk = bytes.subarray(start, start + length);
    pos = start + length + 4;
    if (type === "IHDR") {
      if (length !== 13) return null;
      header = { width: u32(chunk, 0), height: u32(chunk, 4), bitDepth: chunk[8]!, colorType: chunk[9]! };
      if (chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) return null;
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!header || !idat.length) return null;
  const { width, height, bitDepth, colorType } = header;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!width || !height || !channels || (bitDepth !== 8 && bitDepth !== 16)) return null;
  const raw = inflateSync(Buffer.concat(idat.map(chunk => Buffer.from(chunk))));
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++]!;
    const row = new Uint8Array(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    if (filter === 1) {
      for (let i = bpp; i < stride; i += 1) row[i] = (row[i]! + row[i - bpp]!) & 255;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i += 1) row[i] = (row[i]! + previous[i]!) & 255;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        row[i] = (row[i]! + ((left + previous[i]!) >> 1)) & 255;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const up = previous[i]!;
        const corner = i >= bpp ? previous[i - bpp]! : 0;
        const prediction = left + up - corner;
        const pa = Math.abs(prediction - left);
        const pb = Math.abs(prediction - up);
        const pc = Math.abs(prediction - corner);
        const predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
        row[i] = (row[i]! + predicted) & 255;
      }
    } else if (filter !== 0) {
      return null;
    }
    const sample = (x: number, channel: number) => row[(x * channels + channel) * bytesPerSample]!;
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      if (colorType === 6) {
        out[target] = sample(x, 0);
        out[target + 1] = sample(x, 1);
        out[target + 2] = sample(x, 2);
        out[target + 3] = sample(x, 3);
      } else if (colorType === 2) {
        out[target] = sample(x, 0);
        out[target + 1] = sample(x, 1);
        out[target + 2] = sample(x, 2);
        out[target + 3] = 255;
      } else if (colorType === 4) {
        out[target] = out[target + 1] = out[target + 2] = sample(x, 0);
        out[target + 3] = sample(x, 1);
      } else {
        out[target] = out[target + 1] = out[target + 2] = sample(x, 0);
        out[target + 3] = 255;
      }
    }
    previous = row;
  }
  return { width, height, data: out };
}

function boxScale(image: RawImage, targetWidth: number): RawImage {
  const { width, height, data } = image;
  const targetHeight = Math.max(1, Math.round((height * targetWidth) / width));
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor((y * height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor((x * width) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / targetWidth));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const source = (sy * width + sx) * 4;
          r += data[source]!;
          g += data[source + 1]!;
          b += data[source + 2]!;
          a += data[source + 3]!;
          count += 1;
        }
      }
      const target = (y * targetWidth + x) * 4;
      out[target] = Math.round(r / count);
      out[target + 1] = Math.round(g / count);
      out[target + 2] = Math.round(b / count);
      out[target + 3] = Math.round(a / count);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(image: RawImage): Uint8Array {
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) {
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type: string, body: Uint8Array) => {
    const block = Buffer.alloc(12 + body.length);
    block.writeUInt32BE(body.length, 0);
    block.write(type, 4, "ascii");
    block.set(body, 8);
    block.writeUInt32BE(crc32(block.subarray(4, 8 + body.length)), 8 + body.length);
    return block;
  };
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Tool result assembly: the C4 text contract plus the artifact thumbnail as an
// inline image block, so the conversation card can render it directly (C5).
// ---------------------------------------------------------------------------

type MediaContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export async function mediaToolResult(projectRoot: string, summary: string, artifact: MediaArtifact): Promise<{ content: MediaContent[] }> {
  const content: MediaContent[] = [{ type: "text", text: JSON.stringify({ summary, artifacts: [artifact] }) }];
  if (artifact.preview) {
    const bytes = await readFile(resolve(projectRoot, artifact.preview)).catch(() => null);
    if (bytes && bytes.length > 0) content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
  }
  return { content };
}
