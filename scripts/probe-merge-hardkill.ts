import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkOrders, recoverIncompleteMerges, type WorkOrder } from "../src/runtime/work-orders";
import { fingerprintSource } from "../src/runtime/task-ledger";

const childMode = process.argv.includes("--child");
const root = childMode ? process.argv[3] : await mkdtemp(join(tmpdir(), "alpha-merge-hardkill-"));
const projectRoot = join(root, "product");
const dataRoot = join(root, "state");
const taskId = childMode ? process.argv[4] : randomUUID();
const left = join(projectRoot, "src", "left");
const right = join(projectRoot, "src", "right");
if (!childMode) {
  await mkdir(left, { recursive: true });
  await mkdir(right, { recursive: true });
  for (let i = 0; i < 400; i++) {
    const file = `${String(i).padStart(4, "0")}.txt`;
    await writeFile(join(left, file), "old");
    await writeFile(join(right, file), "old");
  }
}
const baseRevision = childMode ? process.argv[5] : await fingerprintSource(projectRoot);
const orders: WorkOrder[] = [
  { id: "left", objective: "Update left", ownedPaths: ["src/left/"], resources: ["left"] },
  { id: "right", objective: "Update right", ownedPaths: ["src/right/"], resources: ["right"] },
];
if (childMode) {
  await executeWorkOrders({ projectRoot, dataRoot, taskId, baseRevision, orders, async runWorker(order, directory) {
    const target = join(directory, "src", order.id);
    for (let i = 0; i < 400; i++) await writeFile(join(target, `${String(i).padStart(4, "0")}.txt`), "new");
    return { evidence: [], unresolved: [] };
  } });
} else {
  const child = Bun.spawn([process.execPath, import.meta.path, "--child", root, taskId, baseRevision], { stdout: "pipe", stderr: "pipe" });
  let observed = false;
  for (let i = 0; i < 1200; i++) {
    const current = await readFile(join(left, "0000.txt"), "utf8");
    if (current === "new") { observed = true; break; }
    if (child.exitCode !== null) break;
    await Bun.sleep(10);
  }
  if (!observed) throw new Error("Merge did not reach first committed file before child exited");
  child.kill();
  const childExitCode = await child.exited;
  const batches = await readdir(join(dataRoot, "workers", taskId));
  const reports = await Promise.all(batches.map(async batch => JSON.parse(await readFile(join(dataRoot, "workers", taskId, batch, "merge.json"), "utf8")) as { status: string; committed: string[] }));
  if (!reports.some(report => report.status === "merging")) throw new Error(`Expected an interrupted merge journal, got ${reports.map(report => report.status)}`);
  const recovered = await recoverIncompleteMerges(projectRoot, dataRoot, taskId);
  const restored = await fingerprintSource(projectRoot);
  if (restored !== baseRevision) throw new Error("Recovery did not restore the original source revision");
  const result = { root, taskId, childExitCode, interruptedStatus: reports[0]?.status, firstFileAfterKill: observed ? "new" : "old", recovered, restoredRevision: restored, baseRevision, probeSha256: createHash("sha256").update(JSON.stringify(reports)).digest("hex") };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
