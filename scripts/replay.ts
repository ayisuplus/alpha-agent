// 重放任务日志：按事件重建每一步模型看到的任务上下文，与 prompt-blob 存储逐条核对，只读不写。
// Run: bun run replay <taskId> [--data .alpha] [--json]
import { replayTaskContexts, type ReplayRow } from "../src/runtime/task-replay";

const args = process.argv.slice(2);
const dataFlag = args.indexOf("--data");
const dataRoot = dataFlag >= 0 ? args[dataFlag + 1] ?? ".alpha" : ".alpha";
const asJson = args.includes("--json");
const taskId = args.filter((arg, index) => !arg.startsWith("--") && index !== dataFlag + 1)[0];
if (!taskId) {
  console.error("用法：bun run replay <taskId> [--data .alpha] [--json]");
  process.exit(2);
}

let rows: ReplayRow[];
try {
  rows = await replayTaskContexts(dataRoot, taskId);
} catch (error) {
  console.error(`重放失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const verified = rows.filter(row => row.verified).length;
const bytes = rows.reduce((total, row) => total + row.taskContextBytes, 0);
if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) {
    console.log(`#${row.seq} ${row.at} ${row.stage} ${row.model} ${row.systemTokens + row.toolTokens} tokens ${row.taskContextBytes}B ${row.verified ? "已核对" : "未核对"} ${row.preview}`);
    if (row.problem) console.log(`    问题：${row.problem}`);
  }
  console.log(`共 ${rows.length} 步 · 上下文合计 ${bytes} 字节 · 核对通过 ${verified} 步`);
}
process.exit(rows.length > 0 && verified === rows.length ? 0 : 1);
