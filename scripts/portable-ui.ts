import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export async function verifyPayloadHashes(root: string, expected: Record<string, string>): Promise<void> {
  const base = resolve(root);
  if (!Object.keys(expected).length) throw new Error("Portable source manifest is empty");
  for (const [name, hash] of Object.entries(expected)) {
    const path = resolve(base, name);
    if (!path.startsWith(base + sep)) throw new Error("Portable manifest path leaves release root");
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actual !== hash) throw new Error(`Packaged source differs from the build: ${name}`);
  }
}

export async function uiHashes(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else if (entry.isFile()) files[name] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex");
      else throw new Error(`Desktop UI contains an unsupported entry: ${name}`);
    }
  }
  await visit(root);
  if (!files["index.html"] || !Object.keys(files).some(name => name.endsWith(".js"))) throw new Error("Desktop UI build is incomplete");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function verifyUiHashes(root: string, expected: Record<string, string>): Promise<void> {
  const actual = await uiHashes(root);
  const paths = Object.keys(actual);
  if (paths.length !== Object.keys(expected).length || paths.some(path => actual[path] !== expected[path])) {
    throw new Error("Packaged desktop UI differs from the fresh build");
  }
}
