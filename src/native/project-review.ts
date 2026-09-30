import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const limit = 512 * 1024;

export interface ProjectReview {
  available: boolean;
  status: string;
  staged: string;
  unstaged: string;
  truncated: boolean;
  reason?: string;
}

/** Read the selected project without refreshing the index; disable external diff/textconv and fsmonitor. */
export async function projectReview(cwd: string): Promise<ProjectReview> {
  let truncated = false;
  const git = async (args: string[]) => {
    try {
      return (await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: limit })).stdout;
    } catch (cause) {
      const error = cause as Error & { code?: string; stdout?: string; stderr?: string };
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") { truncated = true; return error.stdout ?? ""; }
      throw cause;
    }
  };
  let status: string;
  try { status = await git(["status", "--short", "--untracked-files=normal", "--", "."]); }
  catch (cause) {
    const error = cause as Error & { stderr?: string; code?: string };
    if (error.stderr?.includes("not a git repository")) return { available: false, status: "", staged: "", unstaged: "", truncated: false, reason: "当前项目不是 Git 仓库" };
    if (error.code === "ENOENT") throw new Error("本机没有可用的 Git");
    throw new Error("无法读取项目 Git 状态");
  }
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color"];
  const [unstaged, staged] = await Promise.all([git(["diff", ...flags, "--", "."]), git(["diff", "--cached", ...flags, "--", "."])]);
  return { available: true, status, staged, unstaged, truncated };
}
