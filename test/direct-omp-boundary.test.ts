import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { createDirectFileTools } from "../src/runtime/direct-file-tools";
import { assertFileToolGuardLoaded, fileToolGuard } from "../src/runtime/file-tool-guard";
import { ProjectStore } from "../src/runtime/projects";

test("restricted OMP registry routes all four file tools to Alpha proxies", async () => {
  const data = await mkdtemp(join(tmpdir(), "alpha-omp-data-"));
  const root = await mkdtemp(join(tmpdir(), "alpha-omp-root-"));
  try {
    const projects = new ProjectStore(data);
    const project = await projects.create("test");
    const mounted = await projects.mount(project.id, root);
    const customTools = await createDirectFileTools({ taskId: "omp-test", projectId: project.id, projectVersion: mounted.version, projectRoot: root, dataRoot: data, mode: "full", onNeedsInput: async () => {} });
    const created = await createAgentSession({
      cwd: root, agentDir: join(tmpdir(), "alpha-omp-boundary-agent"), sessionManager: SessionManager.inMemory(root),
      toolNames: ["read", "grep", "edit", "write"], restrictToolNames: true, allowRestrictedCustomTools: true,
      customTools, autoApprove: true, disableExtensionDiscovery: true,
      preloadedPreparedExtensions: [fileToolGuard(root, undefined, [], true)],
      enableMCP: false, enableLsp: false, skipPythonPreflight: true,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    });
    try {
      assertFileToolGuardLoaded(created.extensionsResult.extensions);
      for (const name of ["read", "grep", "edit", "write"]) {
        const tool = created.session.agent.state.tools.find(item => item.name === name);
        expect(tool?.description.startsWith("Alpha sandbox proxy.")).toBe(true);
      }
    } finally { await created.session.dispose(); }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await rm(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
