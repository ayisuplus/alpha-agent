import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserKernel } from "../src/runtime/browser-kernel";
import { createBrowserTool } from "../src/runtime/browser-tool";
import { WebApprovalRequired, WebPermissionStore } from "../src/runtime/web-permissions";
import { WebRetrieval } from "../src/runtime/web-retrieval";
import type { WebToolContext } from "../src/runtime/web-tools";
import { parseWorkerBrowserRequest } from "../src/runtime/worker-browser-tool";
import type { VisibleBrowser } from "../src/runtime/visible-browser";

const temporary = () => mkdtemp(join(tmpdir(), "alpha-web-kernel-"));
const taskId = "12345678-1234-1234-1234-123456789012";

test("search discovery stays separate from archived extracted evidence", async () => {
  const root = await temporary();
  const calls: string[] = [];
  const transport = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.headers).toMatchObject({ authorization: "Bearer secret-key" });
    if (String(url).endsWith("/search")) return Response.json({ request_id: "request-1", usage: { credits: 1 }, results: [{ title: "Article", url: "https://8.8.8.8/article", content: "Search snippet", score: 0.8, published_date: "2026-09-20" }] });
    return Response.json({ success: true, data: { markdown: "Full article body", metadata: { title: "Article" } } });
  }) as typeof fetch;
  const web = new WebRetrieval(root, async () => "secret-key", transport);
  const results = await web.search(taskId, "article");
  expect(results.results[0]).toMatchObject({ snippet: "Search snippet", requestId: "request-1", provider: "tavily" });
  const source = await web.extract(taskId, results.results[0].url);
  expect(source.kind).toBe("provider_extraction");
  expect(source.text).toBe("Full article body");
  expect(await readFile(source.rawPath!, "utf8")).toContain("Full article body");
  expect(createHash("sha256").update(await readFile(source.rawPath!)).digest("hex")).toBe(source.rawSha256);
  expect(calls).toEqual(["https://api.tavily.com/search", "https://api.firecrawl.dev/v2/scrape"]);
});

test("crawl cancellation keeps its task-owned receipt and does not issue a second DELETE", async () => {
  const root = await temporary();
  const methods: string[] = [];
  const transport = (async (_url: string | URL | Request, options?: RequestInit) => {
    methods.push(options?.method ?? "GET");
    if (options?.method === "POST") return Response.json({ success: true, id: "crawl-1" });
    return Response.json({ success: true });
  }) as typeof fetch;
  const web = new WebRetrieval(root, async () => "secret-key", transport);
  const job = await web.startCrawl(taskId, "https://8.8.8.8/");
  await expect(web.cancelCrawl("other-task", job.id)).rejects.toThrow("does not belong");
  expect((await web.cancelCrawl(taskId, job.id)).cancelRequested).toBe(true);
  await web.cancelCrawl(taskId, job.id);
  expect(methods).toEqual(["POST", "DELETE"]);
});

test("crawl continuation archives each page once and stays on the provider job URL", async () => {
  const root = await temporary();
  const calls: string[] = [];
  const page = (url: string) => ({ markdown: `Body of ${url}`, metadata: { sourceURL: url, title: url } });
  const transport = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).endsWith("/v2/crawl")) return Response.json({ id: "crawl-2" });
    if (String(url).includes("?skip=1")) return Response.json({ status: "completed", completed: 2, data: [page("https://8.8.8.8/two")] });
    return Response.json({ status: "scraping", completed: 1, next: "https://api.firecrawl.dev/v2/crawl/crawl-2?skip=1", data: [page("https://8.8.8.8/one")] });
  }) as typeof fetch;
  const web = new WebRetrieval(root, async () => "secret-key", transport);
  const job = await web.startCrawl(taskId, "https://8.8.8.8/");
  expect((await web.crawlStatus(taskId, job.id)).sources).toHaveLength(1);
  expect((await web.crawlStatus(taskId, job.id)).sources).toHaveLength(1);
  expect((await web.crawlStatus(taskId, job.id)).sources).toHaveLength(0);
  expect(calls).toEqual(["https://api.firecrawl.dev/v2/crawl", "https://api.firecrawl.dev/v2/crawl/crawl-2", "https://api.firecrawl.dev/v2/crawl/crawl-2?skip=1", "https://api.firecrawl.dev/v2/crawl/crawl-2"]);
});

