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

/** A cheap initial shortlist. The model may revise it; a shortlist never starts an instance. */
export function initialExpertCandidates(objective: string, experts: readonly ExpertSnapshot[]): string[] {
  const wanted = new Set(specialtyTerms(objective));
  return experts.filter(expert => expert.package?.skills.length).map(expert => ({ id: expert.id, score: [...terms(`${expert.name} ${expert.description}`)].filter(term => wanted.has(term)).length }))
    .filter(item => item.score > 1).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3).map(item => item.id);
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
