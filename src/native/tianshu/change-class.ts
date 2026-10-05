/**
 * Change classification for the Tianshu evidence layer.
 *
 * Adapted from Tianshu-harness v3.27.0, Apache-2.0:
 * src/agent/change-classification.ts. See licenses/Tianshu-APACHE-2.0.txt
 * and licenses/Tianshu-NOTICE.txt.
 *
 * Only successful edits of code/test files and working-tree git operations
 * count as "code mutations" (they invalidate earlier verification evidence).
 * Docs/README/localization writes do not — writing a .md must not raise
 * verification debt.
 */

/** OMP built-in modification tools (there is no apply_patch in OMP). */
export const MODIFICATION_TOOLS = ["edit", "ast_edit", "write"] as const;
export type ModificationTool = (typeof MODIFICATION_TOOLS)[number];
export const IS_MODIFICATION_TOOL: Readonly<Record<string, true>> = { edit: true, ast_edit: true, write: true };

/** Verification families used for typed claim reconciliation. */
export type VerificationFamily = "test" | "type" | "lint";

/**
 * Code and test file shapes: the extensions that carry executable logic or
 * tests. Anything else (md/txt/json/yml/toml/html/css/… docs, config and
 * localization files) is not a code mutation. An extension-less path (LICENSE,
 * Makefile, …) is treated as non-code; a missing path is conservative and
 * counts as a mutation (we cannot know what changed).
 */
const CODE_FILE_EXTENSION_RE =
  /\.(?:[cm]?[jt]sx?|pyi?|rs|go|java|kt|kts|scala|cs|cpp|cc|cxx|c|h|hpp|hh|hxx|swift|m|mm|rb|php|lua|sh|bash|zsh|fish|ps1|bat|cmd|sql|vue|svelte|dart|ex|exs|erl|hrl|hs|lhs|ml|mli|fs|fsx|r|jl|zig|nim|cr|pl|pm|groovy)$/i;

/** True when a successful edit to this path is a code mutation. */
export function isCodeMutationPath(path: string | undefined): boolean {
  if (path === undefined) return true; // unknown target: conservative
  const clean = path.split(/[?#]/)[0] ?? path;
  if (clean.length === 0) return true;
  return CODE_FILE_EXTENSION_RE.test(clean);
}

/**
 * Working-tree git operations: the listed subcommands mutate what the earlier
 * verification ran against (checkout/restore bring different code in, add/
 * commit/rm/mv change the tree contents). Pure queries (status/log/diff, and
 * `git stash list|show`) never invalidate evidence.
 */
const GIT_MUTATION_RE = /\bgit\s+(?:add|commit|rm|mv|checkout|merge|rebase|cherry-pick|restore|stash)\b/i;
const GIT_QUERY_ONLY_RE = /\bgit\s+stash\s+(?:list|show)\b/i;

/** True when a successful bash command mutated the working tree. */
export function isGitMutationCommand(command: string | undefined): boolean {
  if (!command) return false;
  return GIT_MUTATION_RE.test(command) && !GIT_QUERY_ONLY_RE.test(command);
}

// ── Verification command recognition (shared by claims.ts / state.ts) ──

/** Test family: test runners actually executing tests. */
const TEST_RUNNER_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b/i;
const TEST_TOOL_RE =
  /\b(?:pytest|vitest|jest)\b|\bpython\s+-m\s+pytest\b|\b(?:cargo|go)\s+test\b|\b(?:dotnet|mvn|gradle|gradlew)\s+test\b/i;

/**
 * Type family: type checkers. `bun run check`-style commands land here (the
 * plan lists them under the type family "若含 tsc"); `check` deliberately does
 * NOT back test claims — a type check never proves tests passed, and the
 * check script's real contents are not observable from the command line.
 */
const TYPE_RE =
  /\btsc\b|\btypecheck\b|\bmypy\b|\bcargo\s+(?:check|clippy)\b|\bdotnet\s+build\b|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?check\b/i;

/** Lint family. */
const LINT_RE = /\bruff\b|\beslint\b|\bclippy\b|\bbiome\b|\boxlint\b/i;

/**
 * Families a successful run of this command provides evidence for.
 * Empty result = not a verification command. A command can serve several
 * families (`cargo clippy` is both type and lint per the plan's tables).
 */
export function classifyVerificationFamilies(command: string | undefined): VerificationFamily[] {
  if (!command) return [];
  const families: VerificationFamily[] = [];
  if (TEST_RUNNER_RE.test(command) || TEST_TOOL_RE.test(command)) families.push("test");
  if (TYPE_RE.test(command)) families.push("type");
  if (LINT_RE.test(command)) families.push("lint");
  return families;
}

