/** Standalone helper: copied with Bun outside managed payload directories before the desktop exits. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

export const managedPayloadRoots = ["Alpha.cmd", "release.json", "README.txt", "src", "desktop", "scripts", "presets", "licenses", "runtime", "node_modules", "test", "package.json", "package-lock.json", "LICENSE", "NOTICE"];
export interface UpdateTransaction {
  id: string; root: string; stage: string; backup: string; failed: string; journal: string;
  version: string; previousVersion: string; names: string[]; originalNames: string[];
  state: "prepared" | "applying" | "launching" | "committed" | "rolled-back" | "recovery-needed";
  error?: string; updatedAt?: string; parentPid?: number; executable?: string; args?: string[];
  workspace?: string; readyFile?: string; readyToken?: string;
}
export function payloadPath(root: string, name: string) {
  if (name.includes("\\") || name.split("/").some(part => !part || part === "." || part === ".." || /[\x00-\x1f:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Invalid payload path: " + name);
  const path = resolve(root, name), part = relative(resolve(root), path);
  if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part) || !managedPayloadRoots.includes(name.split("/")[0]!)) throw new Error("Payload path leaves the managed release: " + name);
  return path;
}
export async function payloadHashes(root: string) {
  const files: Record<string, string> = {};
  const names: string[] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      if (name === "release.json") continue;
      const path = payloadPath(root, name);
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) names.push(name);
      else throw new Error("Release contains a link or unsupported entry: " + name);
    }
  }
  await visit(root, "");
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < names.length) {
      const name = names[next++]!;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(payloadPath(root, name))) hash.update(chunk);
      files[name] = hash.digest("hex");
    }
  }));
  return files;
}
export async function verifyUpdatePayload(root: string) {
  const release = JSON.parse(await readFile(join(root, "release.json"), "utf8")) as { format: number; version: string; payload?: Record<string, string> };
  if (release.format !== 3 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version) || !release.payload || !Object.keys(release.payload).length) throw new Error("Update requires a release with complete payload hashes");
  for (const name of Object.keys(release.payload)) payloadPath(root, name);
  const actual = await payloadHashes(root);
  if (Object.keys(actual).length !== Object.keys(release.payload).length || Object.entries(actual).some(([name, hash]) => release.payload![name] !== hash)) throw new Error("Release payload checksum mismatch");
  for (const name of ["desktop/main.cjs", "desktop/preload.cjs", "desktop/dist/index.html", "src/native/server.ts", "runtime/bun.exe", "package.json"]) if (!actual[name]) throw new Error("Required update component missing: " + name);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")); if (pkg.name !== "alpha-agent" || pkg.version !== release.version) throw new Error("Update package identity or version mismatch");
  return release;
}
export async function saveUpdateTransaction(transaction: UpdateTransaction) {
  transaction.updatedAt = new Date().toISOString();
  await mkdir(dirname(transaction.journal), { recursive: true });
  const temporary = transaction.journal + ".tmp";
  await writeFile(temporary, JSON.stringify(transaction, null, 2)); await rename(temporary, transaction.journal);
}
function validateTransaction(transaction: UpdateTransaction) {
  if (!/^[0-9a-f-]{36}$/.test(transaction.id) || !isAbsolute(transaction.root)) throw new Error("Invalid update transaction");
  const base = join(dirname(transaction.root), ".alpha-update-" + transaction.id);
  if (transaction.stage !== base + ".stage" || transaction.backup !== base + ".backup" || transaction.failed !== base + ".failed" || transaction.names.some(name => !managedPayloadRoots.includes(name))) throw new Error("Update directories leave their transaction scope");
}
async function rollback(transaction: UpdateTransaction) {
  await mkdir(transaction.failed, { recursive: true });
  for (const name of [...transaction.names].reverse()) {
    const current = payloadPath(transaction.root, name), backup = payloadPath(transaction.backup, name), staged = payloadPath(transaction.stage, name);
    if (existsSync(backup)) {
      if (existsSync(current)) await rename(current, payloadPath(transaction.failed, name));
      await rename(backup, current);
    } else if (!transaction.originalNames.includes(name) && !existsSync(staged) && existsSync(current)) await rename(current, payloadPath(transaction.failed, name));
  }
  transaction.state = "rolled-back"; await saveUpdateTransaction(transaction);
}
export async function applyUpdateTransaction(transaction: UpdateTransaction, verifyStartup: (transaction: UpdateTransaction) => Promise<void>) {
  validateTransaction(transaction);
  if (transaction.state !== "prepared") throw new Error("Update is not prepared");
  await verifyUpdatePayload(transaction.stage);
  const previous = JSON.parse(await readFile(join(transaction.root, "release.json"), "utf8"));
  if (previous.version !== transaction.previousVersion) throw new Error("Installed version changed after preparation");
  await mkdir(transaction.backup, { recursive: false }); transaction.state = "applying"; await saveUpdateTransaction(transaction);
  try {
    for (const name of transaction.names) {
      const current = payloadPath(transaction.root, name), staged = payloadPath(transaction.stage, name);
      if (existsSync(current)) await rename(current, payloadPath(transaction.backup, name));
      if (existsSync(staged)) await rename(staged, current);
    }
    transaction.state = "launching"; await saveUpdateTransaction(transaction);
    await verifyStartup(transaction);
    transaction.state = "committed"; await saveUpdateTransaction(transaction);
  } catch (error) {
    transaction.error = String(error);
    try { await rollback(transaction); } catch (recovery) { transaction.state = "recovery-needed"; transaction.error += "\nRollback: " + String(recovery); await saveUpdateTransaction(transaction); }
    throw error;
  }
}
export async function recoverUpdateTransaction(transaction: UpdateTransaction) {
  validateTransaction(transaction);
  if (!["applying", "launching", "recovery-needed"].includes(transaction.state)) throw new Error("Update does not need recovery");
  await rollback(transaction);
}
async function waitForExit(pid: number) {
  for (let count = 0; count < 240; count++) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await Bun.sleep(250);
  }
  throw new Error("Desktop did not exit; installation stopped");
}
async function launchDesktop(transaction: UpdateTransaction, ready = false) {
  const child = spawn(transaction.executable!, transaction.args ?? [], { cwd: transaction.root, env: { ...process.env, ALPHA_WORKSPACE_ROOT: transaction.workspace, ...(ready ? { ALPHA_UPDATE_READY_FILE: transaction.readyFile, ALPHA_UPDATE_READY_TOKEN: transaction.readyToken, ALPHA_UPDATE_TRANSACTION_ID: transaction.id } : {}) }, stdio: "ignore", windowsHide: true, detached: true });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return child;
}
export async function runAppUpdateHelper(journal: string) {
  const transaction: UpdateTransaction = JSON.parse(await readFile(journal, "utf8"));
  if (!transaction.parentPid || !transaction.executable || !transaction.readyFile || !transaction.readyToken) throw new Error("Incomplete desktop update handoff");
  try {
    await waitForExit(transaction.parentPid);
    if (process.argv.includes("--recover")) {
      await recoverUpdateTransaction(transaction);
      (await launchDesktop(transaction)).unref();
      return;
    }
    await applyUpdateTransaction(transaction, async current => {
      const child = await launchDesktop(current, true);
      try {
        for (let count = 0; count < 360; count++) {
          const ready = await readFile(current.readyFile!, "utf8").then(JSON.parse).catch(() => null);
          if (ready?.id === current.id && ready.token === current.readyToken && ready.version === current.version) { child.unref(); return; }
          if (child.exitCode !== null) throw new Error("Updated desktop exited before startup confirmation");
          await Bun.sleep(250);
        }
        throw new Error("Updated desktop did not confirm startup");
      } catch (error) {
        if (child.exitCode === null) {
          if (process.platform === "win32") await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
          else child.kill();
        }
        if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve)); throw error;
      }
    });
  } catch (error) {
    transaction.error = String(error); await saveUpdateTransaction(transaction);
    if (transaction.state === "rolled-back" || transaction.state === "prepared") (await launchDesktop(transaction)).unref();
    throw error;
  }
}
if (import.meta.main) {
  try { await runAppUpdateHelper(resolve(process.argv[2] ?? "")); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
