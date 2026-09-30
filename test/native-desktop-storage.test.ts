import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { stateStorage } = createRequire(import.meta.url)("../desktop/state-storage.cjs");

test("desktop image drafts persist across fresh storage instances and reject path/size escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-desktop-state-"));
  try {
    const first = stateStorage(root), value = JSON.stringify({ text: "未发送材料", images: [{ data: "aW1hZ2U=", mimeType: "image/png", name: "图片.png" }] });
    first.setItem("alpha-composer:session", value);
    expect(stateStorage(root).getItem("alpha-composer:session")).toBe(value);
    first.setItem("alpha-composer:session", "replacement"); expect(stateStorage(root).getItem("alpha-composer:session")).toBe("replacement");
    expect(() => first.setItem("../../user-file", "bad")).toThrow("Invalid desktop storage key");
    expect(() => first.setItem("alpha-composer:session", "x".repeat(7_000_001))).toThrow("size limit");
    expect((await readdir(join(root, ".alpha", "desktop-state"))).every(name => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
    first.removeItem("alpha-composer:session"); expect(stateStorage(root).getItem("alpha-composer:session")).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
