import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishLocalPreview } from "../src/runtime/local-preview";
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
