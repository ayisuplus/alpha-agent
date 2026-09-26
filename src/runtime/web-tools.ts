import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { BrowserKernel } from "./browser-kernel";
import { WebApprovalRequired, WebPermissionStore } from "./web-permissions";
import { WebRetrieval } from "./web-retrieval";

export interface WebToolContext {
  taskId: string;
  projectRoot: string;
  retrieval: WebRetrieval;
  permissions: WebPermissionStore;
  kernel: BrowserKernel;
  directMode?: "ask" | "auto" | "full";
  onNeedsInput?: (reason: string) => Promise<void>;
}

export async function webRead(context: WebToolContext, scope: string): Promise<void> {
  if (!context.directMode || context.directMode === "full") return;
  try { await context.permissions.require(context.taskId, scope, "read"); }
  catch (error) {
    if (error instanceof WebApprovalRequired) await context.onNeedsInput?.(`网页只读授权待处理：${scope}。请在任务中批准请求 ${error.approval.id}。`);
    throw error;
  }
}

export async function webWrite<T>(context: WebToolContext, scope: string, actionId: string, details: string, run: () => Promise<T>): Promise<T> {
  let approval;
  try { approval = await context.permissions.require(context.taskId, scope, "write", actionId, details); }
  catch (error) {
    if (error instanceof WebApprovalRequired) await context.onNeedsInput?.(`外部网页动作待审批：${scope}。请在任务中批准请求 ${error.approval.id}。`);
    throw error;
  }
  if (approval.status === "complete") throw new Error("External web action already completed; inspect the site before another action");
  await context.permissions.beginWrite(context.taskId, approval.id);
  try {
    const result = await run();
    await context.permissions.finishWrite(context.taskId, approval.id);
    return result;
  } catch (error) {
    await context.permissions.finishWrite(context.taskId, approval.id, true);
    throw error;
  }
}

const searchParameters = type({ query: "string" });
const crawlParameters = type({ action: "'map' | 'start' | 'status' | 'cancel'", "url?": "string", "id?": "string" });
const siteParameters = type({ operation: "'repo-search' | 'issues' | 'issue-detail'", "query?": "string", "repository?": "string", "number?": "number" });

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });

export function createSearchTool(context: WebToolContext): CustomTool<typeof searchParameters> {
  return { name: "alpha_search", label: "Search the web", description: "Search public web pages through Tavily. Results are discovery snippets, not archived full-text sources. The configured provider is never silently replaced.", parameters: searchParameters, loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        await webRead(context, "provider:tavily");
        return result(await context.retrieval.search(context.taskId, args.query, signal));
      } catch (error) { return failure(error); }
    },
  };
}

export function createCrawlTool(context: WebToolContext): CustomTool<typeof crawlParameters> {
  return { name: "alpha_crawl", label: "Map and crawl a website", description: "Map a public site or manage a bounded Firecrawl crawl job. The task owns returned job IDs and archived page sources.", parameters: crawlParameters, loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        await webRead(context, "provider:firecrawl");
        if (args.action === "map") { if (!args.url) throw new Error("url is required"); return result(await context.retrieval.map(context.taskId, args.url, signal)); }
        if (args.action === "start") { if (!args.url) throw new Error("url is required"); return result(await context.retrieval.startCrawl(context.taskId, args.url, signal)); }
        if (!args.id) throw new Error("id is required");
        return result(args.action === "status" ? await context.retrieval.crawlStatus(context.taskId, args.id, signal) : await context.retrieval.cancelCrawl(context.taskId, args.id, signal));
      } catch (error) { return failure(error); }
    },
  };
}

/** Deterministic GitHub reading uses the same owned visible tab and browser policy as generic navigation. */
export function createSiteTool(context: WebToolContext): CustomTool<typeof siteParameters> {
  return { name: "alpha_site", label: "Read GitHub", description: "Read GitHub repository search, issue lists, or an issue detail in an Alpha-owned visible tab.", parameters: siteParameters, loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        await webRead(context, "domain:github.com");
        let url: string;
        if (args.operation === "repo-search") {
          if (!args.query?.trim()) throw new Error("query is required");
          url = `https://github.com/search?q=${encodeURIComponent(args.query.trim())}&type=repositories`;
        } else {
          if (!args.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository)) throw new Error("repository must be owner/name");
          url = `https://github.com/${args.repository}/issues`;
          if (args.operation === "issue-detail") {
            if (!Number.isInteger(args.number) || args.number! < 1) throw new Error("positive issue number is required");
            url += `/${args.number}`;
          }
        }
        const existing = context.kernel.tabs(context.taskId).find(tab => { try { return new URL(tab.url).hostname === "github.com"; } catch { return false; } });
        const tab = existing ?? await context.kernel.openTab(context.taskId, url, signal);
        if (existing) {
          await context.kernel.allowNavigation(context.taskId, tab.tabId, url);
          await context.kernel.handle(context.taskId, tab.tabId, signal).navigate(url);
        }
        return result({ tab, observation: await context.kernel.handle(context.taskId, tab.tabId, signal).observe() });
      } catch (error) { return failure(error); }
    },
  };
}
