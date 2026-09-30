import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildLaunch, buildLaunchEnv, defaultWorkspaceRoot, persistedSessionId, writeLaunchConfig, type LaunchOptions } from "../src/native/launch";

const created: string[] = [];
function options(overrides: Partial<LaunchOptions> = {}): LaunchOptions {
  const dataRoot = mkdtempSync(join(tmpdir(), "alpha-launch-options-"));
  created.push(dataRoot);
  return {
    appRoot: resolve(import.meta.dir, ".."),
    cwd: "E:/projects/alpha-agent/workspace/demo",
    sessionDir: "E:/projects/alpha-agent/.alpha/native/sessions/abc",
    sessionId: "00000000-0000-4000-8000-000000000001",
    dataRoot,
    mode: "rpc",
    ...overrides,
  };
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Alpha launch construction", () => {
  test("only saved OMP sessions resume; empty ids can restart without discarding other history", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "alpha-resume-"));
    created.push(sessionDir);
    expect(await persistedSessionId(sessionDir, "empty-id")).toBeUndefined();
    await writeFile(join(sessionDir, "2026-09-30_saved-id.jsonl"), '{"type":"session","id":"saved-id"}\n');
    expect(await persistedSessionId(sessionDir, "saved-id")).toBe("saved-id");
    await expect(persistedSessionId(sessionDir, "missing-id")).rejects.toThrow("已有会话文件未改动");
    expect(await readFile(join(sessionDir, "2026-09-30_saved-id.jsonl"), "utf8")).toContain('"id":"saved-id"');
  });
  test("rpc and terminal argv differ only by --mode", async () => {
    const input = options();
    const rpc = await buildLaunch(input);
    const terminal = await buildLaunch({ ...input, mode: "terminal" });
    const modeIndex = rpc.argv.indexOf("--mode");
    expect(modeIndex).toBeGreaterThan(0);
    expect(rpc.argv.slice(modeIndex)).toEqual(["--mode", "rpc-ui"]);
    expect(rpc.argv.slice(0, modeIndex)).toEqual(terminal.argv);
  });

  test("argv mounts skills, identity, generated config and both extensions, and resumes by id", async () => {
    const plan = await buildLaunch(options({ ompSessionId: "omp-session-42" }));
    const app = resolve(import.meta.dir, "..");
    expect(plan.argv[0]).toBe(join(app, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
    const pair = (flag: string) => plan.argv[plan.argv.indexOf(flag) + 1];
    expect(pair("--plugin-dir")).toBe(join(app, "presets", "alpha-plugin"));
    expect(pair("--append-system-prompt")).toBe(join(app, "presets", "alpha-identity.md"));
    expect(pair("--config")).toBe(plan.configPath);
    expect(plan.argv[plan.argv.indexOf("--resume") + 1]).toBe("omp-session-42");
    const extensions = plan.argv.filter((_, index) => plan.argv[index - 1] === "--extension");
    expect(extensions).toEqual([
      join(app, "src", "native", "tianshu", "extension.ts"),
      join(app, "src", "native", "capabilities", "extension.ts"),
    ]);
  });

  test("environment is an allowlist without tokens, keys or debug ports", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "C:\\tools",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      ALPHA_BROWSER_BRIDGE_TOKEN: "secret-bridge-token",
      ALPHA_BROWSER_BRIDGE_PORT: "41234",
      ALPHA_CDP_PORT: "41235",
      ALPHA_CVM_MODE: "shadow",
      DEEPSEEK_API_KEY: "sk-secret",
      TAVILY_API_KEY: "tvly-secret",
      SSH_AUTH_SOCK: "/tmp/agent",
    };
    const env = buildLaunchEnv(options(), source);
    expect(env.PATH).toBe("C:\\tools");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe("E:/projects/alpha-agent/.alpha/native/sessions/abc");
    expect(env.ALPHA_NATIVE_SESSION_ID).toBe("00000000-0000-4000-8000-000000000001");
    expect(env.PI_RPC_EMIT_TITLE).toBe("1");
    expect(env.ALPHA_CVM_MODE).toBe("shadow");
    expect(buildLaunchEnv(options(), { ALPHA_COMFY_URL: "http://127.0.0.1:8199" }).ALPHA_COMFY_URL).toBe("http://127.0.0.1:8199");
    expect(() => buildLaunchEnv(options(), { ALPHA_COMFY_URL: "https://example.com" })).toThrow("loopback");
    expect(buildLaunchEnv(options(), { ...source, PI_CODING_AGENT_DIR: "D:/omp-profile" }).PI_CODING_AGENT_DIR).toBe("D:/omp-profile");
    for (const key of ["ALPHA_BROWSER_BRIDGE_TOKEN", "ALPHA_BROWSER_BRIDGE_PORT", "ALPHA_CDP_PORT", "DEEPSEEK_API_KEY", "TAVILY_API_KEY", "SSH_AUTH_SOCK"]) {
      expect(key in env).toBe(false);
    }
  });

  test("terminal mode keeps rpc flags out and offers the bundled theme only when asked", () => {
    const env = buildLaunchEnv(options({ mode: "terminal", terminalTheme: true }), { PATH: "C:\\tools" });
    expect("PI_RPC_EMIT_TITLE" in env).toBe(false);
    expect(env.ALPHA_TERMINAL_THEME).toBe("1");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect("ALPHA_TERMINAL_THEME" in buildLaunchEnv(options({ mode: "terminal" }), { PATH: "C:\\tools" })).toBe(false);
  });

  test("generated config points the native browser tool at the local host only", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "alpha-launch-"));
    created.push(dataRoot);
    const configPath = await writeLaunchConfig(options({ dataRoot, browserCdpUrl: "http://127.0.0.1:9222" }));
    expect(configPath).toBe(join(dataRoot, "native", "alpha-settings.yml"));
    expect(await readFile(configPath, "utf8")).toContain("  cdpUrl: http://127.0.0.1:9222");
    const unsafe = await writeLaunchConfig(options({ dataRoot, browserCdpUrl: "http://10.0.0.5:9222" }));
    expect(await readFile(unsafe, "utf8")).not.toContain("cdpUrl");
  });

  test("bundled terminal theme installs by name and never overrides a user theme", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "alpha-launch-"));
    const agentDir = await mkdtemp(join(tmpdir(), "alpha-agent-"));
    created.push(dataRoot, agentDir);
    const terminal = { dataRoot, agentDir, mode: "terminal", terminalTheme: true } as const;
    const configPath = await writeLaunchConfig(options({ ...terminal, agentDir }));
    const config = await readFile(configPath, "utf8");
    expect(config).toContain("  quiet: true");
    expect(config).toContain("  showSplash: false");
    expect(config).toContain("  dark: alpha-sky");
    expect(config).toContain("  light: alpha-sky");
    const installed = await readFile(join(agentDir, "themes", "alpha-sky.json"), "utf8");
    expect(JSON.parse(installed).name).toBe("alpha-sky");

    // A user's existing theme file is never overwritten.
    await writeFile(join(agentDir, "themes", "alpha-sky.json"), '{"name":"user-edited"}', "utf8");
    await writeLaunchConfig(options({ ...terminal, agentDir }));
    expect(await readFile(join(agentDir, "themes", "alpha-sky.json"), "utf8")).toContain("user-edited");

    // No theme overlay when the user has their own theme choice or in rpc mode.
    expect(await readFile(await writeLaunchConfig(options({ dataRoot, agentDir, mode: "terminal", terminalTheme: false })), "utf8")).not.toContain("alpha-sky");
    expect(await readFile(await writeLaunchConfig(options({ dataRoot, agentDir, mode: "rpc", terminalTheme: true })), "utf8")).not.toContain("alpha-sky");
  });

  test("default working directory is a workspace subdirectory", () => {
    expect(defaultWorkspaceRoot("E:/alpha")).toBe(resolve("E:/alpha", "workspace"));
  });
});
