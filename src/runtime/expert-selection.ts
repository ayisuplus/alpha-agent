import type { ExpertSnapshot } from "./experts";

function terms(value: string): Set<string> {
  const text = value.toLowerCase();
  const words: string[] = [...(text.match(/[a-z][a-z0-9-]{2,}/g) ?? [])];
  const han = text.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const phrase of han) for (let i = 0; i < phrase.length - 1; i++) words.push(phrase.slice(i, i + 2));
  return new Set(words);
}

function specialtyTerms(value: string): string[] {
  const generic = new Set(["agent", "code", "development", "expert", "project", "review", "source", "task", "work"]);
  return [...terms(value)].filter(term => !generic.has(term));
}

/**
 * A cheap initial shortlist (§4.3): name and description scoring plus the handoff declaration — role and
 * consumes/produces matches — with a one-hop expansion along `next` / `gate` relations. The model may revise it; a
 * shortlist never starts an instance.
 */
export function initialExpertCandidates(objective: string, experts: readonly ExpertSnapshot[]): string[] {
  const wanted = new Set(specialtyTerms(objective));
  const scores = new Map<string, number>();
  const byRole = new Map<string, string[]>();
  for (const expert of experts) {
    if (!expert.package?.skills.length) continue;
    const handoff = expert.package.handoff;
    const corpus = handoff ? `${expert.name} ${expert.description} ${handoff.role} ${handoff.consumes.join(" ")} ${handoff.produces.join(" ")}` : `${expert.name} ${expert.description}`;
    const score = [...terms(corpus)].filter(term => wanted.has(term)).length;
    if (score > 1) scores.set(expert.id, score);
    if (handoff?.role) byRole.set(handoff.role, [...(byRole.get(handoff.role) ?? []), expert.id]);
  }
  // One hop along the relations: who a matched expert hands work to, and whose gate its outputs must pass.
  for (const expert of experts) {
    const handoff = expert.package?.handoff;
    if (!handoff || !scores.has(expert.id)) continue;
    for (const role of [...handoff.next, ...handoff.gate]) for (const id of byRole.get(role) ?? []) if (!scores.has(id)) scores.set(id, 1);
  }
  return [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 3).map(([id]) => id);
}

/** Roles a built-in neutral reviewer performs when no expert declares them (§6.2). */
const NEUTRAL_GATE_ROLES = ["code-review"];

/**
 * Who performs a gate (§6.2): an enabled expert declaring the role wins; `code-review` falls back to the built-in
 * neutral reviewer; other roles have no neutral fallback and report a gap to pause on.
 */
export function gateActorFor(experts: readonly ExpertSnapshot[], gateRole: string): { expert?: ExpertSnapshot; neutral: boolean } | { missing: string } {
  if (!gateRole) return { neutral: true };
  const match = experts.find(item => item.package?.handoff?.role === gateRole);
  if (match) return { expert: match, neutral: false };
  if (NEUTRAL_GATE_ROLES.includes(gateRole)) return { neutral: true };
  return { missing: gateRole };
}

export function searchExpertCandidates(query: string, experts: readonly ExpertSnapshot[], limit = 8): ExpertSnapshot[] {
  const wanted = specialtyTerms(query);
  if (!wanted.length) return [];
  return experts.filter(expert => expert.package?.skills.length).map(expert => {
    const corpus = `${expert.id} ${expert.name} ${expert.description}`.toLowerCase();
    const score = wanted.filter(term => corpus.includes(term)).length + (corpus.includes(query.trim().toLowerCase()) ? 4 : 0);
    return { expert, score };
  }).filter(item => item.score > 1).sort((a, b) => b.score - a.score || a.expert.id.localeCompare(b.expert.id)).slice(0, limit).map(item => item.expert);
}
