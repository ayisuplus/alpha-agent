import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishLocalPreview } from "../src/runtime/local-preview";
import { stalePreviews } from "../src/runtime/storage";
import { fingerprintSource } from "../src/runtime/task-ledger";

test("local preview serves the frozen build with a version identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-preview-test-"));
  let stop: (() => void) | undefined;
  try {
    const project = join(root, "product");
    const build = join(project, "dist");
    await mkdir(build, { recursive: true });
    await writeFile(join(project, "src.txt"), "source-v1");
    await writeFile(join(build, "index.html"), "<h1>Preview v1</h1>");
    await writeFile(join(build, "voice.flac"), new Uint8Array([102, 76, 97, 67]));
    const revision = await fingerprintSource(project);
    const instance = await publishLocalPreview({ projectRoot: project, buildDir: build, dataRoot: join(root, "alpha-data"), revision });
    stop = instance.stop;
    const manifest = JSON.parse(await readFile(join(root, "alpha-data", "previews", instance.record.id, "preview.json"), "utf8")) as { format?: string; version?: number };
    expect(manifest.format).toBe("preview");
    expect(manifest.version).toBe(1);
    // A legacy manifest without the tag must still identify its preview snapshot for cleanup.
    const legacyId = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(root, "alpha-data", "previews", legacyId), { recursive: true });
    await writeFile(join(root, "alpha-data", "previews", legacyId, "preview.json"), JSON.stringify({ id: legacyId }));
    expect((await stalePreviews(join(root, "alpha-data"), new Set())).map(item => item.id)).toContain(legacyId);
    const response = await fetch(instance.record.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-alpha-revision")).toBe(revision);
    expect(await response.text()).toContain("Preview v1");
    expect((await fetch(new URL("/voice.flac", instance.record.url))).headers.get("content-type")).toBe("audio/flac");
    expect((await fetch(new URL("/missing.js", instance.record.url))).status).toBe(404);

    await writeFile(join(project, "src.txt"), "source-v2");
    await expect(publishLocalPreview({ projectRoot: project, buildDir: build, dataRoot: join(root, "alpha-data"), revision })).rejects.toThrow("changed");
  } finally {
    stop?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
