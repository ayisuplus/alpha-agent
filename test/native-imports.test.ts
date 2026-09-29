import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const nativeRoot = join(repoRoot, "src", "native");

/** The three native entry modules whose import closure must stay inside src/native/. */
const entries = [
  join("src", "native", "server.ts"),
  join("src", "native", "tianshu", "extension.ts"),
  join("src", "native", "capabilities", "extension.ts"),
];

function localImports(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g, // static import/export ... from "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic await import("x")
    /\bimport\s*["']([^"']+)["']/g, // side-effect import "x"
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** Resolves ./x and ../x specifiers against the importing file, completing the .ts extension. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  const hit = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  return hit ?? null;
}

const insideNative = (path: string) => {
  const rest = relative(nativeRoot, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

describe("native import closure", () => {
  test("the three entry files exist", () => {
    for (const entry of entries) expect(existsSync(join(repoRoot, entry))).toBe(true);
  });

  test("every local import reachable from the entries stays inside src/native/", async () => {
    const queue = entries.map(entry => join(repoRoot, entry));
    const visited = new Set<string>();
    const outside: string[] = [];
    const unresolved: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const specifier of localImports(await readFile(file, "utf8"))) {
        if (!specifier.startsWith(".")) continue; // package imports (node_modules) are not local files
        const target = resolveLocal(file, specifier);
        if (!target) {
          unresolved.push(`${relative(repoRoot, file)} → ${specifier}`);
          continue;
        }
        if (insideNative(target)) queue.push(target);
        else outside.push(relative(repoRoot, target));
      }
    }
    expect(unresolved).toEqual([]);
    expect(outside).toEqual([]);
    expect(visited.size).toBeGreaterThan(entries.length);
  });
});
