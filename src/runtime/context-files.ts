import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

// The convention files other agents already read; only the workspace root is consulted.
const NAMES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", join(".github", "copilot-instructions.md")];
const FILE_LIMIT = 24_000;
const TOTAL_LIMIT = 48_000;

export interface ContextFile { path: string; content: string }

/**
 * Project convention files at the root of the assigned workspace, handed to OMP, which renders them in its prompt;
 * Alpha's runtime contract states that they cannot change permissions or acceptance gates.
 *
 * Unlike OMP's discovery this never walks into parent directories (Alpha's own repository or the
 * user's home would leak in) and never expands `@path` imports, which could pull files from outside
 * the sandboxed roots into the prompt. Symbolic links are skipped for the same reason.
 */
export async function projectContextFiles(root: string): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  let total = 0;
  for (const name of NAMES) {
    const path = join(root, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) continue;
    let content = (await readFile(path, "utf8").catch(() => "")).trim();
    if (!content) continue;
    if (content.length > FILE_LIMIT) content = `${content.slice(0, FILE_LIMIT)}\n\n[Alpha truncated this file at ${FILE_LIMIT} characters.]`;
    if (total + content.length > TOTAL_LIMIT) break;
    total += content.length;
    files.push({ path: name.replaceAll("\\", "/"), content });
  }
  return files;
}
