import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildLaunch, buildLaunchEnv, defaultWorkspaceRoot, writeLaunchConfig, type LaunchOptions } from "../src/native/launch";

const created: string[] = [];
function options(overrides: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    appRoot: "E:/projects/alpha-agent",
    cwd: "E:/projects/alpha-agent/workspace/demo",
    sessionDir: "E:/projects/alpha-agent/.alpha/native/sessions/abc",
    sessionId: "00000000-0000-4000-8000-000000000001",
    dataRoot: "E:/projects/alpha-agent/.alpha",
    mode: "rpc",
    ...overrides,
  };
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Alpha launch construction", () => {
  test("rpc and terminal argv differ only by --mode", async () => {
    const rpc = await buildLaunch(options());
    const terminal = await buildLaunch(options({ mode: "terminal" }));
    const modeIndex = rpc.argv.indexOf("--mode");
    expect(modeIndex).toBeGreaterThan(0);
    expect(rpc.argv.slice(modeIndex)).toEqual(["--mode", "rpc-ui"]);
    expect(rpc.argv.slice(0, modeIndex)).toEqual(terminal.argv);
  });

  test("argv mounts skills, identity, generated config and both extensions, and resumes by id", async () => {
    const plan = await buildLaunch(options({ ompSessionId: "omp-session-42" }));
    const app = "E:/projects/alpha-agent";
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
    expect(buildLaunchEnv(options(), { ...source, PI_CODING_AGENT_DIR: "D:/omp-profile" }).PI_CODING_AGENT_DIR).toBe("D:/omp-profile");
    for (const key of ["ALPHA_BROWSER_BRIDGE_TOKEN", "ALPHA_BROWSER_BRIDGE_PORT", "ALPHA_CDP_PORT", "DEEPSEEK_API_KEY", "TAVILY_API_KEY", "SSH_AUTH_SOCK"]) {
      expect(key in env).toBe(false);
    }
  });

  test("terminal mode keeps rpc flags out and offers the bundled theme only when asked", () => {
    const env = buildLaunchEnv(options({ mode: "terminal", terminalTheme: true }), { PATH: "C:\\tools" });
    expect("PI_RPC_EMIT_TITLE" in env).toBe(false);
    expect(env.ALPHA_TERMINAL_THEME).toBe("1");
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

  test("default working directory is a workspace subdirectory", () => {
    expect(defaultWorkspaceRoot("E:/alpha")).toBe(resolve("E:/alpha", "workspace"));
  });
});
