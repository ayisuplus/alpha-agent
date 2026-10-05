import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { attachBrowserConsent } from "./browser-consent";
import { createComfyPlugin } from "./comfyui/register";
import { registerOfficeTools } from "./office/register";

/** Shared registration context for the native capability tools. */
export interface CapabilityContext {
  sessionId: string;
  dataRoot: string;
  projectRoot: string;
}

export default function alphaCapabilities(pi: ExtensionAPI): void {
  // M0 safety boundary: read the desktop bridge and CDP endpoints, then scrub them from the
  // environment so model-run commands (which inherit this process env) can never see the bridge
  // token or debug port. The browser bridge is retired after M0: these values are read only so
  // they can be deleted, then discarded.
  const bridgePort = process.env.ALPHA_BROWSER_BRIDGE_PORT;
  const bridgeToken = process.env.ALPHA_BROWSER_BRIDGE_TOKEN;
  const cdpPort = process.env.ALPHA_CDP_PORT;
  delete process.env.ALPHA_BROWSER_BRIDGE_PORT;
  delete process.env.ALPHA_BROWSER_BRIDGE_TOKEN;
  delete process.env.ALPHA_CDP_PORT;
  void bridgePort;
  void bridgeToken;
  void cdpPort;
  const id = process.env.ALPHA_NATIVE_SESSION_ID;
  const dataRoot = process.env.ALPHA_DATA_ROOT;
  if (!id || !dataRoot) return;
  const ctx: CapabilityContext = { sessionId: id, dataRoot, projectRoot: process.cwd() };

  registerOfficeTools(pi, ctx);
  for (const tool of createComfyPlugin({ projectRoot: ctx.projectRoot, dataRoot: ctx.dataRoot, url: process.env.ALPHA_COMFY_URL }).tools) pi.registerTool(tool);
  attachBrowserConsent(pi, { sessionId: id, dataRoot });
}
