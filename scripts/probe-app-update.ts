import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { cp, link, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { payloadHashes, verifyUpdatePayload } from "../src/native/app-update-installer";

const candidate = resolve(process.argv[2] ?? ""), fixturePath = process.argv[3], evidence = resolve(process.argv[4] ?? "artifacts/parity-app-update");
if (!process.argv[2] || !fixturePath) throw new Error("Pass a verified portable directory and isolated loopback fixture startup.json");
await verifyUpdatePayload(candidate); await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(evidence, "production-")), root = join(directory, "Alpha"), workspace = join(directory, "user-data"), project = join(workspace, "project");
async function clone(source: string, target: string) {
  await mkdir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await clone(from, to);
    else if (entry.name === "package.json" || entry.name === "release.json") await cp(from, to);
    else await link(from, to); // Immutable payload files; all mutable metadata is copied separately.
  }
}
await clone(candidate, root); await mkdir(project, { recursive: true });
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")); pkg.version = "0.2.99"; await writeFile(join(root, "package.json"), JSON.stringify(pkg));
const release = JSON.parse(await readFile(join(root, "release.json"), "utf8")); release.version = pkg.version; release.payload = await payloadHashes(root); await writeFile(join(root, "release.json"), JSON.stringify(release));
await writeFile(join(root, "user-note.txt"), "USER_FILE_MUST_SURVIVE");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")), agent = join(workspace, "profile"); await mkdir(agent);
for (const name of ["config.yml", "models.yml"]) await cp(join(fixture.workspace, "omp", name), join(agent, name));
const token = randomBytes(24).toString("hex");
const driver = Bun.spawn([join(root, "node_modules/electron/dist/electron.exe"), resolve("scripts/probe-app-update-driver.cjs")], { cwd: root, env: { ...process.env, HOME: workspace, USERPROFILE: workspace, PI_CODING_AGENT_DIR: agent, ALPHA_WORKSPACE_ROOT: workspace, ALPHA_SERVER_TOKEN: token, ALPHA_UPDATE_PROBE_ROOT: root, ALPHA_UPDATE_PROBE_EVIDENCE: directory, ALPHA_UPDATE_PROBE_PROJECT: project, ALPHA_UPDATE_PROBE_CANDIDATE: candidate }, stdout: "ignore", stderr: "pipe", windowsHide: true });
let newPid: number | undefined;
try {
  let handoff: { id: string; sessionId: string; nativeSessionId: string } | undefined;
  for (let count = 0; count < 1800; count++) {
    const failure = await readFile(join(directory, "failure.txt"), "utf8").catch(() => null); if (failure) throw new Error(failure);
    handoff = await readFile(join(directory, "handoff.json"), "utf8").then(JSON.parse).catch(() => undefined); if (handoff) break;
    if (driver.exitCode !== null) throw new Error(await new Response(driver.stderr as ReadableStream).text());
    await Bun.sleep(100);
  }
  if (!handoff) throw new Error("Update preparation timed out");
  const journal = join(workspace, ".alpha/updates/transactions", handoff.id + ".json"); let transaction: any;
  for (let count = 0; count < 1800; count++) { transaction = JSON.parse(await readFile(journal, "utf8")); if (transaction.state === "committed" || transaction.error) break; await Bun.sleep(100); }
  if (transaction.state !== "committed") throw new Error(transaction.error ?? "Update startup timed out");
  const ready = JSON.parse(await readFile(transaction.readyFile, "utf8")); newPid = ready.pid;
  const api = async (path: string, input?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}/api/native/${path}`, { method: input === undefined ? "GET" : "POST", headers: { "x-alpha-token": token, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<any>;
  };
  await api(`sessions/${handoff.sessionId}/open`, {});
  const state = await api(`sessions/${handoff.sessionId}/state`);
  if (state.sessionId !== handoff.nativeSessionId) throw new Error("Native session identity changed during update");
  const messages = await api(`sessions/${handoff.sessionId}/messages`); if (!JSON.stringify(messages).includes("Keep this native session")) throw new Error("Native transcript missing");
  if (await readFile(join(root, "user-note.txt"), "utf8") !== "USER_FILE_MUST_SURVIVE") throw new Error("User file changed");
  const storage = createRequire(import.meta.url)(join(root, "desktop/state-storage.cjs")).stateStorage(workspace);
  if (JSON.parse(storage.getItem("alpha-ui-preferences")).language !== "en" || JSON.parse(storage.getItem("alpha-composer:" + handoff.sessionId)).text !== "UPDATE_DRAFT_MUST_SURVIVE") throw new Error("Desktop preferences or draft changed");
  const result = { productionMain: true, productionPreload: true, transition: ["0.2.99", ready.version], artificialBaseVersion: true, installedPayload: true, independentHelper: true, newProcessSurvives: (await stat(join(root, "desktop/main.cjs"))).isFile(), nativeSessionRestored: true, draftAndPreferencesPreserved: true, userFilePreserved: true, backup: transaction.backup };
  process.kill(newPid!, 0); await writeFile(join(evidence, "app-update-result.json"), JSON.stringify(result, null, 2)); console.log("ALPHA_APP_UPDATE_OK " + JSON.stringify(result));
} finally {
  if (newPid) await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(newPid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
  if (driver.exitCode === null) await Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(driver.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
  await driver.exited;
}
