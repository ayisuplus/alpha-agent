import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";

export interface WorkerBrowserRequest { id: string; args: Record<string, unknown>; deadlineAt: number }
const workerBrowserParameters = type({ action: "'observe' | 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'wait' | 'viewport' | 'screenshot' | 'video-frames'", "selector?": "string", "value?": "string", "url?": "string", "width?": "number", "height?": "number", "distance?": "number" });
const actions = new Set(["observe", "navigate", "click", "fill", "select", "press", "scroll", "wait", "viewport", "screenshot", "video-frames"]);

export function parseWorkerBrowserRequest(value: unknown, id: string): WorkerBrowserRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker browser request");
  const request = value as Partial<WorkerBrowserRequest>;
  const args = request.args;
  if (request.id !== id || !args || typeof args !== "object" || Array.isArray(args) || !actions.has(String(args.action)) ||
      !Number.isFinite(request.deadlineAt) || request.deadlineAt! <= Date.now() || request.deadlineAt! > Date.now() + 36_000) throw new Error("Invalid or expired worker browser request");
  for (const [key, item] of Object.entries(args)) {
    if (!["action", "selector", "value", "url", "width", "height", "distance"].includes(key) || typeof item !== "string" && typeof item !== "number" || typeof item === "string" && item.length > 10_000) throw new Error("Invalid worker browser arguments");
  }
  return request as WorkerBrowserRequest;
}

/** The parent owns the visible browser; workers exchange one audited request per tool call. */
export function createWorkerBrowserTool(directory: string): CustomTool<typeof workerBrowserParameters> {
  return {
    name: "alpha_browser", label: "Visible product browser", loadMode: "essential", parameters: workerBrowserParameters,
    description: "Inspect or interact with the assigned visible local preview through the coordinator's browser. No arbitrary website navigation. If no preview is connected, report the missing context instead of claiming visual verification.",
    async execute(_id, args, _update, _ctx, signal) {
      const id = randomUUID();
      const responseFile = join(directory, `${id}.response.json`);
      await mkdir(directory, { recursive: true });
      const deadline = Date.now() + 35_000;
      const requestFile = join(directory, `${id}.request.json`);
      const temp = `${requestFile}.tmp`;
      await writeFile(temp, JSON.stringify({ id, args, deadlineAt: deadline }), { flag: "wx" });
      await rename(temp, requestFile);
      const cancel = async () => { await writeFile(join(directory, `${id}.cancel`), "cancelled", { flag: "wx" }).catch(() => undefined); };
      while (Date.now() < deadline) {
        if (signal?.aborted) { await cancel(); return { content: [{ type: "text", text: "Browser request cancelled; an in-flight action may have an uncertain outcome" }], isError: true }; }
        const result = await readFile(responseFile, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (result) return JSON.parse(result);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await cancel();
      return { content: [{ type: "text", text: "Browser coordinator did not answer within 35 seconds; inspect the page before repeating an action" }], isError: true };
    },
  };
}
