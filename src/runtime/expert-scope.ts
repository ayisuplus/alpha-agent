import { readFile } from "node:fs/promises";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { SkillPluginStore } from "../plugins/third-party";
import { loadExpertPackageSkills, personaText, type ExpertMounts } from "./expert-package";
import type { TemporaryExpert } from "./task-ledger";
import { verifyExpertSnapshot, type ExpertSnapshot } from "./experts";
import { validateSkillBindings } from "./skill-binding";

/**
 * Expert activation is node state (docs/plan-graph-and-expert-state-2026-09-29.md §4): entering a node mounts the
 * expert's persona, its packaged Skills and its declared MCP services, and leaving unloads them. `resolveExpertScope`
 * is the one entry both the coordinator and subagents use (§4.4); the host's access stays authoritative — a persona or
 * a mounted Skill can only add capability, never permission (§4.1).
 */

/** Where the scope mounts: the coordinator session or a subagent run. */
export type ExpertHost = "coordinator" | "worker";
/** What the runtime granted the node; mounting cannot widen it. */
export type ExpertAccess = "read-only" | "write";

export interface ExpertScope {
  /** The library expert that activated; absent when a task-local temporary expert did (§4.3). */
  expert?: ExpertSnapshot;
  /** The task-local expert that activated; mutually exclusive with `expert`. */
  temporary?: TemporaryExpert;
  /** Persona text for the prompt (§4.4 step 1). */
  persona: string;
  /** The primary method's SKILL.md body to inject; absent in list mode (§4.4 step 2). */
  primary?: { id: string; text: string };
  /** Mounted Skills: bundled ∪ explicitly added extras (§4.4 steps 3 and 6). */
  skills: Skill[];
  /** Where each mounted Skill came from; the two sources stay distinguishable (§4.4 step 6). */
  sources: Array<{ id: string; source: "bundled" | "explicit" }>;
  /** Declared MCP services; the host opens each under per-item authorization (§4.4 step 4). */
  mcp: string[];
  /** Declared services the host session does not have: pause and report a gap, never skip silently (§4.4 step 4). */
  missingMcp: string[];
  /** Set when the primary method fell back to list mode; the run record notes it (§4.4 step 2). */
  budgetFallback?: { id: string; reason: string };
}

export interface ExpertScopeInput {
  /** A library expert; mutually exclusive with `temporaryExpert`. */
  expert?: ExpertSnapshot;
  /** A task-local expert (§4.3); it mounts like a library expert but never widens permissions. */
  temporaryExpert?: TemporaryExpert;
  host: ExpertHost;
  access: ExpertAccess;
  dataRoot: string;
  /** Skills added on top of the package: explicit selections only extend the mount (§4.4 step 6). */
  extraSkillIds?: readonly string[];
  /** Token budget for the injected primary method; over budget it falls back to list mode (§4.4 step 2). */
  primaryBudgetTokens?: number;
  /** Whose tokenizer counts the primary method against the budget; estimates when omitted. */
  model?: ConstructorParameters<typeof Tokenizer>[0];
  /** MCP service names the host session actually loaded, for the declared-service check (§4.4 step 4). */
  mcpServers?: readonly string[];
  /** Restricted hosts are checked against their mode's tool set (§4.4 step 5). */
  fullAccess?: boolean;
}

export async function resolveExpertScope(input: ExpertScopeInput): Promise<ExpertScope> {
  const { expert, temporaryExpert, dataRoot, access } = input;
  if (expert && temporaryExpert) throw new Error("专家激活只能选一种来源");
  if (!expert && !temporaryExpert) throw new Error("专家激活缺少来源");
  if (expert) verifyExpertSnapshot(expert);
  const declared: ExpertMounts = expert
    ? expert.package?.mounts ?? { skills: [...(expert.skillIds ?? [])], ...(expert.skillIds?.length ? { primarySkill: expert.skillIds[0] } : {}), mcp: [] }
    : { skills: [...temporaryExpert!.skillIds], ...(temporaryExpert!.skillIds.length ? { primarySkill: temporaryExpert!.skillIds[0] } : {}), mcp: [] };
  const packaged = new Map((expert ? await loadExpertPackageSkills(dataRoot, expert) : []).map(skill => [skill.name, skill]));
  const skills: Skill[] = [];
  const sources: ExpertScope["sources"] = [];
  for (const id of declared.skills) {
    // A snapshot from before packages existed named pool Skills; those resolve from the pool like extras do.
    const skill = packaged.get(id) ?? (await new SkillPluginStore(dataRoot).loadSkills([id]))[0];
    if (!skill) throw new Error(`专家随包 Skill 不可用：${id}`);
    skills.push(skill);
    sources.push({ id, source: "bundled" });
  }
  const extras = [...new Set(input.extraSkillIds ?? [])].filter(id => !skills.some(skill => skill.name === id));
  const added = extras.length ? await new SkillPluginStore(dataRoot).loadSkills(extras) : [];
  const missingExtra = extras.find(id => !added.some(skill => skill.name === id));
  if (missingExtra) throw new Error(`Skill 未安装或未启用：${missingExtra}`);
  skills.push(...added);
  sources.push(...added.map(skill => ({ id: skill.name, source: "explicit" as const })));

  let primary: ExpertScope["primary"];
  let budgetFallback: ExpertScope["budgetFallback"];
  const primaryId = declared.primarySkill && skills.some(skill => skill.name === declared.primarySkill) ? declared.primarySkill : undefined;
  if (primaryId) {
    const text = await readFile(skills.find(skill => skill.name === primaryId)!.filePath, "utf8");
    const tokens = new Tokenizer(input.model).countTokens(text);
    if (input.primaryBudgetTokens !== undefined && tokens > input.primaryBudgetTokens) {
      budgetFallback = { id: primaryId, reason: `主方法正文 ${tokens} tokens 超出注入预算 ${input.primaryBudgetTokens}，退回按需读取` };
    } else {
      primary = { id: primaryId, text };
    }
  }

  await validateSkillBindings([{ id: `mount-${expert?.id ?? "temporary"}`, objective: "Expert activation", kind: access === "write" ? "execute" : "review", ownedPaths: [], resources: [], skillIds: skills.map(skill => skill.name), fullAccess: input.fullAccess ?? input.host === "coordinator" }], skills);

  const mcp = [...declared.mcp];
  const available = new Set(input.mcpServers ?? []);
  const persona = expert ? personaText(expert.name, expert.description, expert.instructions) : personaText(temporaryExpert!.name, temporaryExpert!.description, temporaryExpert!.instructions);
  return {
    ...(expert ? { expert } : {}), ...(temporaryExpert ? { temporary: temporaryExpert } : {}),
    persona, ...(primary ? { primary } : {}),
    skills, sources, mcp, missingMcp: mcp.filter(id => !available.has(id)), ...(budgetFallback ? { budgetFallback } : {}),
  };
}
