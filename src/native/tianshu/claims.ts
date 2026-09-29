/**
 * Claim-vs-evidence reconciliation: the Tianshu "claims must have evidence"
 * audit. Advisory only — it reminds, it never blocks.
 *
 * Adapted from Tianshu-harness v3.27.0, Apache-2.0:
 * src/agent/claim-audit.ts. See licenses/Tianshu-APACHE-2.0.txt and
 * licenses/Tianshu-NOTICE.txt.
 *
 * When the assistant text asserts "全绿 / N/N 通过 / 已修复 / typecheck 干净"
 * style outcomes, the claim is reconciled against the observed evidence
 * timeline. Freshness: a verification only backs a claim when it succeeded
 * after the last code mutation — "全绿" rerun before the latest edit is a stale
 * green. Claims are typed: a test claim needs test-family evidence, a type
 * claim needs type-family evidence, a lint claim needs lint-family evidence.
 * Type checks never back test claims and vice versa.
 */

import type { VerificationFamily } from "./change-class";

export type ClaimKind = VerificationFamily;

/** Test-green claim: asserts the test suite passed. "已修复" is a behavioral claim → tests. */
const TEST_CLAIM_RE =
  /全绿|所有测试通过|测试(?:全部)?通过|已修复|修复完成|\bfixed\b|\btests?\s+(?:pass(?:ed|ing)?|green)\b|\d+\s*\/\s*\d+\s*(?:通过|passed|pass)/i;

/** Typecheck-clean claim: asserts type checking passed (may coexist with a test claim). */
const TYPE_CLAIM_RE = /(?:typecheck|类型检查|tsc)\s*(?:干净|clean|pass(?:ed)?|通过)|没有类型错误|no type errors?\b/i;

/** Lint-clean claim. */
const LINT_CLAIM_RE = /(?:lint|ruff|eslint|biome|oxlint)\s*(?:干净|clean|pass(?:ed)?|通过)|没有\s*lint\s*错误|no lint errors?\b/i;

const CLAIM_PATTERNS: Readonly<Record<ClaimKind, RegExp>> = {
  test: TEST_CLAIM_RE,
  type: TYPE_CLAIM_RE,
  lint: LINT_CLAIM_RE,
};

const CLAIM_LABELS: Readonly<Record<ClaimKind, string>> = {
  test: "测试通过/全绿",
  type: "typecheck 干净",
  lint: "lint 干净",
};

const CLAIM_ORDER: readonly ClaimKind[] = ["test", "type", "lint"];

/** Claim kinds asserted in this text. */
export function detectClaims(text: string): ClaimKind[] {
  if (text.length === 0) return [];
  return CLAIM_ORDER.filter(kind => CLAIM_PATTERNS[kind].test(text));
}

/** Freshness view over the evidence timeline (sequence numbers, larger = later). */
export interface ClaimEvidence {
  lastMutationSeq: number;
  lastPassedSeqByFamily: Readonly<Record<ClaimKind, number>>;
}

export interface ClaimIssue {
  kind: ClaimKind;
  /** Advisory reminder line, shown to user and next-turn model. */
  line: string;
}

function reminderLine(kind: ClaimKind, evidence: ClaimEvidence): string {
  const claimed = CLAIM_LABELS[kind];
  const freshOther = CLAIM_ORDER.filter(
    other => other !== kind && evidence.lastPassedSeqByFamily[other] > evidence.lastMutationSeq,
  );
  const crossNote =
    freshOther.length > 0
      ? `现有新鲜验证只有 ${freshOther.map(other => CLAIM_LABELS[other]).join("、")}——${kind === "test" ? "typecheck 干净证明不了测试通过" : "测试通过证明不了" + claimed}。`
      : "改完没重跑的结论是旧结论。";
  return `天枢提醒：对话里出现了“${claimed}”类宣称，但最后一次代码变更之后没有对应族的通过记录。${crossNote}请由你判断，必要时先补跑对应验证再确认。`;
}

/**
 * Reconcile asserted claims against evidence. Returns one advisory issue per
 * unbacked claim kind; empty = no claim or every claim has fresh typed evidence.
 */
export function auditClaims(claimed: readonly ClaimKind[], evidence: ClaimEvidence): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  for (const kind of claimed) {
    if (evidence.lastPassedSeqByFamily[kind] > evidence.lastMutationSeq) continue;
    issues.push({ kind, line: reminderLine(kind, evidence) });
  }
  return issues;
}
