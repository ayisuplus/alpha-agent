import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcProcess } from "../src/native/rpc-process";
import { redact, preserveRedacted } from "../src/native/host-control";
import type { ExtensionCatalog } from "../src/native/host-types";

const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

test("extension responses hide credentials and edits preserve masked fields", () => {
  const original = { env: { CUSTOM: "secret" }, headers: { x: "secret" }, url: "https://user:password@example.com/mcp?key=secret", auth: { clientSecret: "secret" } };
  expect(JSON.stringify(redact(original))).not.toContain("secret");
  expect(preserveRedacted(redact(original), original)).toEqual(original);
});

test("native CLI and SDK host discover the same skills; host imports and disables real skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-native-host-")); roots.push(root);
  const agent = join(root, "profile"), cwd = join(root, "project"), skills = join(cwd, ".omp", "skills", "fixture-skill");
  await mkdir(agent, { recursive: true }); await mkdir(skills, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), "---\nname: fixture-skill\ndescription: Local native adapter test\n---\n\nReturn Alpha fixture evidence.\n");
  await writeFile(join(agent, "config.yml"), "lsp:\n  enabled: false\nstartup:\n  quiet: true\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") } as Record<string, string>;
  const cli = resolve("node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
  const cliResult = Bun.spawnSync([process.execPath, cli, "skill", "list", cwd, "--json"], { cwd, env, windowsHide: true });
  expect(cliResult.exitCode).toBe(0);
  const listing = JSON.parse(new TextDecoder().decode(cliResult.stdout)) as { skills: Array<{ name: string }> };
  const child = new RpcProcess({ cwd, env, argv: [resolve("src/native/omp-host.ts"), "--mode", "rpc-ui"] });
  try {
    await child.ready;
    const catalog = await child.hostCommand("catalog") as ExtensionCatalog;
    expect(catalog.entries.filter(item => item.kind === "skill" && item.loaded).map(item => item.name).sort()).toEqual(listing.skills.map(item => item.name).sort());
    const entry = catalog.entries.find(item => item.name === "fixture-skill")!;
    expect(entry.loaded).toBe(true);
    const content = await child.hostCommand("extension", { kind: "skill", action: "read", id: entry.id }) as { result: { content: string }; pendingReload: boolean };
    expect(content.result.content).toContain("Return Alpha fixture evidence");
    expect(content.pendingReload).toBe(false);
    const failure = await child.hostCommand("extension", { kind: "skill", action: "read", id: entry.id, reference: "../../../../profile/config.yml" }, 5000).then(() => "unexpected success", error => error.message);
    expect(failure).toContain("escapes");
    await child.hostCommand("extension", { kind: "skill", action: "toggle", name: "fixture-skill", enabled: false });
    const config = await readFile(join(agent, "config.yml"), "utf8"); expect(config).toContain("skill:fixture-skill");
    const response = await child.command({ type: "get_available_commands" }); expect(response.success).toBe(true);
  } finally { await child.stop(); }
}, 120_000);
