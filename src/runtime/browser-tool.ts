import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { BrowserSession } from "./visible-browser";
import { webRead, webWrite, type WebToolContext } from "./web-tools";

export const browserParameters = type({
  action: "'observe' | 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'wait' | 'upload' | 'download' | 'viewport' | 'screenshot' | 'video-frames' | 'open' | 'tabs' | 'focus' | 'close'",
  "selector?": "string",
  "value?": "string",
  "url?": "string",
  "width?": "number",
  "height?": "number",
  "distance?": "number",
  "tabId?": "string",
  "requestId?": "string",
});

async function uploadFile(path: string, dataRoot: string, web: WebToolContext): Promise<{ path: string; sha256: string }> {
  const file = await realpath(path);
  if (/(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.git|\.ssh|\.aws|\.azure|\.codex|\.npmrc|credentials?(?:\.[^\\/]*)?|auth\.json|id_(?:rsa|ed25519))(?:[\\/]|$)/i.test(file)) throw new Error("Protected file cannot be uploaded by the model");
  const roots = [web.projectRoot, join(dataRoot, "artifacts", web.taskId)];
  const allowed = (await Promise.all(roots.map(root => realpath(root).catch(() => null)))).some(root => {
    if (!root) return false;
    const remainder = relative(root, file);
    return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
  });
  if (!allowed) throw new Error("Upload file must belong to this task's project or artifacts");
  const info = await stat(file);
  if (!info.isFile() || info.size > 50_000_000) throw new Error("Upload file is unavailable or exceeds 50 MB");
  return { path: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
}

export function createBrowserTool(getBrowser: () => BrowserSession | null, dataRoot: string, allowedUrl?: string, web?: WebToolContext, readOnly = false): CustomTool<typeof browserParameters> {
  return {
    name: "alpha_browser",
    label: "Visible product browser",
    description: "Inspect and interact with the visible local preview or an owned Alpha web tab. Use tabId for public pages and fresh element refs from observe. Public page writes require a stable requestId and exact approval.",
    parameters: browserParameters,
    loadMode: "essential",
    async execute(toolCallId, args, _update, _ctx, signal) {
      try {
        if (readOnly && !["tabs", "open", "observe", "navigate", "scroll", "wait", "screenshot", "video-frames"].includes(args.action)) throw new Error("This planning or review session has read-only browser access");
        if (args.action === "tabs") {
          if (!web) throw new Error("Desktop web browser is unavailable");
          return { content: [{ type: "text", text: JSON.stringify(web.kernel.tabs(web.taskId)) }] };
        }
        if (args.action === "open") {
          if (!web || !args.url) throw new Error("url and desktop web browser are required");
          await webRead(web, `domain:${new URL(args.url).hostname}`);
          const tab = await web.kernel.openTab(web.taskId, args.url, signal);
          return { content: [{ type: "text", text: JSON.stringify({ tab, observation: await web.kernel.handle(web.taskId, tab.tabId, signal).observe() }) }] };
        }
        if (args.action === "focus" || args.action === "close") {
          if (!web || !args.tabId) throw new Error("Owned tabId is required");
          if (args.action === "focus") await web.kernel.focusTab(web.taskId, args.tabId);
          else await web.kernel.closeTab(web.taskId, args.tabId);
          return { content: [{ type: "text", text: JSON.stringify({ tabId: args.tabId, action: args.action }) }] };
        }
        if (args.tabId && web) {
          const current = await web.kernel.currentTab(web.taskId, args.tabId);
          await webRead(web, `domain:${new URL(current.url).hostname}`);
        }
        const pageIdentity = args.tabId && web && ["click", "fill", "select", "press", "upload", "download"].includes(args.action)
          ? web.kernel.documentIdentity(web.taskId, args.tabId) : undefined;
        let browser = args.tabId && web ? web.kernel.handle(web.taskId, args.tabId, signal, pageIdentity) : getBrowser();
        if (!browser) throw new Error("No visible browser page is connected");
        if ("withSignal" in browser && typeof browser.withSignal === "function") browser = browser.withSignal(signal) as BrowserSession;
        if (readOnly && ["click", "fill", "select", "press", "upload", "download"].includes(args.action)) throw new Error("This reviewer has read-only browser access");
        if (args.tabId && args.action === "navigate") {
          if (!args.url) throw new Error("url is required");
          await webRead(web!, `domain:${new URL(args.url).hostname}`);
          await web!.kernel.allowNavigation(web!.taskId, args.tabId, args.url);
        }
        const upload = args.action === "upload" ? await (async () => {
          if (!web || !args.value) throw new Error("Task and file path are required for upload");
          return uploadFile(args.value, dataRoot, web);
        })() : null;
        const perform = async () => {
        if (args.action === "video-frames") {
          if (!args.selector) throw new Error("selector is required");
          const result = await browser.videoFrames(args.selector);
          return { content: [
            { type: "text" as const, text: JSON.stringify({ duration: result.duration, width: result.width, height: result.height, frameTimes: ["start", "middle", "end"] }) },
            ...result.frames.map(data => ({ type: "image" as const, data, mimeType: "image/png" })),
          ] };
        }
        if (args.action === "download") {
          if (!args.selector || !web) throw new Error("selector and task are required for download");
          const directory = join(dataRoot, "downloads", web.taskId, createHash("sha256").update(toolCallId).digest("hex").slice(0, 24));
          return { content: [{ type: "text" as const, text: JSON.stringify(await browser.download(args.selector, directory)) }] };
        }
        let observation;
        let screenshotPath: string | undefined;
        switch (args.action) {
          case "observe":
            observation = await browser.observe();
            break;
          case "navigate":
            if (!args.url) throw new Error("url is required");
            if (!args.tabId && allowedUrl && new URL(args.url).origin !== new URL(allowedUrl).origin) throw new Error("Browser navigation must stay on the assigned local preview");
            observation = await browser.navigate(args.url);
            break;
          case "click":
            if (!args.selector) throw new Error("selector is required");
            observation = await browser.click(args.selector);
            break;
          case "fill":
            if (!args.selector || args.value === undefined) throw new Error("selector and value are required");
            observation = await browser.fill(args.selector, args.value);
            break;
          case "select":
            if (!args.selector || args.value === undefined) throw new Error("selector and value are required");
            observation = await browser.select(args.selector, args.value);
            break;
          case "press":
            if (!args.selector || !args.value) throw new Error("selector and key value are required");
            observation = await browser.press(args.selector, args.value);
            break;
          case "scroll":
            if (args.distance === undefined) throw new Error("distance is required");
            observation = await browser.scroll(args.distance);
            break;
          case "wait":
            if (!args.selector) throw new Error("selector is required");
            observation = await browser.wait(args.selector);
            break;
          case "upload":
            if (!args.selector || !upload) throw new Error("selector and file path are required");
            if ((await uploadFile(upload.path, dataRoot, web!)).sha256 !== upload.sha256) throw new Error("Upload file changed after approval");
            observation = await browser.upload(args.selector, upload.path);
            break;
          case "viewport":
            if (args.width === undefined || args.height === undefined) throw new Error("width and height are required");
            observation = await browser.viewport(args.width, args.height);
            break;
          case "screenshot":
            screenshotPath = join(dataRoot, "browser", `${toolCallId}.png`);
            await mkdir(join(dataRoot, "browser"), { recursive: true });
            observation = await browser.screenshot(screenshotPath);
            break;
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...observation, screenshotPath }) }] };
        };
        if (args.tabId && ["click", "fill", "select", "press", "upload", "download"].includes(args.action)) {
          if (!args.requestId) throw new Error("Public page interaction needs a stable requestId for approval and recovery");
          if (args.value && args.value.length > 1000 && !upload) throw new Error("Public page action value exceeds the reviewable limit");
          const argumentsJson = JSON.stringify({ tabId: args.tabId, pageIdentity, action: args.action, selector: args.selector, value: args.value, fileHash: upload?.sha256 });
          const digest = createHash("sha256").update(argumentsJson).digest("hex");
          const details = `${args.action} ${args.selector} @ ${new URL((await web!.kernel.currentTab(web!.taskId, args.tabId)).url).href}${args.value === undefined ? "" : ` → ${JSON.stringify(args.value)}`}${upload ? ` · SHA-256 ${upload.sha256}` : ""}`;
          return await webWrite(web!, `action:${args.tabId}:${args.action}:${digest}`, args.requestId, details, perform);
        }
        return await perform();
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
