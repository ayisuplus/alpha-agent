import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskLedger, fingerprintSource } from "./task-ledger";
import { VisibleBrowser, type BrowserObservation, type BrowserSession } from "./visible-browser";
import type { BrowserKernel } from "./browser-kernel";

type Step =
  | { action: "fill" | "select"; selector: string; value: string }
  | { action: "click"; selector: string }
  | { action: "expectText" | "expectAbsentText"; text: string; selector?: string }
  | { action: "expectValue"; selector: string; value: string }
  | { action: "contrast"; selector: string; minRatio: number }
  | { action: "video"; selector: string }
  | { action: "viewport"; width: number; height: number }
  | { action: "wait"; ms: number }
  | { action: "reload" };

interface Plan { steps: Step[] }

interface Progress {
  previewId: string;
  revision: string;
  planHash: string;
  nonce: string;
  nextStep: number;
  inFlight: number | null;
  results: Array<{ index: number; action: Step["action"]; passed: boolean; detail?: string }>;
}

async function saveProgress(file: string, progress: Progress): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(progress));
  await rename(temporary, file);
}

export function parsePlan(value: unknown, objective: string): Plan {
  if (!value || typeof value !== "object" || !Array.isArray((value as Plan).steps)) throw new Error("Verification plan needs a steps array");
  const steps = (value as Plan).steps;
  if (steps.length < 4 || steps.length > 40) throw new Error("Verification plan must have 4–40 steps");
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object") throw new Error("Invalid verification step");
    if (!step.action) throw new Error(`Verification plan step ${index + 1} needs an action field, for example {"action":"click","selector":"#add"}; remove comment-only steps`);
    let allowed: string[];
    if (step.action === "fill" || step.action === "select") {
      allowed = ["action", "selector", "value"];
      if (typeof step.selector !== "string" || !step.selector || typeof step.value !== "string") throw new Error(`Invalid ${step.action} step`);
    } else if (step.action === "click" || step.action === "video") {
      allowed = ["action", "selector"];
      if (typeof step.selector !== "string" || !step.selector) throw new Error(`Invalid ${step.action} step`);
    } else if (step.action === "expectText" || step.action === "expectAbsentText") {
      allowed = ["action", "text", "selector"];
      if (typeof step.text !== "string" || !step.text) throw new Error("Text assertion must be nonempty");
      if (step.selector !== undefined && (typeof step.selector !== "string" || !step.selector)) throw new Error("Text assertion selector must be a nonempty string");
    } else if (step.action === "expectValue") {
      allowed = ["action", "selector", "value"];
      if (typeof step.selector !== "string" || !step.selector || typeof step.value !== "string") throw new Error("Value assertion needs a selector and string value");
    } else if (step.action === "contrast") {
      allowed = ["action", "selector", "minRatio"];
      if (typeof step.selector !== "string" || !step.selector || typeof step.minRatio !== "number" || step.minRatio < 4.5) throw new Error("Contrast step needs a selector and ratio of at least 4.5");
    } else if (step.action === "viewport") {
      allowed = ["action", "width", "height"];
      if (!Number.isInteger(step.width) || !Number.isInteger(step.height)) throw new Error("Viewport dimensions must be integers");
    } else if (step.action === "wait") {
      allowed = ["action", "ms"];
      if (!Number.isInteger(step.ms) || step.ms < 1 || step.ms > 3_000) throw new Error("Wait must be 1–3000 ms");
    } else if (step.action === "reload") allowed = ["action"];
    else throw new Error(`Verification plan has unsupported action: ${(step as { action?: string }).action}`);
    const extra = Object.keys(step).find(key => !allowed.includes(key));
    if (extra) throw new Error(`Verification plan step ${index + 1} has unsupported field: ${extra}`);
  }
  if (!steps.some(step => step.action === "click")) throw new Error("Verification must exercise an interactive user path with a click");
  if (steps.filter(step => step.action === "expectText" || step.action === "expectAbsentText" || step.action === "expectValue").length < 2) throw new Error("Verification needs at least two outcome assertions");
  if (!steps.some(step => step.action === "viewport" && step.width <= 400)) throw new Error("Verification needs a narrow viewport check");
  if (!steps.some(step => step.action === "contrast")) throw new Error("Verification needs a text contrast check");
  if (/持久|刷新|保存|persist|storage|reload/i.test(objective) && !steps.some(step => step.action === "reload")) throw new Error("Persistence requirements need a reload step");
  if (/视频|video/i.test(objective) && !steps.some(step => step.action === "video")) throw new Error("Video requirements need a decoded video frame check");
  return { steps };
}

