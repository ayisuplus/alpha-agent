import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { buildLaunchEnv } from "./launch";

type Shell = { id: string; cwd: string; name: string; active: boolean; output: string; exitCode?: number; error?: string; pty: PtySession };
export class ProjectShells {
  private shells = new Map<string, Shell>();
  constructor(private appRoot: string, private dataRoot: string, private emit: (cwd: string, frame: Record<string, unknown>) => void) {}
  list(cwd: string) { return [...this.shells.values()].filter(shell => shell.cwd === cwd).map(({ pty, ...shell }) => shell); }
  async create(cwd: string, name?: string) {
    if (this.list(cwd).length >= 8) throw new Error("Close a terminal tab before opening another (limit 8)");
    const shell: Shell = { id: randomUUID(), cwd, name: name?.trim().slice(0, 60) || `终端 ${this.list(cwd).length + 1}`, active: true, output: "", pty: new PtySession() };
    this.shells.set(shell.id, shell);
    const env = buildLaunchEnv({ appRoot: this.appRoot, dataRoot: this.dataRoot, cwd, sessionId: shell.id, sessionDir: join(this.dataRoot, "shells"), mode: "terminal" });
    for (const key of ["PI_CODING_AGENT_SESSION_DIR", "ALPHA_NATIVE_SESSION_ID", "ALPHA_DATA_ROOT"]) delete env[key];
    const application = Bun.which("pwsh.exe") ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    void shell.pty.startArgv({ application, args: ["-NoLogo", "-NoProfile"], cwd, env, cols: 100, rows: 30 }, (error, chunk) => {
      if (error) shell.error = error.message;
      if (chunk) shell.output = (shell.output + chunk).slice(-100_000);
      this.emit(cwd, { type: "project_shell", shellId: shell.id, chunk, error: shell.error });
    }).then(result => { shell.exitCode = result.exitCode; }).catch(error => { shell.error = String(error); }).finally(() => { shell.active = false; this.emit(cwd, { type: "project_shell", shellId: shell.id, exited: true, error: shell.error }); });
    return { id: shell.id };
  }
  request(cwd: string, id: string, action: string, input: Record<string, unknown>) {
    const shell = this.shells.get(id); if (!shell || shell.cwd !== cwd) throw new Error("Project terminal not found");
    if (action === "close") { shell.pty.kill(); this.shells.delete(id); return { ok: true }; }
    if (!shell.active) throw new Error("Terminal process has exited; open another tab");
    if (action === "input") { if (typeof input.data !== "string" || input.data.length > 10_000) throw new Error("Invalid terminal input"); shell.pty.write(input.data); }
    else if (action === "resize") shell.pty.resize(Math.max(40, Math.min(240, Number(input.cols) || 100)), Math.max(12, Math.min(100, Number(input.rows) || 30)));
    else throw new Error("Unknown terminal operation");
    return { ok: true };
  }
  busy(cwd: string) { return this.list(cwd).some(shell => shell.active); }
  stop() { for (const shell of this.shells.values()) shell.pty.kill(); }
}
