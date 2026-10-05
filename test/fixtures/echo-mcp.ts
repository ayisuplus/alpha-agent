import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number | string; method: string; params?: { name?: string; arguments?: { message?: string } } };
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "alpha-echo-test", version: "1.0.0" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] }
      : request.method === "tools/call" && request.params?.name === "echo"
        ? { content: [{ type: "text", text: `echo:${request.params.arguments?.message ?? ""}` }] }
        : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
