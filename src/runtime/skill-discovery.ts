import { createHash } from "node:crypto";
import type { TaskLedger } from "./task-ledger";

export interface SkillCandidate {
  name: string;
  description: string;
  source: string;
  revision: string;
  path: string;
  installs: number;
  requirements?: { tools: string[]; services: string[]; conflicts: string[] };
}

const PUBLIC_TERMS = new Set("react typescript javascript python go rust java node frontend backend testing test unit integration e2e playwright vitest jest accessibility ui ux design css html api database sql postgres sqlite security performance debugging refactoring documentation pdf docx excel spreadsheet pptx slides image video audio comfyui unity blender git github docker cloudflare deployment ci cd agents agent prompt research citation latex data analysis visualization search memory mcp plugin skill planning review architecture mobile android ios electron desktop web animation i18n localization workflow tdd seo nextjs vite bun svelte vue tailwind figma writing automation infrastructure kubernetes devops code quality types database migration graphics animation marketing".split(" "));
const sourcePattern = /^(?!\.)[A-Za-z0-9_-][A-Za-z0-9_.-]*\/(?!\.)[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export function publicSkillQuery(input: string): string {
  const query = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!query || query.length > 80 || !/^[a-z0-9+ .-]+$/.test(query) || query.split(/[ .+-]+/).some(token => token && !PUBLIC_TERMS.has(token))) throw new Error("Skill 搜索只接受通用公开技术词；请改用技术类别，不要包含项目资料");
  return query;
}

async function getJson(url: string, fetcher: typeof fetch, deadline: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "alpha-agent-skill-discovery" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) });
  if (!response.ok) throw new Error(`能力搜索服务返回 HTTP ${response.status}`);
  return response.json();
}

function frontmatter(text: string, field: string): string | undefined {
  const header = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return header ? new RegExp(`^${field}:\\s*["']?([^\\r\\n"']+)`, "mi").exec(header)?.[1]?.trim() : undefined;
}

function frontmatterList(text: string, field: string): string[] {
  return (frontmatter(text, field) ?? "").replace(/^\[|\]$/g, "").split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
}

function scorePath(path: string, name: string): number {
  const folder = path.toLowerCase().split("/").at(-2) ?? "";
  const parts = name.toLowerCase().split("-").filter(part => part.length > 2);
  return (folder === name.toLowerCase() ? 100 : 0) + parts.filter(part => folder.includes(part)).length * 10;
}

export async function searchPublicSkills(query: string, fetcher: typeof fetch = fetch): Promise<SkillCandidate[]> {
  const safeQuery = publicSkillQuery(query);
  const deadline = AbortSignal.timeout(30_000);
  const search = await getJson(`https://skills.sh/api/search?${new URLSearchParams({ q: safeQuery, limit: "20" })}`, fetcher, deadline) as { skills?: unknown };
  if (!Array.isArray(search.skills)) throw new Error("Skill 搜索结果格式发生变化");
  const results = search.skills.filter((item): item is { name: string; source: string; installs: number } => !!item && typeof item === "object" && typeof item.name === "string" && typeof item.source === "string" && sourcePattern.test(item.source) && typeof item.installs === "number");
  const repositories = new Set<string>();
  const candidates: SkillCandidate[] = [];
  for (const result of results) {
    if (repositories.has(result.source)) continue;
    if (repositories.size >= 3) break;
    repositories.add(result.source);
    try {
      const commit = await getJson(`https://api.github.com/repos/${result.source}/commits/HEAD`, fetcher, deadline) as { sha?: string; commit?: { tree?: { sha?: string } } };
      if (!/^[0-9a-f]{40}$/.test(commit.sha ?? "") || !/^[0-9a-f]{40}$/.test(commit.commit?.tree?.sha ?? "")) continue;
      const tree = await getJson(`https://api.github.com/repos/${result.source}/git/trees/${commit.commit!.tree!.sha}?recursive=1`, fetcher, deadline) as { truncated?: boolean; tree?: Array<{ path?: string; type?: string }> };
      if (tree.truncated || !Array.isArray(tree.tree)) continue;
      const paths = tree.tree.filter(item => item.type === "blob" && typeof item.path === "string" && /(?:^|\/)SKILL\.md$/i.test(item.path) && !item.path.includes("..") && item.path.includes("/")).map(item => item.path!).sort((a, b) => scorePath(b, result.name) - scorePath(a, result.name)).slice(0, 8);
      const found: SkillCandidate[] = [];
      for (const path of paths) {
        const response = await fetcher(`https://raw.githubusercontent.com/${result.source}/${commit.sha}/${path}`, { signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) });
        if (!response.ok) continue;
        const content = (await response.text()).slice(0, 80_000);
        if (frontmatter(content, "name")?.toLowerCase() !== result.name.toLowerCase()) continue;
        found.push({ name: result.name, description: frontmatter(content, "description") ?? "来源仓库未提供单行说明", source: `https://github.com/${result.source}`, revision: commit.sha!, path, installs: result.installs, requirements: { tools: frontmatterList(content, "requires-tools"), services: frontmatterList(content, "requires-services"), conflicts: frontmatterList(content, "conflicts-with") } });
      }
      if (found.length === 1) candidates.push(found[0]);
    } catch {
      // An individual repository may disappear between search and inspection.
    }
  }
  return candidates.slice(0, 3);
}

export async function discoverForGap(ledger: TaskLedger, description: string, publicQuery: string, fetcher: typeof fetch = fetch): Promise<{ candidates: SkillCandidate[]; error?: string; cached: boolean }> {
  const query = publicSkillQuery(publicQuery);
  const key = createHash("sha256").update(JSON.stringify([ledger.state.contractVersion ?? 1, description.trim(), query])).digest("hex");
  const cognition = ledger.state.cognition;
  if (cognition?.skillSearches?.some(item => item.key === key)) return { candidates: cognition.skillProposals?.filter(item => item.key === key).map(item => ({ name: item.name, description: item.description, source: item.source, revision: item.revision, path: item.path, installs: item.installs, requirements: item.requirements })) ?? [], cached: true };
  if ((cognition?.skillSearches?.filter(item => item.gapDescription === description.trim()).length ?? 0) >= 2) throw new Error("该能力缺口的两次搜索已用尽；请根据现有提案或提供新要求");
  let candidates: SkillCandidate[] = [];
  let error: string | undefined;
  try { candidates = await searchPublicSkills(query, fetcher); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  await ledger.recordSkillSearch({ key, gapDescription: description.trim(), query, error, proposals: candidates });
  return { candidates, error, cached: false };
}
