import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import alphaCapabilities from "../src/native/capabilities/extension";

const leaked = ["ALPHA_BROWSER_BRIDGE_PORT", "ALPHA_BROWSER_BRIDGE_TOKEN", "ALPHA_CDP_PORT"] as const;
const saved = new Map<string, string | undefined>();

function stubPi(): ExtensionAPI {
  const tools: Array<{ name: string }> = [];
  return {
    registerTool(tool: { name: string }) { tools.push(tool); },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ExtensionAPI;
}

afterEach(() => {
  for (const key of leaked) {
    if (saved.has(key)) process.env[key] = saved.get(key);
    else delete process.env[key];
  }
  saved.clear();
});

describe("capability extension environment boundary", () => {
  test("reads the bridge token and CDP port, then scrubs them from process.env", () => {
    for (const key of leaked) { saved.set(key, process.env[key]); }
    process.env.ALPHA_BROWSER_BRIDGE_PORT = "41234";
    process.env.ALPHA_BROWSER_BRIDGE_TOKEN = "secret-bridge-token";
    process.env.ALPHA_CDP_PORT = "41235";
    const previousId = process.env.ALPHA_NATIVE_SESSION_ID;
    const previousRoot = process.env.ALPHA_DATA_ROOT;
    delete process.env.ALPHA_NATIVE_SESSION_ID;
    delete process.env.ALPHA_DATA_ROOT;
    try {
      alphaCapabilities(stubPi());
      for (const key of leaked) expect(process.env[key]).toBeUndefined();
    } finally {
      if (previousId === undefined) delete process.env.ALPHA_NATIVE_SESSION_ID; else process.env.ALPHA_NATIVE_SESSION_ID = previousId;
      if (previousRoot === undefined) delete process.env.ALPHA_DATA_ROOT; else process.env.ALPHA_DATA_ROOT = previousRoot;
    }
  });
});
