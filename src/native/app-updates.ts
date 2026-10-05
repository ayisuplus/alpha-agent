import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { compareVersions } from "@oh-my-pi/pi-utils";
import { managedPayloadRoots, saveUpdateTransaction, verifyUpdatePayload, type UpdateTransaction } from "./app-update-installer";
import { replaceNativeConfiguration } from "./configuration";
import { safeUrl } from "./config-redaction";

type ReleaseSource = { version: string; url: string; sha256: string };
const optional = (path: string) => readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
const maximumDownload = 4 * 1024 ** 3;
function webSource(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Update URLs require HTTPS or a loopback service");
  return url;
}
export class AppUpdates {
  readonly directory: string;
  #controller: AbortController | null = null;
  #phase = "idle";
  #error: string | null = null;
  constructor(readonly root: string, readonly workspace: string, readonly current: string) { this.directory = join(workspace, ".alpha", "updates"); }
  private async source() { return JSON.parse(await optional(join(this.directory, "config.json")) ?? "{}").source as string | undefined; }
  async status() {
    const source = await this.source();
    const rows = await readdir(join(this.directory, "transactions")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const transactions = await Promise.all(rows.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(this.directory, "transactions", name), "utf8")) as UpdateTransaction));
    transactions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { current: this.current, installed: existsSync(join(this.root, "release.json")), source: source ? /^https?:/i.test(source) && safeUrl(source) !== source ? "••••" : source : null, phase: this.#phase, error: this.#error, transactions: transactions.slice(0, 10).map(row => ({ id: row.id, state: row.state, version: row.version, previousVersion: row.previousVersion, updatedAt: row.updatedAt, error: row.error, backup: row.state === "committed" || row.state === "rolled-back" || row.state === "recovery-needed" ? row.backup : undefined })) };
  }
  async configure(source: unknown) {
    if (typeof source !== "string" || source.length > 4096) throw new Error("Invalid update source");
    if (source === "••••") return this.status();
    if (source && /^https?:/i.test(source)) webSource(source);
    const path = join(this.directory, "config.json"), previous = await optional(path);
    await replaceNativeConfiguration(path, JSON.stringify({ source }), previous); return this.status();
  }
  async check() {
    const source = await this.source(); if (!source) return { ...await this.status(), available: false, latest: null };
    try {
      const manifest = await this.manifest(source, AbortSignal.timeout(15000)); this.#error = null;
      return { ...await this.status(), latest: manifest.version, available: compareVersions(manifest.version, this.current) > 0 };
    } catch (error) { this.#error = String(error); throw error; }
  }
  private async manifest(source: string, signal: AbortSignal): Promise<ReleaseSource> {
    let raw: string;
    if (/^https?:/i.test(source)) {
      const response = await fetch(webSource(source), { signal, redirect: "error" }); if (!response.ok) throw new Error("Update manifest HTTP " + response.status);
      const chunks: Uint8Array[] = []; let size = 0;
      if (!response.body) throw new Error("Update manifest is empty");
      for await (const chunk of response.body) { size += chunk.length; if (size > 100000) throw new Error("Update manifest is too large"); chunks.push(chunk); }
      raw = Buffer.concat(chunks).toString("utf8");
    } else raw = await readFile(resolve(this.workspace, source), "utf8");
    if (raw.length > 100000) throw new Error("Update manifest is too large");
    const value = JSON.parse(raw) as ReleaseSource;
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) || typeof value.url !== "string" || !/^[0-9a-f]{64}$/i.test(value.sha256)) throw new Error("Update manifest requires version, url and SHA256");
    value.url = /^https?:/i.test(source) ? webSource(new URL(value.url, source).toString()).toString() : /^https?:/i.test(value.url) ? webSource(value.url).toString() : resolve(dirname(resolve(this.workspace, source)), value.url);
    return value;
  }
  cancel() { this.#controller?.abort(new Error("Update preparation cancelled")); return this.status(); }
  async prepare(input: { path?: string }) {
    if (this.#controller) throw new Error("An update is already being prepared");
    if (!existsSync(join(this.root, "release.json"))) throw new Error("In-place updates require an installed Alpha release");
    const controller = new AbortController(); this.#controller = controller; this.#phase = "preparing"; this.#error = null;
    const id = randomUUID(), journal = join(this.directory, "transactions", id + ".json"), base = join(dirname(this.root), ".alpha-update-" + id);
    const stage = base + ".stage";
    try {
      await mkdir(this.directory, { recursive: true }); await mkdir(stage, { recursive: false });
      let candidate = input.path ? resolve(this.workspace, input.path) : "", expectedVersion: string | undefined;
      if (!candidate) {
        const source = await this.source(); if (!source) throw new Error("No application update source is configured");
        const manifest = await this.manifest(source, controller.signal); expectedVersion = manifest.version;
        candidate = join(this.directory, id + ".zip");
        const hash = createHash("sha256"); let size = 0;
        if (/^https?:/i.test(manifest.url)) {
          const response = await fetch(webSource(manifest.url), { signal: controller.signal, redirect: "error" });
          if (!response.ok || !response.body) throw new Error("Update download HTTP " + response.status);
          const writer = Bun.file(candidate).writer();
          try { for await (const chunk of response.body) { size += chunk.length; if (size > maximumDownload) throw new Error("Update download exceeds 4 GB"); hash.update(chunk); writer.write(chunk); await writer.flush(); } }
          finally { await writer.end(); }
        } else {
          if ((await stat(manifest.url)).size > maximumDownload) throw new Error("Update archive exceeds 4 GB");
          await cp(manifest.url, candidate); for await (const chunk of createReadStream(candidate)) hash.update(chunk);
        }
        if (hash.digest("hex") !== manifest.sha256.toLowerCase()) throw new Error("Update archive SHA256 mismatch");
      }
      controller.signal.throwIfAborted();
      if ((await stat(candidate)).isDirectory()) { await verifyUpdatePayload(candidate); await cp(candidate, stage, { recursive: true, force: false, errorOnExist: true }); }
      else {
        const extraction = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(this.root, "scripts", "extract-app-update.ps1"), "-Archive", candidate, "-Destination", stage], { stdout: "pipe", stderr: "pipe", windowsHide: true });
        const [code, error] = await Promise.all([extraction.exited, new Response(extraction.stderr).text()]); if (code !== 0) throw new Error("Update extraction failed: " + error);
      }
      controller.signal.throwIfAborted();
      const release = await verifyUpdatePayload(stage);
      if (expectedVersion && release.version !== expectedVersion) throw new Error("Downloaded package version differs from its update manifest");
      if (compareVersions(release.version, this.current) <= 0) throw new Error("The selected package is not newer than this Alpha version");
      const originalNames = managedPayloadRoots.filter(name => existsSync(join(this.root, name)));
      const names = managedPayloadRoots.filter(name => originalNames.includes(name) || existsSync(join(stage, name)));
      const transaction: UpdateTransaction = { id, root: this.root, stage, backup: base + ".backup", failed: base + ".failed", journal, version: release.version, previousVersion: this.current, state: "prepared", names, originalNames };
      await saveUpdateTransaction(transaction);
      this.#phase = "prepared"; return { id, version: release.version, ...await this.status() };
    } catch (error) { this.#phase = "failed"; this.#error = String(error); throw error; }
    finally { this.#controller = null; }
  }
  async handoff(id: unknown, input: { parentPid: number; executable: string; args: string[] }) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid prepared update");
    const journal = join(this.directory, "transactions", id + ".json");
    const transaction: UpdateTransaction = JSON.parse(await readFile(journal, "utf8"));
    const recovery = ["applying", "launching", "recovery-needed"].includes(transaction.state);
    if (transaction.root !== this.root || !recovery && (transaction.state !== "prepared" || transaction.previousVersion !== this.current)) throw new Error("Update is not prepared for this installation");
    if (!recovery) await verifyUpdatePayload(transaction.stage);
    const helper = join(this.directory, id + "-helper"); await mkdir(helper, { recursive: true });
    if (!recovery) {
      await cp(join(this.root, "runtime", "bun.exe"), join(helper, "bun.exe"));
      await cp(join(this.root, "src", "native", "app-update-installer.ts"), join(helper, "apply-app-update.ts"));
    }
    Object.assign(transaction, input, { workspace: this.workspace, readyFile: join(helper, "ready.json"), readyToken: randomUUID() });
    await saveUpdateTransaction(transaction);
    return { executable: join(helper, "bun.exe"), args: ["run", join(helper, "apply-app-update.ts"), journal, ...(recovery ? ["--recover"] : [])] };
  }
}
