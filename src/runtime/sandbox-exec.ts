import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildChildEnv } from "./child-env";

export class SandboxUnavailableError extends Error {}
export interface CommandResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }
export interface SandboxCommand { cwd: string; roots: string[]; dataRoot: string; argv: string[]; stdin?: string; network?: boolean; signal?: AbortSignal; timeoutMs?: number }

function bundledCodex(): string {
  return resolve(import.meta.dir, "../..", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
}

function isInside(root: string, path: string): boolean {
  const rest = relative(resolve(root), resolve(path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

async function collect(stream: ReadableStream<Uint8Array> | number | undefined, maxBytes = 2_000_000): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (kept < maxBytes) {
      const part = value.subarray(0, maxBytes - kept);
      chunks.push(part);
      kept += part.length;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks)) + (kept === maxBytes ? "\n[output truncated]" : "");
}

async function spawn(argv: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal, timeoutMs = 120_000, input?: string): Promise<CommandResult> {
  signal?.throwIfAborted();
  const child = Bun.spawn(argv, { cwd, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(input);
    child.stdin.end();
  }
  let timedOut = false;
  let cancelled = false;
  let expire: () => void = () => {};
  const abort = () => { cancelled = true; child.kill(); expire(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const expiry = new Promise<null>(resolve => { expire = () => resolve(null); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); expire(); }, timeoutMs);
  try {
    const finished = await Promise.race([Promise.all([collect(child.stdout), collect(child.stderr), child.exited]), expiry]);
    if (!finished) return { exitCode: -1, stdout: "", stderr: "Sandbox process timed out", timedOut: true, cancelled };
    const [stdout, stderr, exitCode] = finished;
    return { exitCode, stdout, stderr, timedOut, cancelled };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function sandboxArgs(input: SandboxCommand): string[] {
  const roots = [...new Set(input.roots.map(root => resolve(root)))];
  if (!roots.some(root => root.toLowerCase() === resolve(input.cwd).toLowerCase())) throw new SandboxUnavailableError("Command working directory is not a mounted project folder");
  return [bundledCodex(), "sandbox", "-P", "alpha-project", "-C", resolve(input.cwd), "--", ...input.argv];
}

export function protectedSandboxHome(input: Pick<SandboxCommand, "roots" | "dataRoot" | "network">): string {
  const roots = [...new Set(input.roots.map(root => resolve(root)))];
  const base = [process.env.LOCALAPPDATA, resolve(input.dataRoot), process.env.USERPROFILE]
    .find(path => path && !roots.some(root => isInside(root, path)));
  if (!base) throw new SandboxUnavailableError("No protected location for the sandbox configuration");
  const digest = createHash("sha256").update(JSON.stringify([roots.map(root => root.toLowerCase()).sort(), !!input.network])).digest("hex").slice(0, 16);
  // Tests keep profiles in their own temporary folder instead of the machine-wide one.
  const override = process.env.ALPHA_SANDBOX_PROFILES;
  if (override && !roots.some(root => isInside(root, resolve(override)))) return join(resolve(override), digest);
  return join(base, "Alpha", "sandbox-profiles", digest);
}

/**
 * ALPHA_WINDOWS_SANDBOX=off makes every sandboxed command fail closed without touching the real Windows sandbox, whose
 * first setup per profile asks for administrator approval. Tests set it; it never runs anything unsandboxed.
 */
function sandboxDisabled(): boolean {
  return process.env.ALPHA_WINDOWS_SANDBOX === "off";
}

async function rawSandboxCommand(input: SandboxCommand): Promise<CommandResult> {
  if (sandboxDisabled()) throw new SandboxUnavailableError("Windows sandbox is turned off in this environment");
  if (process.platform !== "win32" || !await Bun.file(bundledCodex()).exists()) throw new SandboxUnavailableError("Bundled Windows sandbox runner is unavailable");
  const roots = [...new Set(input.roots.map(root => resolve(root)))];
  const home = protectedSandboxHome(input);
  await mkdir(home, { recursive: true });
  const profileHome = process.env.USERPROFILE;
  const knownCredentials = profileHome ? [
    ".ssh", ".aws", ".azure", ".codex", ".npmrc", ".git-credentials",
    "AppData/Roaming/Microsoft/Credentials", "AppData/Local/Google/Chrome/User Data", "AppData/Local/Microsoft/Edge/User Data",
  ].map(path => resolve(profileHome, path)) : [];
  const denyReads = (await Promise.all(knownCredentials.map(async path => await access(path).then(() => path, () => null)))).filter((path): path is string => !!path);
  denyReads.push(join(resolve(input.dataRoot), "sandbox-secret-canary"));
  const profile = [
    '[windows]', 'sandbox = "elevated"',
    '[permissions.alpha-project]', 'extends = ":workspace"',
    '[permissions.alpha-project.workspace_roots]',
    ...roots.map(root => `${JSON.stringify(root)} = true`),
    '[permissions.alpha-project.filesystem]', '":tmpdir" = "deny"',
    ...denyReads.map(path => `${JSON.stringify(path)} = "deny"`),
    '[permissions.alpha-project.filesystem.":workspace_roots"]',
    '"**/.env" = "deny"', '"**/.env.*" = "deny"',
    '[permissions.alpha-project.network]', `enabled = ${input.network === true}`,
    '',
  ].join("\n");
  const config = join(home, "config.toml");
  const temporary = `${config}.${randomUUID()}.tmp`;
  await writeFile(temporary, profile);
  await rename(temporary, config);
  return spawn(sandboxArgs(input), input.cwd, { ...buildChildEnv(), CODEX_HOME: home }, input.signal, input.timeoutMs, input.stdin);
}

const verified = new Map<string, Promise<void>>();
export async function verifySandbox(input: Pick<SandboxCommand, "cwd" | "roots" | "dataRoot" | "network" | "signal">): Promise<void> {
  const key = JSON.stringify([resolve(input.cwd), input.roots.map(root => resolve(root)).sort(), resolve(input.dataRoot), !!input.network]);
  let check = verified.get(key);
  if (!check) {
    check = (async () => {
      if (sandboxDisabled()) throw new SandboxUnavailableError("Windows sandbox is turned off in this environment");
      const outsideBase =[resolve(input.dataRoot), process.env.USERPROFILE].find(path => path && !input.roots.some(root => isInside(root, path)));
      if (!outsideBase) throw new SandboxUnavailableError("No independent directory is available to verify sandbox isolation");
      const scratch = await mkdtemp(join(outsideBase, "alpha-sandbox-check-"));
      const inside = join(input.cwd, `.alpha-sandbox-check-${randomUUID()}`);
      const outside = join(scratch, "outside.txt");
      const secretDir = join(resolve(input.dataRoot), "sandbox-secret-canary");
      const secret = join(secretDir, "probe.txt");
      const listener = createServer(socket => socket.end());
      try {
        await writeFile(outside, "host");
        await mkdir(secretDir, { recursive: true });
        await writeFile(secret, "canary");
        await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
        const address = listener.address();
        if (!address || typeof address === "string") throw new SandboxUnavailableError("Network probe listener is unavailable");
        const escapedInside = inside.replaceAll("'", "''");
        const escapedOutside = outside.replaceAll("'", "''");
        const escapedSecret = secret.replaceAll("'", "''");
        const childScript = `$x=$false;try{Set-Content -LiteralPath '${escapedOutside}' -Value 'child' -NoNewline -ErrorAction Stop;$x=$true}catch{};Write-Output "child=$x"`;
        const encodedChild = Buffer.from(childScript, "utf16le").toString("base64");
        const probe = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$a=$false;$b=$false;$n=$false;$r=$false;try{Set-Content -LiteralPath '${escapedInside}' -Value 'inside' -NoNewline -ErrorAction Stop;$a=$true}catch{};try{Set-Content -LiteralPath '${escapedOutside}' -Value 'escaped' -NoNewline -ErrorAction Stop;$b=$true}catch{};try{Get-Content -LiteralPath '${escapedSecret}' -Raw -ErrorAction Stop|Out-Null;$r=$true}catch{};try{$c=[Net.Sockets.TcpClient]::new();$c.Connect('127.0.0.1',${address.port});$n=$true;$c.Close()}catch{};$child=& powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodedChild}';$identity=whoami;Write-Output "inside=$a outside=$b secretRead=$r net=$n $child identity=$identity"`];
        const result = await rawSandboxCommand({ ...input, argv: probe, timeoutMs: 30_000 });
        const currentInside = await readFile(inside, "utf8").catch(() => null);
        const currentOutside = await readFile(outside, "utf8");
        const output = result.stdout.toLowerCase();
        const expectedIdentity = input.network ? "codexsandboxonline" : "codexsandboxoffline";
        const failures = [
          result.exitCode !== 0 || result.timedOut ? "沙箱进程未正常完成" : null,
          currentInside !== "inside" || !output.includes("inside=true") ? "工作目录写入失败" : null,
          currentOutside !== "host" || !output.includes("outside=false") ? "越界写入未被拒绝" : null,
          !output.includes("secretread=false") ? "凭据读取未被拒绝" : null,
          !output.includes("child=false") ? "子进程越界操作未被拒绝" : null,
          !output.includes(expectedIdentity) ? "隔离身份不符" : null,
          !input.network && !output.includes("net=false") ? "联网未被拒绝" : null,
        ].filter((reason): reason is string => !!reason);
        if (failures.length) throw new SandboxUnavailableError(`Windows 沙箱隔离检查未通过：${failures.join("；")}`);
      } finally {
        if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
        await rm(inside, { force: true }).catch(() => undefined);
        const actual = resolve(scratch);
        if (!isInside(outsideBase, actual)) throw new SandboxUnavailableError("Probe cleanup path is invalid");
        await rm(actual, { recursive: true, force: true });
      }
    })();
    verified.set(key, check);
    check.catch(() => verified.delete(key));
  }
  return check;
}

export async function runSandboxCommand(input: SandboxCommand): Promise<CommandResult> {
  await verifySandbox(input);
  const result = await rawSandboxCommand(input);
  if (result.timedOut || /^(?:error:.*sandbox|windows sandbox failed:|sandbox setup failed:)/im.test(result.stderr)) {
    throw new SandboxUnavailableError(`Windows sandbox command failed: ${result.stderr.slice(0, 500) || "timed out"}`);
  }
  return result;
}

export async function runFullAccessCommand(input: Omit<SandboxCommand, "roots">): Promise<CommandResult> {
  return spawn(input.argv, input.cwd, buildChildEnv(), input.signal, input.timeoutMs, input.stdin);
}
