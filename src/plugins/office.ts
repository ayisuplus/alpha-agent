import type { TaskLedger } from "../runtime/task-ledger";
import { taskProfile } from "../runtime/task-profile";
import { createOfficeStatusTool, createOfficeTools } from "../runtime/office-tool";

export const officePlugin = {
  id: "office",
  name: "Office",
  description: "离线读取和修改任务中的 Word、Excel、PowerPoint 与 PDF",
  source: "builtin" as const,
};

export function createOfficePlugin(options: { ledger?: TaskLedger; dataRoot: string; enabled?: boolean; readOnly?: boolean }) {
  if (options.enabled === false) return { tools: [], instructions: [] };
  if (!options.ledger) return { tools: [createOfficeStatusTool()], instructions: [] };
  if (!taskProfile(options.ledger.state.taskType).officeTools || options.ledger.state.workspaceOrigin?.kind === "direct") return { tools: [], instructions: [] };
  return {
    tools: createOfficeTools(options.ledger, options.dataRoot, options.readOnly),
    instructions: ["For an attached Office or PDF file, use alpha_office_read before editing. alpha_office_edit creates a separate version and verifies it after saving. If unsupported features are reported, explain the limitation and do not claim an edit succeeded. Include the returned output and PDF preview paths in alpha-deliverable.json. A successful save does not prove visual fidelity."],
  };
}
