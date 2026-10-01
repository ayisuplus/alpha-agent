import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyUpdateTransaction, managedPayloadRoots, payloadHashes, payloadPath, recoverUpdateTransaction, saveUpdateTransaction, verifyUpdatePayload, type UpdateTransaction } from "../scripts/apply-app-update";
import { AppUpdates } from "../src/native/app-updates";

async function release(root: string, version: string) {
  const files: Record<string, string> = { "desktop/main.cjs": "fixture " + version, "desktop/preload.cjs": "fixture", "desktop/dist/index.html": "fixture", "src/native/server.ts": "fixture " + version, "runtime/bun.exe": "fixture", "package.json": JSON.stringify({ name: "alpha-agent", version }) };
  for (const [name, content] of Object.entries(files)) { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  await writeFile(join(root, "release.json"), JSON.stringify({ format: 3, version, payload: await payloadHashes(root) }));
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "alpha-update-test-")), root = join(directory, "Alpha"), workspace = join(directory, "user-data");
  await release(root, "0.2.1"); await mkdir(workspace); const id = randomUUID(), base = join(directory, ".alpha-update-" + id), stage = base + ".stage";
  await release(stage, "0.3.0");
  const originalNames = await readdir(root), names = managedPayloadRoots.filter(name => originalNames.includes(name));
  const transaction: UpdateTransaction = { id, root, stage, backup: base + ".backup", failed: base + ".failed", journal: join(workspace, "transaction.json"), version: "0.3.0", previousVersion: "0.2.1", names, originalNames, state: "prepared" };
  await saveUpdateTransaction(transaction); return { directory, root, workspace, stage, transaction };
}
test("release update backs up managed payload and preserves local data and user files", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "my-project.txt"), "USER_BYTES"); await mkdir(join(f.root, ".alpha")); await writeFile(join(f.root, ".alpha", "session.json"), "SESSION_BYTES");
    await applyUpdateTransaction(f.transaction, async transaction => { expect(JSON.parse(await readFile(join(transaction.root, "release.json"), "utf8")).version).toBe("0.3.0"); expect(await readFile(join(transaction.root, "src/native/server.ts"), "utf8")).toBe("fixture 0.3.0"); });
    expect(f.transaction.state).toBe("committed"); expect((await verifyUpdatePayload(f.transaction.backup)).version).toBe("0.2.1");
    expect(await readFile(join(f.root, "my-project.txt"), "utf8")).toBe("USER_BYTES"); expect(await readFile(join(f.root, ".alpha", "session.json"), "utf8")).toBe("SESSION_BYTES");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("startup failure restores the old release and keeps failed new payload for diagnosis", async () => {
  const f = await fixture();
  try {
    const error = await applyUpdateTransaction(f.transaction, async () => { throw new Error("STARTUP_FAILURE"); }).catch(String);
    expect(error).toContain("STARTUP_FAILURE"); expect(f.transaction.state).toBe("rolled-back");
    expect((await verifyUpdatePayload(f.root)).version).toBe("0.2.1");
    expect((await verifyUpdatePayload(f.transaction.failed)).version).toBe("0.3.0");
    expect(JSON.parse(await readFile(f.transaction.journal, "utf8")).error).toContain("STARTUP_FAILURE");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("checksums, scope validation and stale installed versions stop before replacement", async () => {
  const f = await fixture();
  try {
    expect(() => payloadPath(f.root, "../outside")).toThrow(); expect(() => payloadPath(f.root, "desktop/file:secret")).toThrow();
    await writeFile(join(f.stage, "desktop/main.cjs"), "TAMPERED");
    expect(await applyUpdateTransaction(f.transaction, async () => {}).catch(String)).toContain("checksum");
    expect((await verifyUpdatePayload(f.root)).version).toBe("0.2.1");
    await release(f.stage, "0.3.0"); f.transaction.previousVersion = "0.1.0";
    expect(await applyUpdateTransaction(f.transaction, async () => {}).catch(String)).toContain("changed"); expect((await verifyUpdatePayload(f.root)).version).toBe("0.2.1");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("an interrupted transaction can recover without deleting unrelated files", async () => {
  const f = await fixture();
  try {
    await mkdir(f.transaction.backup); await rename(join(f.root, "desktop"), join(f.transaction.backup, "desktop")); await rename(join(f.stage, "desktop"), join(f.root, "desktop"));
    await writeFile(join(f.root, "notes.txt"), "KEEP"); f.transaction.state = "applying"; await saveUpdateTransaction(f.transaction);
    await recoverUpdateTransaction(f.transaction); expect(String(f.transaction.state)).toBe("rolled-back");
    expect(await readFile(join(f.root, "desktop/main.cjs"), "utf8")).toBe("fixture 0.2.1"); expect(await readFile(join(f.root, "notes.txt"), "utf8")).toBe("KEEP");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("local preparation, persisted update sources and actual loopback manifest validation", async () => {
  const f = await fixture(); let service: ReturnType<typeof Bun.serve> | undefined;
  try {
    const manager = new AppUpdates(f.root, f.workspace, "0.2.1"); expect((await manager.check()).source).toBe(null);
    service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "0.3.0", url: "/package.zip", sha256: "0".repeat(64) }) });
    await manager.configure(`http://127.0.0.1:${service.port}/manifest.json`); expect((await manager.check()).available).toBe(true);
    const cold = new AppUpdates(f.root, f.workspace, "0.2.1"); expect((await cold.status()).source).toContain("manifest.json");
    const prepared = await cold.prepare({ path: f.stage }); expect(prepared.version).toBe("0.3.0"); expect(prepared.transactions[0]?.state).toBe("prepared");
    const transaction = JSON.parse(await readFile(join(cold.directory, "transactions", prepared.id + ".json"), "utf8")) as UpdateTransaction;
    await rm(transaction.stage, { recursive: true, force: true });
    expect(await manager.configure("http://untrusted.example/manifest").catch(String)).toContain("HTTPS");
  } finally { service?.stop(true); await rm(f.directory, { recursive: true, force: true }); }
});
test("Windows helper waits for the old process and confirms a real restarted Bun process", async () => {
  const f = await fixture(); let helper: ReturnType<typeof Bun.spawn> | undefined, parent: ReturnType<typeof Bun.spawn> | undefined, restartedPid: number | undefined;
  try {
    for (const root of [f.root, f.stage]) {
      await cp(process.execPath, join(root, "runtime/bun.exe")); await mkdir(join(root, "scripts"));
      await cp(join(import.meta.dir, "../scripts/apply-app-update.ts"), join(root, "scripts/apply-app-update.ts"));
      await cp(join(import.meta.dir, "../src/native/app-update-installer.ts"), join(root, "src/native/app-update-installer.ts"));
      await writeFile(join(root, "scripts/update-fixture.ts"), 'import { writeFileSync } from "node:fs";\nif(process.env.ALPHA_UPDATE_READY_FILE) writeFileSync(process.env.ALPHA_UPDATE_READY_FILE,JSON.stringify({id:process.env.ALPHA_UPDATE_TRANSACTION_ID,token:process.env.ALPHA_UPDATE_READY_TOKEN,version:"0.3.0",pid:process.pid}));\nawait Bun.sleep(30000);\n');
      const manifest = JSON.parse(await readFile(join(root, "release.json"), "utf8")); manifest.payload = await payloadHashes(root); await writeFile(join(root, "release.json"), JSON.stringify(manifest));
    }
    const manager = new AppUpdates(f.root, f.workspace, "0.2.1"), prepared = await manager.prepare({ path: f.stage });
    parent = Bun.spawn([join(f.root, "runtime/bun.exe"), "-e", "await Bun.sleep(1000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    const handoff = await manager.handoff(prepared.id, { parentPid: parent.pid, executable: join(f.root, "runtime/bun.exe"), args: ["run", join(f.root, "scripts/update-fixture.ts")] });
    helper = Bun.spawn([handoff.executable, ...handoff.args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const journal = join(manager.directory, "transactions", prepared.id + ".json");
    let transaction: UpdateTransaction | undefined;
    for (let count = 0; count < 150; count++) { transaction = JSON.parse(await readFile(journal, "utf8")); if (transaction?.state === "committed" || transaction?.error) break; await Bun.sleep(100); }
    const ready = transaction?.readyFile ? JSON.parse(await readFile(transaction.readyFile, "utf8")) : null; restartedPid = ready?.pid;
    expect(transaction?.error).toBeUndefined(); expect(transaction?.state).toBe("committed"); expect(ready?.version).toBe("0.3.0"); expect(restartedPid).toBeGreaterThan(0);
    expect(await helper.exited).toBe(0); expect((await manager.status()).transactions[0]?.state).toBe("committed");
    expect((await verifyUpdatePayload(f.root)).version).toBe("0.3.0");
    if (transaction) for (const path of [transaction.stage, transaction.backup]) await rm(path, { recursive: true, force: true });
  } finally {
    if (restartedPid) { try { process.kill(restartedPid); } catch {} }
    parent?.kill(); helper?.kill(); await parent?.exited; await helper?.exited; await Bun.sleep(150);
    await rm(f.directory, { recursive: true, force: true });
  }
}, 30000);

test("download checksum and cancellation fail before any installed bytes change", async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), releaseDownload = Promise.withResolvers<void>(); let block = false;
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/manifest") return Response.json({ version: "0.3.0", url: "/package.zip", sha256: "0".repeat(64) });
    if (block) { started.resolve(); await releaseDownload.promise; } return new Response("INCORRECT_ZIP_BYTES");
  } });
  try {
    const manager = new AppUpdates(f.root, f.workspace, "0.2.1"); await manager.configure(`http://127.0.0.1:${service.port}/manifest?token=fixture-secret`);
    expect((await manager.status()).source).toBe("••••"); await manager.configure("••••");
    expect(await manager.prepare({}).catch(String)).toContain("SHA256");
    block = true; const pending = manager.prepare({}).catch(String); await started.promise; await manager.cancel();
    expect(await pending).toContain("cancelled"); expect((await verifyUpdatePayload(f.root)).version).toBe("0.2.1");
  } finally { releaseDownload.resolve(); service.stop(true); await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

test("actual Windows ZIP extraction rejects traversal before creating any outside file", async () => {
  const f = await fixture();
  try {
    const archive = join(f.workspace, "malicious.zip"), destination = join(f.workspace, "extract"); await mkdir(destination);
    const create = join(f.workspace, "create.ps1");
    await writeFile(create, 'param([string]$Archive)\n$ErrorActionPreference="Stop"\nAdd-Type -AssemblyName System.IO.Compression\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$zip=[System.IO.Compression.ZipFile]::Open($Archive,[System.IO.Compression.ZipArchiveMode]::Create)\ntry { $entry=$zip.CreateEntry("../outside.txt"); $stream=[System.IO.StreamWriter]::new($entry.Open()); $stream.Write("FORBIDDEN"); $stream.Dispose() } finally { $zip.Dispose() }');
    const maker = Bun.spawn(["powershell.exe", "-NoProfile", "-File", create, "-Archive", archive], { stdout: "ignore", stderr: "pipe", windowsHide: true }); expect(await maker.exited).toBe(0);
    const extract = Bun.spawn(["powershell.exe", "-NoProfile", "-File", join(import.meta.dir, "../scripts/extract-app-update.ps1"), "-Archive", archive, "-Destination", destination], { stdout: "ignore", stderr: "pipe", windowsHide: true });
    const [code, error] = await Promise.all([extract.exited, new Response(extract.stderr).text()]); expect(code).not.toBe(0); expect(error).toContain("Invalid");
    expect(await Bun.file(join(f.workspace, "outside.txt")).exists()).toBe(false); expect(await readdir(destination)).toHaveLength(0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);

test("a real failed Windows startup rolls back and relaunches the previous payload", async () => {
  const f = await fixture(); let helper: ReturnType<typeof Bun.spawn> | undefined, parent: ReturnType<typeof Bun.spawn> | undefined, oldPid: number | undefined;
  try {
    const marker = join(f.workspace, "old-restarted.json");
    for (const root of [f.root, f.stage]) {
      await cp(process.execPath, join(root, "runtime/bun.exe")); await mkdir(join(root, "scripts")); await cp(join(import.meta.dir, "../scripts/apply-app-update.ts"), join(root, "scripts/apply-app-update.ts"));
      await cp(join(import.meta.dir, "../src/native/app-update-installer.ts"), join(root, "src/native/app-update-installer.ts"));
      await writeFile(join(root, "scripts/start.ts"), root === f.stage ? "process.exit(7);" : `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid})); await Bun.sleep(30000);`);
      const manifest = JSON.parse(await readFile(join(root, "release.json"), "utf8")); manifest.payload = await payloadHashes(root); await writeFile(join(root, "release.json"), JSON.stringify(manifest));
    }
    const manager = new AppUpdates(f.root, f.workspace, "0.2.1"), prepared = await manager.prepare({ path: f.stage });
    parent = Bun.spawn([join(f.root, "runtime/bun.exe"), "-e", "await Bun.sleep(600)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    const handoff = await manager.handoff(prepared.id, { parentPid: parent.pid, executable: join(f.root, "runtime/bun.exe"), args: ["run", join(f.root, "scripts/start.ts")] });
    helper = Bun.spawn([handoff.executable, ...handoff.args], { stdout: "ignore", stderr: "pipe", windowsHide: true });
    expect(await helper.exited).not.toBe(0);
    for (let count = 0; count < 50 && !await Bun.file(marker).exists(); count++) await Bun.sleep(100);
    oldPid = JSON.parse(await readFile(marker, "utf8")).pid; expect(oldPid).toBeGreaterThan(0);
    const transaction = JSON.parse(await readFile(join(manager.directory, "transactions", prepared.id + ".json"), "utf8")) as UpdateTransaction;
    expect(transaction.state).toBe("rolled-back"); expect((await verifyUpdatePayload(f.root)).version).toBe("0.2.1");
    for (const path of [transaction.stage, transaction.backup, transaction.failed]) await rm(path, { recursive: true, force: true });
  } finally { if (oldPid) { try { process.kill(oldPid); } catch {} } parent?.kill(); helper?.kill(); await parent?.exited; await helper?.exited; await Bun.sleep(150); await rm(f.directory, { recursive: true, force: true }); }
}, 30_000);
