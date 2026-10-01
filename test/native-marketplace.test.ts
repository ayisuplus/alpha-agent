import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcProcess } from "../src/native/rpc-process";
import type { ExtensionCatalog } from "../src/native/host-types";

test("native project marketplace plugin installs, disables, updates and uninstalls across host restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-marketplace-")), agent = join(root, "profile"), cwd = join(root, "project"), marketplace = join(root, "marketplace"), plugin = join(marketplace, "fixture-plugin");
  for (const path of [agent, join(cwd, ".omp"), join(marketplace, ".claude-plugin"), join(plugin, ".claude-plugin"), join(plugin, "skills", "marketplace-method")]) await mkdir(path, { recursive: true });
  await writeFile(join(agent, "config.yml"), "lsp:\n  enabled: false\nstartup:\n  quiet: true\n  checkUpdate: false\n");
  const version = async (value: string) => {
    await writeFile(join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "alpha-proof", owner: { name: "Alpha fixture" }, plugins: [{ name: "fixture-plugin", source: "./fixture-plugin", version: value }] }));
    await writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture-plugin", version: value, description: "Native fixture plugin" }));
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "alpha-fixture-marketplace", version: value, license: "MIT", omp: { skills: ["skills"] } }));
    await writeFile(join(plugin, "skills", "marketplace-method", "SKILL.md"), `---\nname: marketplace-method\ndescription: Native marketplace proof\n---\nMARKETPLACE_VERSION_${value}\n`);
  };
  await version("1.0.0");
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") } as Record<string, string>;
  const launch = () => new RpcProcess({ cwd, env, argv: [resolve("src/native/omp-host.ts"), "--mode", "rpc-ui"] });
  let child = launch(); const request = (input: Record<string, unknown>) => child.hostCommand("extension", { kind: "plugin", name: "fixture-plugin@alpha-proof", scope: "project", ...input });
  const restart = async () => { await child.stop(); child = launch(); await child.ready; };
  try {
    await child.ready; await request({ action: "marketplace", path: marketplace }); await request({ action: "install" }); await restart();
    let catalog = await child.hostCommand("catalog") as ExtensionCatalog;
    expect(catalog.entries.find(row => row.name === "fixture-plugin@alpha-proof")?.scope).toBe("project");
    expect(catalog.entries.find(row => row.name === "marketplace-method")?.loaded).toBe(true);
    await request({ action: "toggle", enabled: false }); await restart(); catalog = await child.hostCommand("catalog") as ExtensionCatalog;
    expect(catalog.entries.find(row => row.name === "fixture-plugin@alpha-proof")?.status).toBe("disabled");
    expect(catalog.entries.find(row => row.name === "marketplace-method")?.loaded).not.toBe(true);
    await version("1.1.0"); await request({ action: "upgrade" }); await request({ action: "toggle", enabled: true }); await restart(); catalog = await child.hostCommand("catalog") as ExtensionCatalog;
    const entry = catalog.entries.find(row => row.name === "fixture-plugin@alpha-proof")!; expect(entry.version).toBe("1.1.0");
    expect(await readFile(join(entry.path!, "skills", "marketplace-method", "SKILL.md"), "utf8")).toContain("VERSION_1.1.0");
    await request({ action: "remove" }); await restart(); catalog = await child.hostCommand("catalog") as ExtensionCatalog;
    expect(catalog.entries.some(row => row.name === "fixture-plugin@alpha-proof")).toBe(false);
    expect(await Bun.file(join(plugin, "package.json")).exists()).toBe(true);
  } finally { await child.stop(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
