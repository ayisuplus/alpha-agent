import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

interface Request { action: "read" | "grep" | "edit" | "write"; editMode?: string; cwd: string; roots: string[]; full?: boolean; allowCredential?: boolean; allowMetadata?: boolean; args: Record<string, unknown>; nativePath: string }
const request = JSON.parse(await Bun.stdin.text()) as Request;
const native = await import(pathToFileURL(request.nativePath).href) as typeof import("@oh-my-pi/pi-natives");
const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const credential = (path: string) => /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.codex|\.npmrc|\.env(?:\.[^\\/]*)?|credentials?(?:\.[^\\/]*)?|id_(?:rsa|ed25519)|auth\.json|user data)(?:[\\/]|$)/i.test(path);

async function target(raw: unknown, write: boolean): Promise<string> {
  if (typeof raw !== "string" || !raw || /[\r\n\0]/.test(raw)) throw new Error("Invalid file target");
  const path = resolve(request.cwd, raw);
  if (credential(path) && !request.allowCredential) throw new Error("Known credential location requires separate user approval");
  if (write && !request.full && !request.roots.some(root => inside(root, path))) throw new Error("File target is outside mounted folders");
  let cursor = path;
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symbolic link or junction is not allowed: ${cursor}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  let existing = dirname(path);
  while (true) {
    try { await lstat(existing); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const upper = dirname(existing);
    if (upper === existing) throw new Error("File parent does not exist");
    existing = upper;
  }
  const parent = await realpath(existing);
  if (write && !request.full && !request.roots.some(root => inside(root, parent))) throw new Error("Resolved parent is outside mounted folders");
  if (write && !request.allowMetadata && (/[\\/]\.git(?:[\\/]|$)/i.test(path) || /[\\/]\.alpha(?:[\\/]|$)/i.test(path))) throw new Error("Protected project metadata");
  return path;
}

async function run(): Promise<string> {
  const args = request.args;
  if (request.action === "read") {
    const path = await target(args.path, false);
    const info = await stat(path);
    if (!info.isFile() || info.size > 4_000_000) throw new Error("Read requires a text file smaller than 4 MB");
    const text = await readFile(path, "utf8");
    if (text.includes("\0")) throw new Error("Binary files are not supported by this tool");
    const offset = typeof args.offset === "number" && Number.isInteger(args.offset) ? Math.max(1, args.offset) : 1;
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(400, Math.max(1, args.limit)) : 200;
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const shown = lines.slice(offset - 1, offset - 1 + limit).join("\n");
    if (shown.length > 1_000_000) throw new Error("Read result is too large; select a smaller line range");
    const more = offset - 1 + limit < lines.length ? `\n[Showing ${offset}-${offset - 1 + limit} of ${lines.length} lines]` : "";
    // Only Hashline edits consume line anchors; other formats need the exact text to quote from.
    if ((request.editMode ?? "hashline") !== "hashline") return `${shown}${more}`;
    const tag = native.hashlineFileHash(text);
    return `${native.hashlineFormatHeader(path, tag)}\n${native.hashlineFormatNumberedLines(shown, offset)}${more}`;
  }
  if (request.action === "grep") {
    if (typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 500) throw new Error("Invalid search pattern");
    const regex = new RegExp(args.pattern, args.case === true ? "g" : "gi");
    const start = await target(args.path ?? ".", false);
    if (!request.full && !request.roots.some(root => inside(root, start)) && (await stat(start)).isDirectory()) throw new Error("Search outside mounts requires an explicit file");
    const found: string[] = [];
    let visited = 0;
    const walk = async (path: string): Promise<void> => {
      if (found.length >= 80 || visited >= 2000) return;
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        if (/[\\/](?:node_modules|\.git|\.alpha|dist|build)$/i.test(path)) return;
        for (const name of await readdir(path)) await walk(resolve(path, name));
      } else if (info.isFile() && info.size < 1_000_000 && (!credential(path) || request.allowCredential)) {
        visited++;
        const text = await readFile(path, "utf8");
        if (text.includes("\0")) return;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && found.length < 80; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i]!)) found.push(`${path}:${i + 1}:${lines[i]!.slice(0, 300)}`);
        }
      }
    };
    await walk(start);
    return found.join("\n") || "No matches";
  }
  if (request.action === "write") {
    const path = await target(args.path, true);
    if (typeof args.content !== "string" || args.content.length > 4_000_000) throw new Error("Invalid file content");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, args.content, { flag: "wx" });
    return `Created ${path}`;
  }
  if (request.action === "edit") {
    const mode = request.editMode ?? "hashline";
    const argsJson = JSON.stringify(args);
    if (argsJson.length > 1_000_000) throw new Error("Edit payload is too large");
    const inspection = native.editInspect(mode, argsJson);
    if (!inspection.paths.length) throw new Error("Edit has no inspectable file targets");
    const paths = await Promise.all(inspection.paths.map(path => target(path, true)));
    const store = new native.EditStore();
    for (const path of paths) store.recordSnapshotFile(path);
    const session = new native.EditSession(store, { cwd: request.cwd, mode, allowFuzzy: false, fuzzyThreshold: 0, enforceSeenLines: false, blockAutoGenerated: false, planActive: false, homeDir: request.cwd, rawInput: false });
    session.setArgsJson(argsJson);
    session.finish();
    try {
      const result = await session.apply({ lspFlush: false }, async (error, write) => {
        if (error) throw error;
        const source = await target(write.path, true);
        if (write.moveTo) await target(write.moveTo, true);
        if (write.op === "delete") { await rm(source); return { written: "" }; }
        if (write.content === undefined) throw new Error("Edit omitted content");
        if (write.op === "move") {
          await mkdir(dirname(write.moveTo!), { recursive: true });
          await writeFile(write.moveTo!, write.content, { flag: "wx" });
          await rm(source);
          return { written: write.content };
        }
        if (write.op === "create") await mkdir(dirname(source), { recursive: true });
        await writeFile(source, write.content, { flag: write.op === "create" ? "wx" : "w" });
        return { written: write.content };
      });
      if (result.isError) throw new Error(result.text);
      return result.text;
    } finally { session.close(); }
  }
  throw new Error("Unknown file action");
}

try { process.stdout.write(`__ALPHA_FILE_RESULT__${JSON.stringify({ text: await run() })}\n`); }
catch (error) { process.stdout.write(`__ALPHA_FILE_RESULT__${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; }
