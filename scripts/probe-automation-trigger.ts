import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = join(resolve(import.meta.dir, ".."), ".alpha", `automation-trigger-probe-${Date.now()}`);
const obsidianRead = process.argv.includes("--obsidian-read");
const directNotes = process.argv.includes("--direct-notes");
const backup = process.argv.includes("--backup");
const direct = process.argv.includes("--direct") || directNotes || obsidianRead || backup;
const backupRepo = join(tmpdir(), `alpha-backup-automation-${Date.now()}`);
const directRoot = obsidianRead ? "G:\\知识库\\obsidian" : backup ? join(backupRepo, "obsidian") : join(tmpdir(), `alpha-direct-automation-${Date.now()}`);
await mkdir(root, { recursive: true });
if (direct && !obsidianRead) await mkdir(directRoot, { recursive: true });
if (backup) {
  const git = async (...args: string[]) => { const child = Bun.spawn(["git", "-C", backupRepo, ...args], { stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(err || out); return out.trim(); };
  await git("init", "-b", "main");
  await writeFile(join(backupRepo, "outside.txt"), "outside base\n");
  await writeFile(join(directRoot, "note.md"), "note base\n");
  await git("add", "outside.txt", "obsidian/note.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "base");
  await writeFile(join(backupRepo, "outside.txt"), "outside user edit\n");
  await writeFile(join(directRoot, "note.md"), "ALPHA_BACKUP_TRIGGERED\n");
}
let before: string | null = null;
if (obsidianRead) {
  const child = Bun.spawn(["git", "status", "--porcelain", "--ignore-submodules=all", "--", "."], { cwd: directRoot, stdout: "pipe" });
  before = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Could not inspect Obsidian before the probe");
}
const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/server.ts")], {
  cwd: root, env: { ...process.env, ALPHA_WORKSPACE_ROOT: root }, stdout: "pipe", stderr: "pipe",
});
let port: string | undefined;
let startup = "";
try {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output unavailable");
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 20_000;
  while (!port && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    startup += new TextDecoder().decode(chunk.value);
    port = /ALPHA_SERVER_READY (\d+)/.exec(startup)?.[1];
  }
  reader.releaseLock();
  if (!port) throw new Error(`Server did not start: ${startup.slice(-500)}`);
  const base = `http://127.0.0.1:${port}`;
  let projectId: string | undefined, mountId: string | undefined;
  if (direct) {
    const created = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Automation trigger probe" }) }).then(value => value.json()) as { project: { id: string } };
    projectId = created.project.id;
    const mounted = await fetch(`${base}/api/projects/${projectId}/mounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: directRoot }) }).then(value => value.json()) as { project: { mounts: Array<{ id: string }> } };
    mountId = mounted.project.mounts[0].id;
    await fetch(`${base}/api/projects/${projectId}/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode: "full" }) });
  }
  const at = new Date(Date.now() + 5_000).toISOString();
  const response = await fetch(`${base}/api/automations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Trigger proof", prompt: backup ? "仅备份所选目录" : obsidianRead ? "请只读检查当前 Obsidian 目录，读取 03-日练/00-日练总台.md 的标题，仅回复标题和确认已读取；禁止任何写入操作。" : directNotes ? "在当前工作目录新建 automation-trigger-proof.md，内容严格为 ALPHA_TRIGGERED，然后简短回复。" : "在当前工作目录创建 outputs/automation-trigger-proof.txt，内容严格为 ALPHA_TRIGGERED；再创建 alpha-deliverable.json，内容为 {\"outputs\":[{\"path\":\"outputs/automation-trigger-proof.txt\"}]}。完成后简短回复。", kind: "cron", schedule: { kind: "once", at }, modelSelector: backup ? null : "xiaomi-token-plan-cn/mimo-v2.6-flash", notificationPolicy: "all", ...(direct ? { projectId, mountId } : {}), ...(backup ? { executor: "scoped-git-backup" } : {}) }),
  });
  if (!response.ok) throw new Error(`Automation creation failed: ${await response.text()}`);
  const { automation } = await response.json() as { automation: { id: string } };
  console.log(`PROBE_ROOT ${root}`);
  if (direct) console.log(`DIRECT_ROOT ${directRoot}`);
  console.log(`AUTOMATION ${automation.id} DUE ${at}`);
  let run: { id: string; taskId?: string; status: string; result?: string } | undefined;
  const stopAt = Date.now() + 180_000;
  while (Date.now() < stopAt) {
    await Bun.sleep(3_000);
    const state = await fetch(`${base}/api/automations`).then(value => value.json()) as { runs: Array<{ automationId: string; id: string; taskId?: string; status: string; result?: string }> };
    run = state.runs.find(value => value.automationId === automation.id);
    if (run && ["complete", "failed", "needs-input", "skipped"].includes(run.status)) break;
  }
  if (!run) throw new Error("No automation run was created before timeout");
  console.log(`RUN ${run.id} ${run.status} TASK ${run.taskId ?? "none"} ${run.result ?? ""}`);
  if (run.taskId && !obsidianRead && !backup) {
    const ledger = JSON.parse(await readFile(join(root, ".alpha", "tasks", `${run.taskId}.json`), "utf8")) as { projectRoot?: string; state?: { projectRoot?: string } };
    const projectRoot = ledger.projectRoot ?? ledger.state?.projectRoot;
    if (projectRoot) {
      const proofPath = directNotes ? join(projectRoot, "automation-trigger-proof.md") : join(projectRoot, "outputs", "automation-trigger-proof.txt");
      const proof = await readFile(proofPath, "utf8").catch(() => "");
      console.log(`PROOF ${proof.trim() === "ALPHA_TRIGGERED" ? "PASS" : "MISSING"} ${proofPath}`);
      if (proof.trim() !== "ALPHA_TRIGGERED") process.exitCode = 1;
    }
  } else if (!run.taskId) process.exitCode = 1;
  if (obsidianRead) {
    const child = Bun.spawn(["git", "status", "--porcelain", "--ignore-submodules=all", "--", "."], { cwd: directRoot, stdout: "pipe" });
    const after = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error("Could not inspect Obsidian after the probe");
    console.log(`SOURCE_UNCHANGED ${before === after}`);
    if (before !== after) process.exitCode = 1;
  }
  if (backup) {
    const child = Bun.spawn(["git", "-C", backupRepo, "show", "HEAD:obsidian/note.md"], { stdout: "pipe" });
    const committed = (await new Response(child.stdout).text()).trim();
    const outside = await readFile(join(backupRepo, "outside.txt"), "utf8");
    console.log(`BACKUP_SCOPE ${committed === "ALPHA_BACKUP_TRIGGERED" && outside === "outside user edit\n" ? "PASS" : "FAIL"}`);
    if (await child.exited !== 0 || committed !== "ALPHA_BACKUP_TRIGGERED" || outside !== "outside user edit\n") process.exitCode = 1;
  }
  if (run.status !== "complete") process.exitCode = 1;
} finally {
  child.kill();
  await child.exited;
}
