import { isAbsolute } from "node:path";
import type { TaskState } from "../../task-ledger";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/** Evidence, preview, run and development-workflow events. */

/** Mirrors `TaskLedger.assertActive`; every guard here is pure, so it moves into the reducer. */
function assertActive(state: TaskState): void {
  if (state.status !== "active") throw new InvariantError("apply/not-active", `Task is ${state.status}`);
}

export const evidenceReducers: FamilyReducers = {
  // The payload carries the finished record (id, contractVersion, recordedAt filled by the ledger method);
  // the pure guards from `recordEvidence` re-run against it so a bad event can never enter the fold.
  "evidence/recorded": (state, event) => {
    assertActive(state);
    const evidence = event.payload.evidence;
    const criterion = state.criteria.find(item => item.id === evidence.criterionId);
    if (!criterion || criterion.kind !== evidence.kind) throw new InvariantError("apply/evidence-criterion-mismatch", "Evidence does not match a criterion");
    if (evidence.revision !== state.revision) throw new InvariantError("apply/evidence-revision-stale", "Evidence revision is stale");
    if (evidence.kind === "browser" && (!state.preview || evidence.previewId !== state.preview.id)) {
      throw new InvariantError("apply/evidence-preview-mismatch", "Browser evidence must match the current preview");
    }
    if (!evidence.source.trim()) throw new InvariantError("apply/evidence-source-blank", "Evidence source is required");
    if ((evidence.kind === "source" || evidence.kind === "artifact") && !/^[0-9a-f]{64}$/.test(evidence.contentHash ?? "")) {
      throw new InvariantError("apply/evidence-hash-missing", "Versioned source or artifact evidence needs a SHA-256 hash");
    }
    state.evidence.push(evidence);
  },

  "preview/published": (state, event) => {
    assertActive(state);
    const preview = event.payload.preview;
    if (preview.revision !== state.revision) throw new InvariantError("apply/preview-revision-stale", "Preview revision is stale");
    if (!isAbsolute(preview.path) || !preview.url.startsWith("http://127.0.0.1:")) {
      throw new InvariantError("apply/preview-not-local-loopback", "Preview must use an absolute local path and loopback URL");
    }
    state.preview = preview;
  },

  // `recordRun` has no guards; contractVersion and recordedAt are already set by the ledger method.
  "run/ended": (state, event) => {
    state.runs ??= [];
    state.runs.push(event.payload.run);
  },

  "development/enabled": (state) => {
    if (state.development?.enabled) return;
    state.development = { enabled: true, repairAttempts: 0 };
  },

  // The revision/contract fingerprint comparison in `recordDevelopmentReview` needs IO and stays in the
  // ledger method; everything pure moves here.
  "review/recorded": (state, event) => {
    assertActive(state);
    const review = event.payload.review;
    if (!state.development?.enabled || !state.revision || !review.instanceId) throw new InvariantError("apply/review-state-invalid", "开发审查状态无效");
    state.development.review = review;
  },

  "repair-attempt/recorded": (state) => {
    if (!state.development?.enabled || state.development.repairAttempts >= 2) throw new InvariantError("apply/repair-attempts-exhausted", "自动修复次数已用尽");
    state.development.repairAttempts++;
  },
};