test("web read scope persists while exact external write becomes uncertain on recovery", async () => {
  const root = await temporary();
  const store = new WebPermissionStore(root);
  let approval: WebApprovalRequired | undefined;
  try { await store.require(taskId, "domain:github.com", "read"); } catch (error) { if (error instanceof WebApprovalRequired) approval = error; }
  expect(approval?.approval.status).toBe("pending");
  await store.decide(taskId, approval!.approval.id, true);
  expect((await store.require(taskId, "domain:github.com", "read")).status).toBe("granted");
  await store.grantRead(taskId, "domain:example.com");
  expect((await store.require(taskId, "domain:example.com", "read")).status).toBe("granted");
  let write: WebApprovalRequired | undefined;
  try { await store.require(taskId, "action:tab-1:click", "write", "request-1"); } catch (error) { if (error instanceof WebApprovalRequired) write = error; }
  await store.decide(taskId, write!.approval.id, true);
  await store.beginWrite(taskId, write!.approval.id);
  await store.reconcile(taskId);
  await expect(store.require(taskId, "action:tab-1:click", "write", "request-1")).rejects.toThrow("uncertain");
  await expect(store.require(taskId, "action:tab-1:fill", "write", "request-1")).rejects.toThrow("reused with different arguments");
});

test("browser takeover rejects a queued click before the driver executes it", async () => {
  let clicks = 0;
  const browser = { takeOver() {}, returnControl() {}, disconnect: async () => {}, click: async () => { clicks++; return {} as never; } } as unknown as VisibleBrowser;
  const kernel = new BrowserKernel(null, null);
  kernel.attachPreview(taskId, browser);
  const pending = kernel.handle(taskId).click("#submit");
  kernel.setControl("user");
  await expect(pending).rejects.toThrow("control changed");
  expect(clicks).toBe(0);
  await kernel.detachPreview(taskId);
});

test("a queued approved action is rejected after the document changes", async () => {
  let documentIdentity = "draft-one";
  let clicks = 0;
  const browser = { get documentIdentity() { return documentIdentity; }, takeOver() {}, returnControl() {}, disconnect: async () => {}, click: async () => { clicks++; return {} as never; } } as unknown as VisibleBrowser;
  const kernel = new BrowserKernel(null, null);
  kernel.attachPreview(taskId, browser);
  const pending = kernel.handle(taskId, undefined, undefined, "draft-one").click("#submit");
  documentIdentity = "draft-two";
  await expect(pending).rejects.toThrow("page changed");
  expect(clicks).toBe(0);
  await kernel.detachPreview(taskId);
});

test("a public-page approval cannot be reused after navigation", async () => {
  const root = await temporary();
  const permissions = new WebPermissionStore(root);
  let page = { url: "https://example.com/one", documentIdentity: "document-one" };
  let clicks = 0;
  const kernel = {
    currentTab: async () => ({ tabId: "tab-one", targetId: "target-one", title: "Draft", url: page.url }),
    documentIdentity: () => page.documentIdentity,
    handle: () => ({ click: async () => { clicks++; return {}; } }),
  } as unknown as BrowserKernel;
  const web = { taskId, projectRoot: root, permissions, kernel } as WebToolContext;
  const tool = createBrowserTool(() => null, root, undefined, web);
  const args = { action: "click" as const, tabId: "tab-one", selector: "#submit", requestId: "request-one" };
  expect((await tool.execute("call-one", args, undefined, {} as never)).isError).toBe(true);
  const [approval] = await permissions.list(taskId);
  await permissions.decide(taskId, approval.id, true);
  page = { url: "https://example.com/two", documentIdentity: "document-two" };
  const changed = await tool.execute("call-two", args, undefined, {} as never);
  expect(changed.isError).toBe(true);
  expect(changed.content[0]).toMatchObject({ text: expect.stringContaining("reused with different arguments") });
  expect(clicks).toBe(0);
});

test("worker browser requests reject stale or malformed envelopes", () => {
  const id = "12345678-1234-1234-1234-123456789012";
  expect(() => parseWorkerBrowserRequest({ id, args: { action: "click", selector: "#x" }, deadlineAt: Date.now() - 1 }, id)).toThrow("expired");
  expect(() => parseWorkerBrowserRequest({ id, args: { action: "eval", code: "alert(1)" }, deadlineAt: Date.now() + 1000 }, id)).toThrow("Invalid");
  expect(parseWorkerBrowserRequest({ id, args: { action: "observe" }, deadlineAt: Date.now() + 1000 }, id).id).toBe(id);
});
