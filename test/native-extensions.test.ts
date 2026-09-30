import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcProcess } from "../src/native/rpc-process";
import type { ExtensionCatalog } from "../src/native/host-types";
import { startMcpFixture } from "./fixtures/native-mcp-server";

test("real OMP loads imported skill, invokes MCP over stdio/HTTP/SSE, and manages a native plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-extension-proof-"));
  const cwd = join(root, "project"), agent = join(root, "profile"), source = join(root, "imported-method"), plugin = join(root, "native-plugin");
  for (const dir of [cwd, agent, source, plugin]) await mkdir(dir, { recursive: true });
  const mcp = startMcpFixture();
  let skillObserved = false; let toolObserved = false;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    skillObserved ||= JSON.stringify(body.messages).includes("IMPORTED_ALPHA_METHOD_EVIDENCE");
    const route = /xd:\/\/[a-zA-Z0-9_-]*fixture_http[a-zA-Z0-9_-]*echo/.exec(JSON.stringify(body.messages))?.[0];
    const tool = body.tools?.find(item => item.function.name === "write");
    const last = body.messages.at(-1); const completed = last?.role === "tool";
    toolObserved ||= completed && JSON.stringify(last.content).includes("MCP_EVIDENCE");
    const call = tool && route && !completed;
    const delta = call ? { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ path: route, content: '{"message":"desktop adapter"}' }) } }] } : { content: "ALPHA_EXTENSION_VERIFIED" };
    return new Response(`data: ${JSON.stringify({ id: "local-proof", model: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.port}/v1`, auth: "none", apiKey: "fixture-only", models: [{ id: "fixture", name: "Local proof", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(agent, "config.yml"), "modelRoles:\n  default: fixture/fixture\ndefaultThinkingLevel: off\nlsp:\n  enabled: false\nstartup:\n  setupWizard: false\n  quiet: true\n  checkUpdate: false\nretry:\n  enabled: false\n");
  await writeFile(join(source, "SKILL.md"), "---\nname: imported-method\ndescription: Native imported method fixture\n---\n\nIMPORTED_ALPHA_METHOD_EVIDENCE\n");
  await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "alpha-native-test-plugin", version: "1.0.0", license: "MIT", omp: { extensions: ["index.ts"], settings: { access: { type: "string", secret: true } } } }));
  await writeFile(join(plugin, "index.ts"), 'export default function(api: any) { api.registerCommand("fixture_plugin", { description: "Native fixture plugin command", handler: async (_args: string, ctx: any) => ctx.ui.notify("PLUGIN_EVIDENCE", "info") }); }\n');
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") } as Record<string, string>;
  let child: RpcProcess | undefined;
  const start = async () => { child = new RpcProcess({ cwd, env, argv: [resolve("src/native/omp-host.ts"), "--mode", "rpc-ui"] }); await child.ready; return child; };
  try {
    await start();
    await child!.hostCommand("extension", { kind: "skill", action: "import", name: "imported-method", path: source, scope: "project" });
    for (const [name, config] of Object.entries({ fixture_stdio: { type: "stdio", command: process.execPath, args: [resolve("test/fixtures/native-mcp-server.ts"), "--stdio"] }, fixture_http: { type: "http", url: `http://127.0.0.1:${mcp.port}/mcp` }, fixture_sse: { type: "sse", url: `http://127.0.0.1:${mcp.port}/sse` } })) await child!.hostCommand("extension", { kind: "mcp", action: "add", name, config, scope: "project" });
    await child!.hostCommand("extension", { kind: "plugin", action: "link", path: plugin });
    await child!.hostCommand("extension", { kind: "plugin", action: "setting", name: "alpha-native-test-plugin", key: "access", value: "plugin-secret-fixture" });
    await child!.stop(); await start();
    let catalog = await child!.hostCommand("catalog") as ExtensionCatalog;
    for (let attempt = 0; attempt < 50 && catalog.entries.filter(row => row.kind === "mcp" && row.loaded).length < 3; attempt++) { await Bun.sleep(100); catalog = await child!.hostCommand("catalog") as ExtensionCatalog; }
    expect(catalog.entries.find(row => row.name === "imported-method")?.loaded).toBe(true);
    expect(catalog.entries.find(row => row.name === "alpha-native-test-plugin")?.loaded).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("plugin-secret-fixture");
    for (const name of ["fixture_stdio", "fixture_http", "fixture_sse"]) {
      expect(catalog.entries.find(row => row.name === name)?.loaded).toBe(true);
      const resource = await child!.hostCommand("extension", { kind: "mcp", action: "resource", name, uri: "fixture://evidence" });
      expect(JSON.stringify(resource)).toContain("MCP_RESOURCE_EVIDENCE");
      await child!.hostCommand("extension", { kind: "mcp", action: "reconnect", name });
      await child!.hostCommand("extension", { kind: "mcp", action: "refresh", name });
    }
    const edited = "---\nname: imported-method\ndescription: Native imported method fixture\n---\n\nIMPORTED_ALPHA_METHOD_EVIDENCE revised\n";
    const original = await readFile(join(cwd, ".omp/skills/imported-method/SKILL.md"), "utf8");
    await child!.hostCommand("extension", { kind: "skill", action: "save", name: "imported-method", content: edited, previous: original, scope: "project" });
    const conflict = await child!.hostCommand("extension", { kind: "skill", action: "save", name: "imported-method", content: original, previous: original, scope: "project" }).catch(error => error.message);
    expect(conflict).toContain("changed since opening");
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const callbackPort = reservation.port; reservation.stop(true);
    await child!.hostCommand("extension", { kind: "mcp", action: "save", name: "fixture_http", scope: "project", config: { type: "http", url: `http://127.0.0.1:${mcp.port}/mcp`, oauth: { clientId: "fixture", callbackPort } } });
    await child!.stop(); await start();
    await child!.hostCommand("extension", { kind: "mcp", action: "oauth", name: "fixture_http" });
    let auth: { status: string; url?: string } = { status: "discovering" };
    for (let attempt = 0; attempt < 60 && !auth.url; attempt++) { await Bun.sleep(50); auth = (await child!.hostCommand("extension", { kind: "mcp", action: "oauth-status", name: "fixture_http" }) as { result: typeof auth }).result; }
    expect(auth.status).toBe("authorizing");
    const authURL = new URL(auth.url!); expect(authURL.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authURL.searchParams.get("redirect_uri")!); callback.searchParams.set("state", authURL.searchParams.get("state")!); callback.searchParams.set("code", "fixture-code");
    expect((await fetch(callback)).ok).toBe(true);
    for (let attempt = 0; attempt < 60 && auth.status === "authorizing"; attempt++) { await Bun.sleep(50); auth = (await child!.hostCommand("extension", { kind: "mcp", action: "oauth-status", name: "fixture_http" }) as { result: typeof auth }).result; }
    expect(auth.status).toBe("authorized");
    expect(JSON.stringify(await child!.hostCommand("catalog"))).not.toContain("oauth-fixture-secret");
    await child!.hostCommand("extension", { kind: "mcp", action: "oauth", name: "fixture_http" });
    await child!.hostCommand("extension", { kind: "mcp", action: "oauth-cancel", name: "fixture_http" });
    for (let attempt = 0; attempt < 60 && auth.status !== "cancelled"; attempt++) { await Bun.sleep(50); auth = (await child!.hostCommand("extension", { kind: "mcp", action: "oauth-status", name: "fixture_http" }) as { result: typeof auth }).result; }
    expect(auth.status).toBe("cancelled");
    const receipt = await child!.promptAndWait("/skill:imported-method Verify the imported method and use fixture_http echo.");
    expect(receipt.status).toBe("completed"); expect(skillObserved).toBe(true); expect(toolObserved).toBe(true);
    await child!.hostCommand("extension", { kind: "plugin", action: "toggle", name: "alpha-native-test-plugin", enabled: false });
    await child!.stop(); await start();
    catalog = await child!.hostCommand("catalog") as ExtensionCatalog;
    expect(catalog.entries.find(row => row.name === "alpha-native-test-plugin")?.loaded).toBe(false);
    await child!.hostCommand("extension", { kind: "plugin", action: "toggle", name: "alpha-native-test-plugin", enabled: true });
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "alpha-native-test-plugin", version: "1.0.1", license: "MIT", omp: { extensions: ["index.ts"] } }));
    await child!.hostCommand("extension", { kind: "plugin", action: "upgrade", name: "alpha-native-test-plugin" });
    expect(JSON.stringify(await child!.hostCommand("catalog"))).toContain("1.0.1");
    await child!.hostCommand("extension", { kind: "plugin", action: "remove", name: "alpha-native-test-plugin" });
    expect(await readFile(join(plugin, "index.ts"), "utf8")).toContain("PLUGIN_EVIDENCE");
  } finally { await child?.stop(); model.stop(true); mcp.stop(true); await rm(root, { recursive: true, force: true }); }
}, 120_000);
