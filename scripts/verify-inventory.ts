import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TaskLedger, fingerprintSource } from "../src/runtime/task-ledger";
import { VisibleBrowser } from "../src/runtime/visible-browser";

const [ledgerFile, port] = Bun.argv.slice(2);
if (!ledgerFile || !port) throw new Error("Usage: bun run scripts/verify-inventory.ts <ledger-file> <cdp-port>");
const ledger = await TaskLedger.load(ledgerFile);
const evidenceDir = join(dirname(dirname(ledger.file)), "evidence");
const preview = ledger.state.preview;
if (!preview) throw new Error("Task has no local preview");
if ((await fingerprintSource(ledger.state.projectRoot)) !== preview.revision) throw new Error("Preview source revision is stale");
let browser: VisibleBrowser | undefined;
for (let attempt = 0; attempt < 40 && !browser; attempt++) {
  browser = await VisibleBrowser.connect(`http://127.0.0.1:${port}`, preview.url).catch(() => undefined);
  if (!browser) await Bun.sleep(250);
}
if (!browser) throw new Error(`Visible preview did not open: ${preview.url}`);
try {
  const initial = await browser.observe();
  if (initial.consoleErrors.length || initial.failedRequests.length) throw new Error("Initial inventory state is unhealthy");
  await browser.viewport(375, 812);
  const addContrast = await browser.contrast("#add-btn");
  if (addContrast.ratio < 4.5) throw new Error(`Add button text contrast is only ${addContrast.ratio.toFixed(2)}:1 (${addContrast.foreground} on ${addContrast.background})`);
  await browser.viewport(initial.viewport.width, initial.viewport.height);
  const nameA = `Alpha 图片 ${Date.now()}`;
  const nameB = `Alpha 文档 ${Date.now()}`;
  await browser.fill("#name-input", nameA);
  await browser.select("#category-input", "图片");
  const first = await browser.click("#add-btn");
  if (!first.text.includes(nameA)) throw new Error("First item was not added");
  await browser.fill("#name-input", nameB);
  await browser.select("#category-input", "文档");
  const second = await browser.click("#add-btn");
  if (!second.text.includes(nameA) || !second.text.includes(nameB)) throw new Error("Second item was not added");
  const filtered = await browser.select("#filter-select", "图片");
  if (!filtered.text.includes(nameA) || filtered.text.includes(nameB)) throw new Error("Category filtering failed");
  const refreshed = await browser.navigate(preview.url);
  if (!refreshed.text.includes(nameA) || !refreshed.text.includes(nameB)) throw new Error("Items did not survive refresh");
  const narrow = await browser.viewport(375, 812);
  if (narrow.viewport.horizontalOverflow) throw new Error("Narrow viewport has horizontal overflow");
  await Bun.sleep(250);
  const cardContrast = await browser.contrast(".item-name");
  if (cardContrast.ratio < 4.5) throw new Error(`Item text contrast is only ${cardContrast.ratio.toFixed(2)}:1`);
  await mkdir(evidenceDir, { recursive: true });
  const screenshot = join(evidenceDir, `${ledger.state.id}-${preview.id}-narrow.png`);
  await browser.screenshot(screenshot);
  await browser.viewport(initial.viewport.width, initial.viewport.height);
  const evidencePath = join(evidenceDir, `${ledger.state.id}-${preview.id}-browser.json`);
  await writeFile(evidencePath, JSON.stringify({ taskId: ledger.state.id, previewId: preview.id, revision: preview.revision, names: [nameA, nameB], checked: ["empty", "add", "filter", "refresh", "narrow-overflow", "button-contrast", "item-contrast", "console", "network"], screenshot }, null, 2));
  await ledger.recordEvidence({ criterionId: "user-path", kind: "browser", revision: preview.revision, previewId: preview.id, passed: true, source: evidencePath });
  await ledger.complete();
  console.log(JSON.stringify({ taskId: ledger.state.id, status: ledger.state.status, checked: 9, evidencePath, screenshot }));
} catch (error) {
  await mkdir(evidenceDir, { recursive: true });
  const screenshot = join(evidenceDir, `${ledger.state.id}-${preview.id}-failure.png`);
  await browser.screenshot(screenshot).catch(() => undefined);
  const evidencePath = join(evidenceDir, `${ledger.state.id}-${preview.id}-failure.json`);
  const reason = error instanceof Error ? error.message : String(error);
  await writeFile(evidencePath, JSON.stringify({ taskId: ledger.state.id, previewId: preview.id, revision: preview.revision, reason, screenshot }, null, 2));
  if (ledger.state.status === "complete") await ledger.reopen(reason);
  if (ledger.state.status === "active") await ledger.recordEvidence({ criterionId: "user-path", kind: "browser", revision: preview.revision, previewId: preview.id, passed: false, source: evidencePath });
  throw error;
} finally {
  await browser.disconnect();
}
