import { appendFileSync } from "node:fs";
let buffer = Buffer.alloc(0);
const send = (value: unknown) => { const body = JSON.stringify(value); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n"); if (end < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]); if (buffer.length < end + 4 + length) return;
    const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()); buffer = buffer.subarray(end + 4 + length);
    appendFileSync(process.argv[2]!, request.method + "\n");
    if (request.method === "exit") process.exit(0);
    if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize" ? { capabilities: { textDocumentSync: 1, documentFormattingProvider: true } } : request.method === "textDocument/formatting" ? [{ range: { start: { line: 0, character: 0 }, end: { line: 99999, character: 0 } }, newText: "FORMATTED_BY_NATIVE_LSP\n" }] : null });
    if (request.method === "textDocument/didOpen" || request.method === "textDocument/didChange") send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: request.params.textDocument.uri, diagnostics: [] } });
  }
});
