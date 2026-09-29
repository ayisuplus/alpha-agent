import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveExtractedSource, assertPublicWebUrl, type ResearchSource } from "./research-source";
import { warnUnknownStoreVersion } from "../native/capabilities/comfyui/store-tag";

export type WebProvider = "tavily" | "firecrawl";
export interface WebSearchHit { title: string; url: string; snippet: string; score: number | null; publishedAt: string | null; provider: WebProvider; requestId: string | null }
export interface WebSearchResponse { query: string; results: WebSearchHit[]; requestId: string | null; usage: unknown }
export interface CrawlJob { id: string; provider: "firecrawl"; url: string; status: string; cancelRequested: boolean; creditsUsed?: number; pages?: number; next?: string; archived?: string[] }
interface TaskWebState { searchCount: number; providerCalls: number; jobs: Record<string, CrawlJob> }
type Json = Record<string, unknown>;
const API = { tavily: "https://api.tavily.com", firecrawl: "https://api.firecrawl.dev" } as const;

function record(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

/** Alpha owns provider budgets, job identities, and source provenance. No provider can silently replace another. */
export class WebRetrieval {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataRoot: string, private readonly credential: (provider: WebProvider) => Promise<string | null> = async provider => process.env[provider === "tavily" ? "TAVILY_API_KEY" : "FIRECRAWL_API_KEY"] ?? null, private readonly transport: typeof fetch = fetch) {}

  private path(taskId: string): string { return join(this.dataRoot, "web", `${taskId}.json`); }
  private async state(taskId: string): Promise<TaskWebState> {
    const state = JSON.parse(await readFile(this.path(taskId), "utf8").catch(() => '{"searchCount":0,"providerCalls":0,"jobs":{}}')) as TaskWebState;
    warnUnknownStoreVersion("web", state);
    return state;
  }
  private async change<T>(taskId: string, mutate: (state: TaskWebState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.state(taskId);
      const result = mutate(state);
      const path = this.path(taskId);
      await mkdir(join(this.dataRoot, "web"), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      // .alpha/web/<taskId>.json (web store): v1 = TaskWebState plus its format tag; a version bump must migrate in state().
      await writeFile(temp, JSON.stringify({ ...state, format: "web", version: 1 }, null, 2));
      await rename(temp, path);
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
  private async charge(taskId: string, search = false): Promise<void> {
    await this.change(taskId, state => {
      if (state.providerCalls >= 40 || search && state.searchCount >= 10) throw new Error("Task web request budget exhausted");
      state.providerCalls++;
      if (search) state.searchCount++;
    });
  }
  private async call(taskId: string, provider: WebProvider, method: "GET" | "POST" | "DELETE", path: string, body?: Json, signal?: AbortSignal): Promise<Json> {
    signal?.throwIfAborted();
    const key = await this.credential(provider);
    if (!key) throw new Error(`${provider} API key is not configured`);
    if (!/^\/[A-Za-z0-9_./?=&%+-]+$/.test(path)) throw new Error("Invalid provider path");
    await this.charge(taskId, provider === "tavily" && path === "/search");
    const controller = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]);
    const response = await this.transport(`${API[provider]}${path}`, { method, headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: controller });
    if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length"));
    if (size > 3_000_000) throw new Error(`${provider} response is too large`);
    const raw = await response.text();
    if (raw.length > 3_000_000) throw new Error(`${provider} response is too large`);
    const payload = record(JSON.parse(raw));
    if (payload.success === false) throw new Error(`${provider} reported an unsuccessful request`);
    return payload;
  }

  async search(taskId: string, query: string, signal?: AbortSignal): Promise<WebSearchResponse> {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > 500) throw new Error("Search query must be 1–500 characters");
    const payload = await this.call(taskId, "tavily", "POST", "/search", { query: trimmed, max_results: 5, include_answer: false }, signal);
    const requestId = string(payload.request_id) || null;
    const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, 5).map(item => {
      const hit = record(item);
      return { title: string(hit.title), url: string(hit.url), snippet: string(hit.content).slice(0, 4_000), score: integer(hit.score) ?? (typeof hit.score === "number" ? hit.score : null), publishedAt: string(hit.published_date) || null, provider: "tavily" as const, requestId };
    }).filter(hit => { try { return new URL(hit.url).protocol === "https:"; } catch { return false; } });
    return { query: trimmed, results, requestId, usage: payload.usage ?? null };
  }

  async extract(taskId: string, rawUrl: string, signal?: AbortSignal): Promise<ResearchSource> {
    const url = await assertPublicWebUrl(rawUrl);
    const payload = await this.call(taskId, "firecrawl", "POST", "/v2/scrape", { url: url.href, formats: ["markdown"], onlyMainContent: true }, signal);
    const data = record(payload.data);
    const metadata = record(data.metadata);
    const text = string(data.markdown);
    if (!text.trim()) throw new Error("firecrawl returned no extracted body");
    return archiveExtractedSource(this.dataRoot, taskId, { url: url.href, title: string(metadata.title) || url.hostname, text, raw: payload, provider: "firecrawl", requestId: string(payload.id) || undefined });
  }

  async map(taskId: string, rawUrl: string, signal?: AbortSignal): Promise<{ urls: string[]; requestId: string | null }> {
    const url = await assertPublicWebUrl(rawUrl);
    const payload = await this.call(taskId, "firecrawl", "POST", "/v2/map", { url: url.href, limit: 100 }, signal);
    const links = Array.isArray(payload.links) ? payload.links : [];
    return { urls: links.map(item => typeof item === "string" ? item : string(record(item).url)).filter(Boolean).slice(0, 100), requestId: string(payload.id) || null };
  }

  async startCrawl(taskId: string, rawUrl: string, signal?: AbortSignal): Promise<CrawlJob> {
    const url = await assertPublicWebUrl(rawUrl);
    const payload = await this.call(taskId, "firecrawl", "POST", "/v2/crawl", { url: url.href, limit: 10, maxDiscoveryDepth: 2, scrapeOptions: { formats: ["markdown"] } }, signal);
    const id = string(payload.id);
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("firecrawl returned no valid crawl job ID");
    return this.change(taskId, state => state.jobs[id] = { id, provider: "firecrawl", url: url.href, status: "submitted", cancelRequested: false });
  }

  async crawlStatus(taskId: string, id: string, signal?: AbortSignal): Promise<{ job: CrawlJob; sources: ResearchSource[] }> {
    const job = (await this.state(taskId)).jobs[id];
    if (!job) throw new Error("Crawl job does not belong to this task");
    const next = job.next ? new URL(job.next) : null;
    if (next && (next.origin !== API.firecrawl || next.pathname !== `/v2/crawl/${id}`)) throw new Error("Invalid crawl continuation URL");
    const payload = await this.call(taskId, "firecrawl", "GET", next ? `${next.pathname}${next.search}` : `/v2/crawl/${id}`, undefined, signal);
    const data = Array.isArray(payload.data) ? payload.data.slice(0, 10) : [];
    const sources: ResearchSource[] = [];
    const seen = new Set(job.archived ?? []);
    for (const item of data) {
      const page = record(item);
      const metadata = record(page.metadata);
      const pageUrl = string(metadata.sourceURL) || string(metadata.url);
      const text = string(page.markdown);
      if (!pageUrl || !text) continue;
      await assertPublicWebUrl(pageUrl);
      const fingerprint = createHash("sha256").update(pageUrl).update("\0").update(text).digest("hex");
      if (seen.has(fingerprint)) continue;
      sources.push(await archiveExtractedSource(this.dataRoot, taskId, { url: pageUrl, title: string(metadata.title) || new URL(pageUrl).hostname, text, raw: page, provider: "firecrawl", requestId: id }));
      seen.add(fingerprint);
    }
    const updated = await this.change(taskId, state => state.jobs[id] = { ...state.jobs[id], status: string(payload.status) || "unknown", creditsUsed: integer(payload.creditsUsed), pages: integer(payload.completed), next: string(payload.next) || undefined, archived: [...seen] });
    return { job: updated, sources };
  }

  async cancelCrawl(taskId: string, id: string, signal?: AbortSignal): Promise<CrawlJob> {
    const prior = (await this.state(taskId)).jobs[id];
    if (!prior) throw new Error("Crawl job does not belong to this task");
    if (prior.cancelRequested) return prior;
    await this.change(taskId, state => { state.jobs[id].cancelRequested = true; });
    try { await this.call(taskId, "firecrawl", "DELETE", `/v2/crawl/${id}`, undefined, signal); }
    catch (error) {
      await this.change(taskId, state => { state.jobs[id].status = "cancel-uncertain"; });
      throw error;
    }
    return (await this.state(taskId)).jobs[id];
  }

  async jobs(taskId: string): Promise<CrawlJob[]> { return Object.values((await this.state(taskId)).jobs); }
}
