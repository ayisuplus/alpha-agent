import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent";
import type { WorkOrder } from "./work-orders";

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

function filePath(input: string, allowSelector: boolean): string {
  const path = allowSelector ? input.replace(/:(?:\d+(?:-\d+|\+\d+)?|raw|conflicts)$/i, "") : input;
  if (!path || /[;*?\r\n]/.test(path) || /^[a-z][\w+.-]*:\/\//i.test(path)) throw new Error(`Unsupported file target: ${input}`);
  return path;
}

export async function checkFileToolCall(toolName: string, input: Record<string, unknown>, projectRoot: string, order?: WorkOrder, protectedPaths: string[] = []): Promise<void> {
  if (!["read", "grep", "edit", "write"].includes(toolName)) return;
  const paths = toolName === "edit" ? [...(Array.isArray(input.paths) ? input.paths : []), ...(typeof input.path === "string" ? [input.path] : [])]
    : [toolName === "grep" ? input.path ?? "." : input.path];
  if (!Array.isArray(paths) || paths.length === 0 || paths.some(path => typeof path !== "string" || !path)) throw new Error(`${toolName} target cannot be validated`);
  const root = await realpath(projectRoot);
  for (const raw of paths as string[]) {
    if (toolName === "read" && raw.startsWith("skill://") && !order && /^skill:\/\/[a-z][a-z0-9:-]*(?:\/[\w./-]*)?$/.test(raw) && !raw.includes("..")) continue;
    const target = await canonicalTarget(resolve(projectRoot, filePath(raw, toolName === "read" || toolName === "grep")));
    if (!inside(root, target)) throw new Error(`File target is outside the assigned project: ${raw}`);
    if (toolName === "edit" || toolName === "write") {
      const relativePath = relative(root, target).split(sep).join("/");
      if (relativePath === ".git" || relativePath.startsWith(".git/") || protectedPaths.some(scope => relativePath === scope || relativePath.startsWith(`${scope}/`))) throw new Error(`File target is protected: ${raw}`);
    }
    if (order && (toolName === "edit" || toolName === "write")) {
      const relativePath = relative(root, target).split(sep).join("/");
      if (!order.ownedPaths.some(scope => scope.endsWith("/") ? relativePath.startsWith(scope) : relativePath === scope)) throw new Error(`Worker does not own file: ${raw}`);
    }
  }
}

/** OMP fires tool_call before scheduling and again for direct tool dispatches. Fail closed on missing edit targets. */
export function fileToolGuard(projectRoot: string, order?: WorkOrder, protectedPaths: string[] = [], direct = false): PreparedExtension {
  return {
    path: "alpha:file-tool-guard",
    resolvedPath: "alpha:file-tool-guard",
    error: null,
    factory: api => {
      api.on("tool_call", async event => {
        if (direct && ["read", "grep", "edit", "write"].includes(event.toolName)) return;
        try { await checkFileToolCall(event.toolName, event.input as Record<string, unknown>, projectRoot, order, protectedPaths); }
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
