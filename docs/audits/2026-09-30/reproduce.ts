// Audit-only reproduction; writes fresh files under the OS temporary directory.
// Run from the repository root: bun run docs/audits/2026-09-30/reproduce.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, Scheduler, nextCronRun } from "../../../src/native/scheduler";
import { drivesBrowser } from "../../../src/native/capabilities/browser-consent";

const root = await mkdtemp(join(tmpdir(), "alpha-release-audit-"));
const store = new ScheduleStore(join(root, "concurrent"));
await Promise.all(Array.from({ length: 20 }, (_, index) => store.create({
  name: `audit-${index}`, prompt: "audit", kind: "interval", intervalMinutes: 60, target: { kind: "new" },
})));
const concurrent = { submitted: 20, persisted: (await store.list()).length };

// Production deliverSchedule returns on RPC prompt acceptance, before task completion.
const receipts = new ScheduleStore(join(root, "receipts"));
let now = new Date("2026-09-30T01:00:00Z");
await receipts.create({ name: "slow task", prompt: "audit", kind: "interval", intervalMinutes: 1, target: { kind: "new" } }, new Date(now.getTime() - 120_000));
let unfinished = 0;
const scheduler = new Scheduler(receipts, async () => { unfinished++; return "已投递"; }, () => now);
await scheduler.tick();
now = new Date(now.getTime() + 60_000);
await scheduler.tick();

const from = new Date(2026, 8, 30, 10);
const cron = ["0 9 * * 7", "0 9 1 * 1"].map(expression => ({ expression, next: nextCronRun(expression, from)?.toString() ?? null }));
const browser = [
  "await browser.open({url:'https://example.com'})",
  "await browser['open']({url:'https://example.com'})",
  "const b = browser; await b.open({url:'https://example.com'})",
].map(code => ({ code, detected: drivesBrowser("eval", { code }) }));
console.log(JSON.stringify({ evidenceDirectory: root, concurrent, unfinishedAfterTwoDeliveries: unfinished, cron, browser }, null, 2));
