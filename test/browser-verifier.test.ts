import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, verifyBrowserPlan } from "../src/runtime/browser-verifier";
import { TaskLedger } from "../src/runtime/task-ledger";
import { VisibleBrowser } from "../src/runtime/visible-browser";
import { recordApprovedPlan } from "./support/approved-plan";

const steps = [
  { action: "fill", selector: "#name", value: "Alpha {{nonce}}" },
  { action: "click", selector: "#save" },
  { action: "expectText", text: "Alpha {{nonce}}" },
  { action: "viewport", width: 375, height: 812 },
  { action: "contrast", selector: "#save", minRatio: 4.5 },
  { action: "reload" },
  { action: "expectText", text: "Alpha {{nonce}}" },
];

test("a persistence task requires a real interaction, assertions, reload and narrow viewport", () => {
  expect(parsePlan({ steps }, "新增素材并在刷新后保存").steps).toHaveLength(7);
  expect(() => parsePlan({ steps: steps.filter(step => step.action !== "reload") }, "新增素材并在刷新后保存")).toThrow("reload");
  expect(() => parsePlan({ steps: steps.filter(step => step.action !== "click") }, "新增素材并保存")).toThrow("interactive");
  expect(() => parsePlan({ steps: steps.filter(step => step.action !== "expectText") }, "新增素材并保存")).toThrow("assertions");
  expect(() => parsePlan({ steps: [...steps, { action: "expectText", text: "line-through", checkStyle: true }] }, "新增素材并保存")).toThrow("unsupported field");
});

test("an input value is an explicit outcome assertion", () => {
  const inputSteps = steps.map(step => step.action === "expectText" ? { action: "expectValue", selector: "#name", value: "Alpha {{nonce}}" } : step);
  expect(parsePlan({ steps: inputSteps }, "刷新后保存").steps).toHaveLength(7);
  expect(parsePlan({ steps: [...inputSteps, { action: "expectValue", selector: "#name", value: "" }] }, "刷新后保存").steps).toHaveLength(8);
  expect(() => parsePlan({ steps: [...inputSteps, { action: "expectValue", selector: "#name", value: 3 }] }, "刷新后保存")).toThrow("Value assertion");
});

test("a button-only product can verify a changed result without a form", () => {
  const clickOnly = steps.filter(step => step.action !== "fill");
  expect(parsePlan({ steps: clickOnly }, "点击切换短语").steps).toHaveLength(6);
});

test("a video product must verify decodable frames in the preview", () => {
  expect(() => parsePlan({ steps }, "构建一个带原创视频的页面")).toThrow("decoded video frame");
  expect(parsePlan({ steps: [...steps, { action: "video", selector: "#hero-video" }] }, "构建一个带原创视频的页面").steps).toHaveLength(8);
});

test("each verification attempt keeps its own evidence and source changes cannot complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-browser-attempt-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  const connect = spyOn(VisibleBrowser, "connect");
  try {
    const product = join(root, "product");
    const dataRoot = join(root, "state");
    await mkdir(product);
    await writeFile(join(product, "index.html"), "original");
    await writeFile(join(product, "alpha-verification.json"), JSON.stringify({ steps: [
      { action: "click", selector: "#go" }, { action: "expectText", text: "done" },
      { action: "expectText", text: "saved" }, { action: "viewport", width: 375, height: 800 },
      { action: "contrast", selector: "#go", minRatio: 4.5 },
    ] }));
    const ledger = await TaskLedger.create(dataRoot, { objective: "Build app", projectRoot: product, criteria: [
      { id: "build", kind: "build", description: "Build" }, { id: "user-path", kind: "browser", description: "Browser" },
    ] });
    await recordApprovedPlan(ledger);
    const revision = ledger.state.revision!;
    await ledger.recordEvidence({ criterionId: "build", kind: "build", revision, passed: true, source: "build.log" });
    server = Bun.serve({ port: 0, fetch: () => new Response("ok", { headers: { "x-alpha-preview-id": "preview-one", "x-alpha-revision": revision } }) });
    await ledger.recordPreview({ id: "preview-one", revision, path: join(root, "preview"), url: `http://127.0.0.1:${server.port}` });
    const observation = { text: "done saved", consoleErrors: [], failedRequests: [], brokenImages: [], viewport: { horizontalOverflow: false } };
    let changeSource = false;
    connect.mockImplementation(async () => ({
      navigate: async () => observation, observe: async () => observation,
      click: async () => { if (changeSource) await writeFile(join(product, "index.html"), "changed"); return observation; },
      viewport: async () => observation, contrast: async () => ({ ratio: 7 }),
      screenshot: async (path: string) => { await writeFile(path, "image"); },
      disconnect: async () => undefined,
    }) as unknown as VisibleBrowser);
    await verifyBrowserPlan(ledger, 1234, dataRoot);
    const first = ledger.state.evidence.findLast(item => item.kind === "browser")!;
    expect(first.attemptId).toBeTruthy();
    expect(ledger.state.status).toBe("complete");
    await ledger.reopen("repeat verification");
    // A legacy progress document without the store tag must load and be resumed, not discarded.
    await mkdir(join(dataRoot, "browser-progress"), { recursive: true });
    await writeFile(join(dataRoot, "browser-progress", `${ledger.state.id}.json`), JSON.stringify({
      previewId: "preview-one", revision,
      planHash: createHash("sha256").update(await readFile(join(product, "alpha-verification.json"), "utf8")).digest("hex"),
      nonce: "resume12", nextStep: 40, inFlight: null, results: [],
    }));
    await verifyBrowserPlan(ledger, 1234, dataRoot, undefined, undefined, false);
    const second = ledger.state.evidence.findLast(item => item.kind === "browser")!;
    expect(ledger.state.status).toBe("active");
    expect(JSON.parse(await readFile(second.source, "utf8")).results).toEqual([]);
    await ledger.complete();
    expect(second.source).not.toBe(first.source);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(JSON.parse(await readFile(first.source, "utf8")).attemptId).toBe(first.attemptId);
    await ledger.enableDevelopmentWorkflow();
    await ledger.reopen("review is pending");
    await verifyBrowserPlan(ledger, 1234, dataRoot);
    expect(ledger.state.status).toBe("active");
    expect(ledger.state.evidence.findLast(item => item.kind === "browser")?.passed).toBe(true);
    expect(ledger.completionGaps()).toContain("gate");
    await ledger.recordDevelopmentReview({ verdict: "pass", findings: [], instanceId: "review-1" });
    await ledger.complete();
    await ledger.reopen("check changed source");
    changeSource = true;
    await expect(verifyBrowserPlan(ledger, 1234, dataRoot)).rejects.toThrow("Source changed");
    expect(JSON.parse(await readFile(join(dataRoot, "browser-progress", `${ledger.state.id}.json`), "utf8"))).toMatchObject({ format: "browser-progress", version: 1 });
    expect(ledger.state.status).toBe("active");
    expect(ledger.state.preview).toBeNull();
    expect(ledger.state.evidence.findLast(item => item.kind === "browser")?.passed).toBe(false);
  } finally {
    connect.mockRestore();
    server?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
