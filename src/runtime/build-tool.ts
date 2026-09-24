import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";

const parameters = type({ action: "'build'" });

export function createBuildTool(projectRoot: string): CustomTool<typeof parameters> {
  let running = false;
  return {
    name: "alpha_build",
    label: "Build assigned product",
    description: "Run the assigned product's build. Alpha's runtime will publish and verify the visible local preview after the agent turn. Do not start a server or inspect ports.",
    parameters,
    loadMode: "essential",
    approval: "exec",
    async execute(_toolCallId, _args, _onUpdate, _ctx, signal) {
      if (running) return { content: [{ type: "text", text: "A build is already running" }], isError: true };
      running = true;
      const child = Bun.spawn([process.execPath, "run", "build"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 60_000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const output = `${stdout}\n${stderr}`.trim().slice(-10_000);
        return { content: [{ type: "text", text: `exit=${exitCode}\n${output}` }], isError: exitCode !== 0 || signal?.aborted === true };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        running = false;
      }
    },
  };
}
