import { randomUUID } from "node:crypto";
import { ensureTheme, Settings } from "@oh-my-pi/pi-coding-agent";
import { SETTINGS_SCHEMA, type SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { setIdleTimeout as setLspIdleTimeout, shutdownAll as shutdownAllLanguageServers } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";

export type EditMode = ReturnType<typeof resolveEditMode>;

let themeReady: Promise<void> | null = null;

/** OMP's command line loads a UI theme at startup; some tool output (LSP diagnostics) reads its symbols and throws without it. */
function prepareOmpProcess(): Promise<void> {
  themeReady ??= ensureTheme();
  return themeReady;
}

/**
 * Disposing a session leaves its language servers running. The long-lived workbench server reaps idle ones after
 * five minutes; short-lived processes call shutdownLanguageServers() instead, because the reaper's interval (and the
 * servers' pipes) would keep them from exiting.
 */
export function reapIdleLanguageServers(): void {
  setLspIdleTimeout(5 * 60_000);
}

/**
 * A unique OMP agent identity for one session. OMP registers every session in a process-wide registry under
 * "Main" unless told otherwise, so sessions that start at the same time (parallel tasks, a title or review call next
 * to a run) would replace each other during initialization.
 */
export function ompAgentId(purpose: string): string {
  return `alpha-${purpose}-${randomUUID().slice(0, 8)}`;
}

export async function shutdownLanguageServers(): Promise<void> {
  await shutdownAllLanguageServers().catch(() => undefined);
}

/**
 * Settings for one Alpha session: the effective OMP configuration plus Alpha's overrides, isolated from every other
 * session in the process (tasks run concurrently, so nothing here may be process-global). Same pattern OMP uses for
 * its own subagents. Nothing is written to the OMP configuration.
 * - Edit format: OMP picks it per model (some families get `replace`). Code work pins Hashline, which Alpha's
 *   verification and sandbox proxy are built around; everything else keeps OMP's choice.
 * - ast_grep: off by default in OMP; restricted sessions still get it only where Alpha lists it.
 * - LSP: servers belong to this process rather than OMP's shared multiplexer daemon.
 * - Retries: OMP backs off and retries transient provider errors; its defaults (ten attempts, waits up to five
 *   minutes) would consume a whole run budget, so they are bounded.
 */
export async function ompSessionSettings(cwd: string, agentDir: string, options: { pinHashline: boolean }): Promise<Settings> {
  await prepareOmpProcess();
  const base = await Settings.init({ cwd, agentDir });
  const snapshot: Partial<Record<SettingPath, unknown>> = {};
  for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) snapshot[key] = base.get(key);
  const overrides: Record<string, unknown> = {
    ...snapshot,
    "astGrep.enabled": true,
    "lsp.shared": false,
    "retry.maxRetries": 4,
    "retry.maxDelayMs": 30_000,
    // A model-pattern variant outranks OMP's per-family fallback; the empty pattern matches every model.
    ...(options.pinHashline ? { "edit.mode": "hashline", "edit.modelVariants": { "": "hashline" } } : {}),
  };
  return Settings.isolated(overrides as Partial<Record<SettingPath, unknown>>, { storage: base.getStorage() });
}

/** The edit format a session with these settings uses for `model` (`provider/id`). */
export function sessionEditMode(settings: Settings, model: string): EditMode {
  return resolveEditMode({ settings, getActiveModelString: () => model });
}
