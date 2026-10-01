/** Read-only external-service acceptance through the actual OMP session and MCP manager. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RpcProcess } from "../src/native/rpc-process";
import type { ExtensionCatalog } from "../src/native/host-types";

const evidence = resolve(process.argv[2] ?? "artifacts/parity-external-mcp"); await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(evidence, "external-")), profile = join(root, "profile"), project = join(root, "project"), sessions = join(root, "sessions");
await mkdir(profile); await mkdir(project);
let called = false, resultText = "";
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> };
  const last = body.messages.at(-1), route = /xd:\/\/[a-zA-Z0-9_-]*microsoft_docs_search/.exec(JSON.stringify(body.messages))?.[0];
  const write = body.tools?.find(tool => tool.function.name === "write");
  const invoke = route && write && last?.role !== "tool";
  if (last?.role === "tool") resultText = JSON.stringify(last.content);
  if (invoke) called = true;
  const delta = invoke ? { tool_calls: [{ index: 0, id: "external-read-proof", type: "function", function: { name: "write", arguments: JSON.stringify({ path: route, content: JSON.stringify({ query: "PowerShell 7 command line documentation" }) }) } }] } : { content: "EXTERNAL_READ_PROOF_FINISHED" };
  return new Response(`data: ${JSON.stringify({ id: "external-read-model", choices: [{ index: 0, delta, finish_reason: invoke ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} });
await writeFile(join(profile, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.port}/v1`, auth: "none", apiKey: "fixture-only", models: [{ id: "proof", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
await writeFile(join(profile, "config.yml"), "modelRoles:\n  default: fixture/proof\nlsp:\n  enabled: false\nstartup:\n  quiet: true\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\nretry:\n  enabled: false\n");
const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_SESSION_DIR: sessions };
let child: RpcProcess | undefined;
const start = async () => { child = new RpcProcess({ cwd: project, env, argv: [resolve("src/native/omp-host.ts"), "--mode", "rpc-ui"] }); await child.ready; };
try {
  await start(); await child!.hostCommand("extension", { kind: "mcp", action: "add", name: "microsoft_learn", scope: "project", config: { type: "http", url: "https://learn.microsoft.com/api/mcp" } });
  await child!.stop(); await start();
  let row: ExtensionCatalog["entries"][number] | undefined;
  for (let count = 0; count < 200; count++) { const catalog = await child!.hostCommand("catalog") as ExtensionCatalog; row = catalog.entries.find(row => row.kind === "mcp" && row.name === "microsoft_learn"); if (row?.loaded || row?.error) break; await Bun.sleep(300); }
  if (row?.status !== "connected" || !JSON.stringify(row.details).includes("microsoft_docs_search")) throw new Error("External native MCP connection failed: " + JSON.stringify(row));
  await child!.promptAndWait("Use the microsoft_learn microsoft_docs_search MCP tool to read public PowerShell documentation.");
  if (!called || !resultText.includes("learn.microsoft.com") || !/PowerShell/i.test(resultText)) throw new Error("The external MCP tool did not return real documentation");
  await child!.hostCommand("extension", { kind: "mcp", action: "reconnect", name: "microsoft_learn" }); await child!.hostCommand("extension", { kind: "mcp", action: "refresh", name: "microsoft_learn" });
  const result = { endpoint: "https://learn.microsoft.com/api/mcp", transport: "http", actualNativeManager: true, connected: true, toolCalled: true, publicDocumentationReturned: true, reconnectAndRefresh: true, oauth: "not-required-not-tested", model: "isolated-loopback-dispatch-only" };
  await writeFile(join(evidence, "external-mcp-result.json"), JSON.stringify(result, null, 2)); console.log("ALPHA_EXTERNAL_MCP_OK " + JSON.stringify(result));
} finally { await child?.stop(); model.stop(true); }
