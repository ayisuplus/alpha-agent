import { structuredPatch } from "diff";
import type { SourceChange } from "../api/types";

export interface DiffLine {
  kind: "context" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  truncated: boolean;
}

const MAX_LINES = 4_000;

export function fileDiff(change: SourceChange): FileDiff {
  const status = change.before === null ? "added" : change.after === null ? "deleted" : "modified";
  const patch = structuredPatch(change.path, change.path, change.before ?? "", change.after ?? "", undefined, undefined, { context: 3 });
  let additions = 0;
  let deletions = 0;
  let rendered = 0;
  let truncated = false;
  const hunks: DiffHunk[] = [];
  for (const hunk of patch.hunks) {
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    const lines: DiffLine[] = [];
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "\\") continue;
      if (marker === "+") { additions++; if (rendered < MAX_LINES) lines.push({ kind: "add", oldNo: null, newNo: newNo, text }); newNo++; }
      else if (marker === "-") { deletions++; if (rendered < MAX_LINES) lines.push({ kind: "del", oldNo: oldNo, newNo: null, text }); oldNo++; }
      else { if (rendered < MAX_LINES) lines.push({ kind: "context", oldNo: oldNo, newNo: newNo, text }); oldNo++; newNo++; }
      if (rendered < MAX_LINES) rendered++;
      else truncated = true;
    }
    if (lines.length) hunks.push({ header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, lines });
  }
  return { path: change.path, status, additions, deletions, hunks, truncated };
}
