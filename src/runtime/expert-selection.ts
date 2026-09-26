import type { AgentPresetSnapshot } from "./agent-presets";

function terms(value: string): Set<string> {
  const text = value.toLowerCase();
  const words: string[] = [...(text.match(/[a-z][a-z0-9-]{2,}/g) ?? [])];
  const han = text.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const phrase of han) for (let i = 0; i < phrase.length - 1; i++) words.push(phrase.slice(i, i + 2));
  return new Set(words);
}

/** A cheap initial shortlist. The model may revise it; a shortlist never starts an instance. */
export function initialExpertCandidates(objective: string, experts: readonly AgentPresetSnapshot[]): string[] {
  const wanted = terms(objective);
  return experts.map(expert => ({ id: expert.id, score: [...terms(`${expert.name} ${expert.description}`)].filter(term => wanted.has(term)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3).map(item => item.id);
}

export function searchExpertCandidates(query: string, experts: readonly AgentPresetSnapshot[], limit = 8): AgentPresetSnapshot[] {
  const wanted = terms(query);
  return experts.map(expert => {
    const corpus = `${expert.id} ${expert.name} ${expert.description}`.toLowerCase();
    const score = [...wanted].filter(term => corpus.includes(term)).length + (corpus.includes(query.trim().toLowerCase()) ? 4 : 0);
    return { expert, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.expert.id.localeCompare(b.expert.id)).slice(0, limit).map(item => item.expert);
}
