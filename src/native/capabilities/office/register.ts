import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { CapabilityContext } from "../extension";
import { editOffice, exportOfficePdf, officeRuntimeStatus, readOffice, type OfficeWorkspace } from "./office-runtime";

type Input = NonNullable<OfficeWorkspace["state"]["inputs"]>[number];
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });

/** Registers the alpha_office_* tools against the session's managed Office inputs. */
export function registerOfficeTools(pi: ExtensionAPI, ctx: CapabilityContext): void {
  const inputsFile = join(ctx.dataRoot, "native", "office", `${ctx.sessionId}.json`);
  let saveQueue = Promise.resolve();

  async function workspace(): Promise<OfficeWorkspace> {
    const inputs = await readFile(inputsFile, "utf8").then(text => JSON.parse(text) as Input[], () => [] as Input[]);
    return { state: { id: ctx.sessionId, projectRoot: ctx.projectRoot, inputs } };
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
        const directory = join(ctx.dataRoot, "task-inputs", ctx.sessionId);
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
    async execute(_callId, args: { id: string }, signal) { try { return result(await readOffice(await workspace(), ctx.dataRoot, args.id, false, signal)); } catch (error) { return failure(error); } },
  });
  pi.registerTool({
    name: "alpha_office_edit", label: "Edit Office or PDF copy", loadMode: "discoverable",
    description: "Apply targeted JSON edits to a managed attachment or output. Saves a separate version with before/after preview and verification; never overwrites the original.",
    parameters: type({ id: "string", edits: "string" }),
    async execute(_callId, args: { id: string; edits: string }, signal) {
      try { const edits = JSON.parse(args.edits); if (!Array.isArray(edits)) throw new Error("edits must be an array"); return result(await editOffice(await workspace(), ctx.dataRoot, args.id, edits, signal)); }
      catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: "alpha_office_export", label: "Export Office PDF", loadMode: "discoverable",
    description: "Render an attached Office document to a separate PDF with source hash and preview.",
    parameters: type({ id: "string" }),
    async execute(_callId, args: { id: string }, signal) { try { return result(await exportOfficePdf(await workspace(), ctx.dataRoot, args.id, signal)); } catch (error) { return failure(error); } },
  });
}
