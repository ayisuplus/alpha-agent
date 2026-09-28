import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandApprovalStore } from "./command-approval";
import { runCodeCheck } from "./code-check";
import { ProjectStore } from "./projects";
import { snapshotSourceHashes, sourceChanges } from "./source-review";
import { fingerprintSource, type TaskLedger } from "./task-ledger";
import { taskProfile } from "./task-profile";
import { reviewCodeApply } from "./workspace-apply";

/** One acceptance path for server and CLI code tasks. Model reports do not create evidence. */
export async function acceptCodeChange(input: {
  ledger: TaskLedger;
  dataRoot: string;
  runId: string;
  signal?: AbortSignal;
  onCheck?: (name: string) => void;
  complete?: boolean;
}): Promise<boolean> {
  const { ledger, dataRoot, runId } = input;
  if (!taskProfile(ledger.state.taskType).codeAcceptance || ledger.state.status !== "active") throw new Error("Code acceptance requires an active code task");
  input.signal?.throwIfAborted();
  const projectRoot = ledger.state.projectRoot;
  const direct = ledger.state.workspaceOrigin?.kind === "direct";
  const baselineFile = join(dataRoot, "direct-baselines", `${ledger.state.id}.json`);
  const persisted = direct || ledger.state.taskType === "general" ? await readFile(baselineFile, "utf8").then(value => JSON.parse(value) as unknown).catch(() => null) : null;
  if (persisted && (typeof persisted !== "object" || Array.isArray(persisted) || !('format' in persisted) || persisted.format !== 2 || !('files' in persisted) || !persisted.files || typeof persisted.files !== "object" || Array.isArray(persisted.files))) {
    throw new Error("Task source baseline uses an obsolete format; create a new task before acceptance");
  }
  const baseline = persisted ? (persisted as { files: Record<string, string> }).files : null;
  const afterHashes = baseline ? await snapshotSourceHashes(projectRoot) : null;
  if ((direct || ledger.state.taskType === "general") && !baseline) throw new Error("Task has no persisted source baseline for acceptance");
  const review = baseline
    ? { changes: sourceChanges(baseline!, afterHashes!).map(change => ({ path: change.path, action: change.before === null ? "added" : change.after === null ? "removed" : "modified", conflict: false })) }
    : await reviewCodeApply(ledger, dataRoot);
  const evidenceRoot = join(dataRoot, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const reviewPath = join(evidenceRoot, `${ledger.state.id}-${runId}-code-review.json`);
  await writeFile(reviewPath, JSON.stringify(review, null, 2), { flag: "wx" });
  if (review.changes.length) await ledger.recordEvidence({ criterionId: "change", kind: "asset", revision: ledger.state.revision!, passed: true, source: reviewPath });

  const checks = ledger.state.workspaceOrigin?.checks ?? [];
  const checkResults: Array<{ name: string; passed: boolean; logPath: string }> = [];
  if (!checks.length) {
    const approved = (await commandApprovalStore(dataRoot).list(ledger.state.id)).findLast(item => item.purpose === "check" && item.status === "complete" && item.result?.exitCode === 0 && item.result.revision === ledger.state.revision);
    if (!approved?.result) throw new Error("No configured project check; approve and run a check command before technical completion");
    checkResults.push({ name: approved.argv.join(" "), passed: true, logPath: approved.result.logPath });
  }
  const permission = ledger.state.projectId
    ? { mode: ledger.state.permissionMode ?? "ask", roots: await new ProjectStore(dataRoot).roots(ledger.state.projectId, ledger.state.projectVersion ?? 0) }
    : undefined;
  for (const check of checks) {
    input.onCheck?.(check.name);
    const result = await runCodeCheck(projectRoot, dataRoot, ledger.state.id, check.name, checks, input.signal, permission);
    checkResults.push({ name: check.name, passed: result.passed, logPath: result.logPath });
    if (!result.passed) break;
  }
  input.signal?.throwIfAborted();
  if (await fingerprintSource(projectRoot) !== ledger.state.revision) throw new Error("Project source changed during checks; review and rerun");
  const checkPath = join(evidenceRoot, `${ledger.state.id}-${runId}-checks.json`);
  await writeFile(checkPath, JSON.stringify({ checks: checkResults }, null, 2), { flag: "wx" });
  const passed = checkResults.length === Math.max(1, checks.length) && checkResults.every(item => item.passed);
  await ledger.recordEvidence({ criterionId: "check", kind: "test", revision: ledger.state.revision!, passed, source: checkPath });
  if (!passed) throw new Error(`Configured check failed: ${checkResults.find(item => !item.passed)?.name}`);
  if (ledger.completionGaps().length) return false;
  if (ledger.state.projectId) await new ProjectStore(dataRoot).roots(ledger.state.projectId, ledger.state.projectVersion ?? 0);
  if (input.complete !== false) await ledger.complete();
  return true;
}
