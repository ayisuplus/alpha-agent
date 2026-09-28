import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Content-addressed store for the large pieces of what a model saw. A `step/context` event carries the hash and the
 * sizes; the text itself lives here so the log stays small and a replay can rebuild the exact block by hash.
 */

export function promptBlobPath(dataRoot: string, hash: string): string {
  return join(dataRoot, "prompt-blobs", `${hash}.txt`);
}

export function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stores one text block and returns how to find it again; identical text is stored once. */
export async function writePromptBlob(dataRoot: string, text: string): Promise<{ hash: string; bytes: number; path: string }> {
  const hash = promptHash(text);
  const path = promptBlobPath(dataRoot, hash);
  if (await stat(path).then(() => true, () => false)) return { hash, bytes: Buffer.byteLength(text, "utf8"), path };
  await mkdir(join(dataRoot, "prompt-blobs"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
  return { hash, bytes: Buffer.byteLength(text, "utf8"), path };
}

export async function readPromptBlob(dataRoot: string, hash: string): Promise<string | null> {
  return readFile(promptBlobPath(dataRoot, hash), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}
