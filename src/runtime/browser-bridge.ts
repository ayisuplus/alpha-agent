export interface BrowserTab { tabId: string; targetId: string; url: string; title: string }

/** Authenticated loopback IPC to the Electron process that owns real browser views and encrypted keys. */
export class BrowserBridge {
  private readonly origin: string;
  private readonly token: string;
  constructor(port = process.env.ALPHA_BROWSER_BRIDGE_PORT, token = process.env.ALPHA_BROWSER_BRIDGE_TOKEN) {
    if (!port || !/^\d+$/.test(port) || !token) throw new Error("Desktop browser bridge is unavailable");
    this.origin = `http://127.0.0.1:${port}`;
    this.token = token;
  }
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, { method, headers: { "x-alpha-bridge-token": this.token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path === "/tabs" && method === "POST" ? 30_000 : 10_000) });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Browser bridge HTTP ${response.status}`);
    return data;
  }
  createTab(taskId: string, url: string): Promise<BrowserTab> { return this.request("POST", "/tabs", { taskId, url }); }
  async tabs(): Promise<BrowserTab[]> { return (await this.request<{ tabs: BrowserTab[] }>("GET", "/tabs")).tabs; }
  focusTab(tabId: string): Promise<{ focused: boolean }> { return this.request("POST", `/tabs/${tabId}`); }
  closeTab(tabId: string): Promise<{ closed: boolean }> { return this.request("DELETE", `/tabs/${tabId}`); }
  allowNavigation(tabId: string, url: string): Promise<{ allowed: boolean }> { return this.request("POST", `/tabs/${tabId}/allow`, { url }); }
  previewTarget(): Promise<{ targetId: string; url: string }> { return this.request("GET", "/preview-target"); }
  async key(provider: "tavily" | "firecrawl"): Promise<string | null> { return (await this.request<{ key: string | null }>("GET", `/secrets/${provider}`)).key; }
  setKey(provider: "tavily" | "firecrawl", key: string): Promise<{ saved: boolean }> { return this.request("PUT", `/secrets/${provider}`, { key }); }
  removeKey(provider: "tavily" | "firecrawl"): Promise<{ removed: boolean }> { return this.request("DELETE", `/secrets/${provider}`); }
}