function substitute(value: string, nonce: string): string {
  return value.replaceAll("{{nonce}}", nonce);
}

async function waitForText(browser: BrowserSession, expected: string, present: boolean, selector?: string): Promise<BrowserObservation> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const observation = await browser.observe();
    const actual = selector ? await browser.textOf(selector) : observation.text;
    if ((actual?.includes(expected) ?? false) === present) return observation;
    await Bun.sleep(100);
  }
  throw new Error(`Text assertion failed: ${present ? "expected" : "forbidden"} ${expected}`);
}

async function waitForValue(browser: BrowserSession, selector: string, expected: string): Promise<BrowserObservation> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const observation = await browser.observe();
    if (await browser.valueOf(selector) === expected) return observation;
    await Bun.sleep(100);
  }
  throw new Error(`Value assertion failed at ${selector}: expected ${expected}`);
}

export async function verifyBrowserPlan(ledger: TaskLedger, cdpPort: number, dataRoot: string, signal?: AbortSignal, kernel?: BrowserKernel, complete = true): Promise<void> {
  signal?.throwIfAborted();
  if (ledger.state.status !== "active") throw new Error("Only active tasks can be verified");
  const preview = ledger.state.preview;
  const contractVersion = ledger.state.contractVersion ?? 1;
  if (!preview || preview.revision !== ledger.state.revision) throw new Error("Task has no current preview");
  if ((await fingerprintSource(ledger.state.projectRoot)) !== preview.revision) throw new Error("Preview source revision is stale");
  const planText = await readFile(join(ledger.state.projectRoot, "alpha-verification.json"), "utf8");
  let plan: Plan;
  try {
    plan = parsePlan(JSON.parse(planText) as unknown, ledger.state.objective);
  } catch (error) {
    throw new Error(`Verification plan invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const planHash = createHash("sha256").update(planText).digest("hex");
  const response = await fetch(preview.url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok || response.headers.get("x-alpha-preview-id") !== preview.id || response.headers.get("x-alpha-revision") !== preview.revision) {
    throw new Error("Preview response identity does not match the task");
  }
  const evidenceDir = join(dataRoot, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const progressDir = join(dataRoot, "browser-progress");
  await mkdir(progressDir, { recursive: true });
  const progressFile = join(progressDir, `${ledger.state.id}.json`);
  const saved = await readFile(progressFile, "utf8").then(text => JSON.parse(text) as Progress).catch(() => null);
  const progress: Progress = saved?.previewId === preview.id && saved.revision === preview.revision && saved.planHash === planHash
    ? saved
    : { previewId: preview.id, revision: preview.revision, planHash, nonce: randomUUID().slice(0, 8), nextStep: 0, inFlight: null, results: [] };
  if (progress.inFlight !== null && plan.steps[progress.inFlight]?.action === "click") {
    throw new Error(`Verification step ${progress.inFlight + 1} click result is unknown after interruption; inspect the visible page before retrying`);
  }
  await saveProgress(progressFile, progress);
  const { nonce, results } = progress;
  let browser: BrowserSession | undefined;
  for (let attempt = 0; attempt < 40 && !browser; attempt++) {
    signal?.throwIfAborted();
    browser = await (kernel ? kernel.connectPreview(ledger.state.id, preview.url, signal) : VisibleBrowser.connect(`http://127.0.0.1:${cdpPort}`, preview.url)).catch(() => undefined);
    if (!browser) await Bun.sleep(250);
  }
  if (!browser) throw new Error(`Visible preview did not open: ${preview.url}`);
  const attemptId = randomUUID();
  const screenshot = join(evidenceDir, `${ledger.state.id}-${preview.id}-${attemptId}-plan.png`);
  const evidencePath = join(evidenceDir, `${ledger.state.id}-${preview.id}-${attemptId}-plan.json`);
  const assertCurrent = async () => {
    const current = (await TaskLedger.load(ledger.file)).state;
    if (current.status !== "active" || (current.contractVersion ?? 1) !== contractVersion || current.revision !== preview.revision || current.preview?.id !== preview.id) throw new Error("Task or preview changed during verification");
    if (await fingerprintSource(ledger.state.projectRoot) !== preview.revision) throw new Error("Source changed during verification");
    if (createHash("sha256").update(await readFile(join(ledger.state.projectRoot, "alpha-verification.json"), "utf8")).digest("hex") !== planHash) throw new Error("Verification plan changed during verification");
    const response = await fetch(preview.url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok || response.headers.get("x-alpha-preview-id") !== preview.id || response.headers.get("x-alpha-revision") !== preview.revision) throw new Error("Preview instance changed during verification");
  };
  try {
    let observation = progress.nextStep > 0 ? await browser.observe() : await browser.navigate(preview.url);
    if (observation.consoleErrors.length || observation.failedRequests.length || observation.brokenImages.length) throw new Error(`Preview has console, network or broken image errors on load: ${observation.brokenImages.join(", ")}`);
    for (let index = progress.nextStep; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      try {
        signal?.throwIfAborted();
        progress.inFlight = index;
        await saveProgress(progressFile, progress);
        if (step.action === "fill") observation = await browser.fill(step.selector, substitute(step.value, nonce));
        else if (step.action === "select") observation = await browser.select(step.selector, substitute(step.value, nonce));
        else if (step.action === "click") observation = await browser.click(step.selector);
        else if (step.action === "reload") observation = await browser.navigate(preview.url);
        else if (step.action === "viewport") {
          observation = await browser.viewport(step.width, step.height);
          if (observation.viewport.horizontalOverflow) throw new Error(`Horizontal overflow at ${step.width}px`);
        } else if (step.action === "contrast") {
          const colors = await browser.contrast(step.selector);
          if (colors.ratio < step.minRatio) throw new Error(`Text contrast is ${colors.ratio.toFixed(2)}:1 at ${step.selector}`);
        } else if (step.action === "video") {
          const video = await browser.videoFrames(step.selector);
          if (video.frames.length !== 3) throw new Error("Video did not yield start, middle and end frames");
        } else if (step.action === "wait") {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, step.ms);
            const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Verification interrupted")); };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        } else if (step.action === "expectText" || step.action === "expectAbsentText") {
          observation = await waitForText(browser, substitute(step.text, nonce), step.action === "expectText", step.selector);
        } else if (step.action === "expectValue") {
          observation = await waitForValue(browser, step.selector, substitute(step.value, nonce));
        }
        if (observation.consoleErrors.length || observation.failedRequests.length || observation.brokenImages.length) throw new Error(`Console, network or broken image error: ${observation.brokenImages.join(", ")}`);
        results.push({ index: index + 1, action: step.action, passed: true });
        progress.nextStep = index + 1;
        progress.inFlight = null;
        await saveProgress(progressFile, progress);
      } catch (error) {
        throw new Error(`Verification step ${index + 1}/${plan.steps.length} ${JSON.stringify(step)} failed after ${results.length} passing steps: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await Bun.sleep(250);
    signal?.throwIfAborted();
    await browser.screenshot(screenshot);
    await assertCurrent();
    await writeFile(evidencePath, JSON.stringify({ attemptId, taskId: ledger.state.id, previewId: preview.id, revision: preview.revision, planHash, nonce, results, screenshot }, null, 2), { flag: "wx" });
    await ledger.recordEvidence({ attemptId, criterionId: "user-path", kind: "browser", previewId: preview.id, revision: preview.revision, passed: true, source: evidencePath });
    if (complete && !ledger.completionGaps().length) await ledger.complete();
    await unlink(progressFile).catch(() => undefined);
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    await browser.screenshot(screenshot).catch(() => undefined);
    await writeFile(evidencePath, JSON.stringify({ attemptId, taskId: ledger.state.id, previewId: preview.id, revision: preview.revision, planHash, nonce, results, reason, screenshot }, null, 2), { flag: "wx" }).catch(writeError => {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    });
    const current = (await TaskLedger.load(ledger.file)).state;
    if (current.status === "active" && (current.contractVersion ?? 1) === contractVersion && current.preview?.id === preview.id && current.revision === preview.revision) {
      await ledger.recordEvidence({ attemptId, criterionId: "user-path", kind: "browser", previewId: preview.id, revision: preview.revision, passed: false, source: evidencePath });
      await ledger.refreshRevision();
    }
    throw error;
  } finally {
    if (kernel) await kernel.detachPreview(ledger.state.id);
    else await (browser as VisibleBrowser).disconnect();
  }
}
