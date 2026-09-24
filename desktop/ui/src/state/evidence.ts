import type { EvidenceItem } from "../api/types";

export interface BrowserStep {
  /** 1-based step number, as recorded by the browser verifier. */
  index: number;
  action: string;
  passed: boolean;
  detail?: string;
}

export interface BrowserFailure {
  step: number;
  total: number;
  spec: Record<string, unknown> | null;
  passedBefore: number;
  message: string;
}

export type ParsedEvidence =
  | { kind: "browser"; steps: BrowserStep[]; reason: string | null; failure: BrowserFailure | null }
  | { kind: "text"; text: string };

const FAILURE = /^Verification step (\d+)\/(\d+) (\{.*?\}) failed after (\d+) passing steps: ([\s\S]*)$/;

export function parseFailure(reason: string): BrowserFailure | null {
  const match = FAILURE.exec(reason.trim());
  if (!match) return null;
  let spec: Record<string, unknown> | null = null;
  try { spec = JSON.parse(match[3]) as Record<string, unknown>; } catch { /* Keep the message even if the step JSON is unusual. */ }
  return { step: Number(match[1]), total: Number(match[2]), spec, passedBefore: Number(match[4]), message: match[5].trim() };
}

export function parseEvidence(content: string): ParsedEvidence {
  if (content.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as { results?: unknown; reason?: unknown };
      if (Array.isArray(parsed.results) || typeof parsed.reason === "string") {
        const steps = (Array.isArray(parsed.results) ? parsed.results : [])
          .filter((item): item is BrowserStep => !!item && typeof item === "object" && typeof (item as BrowserStep).index === "number")
          .map(item => ({ index: item.index, action: String(item.action), passed: item.passed === true, detail: typeof item.detail === "string" ? item.detail : undefined }));
        const reason = typeof parsed.reason === "string" ? parsed.reason : null;
        return { kind: "browser", steps, reason, failure: reason ? parseFailure(reason) : null };
      }
    } catch { /* Fall back to showing the raw content. */ }
  }
  return { kind: "text", text: content };
}

const ACTIONS: Record<string, string> = {
  click: "点击",
  fill: "填写",
  select: "选择",
  expectText: "应显示文字",
  expectAbsentText: "不应显示文字",
  expectValue: "输入框的值应为",
  contrast: "文字对比度",
  video: "视频抽帧检查",
  viewport: "切换视口",
  wait: "等待",
  reload: "刷新页面",
};

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}

export function describeStep(spec: Record<string, unknown>): string {
  const action = String(spec.action ?? "");
  const parts = [actionLabel(action)];
  if (action === "viewport") parts.push(`${spec.width}×${spec.height}`);
  else if (action === "wait") parts.push(`${spec.ms} ms`);
  else if (action === "contrast") parts.push(`${spec.selector ?? ""} ≥ ${spec.minRatio}:1`);
  else {
    if (typeof spec.text === "string") parts.push(`“${spec.text}”`);
    if (typeof spec.selector === "string") parts.push(spec.selector);
    if (typeof spec.value === "string") parts.push(`= “${spec.value}”`);
  }
  return parts.filter(Boolean).join(" ");
}

export type CriterionState = "pass" | "fail" | "pending";

/** Pass when the server reports no gap; fail when the newest evidence for the current revision failed. */
export function criterionState(id: string, pending: string[], evidence: EvidenceItem[]): CriterionState {
  if (!pending.includes(id)) return "pass";
  const latest = evidence.filter(item => item.criterionId === id && item.current).at(-1);
  return latest && !latest.passed ? "fail" : "pending";
}

/** The evidence record closest to (and not long before) a moment in the timeline, for linking a check result to its file. */
export function evidenceNear(evidence: EvidenceItem[], criterionId: string, at: string): EvidenceItem | null {
  const time = new Date(at).getTime();
  let best: EvidenceItem | null = null;
  let bestDistance = Infinity;
  for (const item of evidence) {
    if (item.criterionId !== criterionId) continue;
    const distance = Math.abs(new Date(item.recordedAt).getTime() - time);
    if (distance < bestDistance && distance <= 120_000) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}
