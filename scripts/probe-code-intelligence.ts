// Creates a restricted OMP session the way Alpha does for managed code work (no model call) and exercises
// ast_grep and read-only LSP against a scratch TypeScript project. Run: bun run scripts/probe-code-intelligence.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ensureTheme, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { assertFileToolGuardLoaded, fileToolGuard } from "../src/runtime/file-tool-guard";

// Inside the repository so the language server finds its TypeScript install, like a real project would.
const root = await mkdtemp(join(import.meta.dir, "..", ".alpha", "probe-code-intel-"));
const agentDir = await mkdtemp(join(tmpdir(), "alpha-code-intel-agent-"));
try {
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }));
  await writeFile(join(root, "app.ts"), "export function total(items: { price: number }[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\nconst broken: number = \"text\";\nconsole.log(total([]), broken);\n");
  await ensureTheme();
  const settings = await Settings.init({ cwd: root, agentDir });
  settings.override("astGrep.enabled", true);
  settings.override("lsp.shared", false);
  const created = await createAgentSession({
    cwd: root, agentDir, sessionManager: SessionManager.inMemory(root),
    toolNames: ["read", "grep", "ast_grep", "lsp"], restrictToolNames: true, allowRestrictedCustomTools: true,
    autoApprove: true, disableExtensionDiscovery: true,
    preloadedPreparedExtensions: [fileToolGuard(root)],
    enableMCP: false, enableLsp: true, lspReadOnly: true, skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  try {
    assertFileToolGuardLoaded(created.extensionsResult.extensions);
    const tools = created.session.agent.state.tools;
    console.log("tools:", tools.map(tool => tool.name).join(", "));
    const run = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find(item => item.name === name);
      if (!tool) throw new Error(`${name} is not registered`);
      try {
        const result = await tool.execute(`probe-${name}`, args as never, AbortSignal.timeout(60_000), undefined as never);
        const text = result.content.map(part => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
        console.log(`\n--- ${name} ${JSON.stringify(args)}${result.isError ? " (error)" : ""}\n${text.slice(0, 1200)}`);
      } catch (error) {
        console.log(`\n--- ${name} ${JSON.stringify(args)} threw\n${error instanceof Error ? error.stack ?? error.message : String(error)}`.slice(0, 1500));
      }
    };
    await run("ast_grep", { pat: "items.reduce($$$)", path: "*.ts" });
    await run("lsp", { action: "diagnostics", file: "app.ts" });
    await run("lsp", { action: "hover", file: "app.ts", line: 1, symbol: "total" });
    await run("lsp", { action: "rename", file: "app.ts", line: 1, symbol: "total", new_name: "sum" });
  } finally { await created.session.dispose(); }
} finally {
  // Language servers can hold the folder briefly after shutdown on Windows; a leftover temp folder is harmless.
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
  await rm(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
}
