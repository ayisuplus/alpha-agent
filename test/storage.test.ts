import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStalePreviews, storageReport } from "../src/runtime/storage";

test("preview cleanup removes only unreferenced Alpha snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-storage-"));
  const data = join(root, ".alpha");
  const products = join(root, "products");
  const keep = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const stale = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const unknown = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  try {
    await mkdir(products, { recursive: true });
    for (const id of [keep, stale, unknown]) {
      const path = join(data, "previews", id);
      await mkdir(join(path, "files"), { recursive: true });
      await writeFile(join(path, "files", "index.html"), "preview content");
      if (id !== unknown) await writeFile(join(path, "preview.json"), JSON.stringify({ id }));
    }
    await mkdir(join(data, "evidence"), { recursive: true });
    await writeFile(join(data, "evidence", "proof.txt"), "keep this evidence");
    const protectedIds = new Set([keep]);
    const before = await storageReport(data, products, protectedIds);
    expect(before.cleanup.count).toBe(1);
    expect(before.cleanup.bytes).toBeGreaterThan(0);
    expect((await cleanupStalePreviews(data, protectedIds)).removed).toBe(1);
    expect(await stat(join(data, "previews", stale)).catch(() => null)).toBeNull();
    expect((await stat(join(data, "previews", keep))).isDirectory()).toBe(true);
    expect((await stat(join(data, "previews", unknown))).isDirectory()).toBe(true);
    expect(await readFile(join(data, "evidence", "proof.txt"), "utf8")).toBe("keep this evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});
