import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { discoverOAuthEndpoints } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { MCPOAuthFlow, mcpOAuthCredentialId, type MCPStoredOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

/** UI transport for OMP's OAuth flow; credentials remain in native AuthStorage. */
export class NativeMcpOAuth {
  private controller?: AbortController;
  private manual?: ReturnType<typeof Promise.withResolvers<string>>;
  private value: { name?: string; status: string; url?: string; error?: string } = { status: "idle" };
  state() { return this.value; }
  code(code: string) { if (!this.manual) throw new Error("No OAuth input pending"); this.manual.resolve(code); }
  cancel() { this.controller?.abort(); this.manual?.reject(new Error("Authorization cancelled")); }
  start(session: AgentSession, name: string, config: MCPServerConfig) {
    if (this.controller) throw new Error("OAuth already in progress");
    if (!("url" in config)) throw new Error("OAuth requires an HTTP or SSE server");
    const controller = this.controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    this.value = { name, status: "discovering" };
    void (async () => {
      const endpoints = await discoverOAuthEndpoints(config.url, undefined, undefined, { signal: controller.signal });
      if (!endpoints) throw new Error("OAuth endpoints not discovered; check native server configuration");
      const flow = new MCPOAuthFlow({ ...endpoints, ...config.oauth, scopes: config.oauth?.scope ?? endpoints.scopes, resource: endpoints.resource ?? config.url }, {
        signal: controller.signal,
        onAuth: info => { this.value = { name, status: "authorizing", url: info.url }; },
        onManualCodeInput: signal => {
          const manual = this.manual = Promise.withResolvers<string>();
          const cancel = () => manual.reject(new Error("Authorization cancelled"));
          signal?.addEventListener("abort", cancel, { once: true });
          return manual.promise.finally(() => { signal?.removeEventListener("abort", cancel); this.manual = undefined; });
        },
      });
      const credentials = await flow.login();
      if (controller.signal.aborted) throw new Error("Authorization cancelled");
      const stored: MCPStoredOAuthCredential = { type: "oauth", ...credentials, tokenUrl: endpoints.tokenUrl, clientId: flow.resolvedClientId, clientSecret: flow.registeredClientSecret ?? config.oauth?.clientSecret, resource: flow.resource, authorizationUrl: flow.authorizationUrl };
      await session.modelRegistry.authStorage.credentials.set(mcpOAuthCredentialId(config.url), stored);
      this.value = { name, status: "authorized" };
    })().catch(error => { this.value = { name, status: controller.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) }; }).finally(() => { clearTimeout(timer); this.controller = undefined; });
    return this.state();
  }
}
