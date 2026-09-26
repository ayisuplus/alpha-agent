import { BrowserBridge, type BrowserTab } from "./browser-bridge";
import { assertPublicWebUrl } from "./research-source";
import { VisibleBrowser, type BrowserSession } from "./visible-browser";

interface OwnedSession { taskId: string; browser: VisibleBrowser; kind: "preview" | "web"; tab?: BrowserTab }

/** One owner for page identity, control handoff, ordering, and late-result rejection. */
export class BrowserKernel {
  private holder: "alpha" | "user" = "alpha";
  private epoch = 0;
  private readonly sessions = new Map<string, OwnedSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly cdpPort: number | null, private readonly bridge: BrowserBridge | null) {}

  get controlHolder(): "alpha" | "user" { return this.holder; }
  async previewTarget(): Promise<{ targetId: string; url: string }> {
    if (!this.bridge) throw new Error("Desktop preview target is unavailable");
    return this.bridge.previewTarget();
  }
  setControl(holder: "alpha" | "user"): void {
    if (holder === this.holder) return;
    this.holder = holder;
    this.epoch++;
    for (const entry of this.sessions.values()) holder === "user" ? entry.browser.takeOver() : entry.browser.returnControl();
  }

  attachPreview(taskId: string, browser: VisibleBrowser): void {
    const key = `preview:${taskId}`;
    if (this.sessions.has(key)) throw new Error("Preview is already owned by this task");
    if (this.holder === "user") browser.takeOver();
    this.sessions.set(key, { taskId, browser, kind: "preview" });
  }
  async connectPreview(taskId: string, expectedUrl: string, signal?: AbortSignal): Promise<BrowserSession> {
    signal?.throwIfAborted();
    if (!this.cdpPort) throw new Error("Desktop CDP port is unavailable");
    const target = await this.previewTarget();
    if (new URL(target.url).origin !== new URL(expectedUrl).origin) throw new Error("Visible preview does not match the task");
    const browser = await VisibleBrowser.connect(`http://127.0.0.1:${this.cdpPort}`, target.targetId, true);
    this.attachPreview(taskId, browser);
    return this.handle(taskId, undefined, signal);
  }
  async detachPreview(taskId: string): Promise<void> {
    const key = `preview:${taskId}`;
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    await session.browser.disconnect();
  }
  private key(tabId: string): string { return `web:${tabId}`; }

  async openTab(taskId: string, rawUrl: string, signal?: AbortSignal, userInitiated = false): Promise<BrowserTab> {
    signal?.throwIfAborted();
    if (this.holder !== "alpha" && !userInitiated) throw new Error("User controls the browser");
    if (!this.bridge || !this.cdpPort) throw new Error("Desktop browser is unavailable");
    await assertPublicWebUrl(rawUrl);
    if ([...this.sessions.values()].filter(item => item.taskId === taskId && item.kind === "web").length >= 6) throw new Error("Task browser tab limit reached");
    const tab = await this.bridge.createTab(taskId, rawUrl);
    try {
      const browser = await VisibleBrowser.connect(`http://127.0.0.1:${this.cdpPort}`, tab.targetId, true, "web");
      if (signal?.aborted || this.holder !== "alpha" && !userInitiated) throw new Error("Browser tab opened after control changed");
      if (this.holder === "user") browser.takeOver();
      this.sessions.set(this.key(tab.tabId), { taskId, browser, kind: "web", tab });
      return tab;
    } catch (error) {
      await this.bridge.closeTab(tab.tabId).catch(() => undefined);
      throw error;
    }
  }
  tabs(taskId: string): BrowserTab[] {
    return [...this.sessions.values()].filter(item => item.taskId === taskId && item.tab).map(item => item.tab!);
  }
  async currentTab(taskId: string, tabId: string): Promise<BrowserTab> {
    const session = this.owned(taskId, this.key(tabId));
    const current = (await this.bridge?.tabs())?.find(tab => tab.tabId === tabId);
    if (!current || current.targetId !== session.tab?.targetId) throw new Error("Owned browser target is no longer available");
    session.tab.url = current.url;
    session.tab.title = current.title;
    return session.tab;
  }
  documentIdentity(taskId: string, tabId: string): string {
    return this.owned(taskId, this.key(tabId)).browser.documentIdentity;
  }
  async focusTab(taskId: string, tabId: string): Promise<void> {
    this.owned(taskId, this.key(tabId));
    await this.bridge?.focusTab(tabId);
  }
  async allowNavigation(taskId: string, tabId: string, url: string): Promise<void> {
    this.owned(taskId, this.key(tabId));
    await assertPublicWebUrl(url);
    await this.bridge?.allowNavigation(tabId, url);
  }
  async closeTab(taskId: string, tabId: string): Promise<void> {
    const key = this.key(tabId);
    const session = this.owned(taskId, key);
    this.sessions.delete(key);
    await session.browser.disconnect();
    await this.bridge?.closeTab(tabId);
  }
  private owned(taskId: string, key: string): OwnedSession {
    const session = this.sessions.get(key);
    if (!session || session.taskId !== taskId) throw new Error("Browser tab is not owned by this task");
    return session;
  }
  private async run<T>(taskId: string, key: string, work: (browser: VisibleBrowser) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const startingEpoch = this.epoch;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const action = previous.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      if (this.holder !== "alpha" || startingEpoch !== this.epoch) throw new Error("Browser control changed before the action started");
      const session = this.owned(taskId, key);
      try {
        const result = await work(session.browser);
        if (signal?.aborted || startingEpoch !== this.epoch) throw new Error("Browser action outcome is uncertain after cancellation or takeover");
        if (session.tab && result && typeof result === "object" && "url" in result && "title" in result && typeof result.url === "string" && typeof result.title === "string") {
          session.tab.url = result.url;
          session.tab.title = result.title;
        }
        return result;
      } catch (error) {
        if (signal?.aborted || startingEpoch !== this.epoch) throw new Error("Browser action outcome is uncertain after cancellation or takeover");
        throw error;
      }
    });
    this.queues.set(key, action.then(() => undefined, () => undefined));
    return action;
  }

  handle(taskId: string, tabId?: string, signal?: AbortSignal, expectedDocument?: string): BrowserSession & { withSignal(signal?: AbortSignal): BrowserSession } {
    const key = tabId ? this.key(tabId) : `preview:${taskId}`;
    const apply = <T>(work: (browser: VisibleBrowser) => Promise<T>) => this.run(taskId, key, browser => {
      if (expectedDocument && browser.documentIdentity !== expectedDocument) throw new Error("Browser page changed after action approval");
      return work(browser);
    }, signal);
    return {
      withSignal: next => this.handle(taskId, tabId, next, expectedDocument),
      observe: () => apply(browser => browser.observe()),
      navigate: url => apply(browser => browser.navigate(url)),
      click: selector => apply(browser => browser.click(selector)),
      fill: (selector, value) => apply(browser => browser.fill(selector, value)),
      select: (selector, value) => apply(browser => browser.select(selector, value)),
      press: (selector, key) => apply(browser => browser.press(selector, key)),
      scroll: distance => apply(browser => browser.scroll(distance)),
      wait: selector => apply(browser => browser.wait(selector)),
      upload: (selector, filePath) => apply(browser => browser.upload(selector, filePath)),
      download: (selector, directory) => apply(browser => browser.download(selector, directory)),
      viewport: (width, height) => apply(browser => browser.viewport(width, height)),
      screenshot: path => apply(browser => browser.screenshot(path)),
      videoFrames: selector => apply(browser => browser.videoFrames(selector)),
      contrast: selector => apply(browser => browser.contrast(selector)),
      textOf: selector => apply(browser => browser.textOf(selector)),
      valueOf: selector => apply(browser => browser.valueOf(selector)),
    };
  }
}
