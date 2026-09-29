import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createComfyPlugin } from "../plugins/comfyui";
import { BrowserBridge } from "../runtime/browser-bridge";
import { BrowserKernel } from "../runtime/browser-kernel";
import { createDocumentTool } from "../runtime/document-tool";
import { editOffice, exportOfficePdf, officeRuntimeStatus, readOffice, type OfficeWorkspace } from "../runtime/office-runtime";

type Input = NonNullable<OfficeWorkspace["state"]["inputs"]>[number];
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });

export default function alphaCapabilities(pi: ExtensionAPI): void {
  const id = process.env.ALPHA_NATIVE_SESSION_ID;
  const dataRoot = process.env.ALPHA_DATA_ROOT;
  if (!id || !dataRoot) return;
  const root = dataRoot;
  const sessionId = id;
  const projectRoot = process.cwd();
  const inputsFile = join(root, "native", "office", `${id}.json`);
  const bridge = process.env.ALPHA_BROWSER_BRIDGE_PORT && process.env.ALPHA_BROWSER_BRIDGE_TOKEN ? new BrowserBridge() : null;
  const kernel = new BrowserKernel(Number(process.env.ALPHA_CDP_PORT) || null, bridge);
  let saveQueue = Promise.resolve();

  async function workspace(): Promise<OfficeWorkspace> {
    const inputs = await readFile(inputsFile, "utf8").then(text => JSON.parse(text) as Input[], () => [] as Input[]);
    return { state: { id: sessionId, projectRoot, inputs } };
  }
  async function saveInput(input: Input): Promise<void> {
    saveQueue = saveQueue.then(async () => {
      await mkdir(dirname(inputsFile), { recursive: true });
      const inputs = (await workspace()).state.inputs ?? [];
      const temp = `${inputsFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify([...inputs, input], null, 2));
      await rename(temp, inputsFile);
    });
    return saveQueue;
  }

  // Existing tools remain independent capabilities; OMP's native tools and discovery stay intact.
  for (const tool of [...createComfyPlugin({ projectRoot, dataRoot: root }).tools, createDocumentTool(projectRoot, root, id)]) {
    // These bundled tools use the pre-18.4 argument order; bridge only that boundary.
    const legacy = tool as unknown as { execute: (...args: any[]) => Promise<any> };
    pi.registerTool({ ...(tool as any), execute: (callId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => legacy.execute(callId, params, onUpdate, ctx, signal) });
  }

  pi.registerTool({
    name: "alpha_office_status", label: "Office runtime", description: "Check the local Office engine; this does not open a file.",
    parameters: type({}), async execute() { return result(await officeRuntimeStatus()); },
  });
  pi.registerTool({
    name: "alpha_office_attach", label: "Attach an existing Office file", loadMode: "discoverable",
    description: "Copy a local DOCX, XLSX, PPTX, or PDF into this session's managed inputs. The original file is unchanged. Returns an ID for read/edit/export.",
    parameters: type({ path: "string" }),
    async execute(_callId, args: { path: string }) {
      try {
        const source = await realpath(args.path);
        const extension = extname(source).slice(1).toLowerCase();
        if (!["docx", "xlsx", "pptx", "pdf"].includes(extension)) throw new Error("Unsupported Office file type");
        const info = await stat(source);
        if (!info.isFile() || info.size > 100_000_000) throw new Error("Office file is unavailable or too large");
        const contents = await readFile(source);
        const hash = createHash("sha256").update(contents).digest("hex");
        const inputId = randomUUID();
        const directory = join(root, "task-inputs", id);
        await mkdir(directory, { recursive: true });
        const target = join(directory, `${inputId}.${extension}`);
        await copyFile(source, target);
        if (createHash("sha256").update(await readFile(target)).digest("hex") !== hash) throw new Error("Office attachment changed during copy");
        const input: Input = { id: inputId, name: basename(source), path: target, sha256: hash, mimeType: "", size: info.size, uploadedAt: new Date().toISOString() };
        await saveInput(input);
        return result({ id: inputId, name: input.name, sha256: hash, original: source });
      } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: "alpha_office_read", label: "Read Office or PDF", loadMode: "discoverable",
    description: "Read a managed Office/PDF attachment or output by ID. Reports unsupported structures and OCR gaps.",
    parameters: type({ id: "string" }),
    async execute(_callId, args: { id: string }, signal) { try { return result(await readOffice(await workspace(), root, args.id, false, signal)); } catch (error) { return failure(error); } },
  });
  pi.registerTool({
    name: "alpha_office_edit", label: "Edit Office or PDF copy", loadMode: "discoverable",
    description: "Apply targeted JSON edits to a managed attachment or output. Saves a separate version with before/after preview and verification; never overwrites the original.",
    parameters: type({ id: "string", edits: "string" }),
    async execute(_callId, args: { id: string; edits: string }, signal) {
      try { const edits = JSON.parse(args.edits); if (!Array.isArray(edits)) throw new Error("edits must be an array"); return result(await editOffice(await workspace(), root, args.id, edits, signal)); }
      catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: "alpha_office_export", label: "Export Office PDF", loadMode: "discoverable",
    description: "Render an attached Office document to a separate PDF with source hash and preview.",
    parameters: type({ id: "string" }),
    async execute(_callId, args: { id: string }, signal) { try { return result(await exportOfficePdf(await workspace(), root, args.id, signal)); } catch (error) { return failure(error); } },
  });

  pi.registerTool({
    name: "alpha_browser", label: "Visible desktop browser", loadMode: "discoverable",
    description: "Open and inspect a public HTTPS page in Alpha's visible browser. Page interactions use a fresh selector from observe; writes require a desktop confirmation.",
    parameters: type({ action: "'open' | 'tabs' | 'focus' | 'close' | 'observe' | 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'wait' | 'screenshot'", "tabId?": "string", "url?": "string", "selector?": "string", "value?": "string", "distance?": "number" }),
    async execute(callId, args: { action: string; tabId?: string; url?: string; selector?: string; value?: string; distance?: number }, signal, _update, ctx) {
      try {
        if (args.action === "tabs") return result(kernel.tabs(id));
        if (args.action === "open") { if (!args.url) throw new Error("url required"); const tab = await kernel.openTab(id, args.url, signal); return result({ tab, observation: await kernel.handle(id, tab.tabId, signal).observe() }); }
        if (!args.tabId) throw new Error("tabId required");
        if (args.action === "focus") { await kernel.focusTab(id, args.tabId); return result({ focused: args.tabId }); }
        if (args.action === "close") { await kernel.closeTab(id, args.tabId); return result({ closed: args.tabId }); }
        const page = kernel.handle(id, args.tabId, signal);
        if (args.action === "observe") return result(await page.observe());
        if (args.action === "navigate") { if (!args.url) throw new Error("url required"); await kernel.allowNavigation(id, args.tabId, args.url); return result(await page.navigate(args.url)); }
        if (args.action === "scroll") { if (args.distance === undefined) throw new Error("distance required"); return result(await page.scroll(args.distance)); }
        if (args.action === "wait") { if (!args.selector) throw new Error("selector required"); return result(await page.wait(args.selector)); }
        if (args.action === "screenshot") { const path = join(root, "native", "browser", `${callId}.png`); await mkdir(dirname(path), { recursive: true }); return result({ path, observation: await page.screenshot(path) }); }
        if (!args.selector) throw new Error("selector required");
        const tab = await kernel.currentTab(id, args.tabId);
        const confirmed = await ctx.ui.confirm("网页操作", `${args.action} ${args.selector} @ ${tab.url}${args.value ? ` → ${args.value.slice(0, 200)}` : ""}`);
        if (!confirmed) throw new Error("User declined browser interaction");
        const stable = kernel.handle(id, args.tabId, signal, kernel.documentIdentity(id, args.tabId));
        if (args.action === "click") return result(await stable.click(args.selector));
        if (args.action === "fill") { if (args.value === undefined) throw new Error("value required"); return result(await stable.fill(args.selector, args.value)); }
        if (args.action === "select") { if (args.value === undefined) throw new Error("value required"); return result(await stable.select(args.selector, args.value)); }
        if (args.action === "press") { if (!args.value) throw new Error("key required"); return result(await stable.press(args.selector, args.value)); }
        throw new Error("Unsupported browser action");
      } catch (error) { return failure(error); }
    },
  });
}
