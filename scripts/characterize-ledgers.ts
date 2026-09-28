// Regenerates or verifies the ledger characterization baseline, and replays the same probe over copies of real task
// ledgers. Run: bun run scripts/characterize-ledgers.ts [--write-fixtures]
//           bun run scripts/characterize-ledgers.ts --real [--data .alpha] [--out artifacts/ledger-characterization.json]
// Real ledgers are only ever read: the probe runs on a copy in a scratch directory.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { characterizeLedger, characterizeScenario, loadLedgerCopy, scenarios, withScratch, type Characterization } from "../test/support/ledger-characterization";

const args = process.argv.slice(2);
const fixtureDir = resolve("test/fixtures/ledger-characterization");
const dataFlag = args.indexOf("--data");
const dataRoot = resolve(dataFlag >= 0 ? args[dataFlag + 1] : ".alpha");
const outFlag = args.indexOf("--out");
const outFile = outFlag >= 0 ? args[outFlag + 1] : `artifacts/ledger-characterization-${new Date().toISOString().slice(0, 10)}.json`;

if (args.includes("--real")) {
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
