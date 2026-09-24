import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserTool } from "../src/runtime/browser-tool";
import { assertFileToolGuardLoaded, fileToolGuard } from "../src/runtime/file-tool-guard";

process.env.PI_EDIT_VARIANT = "hashline";
process.env.PI_STRICT_EDIT_MODE = "1";

const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const workspace = await mkdtemp(join(tmpdir(), "alpha-omp-probe-"));
const agentDir = join(process.cwd(), ".alpha", "omp-probe");

try {
  await writeFile(join(workspace, "sample.txt"), "one\ntwo\nthree\n");
  const { session, mcpManager, extensionsResult } = await createAgentSession({
    cwd: workspace,
    agentDir,
    sessionManager: SessionManager.inMemory(workspace),
    toolNames: ["read", "edit", "write", "alpha_browser"],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    customTools: [createBrowserTool(() => null, join(process.cwd(), ".alpha"))],
    preloadedPreparedExtensions: [fileToolGuard(workspace)],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  });
  try {
    assertFileToolGuardLoaded(extensionsResult.extensions);
    const tools = session.agent.state.tools.map(tool => tool.name).sort();
    if (tools.join(",") !== "alpha_browser,edit,read,write") {
      throw new Error(`Unexpected tools: ${tools.join(",")}`);
    }
    if (mcpManager) throw new Error("Restricted probe unexpectedly enabled MCP");
    const read = session.getToolByName("read");
    const edit = session.getToolByName("edit");
    const write = session.getToolByName("write");
    if (!write) throw new Error("Write tool missing");
    if (!read || !edit) throw new Error("Read/edit tools missing");
    const outside = join(process.cwd(), "package.json");
    const blocked = async (call: () => Promise<unknown>) => {
      try { return (await call() as { isError?: boolean }).isError === true; }
      catch (error) { return error instanceof Error && error.message.includes("outside the assigned project"); }
    };
    if (!await blocked(() => read.execute(crypto.randomUUID(), { path: outside }))) throw new Error("Out-of-root read passed guard");
    if (!await blocked(() => write.execute(crypto.randomUUID(), { path: outside, content: "forbidden" }))) throw new Error("Out-of-root write passed guard");
    const sample = join(workspace, "sample.txt");
    const readText = async () => {
      const result = await read.execute(crypto.randomUUID(), { path: sample });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    };
    const header = (await readText()).match(/\[[^\]\n]+#[0-9a-fA-F]{4}\]/)?.[0];
    if (!header) throw new Error("Hashline read header missing");
    const first = await edit.execute(crypto.randomUUID(), {
      input: `*** Begin Patch\n${header}\nPUT 2.=2:\n+TWO\n*** End Patch`,
    });
    if (first.isError) throw new Error(`Hashline edit failed: ${JSON.stringify(first.content)}`);
    if ((await readFile(sample, "utf8")) !== "one\nTWO\nthree\n") throw new Error("Hashline edit wrote wrong content");

    const staleHeader = (await readText()).match(/\[[^\]\n]+#[0-9a-fA-F]{4}\]/)?.[0];
    if (!staleHeader) throw new Error("Hashline read after edit missing header");
    await writeFile(sample, "one\noutside\nthree\n");
    const stale = await edit.execute(crypto.randomUUID(), {
      input: `*** Begin Patch\n${staleHeader}\nPUT 2.=2:\n+WRONG\n*** End Patch`,
    });
    if (!stale.isError) throw new Error("Stale Hashline edit unexpectedly succeeded");
    if ((await readFile(sample, "utf8")) !== "one\noutside\nthree\n") throw new Error("Stale edit clobbered external change");
    console.log(JSON.stringify({ package: "@oh-my-pi/pi-coding-agent", version: "18.2.11", tools, sdk: "ok", hashline: "read-edit-stale-rejected" }));
  } finally {
    await session.dispose();
  }
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
