import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TaskLedger, fingerprintSource, type WorkspaceOrigin } from "./task-ledger";
import { configuredChecks } from "./code-check";

export interface ImportSnapshot {
  sourcePath: string;
  managedPath: string;
  kind: "git" | "copy";
  importedAt: string;
  files: Record<string, string>;
  excluded: string[];
}

const SKIP_DIRS = new Set([".git", ".alpha", ".venv", "venv", "node_modules", "dist", "build", "release", "target", ".next", ".cache", "coverage", "__pycache__"]);
const SECRET = /^(?:\.env(?:\..*)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|p12|pfx|key)$/i;

function allowed(path: string): boolean {
  const parts = path.split("/");
  return parts.every((part, index) => !SKIP_DIRS.has(part) && !SECRET.test(part) && (index < parts.length - 1 || !/\.log$/i.test(part)));
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

async function git(source: string, args: string[]): Promise<{ code: number; output: string; error: string }> {
  const child = Bun.spawn(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output, error };
}

async function sourceFiles(source: string, dataRoot: string): Promise<{ kind: "git" | "copy"; files: string[] }> {
  const root = await git(source, ["rev-parse", "--show-toplevel"]).catch(() => ({ code: 1, output: "", error: "" }));
  if (root.code !== 0) {
    const temporary = join(dataRoot, "imports", `ignore-${randomUUID()}.git`);
    await mkdir(dirname(temporary), { recursive: true });
    const init = Bun.spawn(["git", "init", "--bare", temporary], { stdout: "pipe", stderr: "pipe" });
    if (await init.exited !== 0) throw new Error("Git is required to honor ignore rules during non-Git import");
    try {
      const child = Bun.spawn(["git", `--git-dir=${temporary}`, `--work-tree=${source}`, "ls-files", "--others", "--exclude-standard", "-z"], { cwd: source, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`Cannot apply project ignore rules: ${error.slice(0, 300)}`);
      return { kind: "copy", files: output.split("\0").filter(Boolean).sort() };
    } finally {
      if (!inside(resolve(dataRoot), resolve(temporary))) throw new Error("Unexpected import temporary path");
      await rm(temporary, { recursive: true, force: true });
    }
  }
  if (resolve(root.output.trim()).toLowerCase() !== source.toLowerCase()) throw new Error("Choose the Git repository root for import");
  const listed = await git(source, ["ls-files", "-c", "-o", "--exclude-standard", "-z"]);
  if (listed.code !== 0) throw new Error(`Cannot list Git snapshot: ${listed.error.slice(0, 300)}`);
  return { kind: "git", files: [...new Set(listed.output.split("\0").filter(Boolean))].sort() };
}

/** Imports a checked snapshot without changing source working files. Exclusions are recorded, never silently substituted. */
export async function importCodeWorkspace(input: { sourcePath: string; productsRoot: string; dataRoot: string; objective: string; modelSelector?: string }): Promise<TaskLedger> {
  const sourcePath = await realpath(resolve(input.sourcePath));
  if (!(await lstat(sourcePath)).isDirectory()) throw new Error("Import source must be a directory");
  const productsRoot = resolve(input.productsRoot);
  const dataRoot = resolve(input.dataRoot);
  if (inside(sourcePath, productsRoot) || inside(productsRoot, sourcePath)) throw new Error("Import source and managed products must not contain each other");
  const id = randomUUID();
  const managedPath = join(productsRoot, `import-${id}`);
  const manifestFile = join(dataRoot, "imports", `${id}.json`);
  const source = await sourceFiles(sourcePath, dataRoot);
  await mkdir(productsRoot, { recursive: true });
  if (source.kind === "git") {
    const result = await git(sourcePath, ["worktree", "add", "--detach", "--no-checkout", managedPath, "HEAD"]);
    if (result.code !== 0) throw new Error(`Cannot create managed Git worktree: ${result.error.slice(0, 400)}`);
  } else await mkdir(managedPath);
  const files: Record<string, string> = {};
  const excluded: string[] = [];
  for (const raw of source.files) {
    const path = raw.split("\\").join("/");
    if (!allowed(path)) { excluded.push(path); continue; }
    const from = resolve(sourcePath, path);
    if (!inside(sourcePath, from)) throw new Error(`Invalid imported path: ${path}`);
    const info = await lstat(from).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue; // Preserve a tracked deletion in the managed worktree.
    if (!info.isFile()) { excluded.push(path); continue; }
    const canonical = await realpath(from);
    if (!inside(sourcePath, canonical)) { excluded.push(path); continue; }
    const destination = resolve(managedPath, path);
    if (!inside(managedPath, destination)) throw new Error(`Invalid managed path: ${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(from, destination);
    files[path] = createHash("sha256").update(await readFile(destination)).digest("hex");
  }
  const snapshot: ImportSnapshot = { sourcePath, managedPath, kind: source.kind, importedAt: new Date().toISOString(), files, excluded };
  await mkdir(dirname(manifestFile), { recursive: true });
  await writeFile(`${manifestFile}.tmp`, JSON.stringify(snapshot, null, 2));
  await rename(`${manifestFile}.tmp`, manifestFile);
  const origin: WorkspaceOrigin = { kind: source.kind, sourcePath, snapshotFile: manifestFile, initialRevision: await fingerprintSource(managedPath), checks: await configuredChecks(managedPath) };
  const ledger = await TaskLedger.create(dataRoot, { objective: input.objective, projectRoot: managedPath, taskType: "code-change", workspaceOrigin: origin,
    modelSelector: input.modelSelector,
    criteria: [{ id: "change", description: "Source changes are reviewable", kind: "asset" }, { id: "check", description: "Configured project checks pass", kind: "test" }],
  });
  return ledger;
}
