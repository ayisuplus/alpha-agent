import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent";
import type { WorkOrder } from "./work-orders";
import type { TaskPhase } from "./task-ledger";
import { PLANNING_TOOL_NAMES, REVIEW_PAUSE_TOOL_NAMES, WRITE_TOOL_NAMES } from "./planning-policy";

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

async function canonicalTarget(path: string): Promise<string> {
  const parent = dirname(path);
  if (parent === path) return realpath(path);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symbolic link target is not allowed: ${path}`);
    return realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const canonicalParent = await canonicalTarget(parent);
    return resolve(canonicalParent, path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

export function stripReadSelector(input: string): string {
  const token = String.raw`-?\d+(?:-\d*|\+\d+)?`;
  const ranges = `${token}(?:,${token})*`;
  return input.replace(new RegExp(String.raw`:(?:raw(?::${ranges})?|${ranges}(?::raw)?|conflicts|img)$`, "i"), "");
}

function filePath(input: string, allowSelector: boolean): string {
  const path = allowSelector ? stripReadSelector(input) : input;
  if (!path || /[;*?\r\n]/.test(path) || /^[a-z][\w+.-]*:\/\//i.test(path)) throw new Error(`Unsupported file target: ${input}`);
  return path;
}

/**
 * ast_grep takes `;`-separated targets that may end in a glob. Each target's fixed directory prefix is what must stay
 * inside the project; URL schemes and `..` segments are refused outright.
 */
export function astGrepBases(input: Record<string, unknown>): string[] {
  const raw = input.path === undefined ? "." : input.path;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("ast_grep target cannot be validated");
  return raw.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    if (/^[a-z][\w+.-]*:\/\//i.test(part) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(part) || /[\r\n]/.test(part)) throw new Error(`Unsupported ast_grep target: ${part}`);
    const wildcard = part.search(/[*?[{]/);
    return wildcard < 0 ? part : part.slice(0, wildcard).replace(/[^\\/]*$/, "") || ".";
  });
}

const PROTECTED_READ = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|\.codex|\.npmrc|credentials?(?:\.[^\\/]*)?|auth\.json|id_(?:rsa|ed25519)|user data)(?:[\\/]|$)/i;

function inScope(relativePath: string, scopes: readonly string[]): boolean {
  return scopes.some(scope => scope === "." || (scope.endsWith("/") ? relativePath === scope.slice(0, -1) || relativePath.startsWith(scope) : relativePath === scope));
}

export async function checkFileToolCall(toolName: string, input: Record<string, unknown>, projectRoot: string, order?: WorkOrder, protectedPaths: string[] = [], reviewing = false, parentWorkers?: { assertParentWrite(path: string): void; assertParentTool(name: string): void }, onRead?: (path: string) => void): Promise<void> {
  if (!order) parentWorkers?.assertParentTool(toolName);
  if (order && !order.fullAccess && ["glob", "ls", "find"].includes(toolName)) throw new Error(`Worker cannot enumerate files with ${toolName}; use explicit readPaths`);
  if (order?.fullAccess && !["read", "grep", "ast_grep", "lsp", "edit", "write", "alpha_check", "alpha_worker_result", "alpha_cognition_update", "alpha_send", "alpha_inbox", "alpha_browser", "alpha_search", "alpha_source", "alpha_crawl", "alpha_skill_read"].includes(toolName)) onRead?.(".");
  if (toolName === "ast_grep") {
    const root = await realpath(projectRoot);
    for (const base of astGrepBases(input)) {
      const target = await canonicalTarget(resolve(projectRoot, base));
      if (!inside(root, target)) throw new Error(`File target is outside the assigned project: ${base}`);
      const relativePath = relative(root, target).split(sep).join("/") || ".";
      if (order && !order.fullAccess && !inScope(relativePath, [...order.ownedPaths, ...(order.readPaths ?? [])])) throw new Error(`Worker cannot search unassigned path: ${base}`);
      if (order?.fullAccess) onRead?.(relativePath === "." ? "." : `${relativePath}/`);
      if (reviewing && PROTECTED_READ.test(target)) throw new Error(`Reviewer cannot read protected file: ${base}`);
    }
    return;
  }
  if (toolName === "lsp") {
    // Read-only LSP (navigation, diagnostics) addresses one file, or the whole workspace when none is given.
    const scopes = order && !order.fullAccess ? [...order.ownedPaths, ...(order.readPaths ?? [])] : null;
    if (input.file === undefined) {
      if (scopes && !inScope(".", scopes)) throw new Error("Worker LSP queries need an assigned file");
      if (order?.fullAccess) onRead?.(".");
      return;
    }
    if (typeof input.file !== "string" || !input.file) throw new Error("lsp target cannot be validated");
    const root = await realpath(projectRoot);
    const target = await canonicalTarget(resolve(projectRoot, filePath(input.file, false)));
    if (!inside(root, target)) throw new Error(`File target is outside the assigned project: ${input.file}`);
    const relativePath = relative(root, target).split(sep).join("/") || ".";
    if (scopes && !inScope(relativePath, scopes)) throw new Error(`Worker cannot read unassigned file: ${input.file}`);
    if (order?.fullAccess) onRead?.(relativePath);
    return;
  }
  if (!["read", "grep", "edit", "write"].includes(toolName)) return;
  const paths = toolName === "edit" ? [...(Array.isArray(input.paths) ? input.paths : []), ...(typeof input.path === "string" ? [input.path] : [])]
    : [toolName === "grep" ? input.path ?? "." : input.path];
  if (!Array.isArray(paths) || paths.length === 0 || paths.some(path => typeof path !== "string" || !path)) throw new Error(`${toolName} target cannot be validated`);
  const root = await realpath(projectRoot);
  for (const raw of paths as string[]) {
    if (reviewing && toolName === "grep" && (raw === "." || raw.endsWith("/") || raw.endsWith("\\"))) throw new Error("Reviewer grep requires one explicit file");
    if (toolName === "read" && raw.startsWith("skill://") && /^skill:\/\/[a-z][a-z0-9:-]*(?:\/[\w./-]*)?$/.test(raw) && !raw.includes("..")) {
      const skillId = raw.slice("skill://".length).split("/")[0];
      if (!order || order.skillIds?.includes(skillId)) continue;
      throw new Error(`Worker Skill is not bound to this order: ${skillId}`);
    }
    const target = await canonicalTarget(resolve(projectRoot, filePath(raw, toolName === "read" || toolName === "grep")));
    if (!inside(root, target)) throw new Error(`File target is outside the assigned project: ${raw}`);
    const relativePath = relative(root, target).split(sep).join("/") || ".";
    if (order?.fullAccess && (toolName === "read" || toolName === "grep")) {
      const directory = await lstat(target).then(item => item.isDirectory(), () => false);
      onRead?.(directory && relativePath !== "." ? `${relativePath}/` : relativePath);
    }
    if (order && !order.fullAccess && (toolName === "read" || toolName === "grep")) {
      const scopes = [...order.ownedPaths, ...(order.readPaths ?? [])];
      if (!inScope(relativePath, scopes)) throw new Error(`Worker cannot read unassigned file: ${raw}`);
    }
    if (reviewing && PROTECTED_READ.test(target)) throw new Error(`Reviewer cannot read protected file: ${raw}`);
    if (reviewing && (toolName === "edit" || toolName === "write")) throw new Error("Reviewer is read-only");
    if (toolName === "edit" || toolName === "write") {
      const relativePath = relative(root, target).split(sep).join("/");
      if (!order) parentWorkers?.assertParentWrite(relativePath);
      if (relativePath === ".git" || relativePath.startsWith(".git/") || protectedPaths.some(scope => relativePath === scope || relativePath.startsWith(`${scope}/`))) throw new Error(`File target is protected: ${raw}`);
    }
    if (order && !order.fullAccess && (toolName === "edit" || toolName === "write")) {
      const relativePath = relative(root, target).split(sep).join("/");
      if (!order.ownedPaths.some(scope => scope.endsWith("/") ? relativePath.startsWith(scope) : relativePath === scope)) throw new Error(`Worker does not own file: ${raw}`);
    }
  }
}

/** OMP fires tool_call before scheduling and again for direct tool dispatches. Fail closed on missing edit targets. */
export function fileToolGuard(projectRoot: string, order?: WorkOrder, protectedPaths: string[] = [], direct = false, reviewing = false, phase?: () => TaskPhase | undefined, requiresPlan?: () => boolean, writeBlocked?: () => boolean, parentWorkers?: { assertParentWrite(path: string): void; assertParentTool(name: string): void }, onRead?: (path: string) => void): PreparedExtension {
  return {
    path: "alpha:file-tool-guard",
    resolvedPath: "alpha:file-tool-guard",
    error: null,
    factory: api => {
      api.on("tool_call", async event => {
        // Plan first: before a plan is recorded only the planning tools may run, and the rejection happens per call so
        // the session keeps its tool set and the run continues into execution right after alpha_plan records it.
        if (requiresPlan?.() && !(PLANNING_TOOL_NAMES as readonly string[]).includes(event.toolName)) return { block: true, reason: "先用 alpha_plan 记录计划" };
        if (writeBlocked?.() && (WRITE_TOOL_NAMES as readonly string[]).includes(event.toolName)) return { block: true, reason: "当前节点为只读节点（调查/审查）：不能写文件或运行命令；先用 alpha_step 退出该节点" };
        if (phase?.() === "plan-review" && !(REVIEW_PAUSE_TOOL_NAMES as readonly string[]).includes(event.toolName)) return { block: true, reason: "Plan changed and is awaiting user review" };
        if (direct && ["read", "grep", "edit", "write"].includes(event.toolName)) return;
        try { await checkFileToolCall(event.toolName, event.input as Record<string, unknown>, projectRoot, order, protectedPaths, reviewing, parentWorkers, onRead); }
        catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
      });
    },
  };
}

export function assertFileToolGuardLoaded(extensions: readonly { path: string; handlers: Map<string, unknown[]> }[]): void {
  const guard = extensions.find(extension => extension.path === "alpha:file-tool-guard");
  if (!guard?.handlers.get("tool_call")?.length) throw new Error("File tool guard did not load; refusing to start model file tools");
  if (extensions.some(extension => extension !== guard && extension.handlers.get("tool_call")?.length)) {
    throw new Error("Another tool_call hook could revise a file target after validation; refusing to start model file tools");
  }
}
