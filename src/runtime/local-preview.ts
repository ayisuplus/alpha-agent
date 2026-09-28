import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fingerprintSource, type LocalPreview } from "./task-ledger";

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".flac": "audio/flac",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Preview output contains a symlink: ${from}`);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

export interface PreviewInstance {
  record: LocalPreview;
  stop(): void;
}

export async function publishLocalPreview(input: {
  projectRoot: string;
  buildDir: string;
  dataRoot: string;
  revision: string;
  taskId?: string;
}): Promise<PreviewInstance> {
  const projectRoot = await realpath(input.projectRoot);
  const buildDir = await realpath(input.buildDir);
  const relativeBuild = relative(projectRoot, buildDir);
  if (relativeBuild.startsWith("..") || isAbsolute(relativeBuild)) throw new Error("Build directory must be inside the project");
  if ((await fingerprintSource(projectRoot)) !== input.revision) throw new Error("Source revision changed before preview publication");
  if (!(await stat(join(buildDir, "index.html")).catch(() => null))?.isFile()) throw new Error("Build output needs index.html");

  const id = randomUUID();
  const destination = join(resolve(input.dataRoot), "previews", id);
  const filesRoot = join(destination, "files");
  await copyTree(buildDir, filesRoot);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const target = resolve(filesRoot, `.${pathname}`);
      if (target !== filesRoot && !target.startsWith(filesRoot + sep)) return new Response("Forbidden", { status: 403 });
      let file = target;
      const details = await stat(file).catch(() => null);
      if (details?.isDirectory()) file = join(file, "index.html");
      const body = Bun.file(file);
      if (!(await body.exists())) return new Response("Not found", { status: 404 });
      return new Response(body, { headers: { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "x-alpha-preview-id": id, "x-alpha-revision": input.revision } });
    },
  });
  const record: LocalPreview = {
    id,
    revision: input.revision,
    path: destination,
    url: `http://127.0.0.1:${server.port}/`,
    taskId: input.taskId,
    pid: process.pid,
    port: server.port,
    recordedAt: new Date().toISOString(),
  };
  // previews/<id>/preview.json (preview store): v1 = LocalPreview plus its format tag; a version bump must migrate in storage.ts's manifest read.
  await writeFile(join(destination, "preview.json"), JSON.stringify({ ...record, format: "preview", version: 1 }, null, 2));
  return { record, stop: () => server.stop(true) };
}
