import { createInterface } from "node:readline";

export function answer(frame: { id?: string | number; method: string; params?: Record<string, unknown> }) {
  if (frame.id === undefined) return null;
  const result = frame.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "Alpha native fixture", version: "1.0.0" } }
    : frame.method === "tools/list" ? { tools: [{ name: "echo", description: "Return Alpha transport evidence", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] }
    : frame.method === "tools/call" ? { content: [{ type: "text", text: "MCP_EVIDENCE:" + String((frame.params?.arguments as { message?: string })?.message) }] }
    : frame.method === "resources/list" ? { resources: [{ uri: "fixture://evidence", name: "Transport evidence", mimeType: "text/plain" }] }
    : frame.method === "resources/read" ? { contents: [{ uri: "fixture://evidence", mimeType: "text/plain", text: "MCP_RESOURCE_EVIDENCE" }] }
    : frame.method === "resources/templates/list" ? { resourceTemplates: [] }
    : frame.method === "prompts/list" ? { prompts: [] } : {};
  return { jsonrpc: "2.0", id: frame.id, result };
}

export function startMcpFixture() {
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.includes(".well-known/")) return Response.json({ issuer: url.origin, authorization_endpoint: url.origin + "/authorize", token_endpoint: url.origin + "/token", scopes_supported: ["fixture"] });
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await request.text());
      if (form.get("code") !== "fixture-code" || !form.get("code_verifier")) return new Response("Invalid fixture PKCE exchange", { status: 400 });
      return Response.json({ access_token: "oauth-fixture-secret", refresh_token: "fixture-refresh", expires_in: 3600, token_type: "Bearer" });
    }
    if (request.method === "GET" && url.pathname === "/sse") {
      return new Response(new ReadableStream({ start(controller) { sse = controller; controller.enqueue(encoder.encode(`event: endpoint\ndata: /messages\n\n`)); }, cancel() { sse = undefined; } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const frame = await request.json() as Parameters<typeof answer>[0]; const response = answer(frame);
    if (url.pathname === "/messages") { if (response) sse?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`)); return new Response(null, { status: 202 }); }
    return response ? Response.json(response) : new Response(null, { status: 202 });
  } });
  return server;
}

if (process.argv.includes("--stdio")) createInterface({ input: process.stdin }).on("line", line => { const result = answer(JSON.parse(line)); if (result) process.stdout.write(JSON.stringify(result) + "\n"); });
