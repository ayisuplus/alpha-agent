import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { CapabilityContext } from "../extension";
import {
  officeConvert,
  officeCreate,
  officeEdit,
  officeInspect,
  officePdf,
  officePreview,
  OfficeError,
  type ConvertFormat,
  type OfficeResult,
  type PdfParams,
  type SlideSpec,
} from "./office-runtime";

/** edit operations: union discriminated by `op` (office-spec 6.3). */
const editOperation = type({ op: "'replace_text'", paragraph: "number", expected: "string", replacement: "string" })
  .or({ op: "'insert_paragraph'", after: "number", text: "string", "style?": "string" })
  .or({ op: "'add_table_row'", table: "string", cells: "(string | number)[]" })
  .or({ op: "'set_cells'", sheet: "string", range: "string", values: "unknown[][]" })
  .or({ op: "'add_slide'", after: "number", title: "string", bullets: "string[]", "layout?": "'title' | 'title_content' | 'blank'" })
  .or({ op: "'remove_slide'", index: "number" })
  .or({ op: "'duplicate_slide'", index: "number", after: "number" })
  .or({ op: "'set_shape'", slide: "number", shape: "number", "text?": "string", "image?": "string" });

const sheetSpec = type({ "name?": "string", headers: "string[]", rows: "unknown[][]", "widths?": "number[]" });
const slideSpec = type({ title: "string", bullets: "string[]", "layout?": "'title' | 'title_content' | 'blank'" });

/** pdf actions: union discriminated by `action` (office-spec 6.3). */
const pdfParameters = type({ action: "'merge'", paths: "string[]", "name?": "string" })
  .or({ action: "'split'", paths: "string[]", "name?": "string", "ranges?": "number[][]" })
  .or({ action: "'rotate'", paths: "string[]", "name?": "string", "pages?": "number[]", "degrees?": "number" })
  .or({ action: "'watermark'", paths: "string[]", "name?": "string", text: "string", "fontSize?": "number", "opacity?": "number", "degrees?": "number" })
  .or({ action: "'extract'", paths: "string[]", "name?": "string", pages: "number[]" });

const officeParameters = type({
  action: "'inspect' | 'edit' | 'create' | 'convert' | 'pdf' | 'preview'",
  "path?": "string",
  "ops?": editOperation.array(),
  "kind?": "'docx' | 'xlsx' | 'pptx' | 'pdf'",
  "name?": "string",
  "content?": "string",
  "data?": type({ sheets: sheetSpec.array() }).or({ "name?": "string", headers: "string[]", rows: "unknown[][]", "widths?": "number[]" }),
  "outline?": slideSpec.array(),
  "layout?": "'title' | 'title_content' | 'blank'",
  "to?": "'docx' | 'xlsx' | 'pptx' | 'pdf' | 'html' | 'odt' | 'ods' | 'odp'",
  "pdf?": pdfParameters,
  "pages?": "number[]",
});

interface OfficeToolParams {
  action: "inspect" | "edit" | "create" | "convert" | "pdf" | "preview";
  path?: string;
  ops?: unknown[];
  kind?: "docx" | "xlsx" | "pptx" | "pdf";
  name?: string;
  content?: string;
  data?: unknown;
  outline?: SlideSpec[];
  layout?: "title" | "title_content" | "blank";
  to?: ConvertFormat;
  pdf?: PdfParams;
  pages?: number[];
}

function requirePath(path: unknown, action: string): string {
  if (typeof path !== "string" || !path.trim()) throw new OfficeError(`${action} 需要 path`);
  return path;
}

function sessionInput(params: OfficeToolParams): Record<string, unknown> {
  if (params.action === "create") return { kind: params.kind, name: params.name };
  if (params.action === "pdf") return { paths: params.pdf?.paths, pdfAction: params.pdf?.action };
  return { path: params.path, ...(params.action === "convert" ? { to: params.to } : {}), ...(params.pages ? { pages: params.pages } : {}) };
}

/** preview/before PNGs ride along as ImageContent so the desktop card can show thumbnails. */
async function previewImages(projectRoot: string, result: OfficeResult): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const artifact of result.artifacts) {
    for (const png of [artifact.preview, artifact.before]) {
      if (!png) continue;
      const bytes = await readFile(isAbsolute(png) ? png : join(projectRoot, png)).catch(() => undefined);
      if (bytes) images.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
    }
  }
  return images;
}

/** Registers the single alpha_office tool (plan 6.3: one tool, path in / path out). */
export function registerOfficeTools(pi: ExtensionAPI, ctx: CapabilityContext): void {
  pi.registerTool({
    name: "alpha_office",
    label: "Office documents",
    description: "Work on office documents by project path. Actions: inspect (editable paragraph/table/sheet/slide addresses and unsupported structures), edit (targeted ops written to a new <name>.alpha-v<N> copy; the original is never overwritten), create (markdown content to docx/pdf, table data to xlsx, outline to pptx, written to outputs/), convert (soffice conversion into outputs/), pdf (merge, split, rotate, watermark, extract with pdf-lib), preview (render pages to outputs/previews/*.png). Reading document text is the native read tool's job. inspect, edit, create docx/pdf/pptx, convert, and preview of office files need local LibreOffice; create xlsx and the pdf actions never do, and missing LibreOffice returns an explicit gap.",
    parameters: officeParameters,
    approval: "write",
    async execute(_callId, params: OfficeToolParams, signal) {
      try {
        const projectRoot = ctx.projectRoot;
        let result;
        switch (params.action) {
          case "inspect":
            result = await officeInspect({ projectRoot }, requirePath(params.path, "inspect"), signal);
            break;
          case "edit":
            result = await officeEdit({ projectRoot }, requirePath(params.path, "edit"), params.ops ?? [], signal);
            break;
          case "create":
            result = await officeCreate({ projectRoot }, {
              kind: params.kind ?? (() => { throw new OfficeError("create 需要 kind"); })(),
              name: params.name ?? (() => { throw new OfficeError("create 需要 name"); })(),
              content: params.content,
              data: params.data,
              outline: params.outline,
              layout: params.layout,
            }, signal);
            break;
          case "convert":
            result = await officeConvert({ projectRoot }, requirePath(params.path, "convert"), params.to ?? (() => { throw new OfficeError("convert 需要 to"); })(), params.name, signal);
            break;
          case "pdf":
            result = await officePdf({ projectRoot }, params.pdf ?? (() => { throw new OfficeError("pdf 动作需要 pdf 参数"); })(), signal);
            break;
          default:
            result = await officePreview({ projectRoot }, requirePath(params.path, "preview"), params.pages, signal);
            break;
        }
        pi.appendEntry("alpha-office", { action: params.action, input: sessionInput(params), artifacts: result.artifacts });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }, ...(await previewImages(ctx.projectRoot, result))],
        };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });
}
