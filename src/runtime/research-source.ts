import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { BrowserKernel } from "./browser-kernel";
import type { WebRetrieval } from "./web-retrieval";
import { WebApprovalRequired } from "./web-permissions";
import { warnUnknownStoreVersion } from "./store-tag";

export interface ResearchSource { id: string; taskId: string; url: string; visitedAt: string; title: string; sha256: string; rawSha256: string; text: string; kind?: "direct_http" | "provider_extraction" | "rendered_page"; provider?: string; requestId?: string; rawPath?: string }
const parameters = type({ url: "string", "mode?": "'http' | 'extract' | 'rendered'", "tabId?": "string" });

function publicAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("::ffff:") || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:") || lower.startsWith("fec0:")) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (!match) return true;
  const [first, second] = match.slice(1).map(Number);
  return first !== 0 && first !== 10 && first !== 127 && first < 224 && !(first === 100 && second >= 64 && second <= 127) && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && (second === 168 || second === 0)) && !(first === 198 && (second === 18 || second === 19));
}

function normalizeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !url.hostname || url.hostname === "localhost") throw new Error("Research source must be a public HTTPS page");
  return url;
}

export async function assertPublicWebUrl(raw: string): Promise<URL> {
  const url = normalizeUrl(raw);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address)) || isIP(url.hostname) && !publicAddress(url.hostname)) throw new Error("Web source resolves to a private address");
  return url;
}

function htmlText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "Untitled page";
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|amp|lt|gt|quot);/g, value => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"" })[value] ?? value).replace(/\s+/g, " ").trim();
  return { title, text: text.slice(0, 100_000) };
}

async function fetchPinned(url: URL, address: string, family: number, signal?: AbortSignal): Promise<{ body: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { timeout: 15_000, headers: { accept: "text/html,text/plain" }, lookup: (_host, options, callback) => {
      if (options.all) (callback as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
      else (callback as (error: null, address: string, family: number) => void)(null, address, family);
    } }, response => {
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) { response.resume(); reject(new Error(`Research source returned HTTP ${response.statusCode}`)); return; }
      const contentType = response.headers["content-type"] ?? "";
      if (!/text\/(html|plain)/i.test(contentType)) { response.resume(); reject(new Error("Research source is not a text page")); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) { request.destroy(new Error("Research source is too large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ body: Buffer.concat(chunks), contentType }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Research source timed out")));
    request.on("error", reject);
    signal?.addEventListener("abort", () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("Cancelled")), { once: true });
    request.end();
  });
}

export async function archiveResearchSource(dataRoot: string, taskId: string, rawUrl: string, signal?: AbortSignal): Promise<ResearchSource> {
  const url = normalizeUrl(rawUrl);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address)) || isIP(url.hostname) && !publicAddress(url.hostname)) throw new Error("Research source resolves to a private address");
  const selected = addresses.find(item => item.family === 4) ?? addresses[0];
  const fetched = await fetchPinned(url, selected.address, selected.family, signal);
  const body = fetched.body;
  const decoded = body.toString("utf8");
  const parsed = /text\/html/i.test(fetched.contentType) ? htmlText(decoded) : { title: url.hostname, text: decoded.slice(0, 100_000) };
  const source: ResearchSource = { id: randomUUID(), taskId, url: url.href, visitedAt: new Date().toISOString(), title: parsed.title, sha256: createHash("sha256").update(parsed.text).digest("hex"), rawSha256: createHash("sha256").update(body).digest("hex"), text: parsed.text, kind: "direct_http" };
  const directory = join(dataRoot, "sources", taskId);
  await mkdir(directory, { recursive: true });
  source.rawPath = join(directory, `${source.id}.raw`);
  await writeFile(source.rawPath, body, { flag: "wx" });
  // .alpha/sources/<taskId>/<id>.json (sources store): v1 = ResearchSource plus its format tag; a version bump must migrate in listResearchSources().
  await writeFile(join(directory, `${source.id}.json`), JSON.stringify({ ...source, format: "sources", version: 1 }, null, 2), { flag: "wx" });
  return source;
}

/** Provider output is evidence only after the actual returned body is persisted. */
export async function archiveExtractedSource(dataRoot: string, taskId: string, input: { url: string; title: string; text: string; raw: unknown; provider: string; requestId?: string; kind?: "provider_extraction" | "rendered_page" }): Promise<ResearchSource> {
  const id = randomUUID();
  const directory = join(dataRoot, "sources", taskId);
  const raw = Buffer.from(JSON.stringify(input.raw));
  const text = input.text.slice(0, 100_000);
  const source: ResearchSource = { id, taskId, url: input.url, visitedAt: new Date().toISOString(), title: input.title, text, sha256: createHash("sha256").update(text).digest("hex"), rawSha256: createHash("sha256").update(raw).digest("hex"), rawPath: join(directory, `${id}.raw`), provider: input.provider, requestId: input.requestId, kind: input.kind ?? "provider_extraction" };
  await mkdir(directory, { recursive: true });
  await writeFile(source.rawPath!, raw, { flag: "wx" });
  // .alpha/sources/<taskId>/<id>.json (sources store): v1 = ResearchSource plus its format tag; a version bump must migrate in listResearchSources().
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...source, format: "sources", version: 1 }, null, 2), { flag: "wx" });
  return source;
}

export async function listResearchSources(dataRoot: string, taskId: string): Promise<ResearchSource[]> {
  const directory = join(dataRoot, "sources", taskId);
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  return Promise.all(names.map(async name => {
    const source = JSON.parse(await readFile(join(directory, name), "utf8")) as ResearchSource;
    warnUnknownStoreVersion("sources", source);
    return source;
  }));
}

export function createResearchSourceTool(dataRoot: string, taskId: string, onUnavailable?: (reason: string) => Promise<void>, web?: { retrieval: WebRetrieval; kernel: BrowserKernel; authorizeRead: (scope: string) => Promise<void> }): CustomTool<typeof parameters> {
  return {
    name: "alpha_source", label: "Archive a web source",
    description: "Archive a specified public HTTPS page through direct HTTP, Firecrawl extraction, or the task's current rendered browser tab. Save raw material and content hashes. A failed specified source is never replaced automatically.",
    parameters, loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        signal?.throwIfAborted();
        const mode = args.mode ?? "http";
        const source = mode === "extract" ? await (async () => {
          if (!web) throw new Error("Web extraction is unavailable");
          await web.authorizeRead("provider:firecrawl");
          return web.retrieval.extract(taskId, args.url, signal);
        })() : mode === "rendered" ? await (async () => {
          if (!web || !args.tabId) throw new Error("An owned browser tab is required");
          const observation = await web.kernel.handle(taskId, args.tabId, signal).observe();
          if (observation.url !== args.url) throw new Error("Rendered source URL must match the visible tab");
          await web.authorizeRead(`domain:${new URL(args.url).hostname}`);
          return archiveExtractedSource(dataRoot, taskId, { url: observation.url, title: observation.title, text: observation.text, raw: observation, provider: "alpha-browser", kind: "rendered_page" });
        })() : await (async () => {
          await web?.authorizeRead(`domain:${new URL(args.url).hostname}`);
          return archiveResearchSource(dataRoot, taskId, args.url, signal);
        })();
        return { content: [{ type: "text", text: JSON.stringify({ ...source, text: source.text.slice(0, 20_000) }) }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!signal?.aborted && !(error instanceof WebApprovalRequired)) await onUnavailable?.(`网页来源 ${args.url} 无法访问：${reason}。请确认来源或提供下一步要求。`);
        return { content: [{ type: "text", text: reason }], isError: true };
      }
    },
  };
}
