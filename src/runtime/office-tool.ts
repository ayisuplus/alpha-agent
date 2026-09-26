import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";
import { editOffice, exportOfficePdf, officeRuntimeStatus, readOffice } from "./office-runtime";

const idParams = type({ id: "string" });
const editParams = type({ id: "string", edits: "string" });

function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
function failure(error: unknown) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }

export function createOfficeStatusTool(): CustomTool {
  return {
    name: "alpha_office_status", label: "Check Office runtime", parameters: type({}), loadMode: "essential",
    description: "Check whether the local LibreOffice runtime is available. No document is opened.",
    async execute() { return result(await officeRuntimeStatus()); },
  };
}

export function createOfficeTools(ledger: TaskLedger, dataRoot: string, readOnly = false): CustomTool[] {
  const status = createOfficeStatusTool();
  const read: CustomTool<typeof idParams> = {
    name: "alpha_office_read", label: "Read attached Office or PDF file", parameters: idParams, loadMode: "essential",
    description: "Read a DOCX, XLSX, PPTX or text PDF by this task's attachment or Office output ID. Returns object locators and warns about unsupported editing features and scanned PDF pages.",
    async execute(_callId, args, _update, _ctx, signal) {
      try { return result(await readOffice(ledger, dataRoot, args.id, false, signal)); }
      catch (error) { return failure(error); }
    },
  };
  if (readOnly) return [status, read];
  const edit: CustomTool<typeof editParams> = {
    name: "alpha_office_edit", label: "Edit a copy of an attached document", parameters: editParams, loadMode: "essential",
    description: "Create a new verified version of a DOCX, XLSX, PPTX or PDF attached to this task. edits is a JSON array. DOCX: {paragraph:0,expected:'old',replacement:'new'} or {table:'Table1',cell:'A1',expected:'old',replacement:'new'}. XLSX: {sheet:'Sheet1',cell:'A1',expected:'old',replacement:4}. PPTX text: {slide:0,shape:0,expected:'old',replacement:'new'}; image: {slide:0,shape:1,imageInputId:'attached-image-id'}. PDF: {kind:'select',pages:[1,3]}, {kind:'reorder',pages:[2,1]}, {kind:'rotate',pages:[1],degrees:90}, {kind:'merge',ids:['attached-pdf-id']}. Never edits the original. Include the returned output in alpha-deliverable.json; its before and after previews are archived automatically.",
    async execute(_callId, args, _update, _ctx, signal) {
      try {
        const edits = JSON.parse(args.edits) as unknown;
        if (!Array.isArray(edits)) throw new Error("edits must be a JSON array");
        return result(await editOffice(ledger, dataRoot, args.id, edits, signal));
      } catch (error) { return failure(error); }
    },
  };
  const exportPdf: CustomTool<typeof idParams> = {
    name: "alpha_office_export", label: "Export an attached Office document as PDF", parameters: idParams, loadMode: "essential",
    description: "Render this task's DOCX, XLSX or PPTX to PDF without changing the source. Include the returned PDF in alpha-deliverable.json when it is part of the deliverable.",
    async execute(_callId, args, _update, _ctx, signal) {
      try { return result(await exportOfficePdf(ledger, dataRoot, args.id, signal)); }
      catch (error) { return failure(error); }
    },
  };
  return [status, read, edit, exportPdf];
}
