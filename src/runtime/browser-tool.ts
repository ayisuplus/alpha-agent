import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { VisibleBrowser } from "./visible-browser";

const parameters = type({
  action: "'observe' | 'navigate' | 'click' | 'fill' | 'select' | 'viewport' | 'screenshot' | 'video-frames'",
  "selector?": "string",
  "value?": "string",
  "url?": "string",
  "width?": "number",
  "height?": "number",
});

export function createBrowserTool(getBrowser: () => VisibleBrowser | null, dataRoot: string, allowedUrl?: string): CustomTool<typeof parameters> {
  return {
    name: "alpha_browser",
    label: "Visible product browser",
    description: "Inspect and interact with the same visible local preview the user sees. Observe controls and errors before clicking. Navigate only to local preview URLs. Screenshots alone do not prove a user path works.",
    parameters,
    loadMode: "essential",
    async execute(toolCallId, args) {
      const browser = getBrowser();
      if (!browser) return { content: [{ type: "text", text: "No visible preview is connected" }], isError: true };
      try {
        if (args.action === "video-frames") {
          if (!args.selector) throw new Error("selector is required");
          const result = await browser.videoFrames(args.selector);
          return { content: [
            { type: "text" as const, text: JSON.stringify({ duration: result.duration, width: result.width, height: result.height, frameTimes: ["start", "middle", "end"] }) },
            ...result.frames.map(data => ({ type: "image" as const, data, mimeType: "image/png" })),
          ] };
        }
        let observation;
        let screenshotPath: string | undefined;
        switch (args.action) {
          case "observe":
            observation = await browser.observe();
            break;
          case "navigate":
            if (!args.url) throw new Error("url is required");
            if (allowedUrl && new URL(args.url).origin !== new URL(allowedUrl).origin) throw new Error("Browser navigation must stay on the assigned local preview");
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
        return { content: [{ type: "text", text: JSON.stringify({ ...observation, screenshotPath }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
