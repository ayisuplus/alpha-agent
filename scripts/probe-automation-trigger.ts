import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = join(resolve(import.meta.dir, ".."), ".alpha", `automation-trigger-probe-${Date.now()}`);
await mkdir(root, { recursive: true });
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
  const at = new Date(Date.now() + 5_000).toISOString();
  const response = await fetch(`${base}/api/automations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Trigger proof", prompt: "在当前工作目录创建 outputs/automation-trigger-proof.txt，内容严格为 ALPHA_TRIGGERED；再创建 alpha-deliverable.json，内容为 {\"outputs\":[{\"path\":\"outputs/automation-trigger-proof.txt\"}]}。完成后简短回复。", kind: "cron", schedule: { kind: "once", at }, modelSelector: "xiaomi-token-plan-cn/mimo-v2.6-flash", notificationPolicy: "all" }),
  });
  if (!response.ok) throw new Error(`Automation creation failed: ${await response.text()}`);
  const { automation } = await response.json() as { automation: { id: string } };
  console.log(`PROBE_ROOT ${root}`);
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
  if (run.taskId) {
    const ledger = JSON.parse(await readFile(join(root, ".alpha", "tasks", `${run.taskId}.json`), "utf8")) as { projectRoot?: string; state?: { projectRoot?: string } };
    const projectRoot = ledger.projectRoot ?? ledger.state?.projectRoot;
    if (projectRoot) {
      const proof = await readFile(join(projectRoot, "outputs", "automation-trigger-proof.txt"), "utf8").catch(() => "");
      console.log(`PROOF ${proof.trim() === "ALPHA_TRIGGERED" ? "PASS" : "MISSING"} ${join(projectRoot, "outputs", "automation-trigger-proof.txt")}`);
      if (proof.trim() !== "ALPHA_TRIGGERED") process.exitCode = 1;
    }
  } else process.exitCode = 1;
  if (run.status !== "complete") process.exitCode = 1;
} finally {
  child.kill();
  await child.exited;
}
