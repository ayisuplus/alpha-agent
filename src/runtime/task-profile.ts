import type { TaskType } from "./task-ledger";

/** Coordinator tools that produce or check a task's deliverable; each is built from its name in the runner. */
export type DeliveryTool = "alpha_check" | "alpha_document" | "alpha_build";

/**
 * How a finished run is accepted: a built product verified in the visible preview, configured checks over a source
 * change, a reviewable deliverable file, or whichever of those the run actually produced.
 */
export type AcceptanceKind = "web-preview" | "code-checks" | "deliverable" | "adaptive";

/**
 * Everything that differs between task types, in one place. Runtime code asks the profile instead of comparing type
 * names, so changing what a task type can do, or adding one, is a single edit here.
 */
export interface TaskProfile {
  /** Source-code work: edits pin Hashline; other work keeps OMP's per-model edit format. */
  writesCode: boolean;
  /** How the runtime accepts a finished run. */
  acceptance: AcceptanceKind;
  /** Coordinator tools that produce and check the deliverable. Direct projects cannot build or write documents. */
  deliveryTools(direct: boolean): DeliveryTool[];
  /** Uploaded files live in inputs/, which no file tool may write. */
  uploads: boolean;
  /** Uploaded attachments are read through alpha_input. */
  attachments: boolean;
  /** The coordinator and implementing workers may request commands, which the approvals queue then decides. */
  commands: boolean;
  /** The coordinator can dispatch subagents. */
  dispatch: boolean;
  /**
   * How a user-designated expert binds — the same picker entry, two contracts:
   * - dispatching types (`web-product`, `code-change`): execution contract — some implementing order must carry the
   *   expert, and acceptance requires a completed instance of exactly this expert (`task-completion`'s
   *   `designated-expert` gap; `worker-binding`'s allocation guard refuses dispatch without it);
   * - the other types: perspective only — the expert is the coordinator's persona and methods, no instance is
   *   required and none is implied.
   */
  expertPerspective: boolean;
  /** Third-party hooks and MCP servers the user selected are loaded for the coordinator. */
  thirdParty: boolean;
  /** Office document tools (read and edit DOCX, XLSX, PPTX, PDF) are available. */
  officeTools: boolean;
  /** An independent development review runs before acceptance. */
  developmentReview: boolean;
  /** Configured checks over a recorded source baseline can accept the task. */
  codeAcceptance: boolean;
}

const PROFILES: Record<TaskType, TaskProfile> = {
  "web-product": {
    writesCode: true, acceptance: "web-preview", deliveryTools: () => ["alpha_build"], uploads: false, attachments: false, commands: false,
    dispatch: true, expertPerspective: false, thirdParty: true, officeTools: false, developmentReview: true, codeAcceptance: false,
  },
  "code-change": {
    writesCode: true, acceptance: "code-checks", deliveryTools: () => ["alpha_check"], uploads: false, attachments: false, commands: true,
    dispatch: true, expertPerspective: true, thirdParty: false, officeTools: false, developmentReview: true, codeAcceptance: true,
  },
  research: {
    writesCode: false, acceptance: "deliverable", deliveryTools: () => ["alpha_document"], uploads: true, attachments: false, commands: false,
    dispatch: false, expertPerspective: true, thirdParty: true, officeTools: false, developmentReview: false, codeAcceptance: false,
  },
  "file-work": {
    writesCode: false, acceptance: "deliverable", deliveryTools: () => ["alpha_document"], uploads: true, attachments: false, commands: false,
    dispatch: false, expertPerspective: true, thirdParty: true, officeTools: true, developmentReview: false, codeAcceptance: false,
  },
  general: {
    writesCode: false, acceptance: "adaptive", deliveryTools: direct => direct ? ["alpha_check"] : ["alpha_check", "alpha_document", "alpha_build"],
    uploads: true, attachments: true, commands: true, dispatch: false, expertPerspective: true, thirdParty: true, officeTools: true, developmentReview: false, codeAcceptance: true,
  },
};

/** Tasks recorded before task types existed are web products. */
export function taskProfile(taskType: TaskType | undefined): TaskProfile {
  return PROFILES[taskType ?? "web-product"];
}
