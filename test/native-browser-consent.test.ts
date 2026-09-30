import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { attachBrowserConsent, drivesBrowser } from "../src/native/capabilities/browser-consent";

type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function harness(answer: string | undefined) {
  let handler: Handler | undefined;
  const pi = {
    on(event: string, fn: Handler) { if (event === "tool_call") handler = fn; },
  } as unknown as ExtensionAPI;
  const asked: string[] = [];
  const ui = {
    select(title: string, options: Array<{ label: string }>) {
      asked.push(title);
      return Promise.resolve(answer && options.some(option => option.label === answer) ? answer : undefined);
    },
  };
  return { pi, asked, ui: ui as unknown as ExtensionContext["ui"], run: (event: { toolName: string; input: Record<string, unknown> }) => handler!(event, { ui } as ExtensionContext) };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alpha-consent-"));
  roots.push(root);
  return join(root, "data");
}

describe("browser consent gate", () => {
  test("browser calls require consent; plain tools and evals pass untouched", async () => {
    const dataRoot = await fixture();
    const pass = harness("本会话");
    attachBrowserConsent(pass.pi, { sessionId: "s1", dataRoot });
    expect(await pass.run({ toolName: "bash", input: { command: "ls" } })).toBeUndefined();
    expect(await pass.run({ toolName: "eval", input: { code: "console.log(1)" } })).toBeUndefined();
    expect(pass.asked).toHaveLength(1);

    const denied = harness("拒绝");
    attachBrowserConsent(denied.pi, { sessionId: "denied", dataRoot });
    const blocked = await denied.run({ toolName: "browser", input: { action: "open", url: "http://127.0.0.1" } });
    expect(blocked && "block" in blocked && blocked.block).toBe(true);

    const evalBlocked = harness("拒绝");
    attachBrowserConsent(evalBlocked.pi, { sessionId: "s2", dataRoot });
    const result = await evalBlocked.run({ toolName: "eval", input: { code: "await browser.open('http://127.0.0.1')" } });
    expect(result && "block" in result && result.block).toBe(true);
    expect(evalBlocked.asked).toHaveLength(1);
  });

  test("session consent passes later calls and survives until the entry is revoked", async () => {
    const dataRoot = await fixture();
    const first = harness("本会话");
    attachBrowserConsent(first.pi, { sessionId: "s1", dataRoot });
    expect(await first.run({ toolName: "browser", input: {} })).toBeUndefined();
    expect(first.asked).toHaveLength(1);

    const second = harness("本会话");
    attachBrowserConsent(second.pi, { sessionId: "s1", dataRoot });
    expect(await second.run({ toolName: "browser", input: {} })).toBeUndefined();
    expect(second.asked).toHaveLength(0);

    // 撤销 = 删除本会话条目（“本机能力”页或终端内同义）。
    const file = join(dataRoot, "native", "browser-consents", "s1.json");
    const entries = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete entries.s1;
    await writeFile(file, JSON.stringify(entries));

    const revoked = harness("拒绝");
    attachBrowserConsent(revoked.pi, { sessionId: "s1", dataRoot });
    const blocked = await revoked.run({ toolName: "browser", input: {} });
    expect(blocked && "block" in blocked && blocked.block).toBe(true);
    expect(revoked.asked).toHaveLength(1);
  });

  test("once consent expires after one call and denial keeps blocking", async () => {
    const dataRoot = await fixture();
    const once = harness("仅这次");
    attachBrowserConsent(once.pi, { sessionId: "s1", dataRoot });
    expect(await once.run({ toolName: "browser", input: {} })).toBeUndefined();
    expect(once.asked).toHaveLength(1);

    const again = harness(undefined);
    attachBrowserConsent(again.pi, { sessionId: "s1", dataRoot });
    const blocked = await again.run({ toolName: "browser", input: {} });
    expect(blocked && "block" in blocked && blocked.block).toBe(true);

    const denied = harness("拒绝");
    attachBrowserConsent(denied.pi, { sessionId: "s2", dataRoot });
    await denied.run({ toolName: "browser", input: {} });
    const stillDenied = harness(undefined);
    attachBrowserConsent(stillDenied.pi, { sessionId: "s2", dataRoot });
    const result = await stillDenied.run({ toolName: "browser", input: {} });
    expect(result && "block" in result && result.block).toBe(true);
    expect(stillDenied.asked).toHaveLength(0);
  });

  test("eval authorization cannot be bypassed by aliases or dynamic properties", () => {
    expect(drivesBrowser("browser", {})).toBe(true);
    expect(drivesBrowser("eval", { code: "await browser.open(url)" })).toBe(true);
    expect(drivesBrowser("eval", { code: "browser.tabs()" })).toBe(true);
    expect(drivesBrowser("eval", { code: "const b = browser; b['open'](url)" })).toBe(true);
    expect(drivesBrowser("eval", { code: "b.open(url)" })).toBe(true);
    expect(drivesBrowser("eval", { code: "console.log(1)" })).toBe(true);
    expect(drivesBrowser("bash", { command: "browser.open()" })).toBe(false);
  });
  test("manual takeover blocks even sessions with persisted permission", async () => {
    const dataRoot = await fixture();
    const allowed = harness("本会话");
    attachBrowserConsent(allowed.pi, { sessionId: "s1", dataRoot });
    await allowed.run({ toolName: "eval", input: {} });
    await writeFile(join(dataRoot, "native", "browser-control.json"), JSON.stringify({ paused: true }));
    const result = await allowed.run({ toolName: "eval", input: { code: "b.open(url)" } });
    expect(result && "block" in result && result.block).toBe(true);
  });
});
