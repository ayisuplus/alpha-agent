// Regenerates or verifies the ledger characterization baseline, replays the same probe over copies of real task
// ledgers, and checks that importing a pre-event-log ledger folds back to the original file. Run:
//   bun run scripts/characterize-ledgers.ts [--write-fixtures]
//   bun run scripts/characterize-ledgers.ts --real [--data .alpha] [--out artifacts/ledger-characterization.json]
//   bun run scripts/characterize-ledgers.ts --verify-import [--data .alpha]
// Real ledgers are only ever read: everything runs on a copy in a scratch directory.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { foldTask, readEvents, taskLogDir } from "../src/runtime/task-events";
import { characterizeLedger, characterizeScenario, diffStates, flatten, loadLedgerCopy, scenarios, withScratch, type Characterization } from "../test/support/ledger-characterization";

const args = process.argv.slice(2);
const fixtureDir = resolve("test/fixtures/ledger-characterization");
const dataFlag = args.indexOf("--data");
const dataRoot = resolve(dataFlag >= 0 ? args[dataFlag + 1] : ".alpha");
const outFlag = args.indexOf("--out");
const outFile = outFlag >= 0 ? args[outFlag + 1] : `artifacts/ledger-characterization-${new Date().toISOString().slice(0, 10)}.json`;

if (args.includes("--verify-import")) {
  const files = (await readdir(join(dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
  // Importing normalizes the pre-code pause field; anything else must come back byte-identical.
  const normalizedPaths = new Set(["blockedService", "pauseReason"]);
  let unexpected = 0;
  await withScratch("alpha-import-check-", async scratch => {
    for (const name of files) {
      const original = join(dataRoot, "tasks", name);
      const before = await readFile(original, "utf8");
      const ledger = await loadLedgerCopy(original, scratch);
      const events = await readEvents(taskLogDir(ledger.file));
      const projection = await readFile(ledger.file, "utf8");
      const imported = events.length === 1 && events[0].type === "task/imported";
      const changes = diffStates(flatten(JSON.parse(before)), flatten(foldTask(events)));
      const surprises = changes.filter(change => !normalizedPaths.has(change.path));
      const ok = imported && projection === before && surprises.length === 0;
      if (!ok) unexpected++;
      const detail = changes.length
        ? `归一化 ${changes.map(change => `${change.path}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`).join("；")}`
        : "折叠与原文件逐字节一致";
      console.log(`${ok ? "通过" : "不通过"} ${name}：事件 ${events.length} 条，投影${projection === before ? "未改写" : "被改写"}，${detail}`);
      for (const surprise of surprises) console.log(`  意外差异 ${surprise.path}: ${JSON.stringify(surprise.before)} → ${JSON.stringify(surprise.after)}`);
    }
  });
  if (unexpected) { console.error(`\n${unexpected} 个账本导入后出现意外差异`); process.exit(1); }
  console.log(`\n${files.length} 个真实账本副本：导入 → 折叠只归一化暂停原因码，投影文件未被改写`);
} else if (args.includes("--real")) {
  const files = (await readdir(join(dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
  const tasks = await withScratch("alpha-characterize-real-", async scratch => {
    const collected: Array<{ initial: Record<string, unknown>; characterization: Characterization }> = [];
    for (const name of files) {
      const ledger = await loadLedgerCopy(join(dataRoot, "tasks", name), scratch);
      const { status, phase, taskType, contractVersion } = ledger.state;
      const characterization = await characterizeLedger(`real:${ledger.state.id}`, ledger, { root: scratch });
      const accepted = characterization.steps.filter(step => step.outcome === "ok").length;
      collected.push({ initial: { id: ledger.state.id, status, phase: phase ?? null, taskType: taskType ?? null, contractVersion: contractVersion ?? 1 }, characterization });
      console.log(`已回放 ${name}（${status}/${phase ?? "-"} · ${taskType ?? "-"}）：${accepted} 步生效，${characterization.steps.length - accepted} 步被拒`);
    }
    return collected;
  });
  await mkdir(resolve(outFile, ".."), { recursive: true });
  await writeFile(outFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), dataRoot, tasks }, null, 2)}\n`);
  console.log(`\n真实账本副本回放 ${tasks.length} 个，结果写入 ${outFile}`);
} else {
  const results = await withScratch("alpha-characterize-", async root => {
    const collected: Characterization[] = [];
    for (const scenario of scenarios) collected.push(await characterizeScenario(scenario, root));
    return collected;
  });
  await mkdir(fixtureDir, { recursive: true });
  let mismatched = 0;
  for (const result of results) {
    const file = join(fixtureDir, `${result.scenario}.json`);
    const contents = `${JSON.stringify(result, null, 2)}\n`;
    if (args.includes("--write-fixtures")) {
      await writeFile(file, contents);
      console.log(`已写入 ${file}（${result.steps.length} 步）`);
      continue;
    }
    const previous = await readFile(file, "utf8").catch(() => null);
    if (previous === contents) { console.log(`一致 ${result.scenario}（${result.steps.length} 步）`); continue; }
    mismatched++;
    if (previous === null) console.log(`缺少基线 ${result.scenario}：运行 bun run scripts/characterize-ledgers.ts --write-fixtures`);
    else {
      const before = JSON.parse(previous) as Characterization;
      const steps = Math.max(before.steps.length, result.steps.length);
      for (let index = 0; index < steps; index++) {
        const left = JSON.stringify(before.steps[index] ?? null);
        const right = JSON.stringify(result.steps[index] ?? null);
        if (left !== right) console.log(`差异 ${result.scenario} 步骤 ${index}: ${before.steps[index]?.name ?? "-"} → ${result.steps[index]?.name ?? "-"}`);
      }
      if (JSON.stringify(before.finalState) !== JSON.stringify(result.finalState)) console.log(`差异 ${result.scenario} 最终状态`);
    }
  }
  if (mismatched) { console.error(`\n${mismatched} 个场景与基线不一致`); process.exit(1); }
  if (!args.includes("--write-fixtures")) console.log(`\n${results.length} 个场景与基线一致`);
}
