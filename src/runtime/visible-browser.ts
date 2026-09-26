import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import puppeteer, { type Browser, type ElementHandle, type Frame, type KeyInput, type Page } from "puppeteer-core";
import { assertPublicWebUrl } from "./research-source";

export interface BrowserObservation {
  title: string;
  url: string;
  text: string;
  controls: Array<{ tag: string; id: string; name: string; label: string; text: string; role?: string; disabled?: boolean; ref?: string; frame?: string }>;
  consoleErrors: string[];
  failedRequests: string[];
  brokenImages: string[];
  viewport: { width: number; height: number; horizontalOverflow: boolean };
  snapshotId?: string;
}

export interface BrowserSession {
  observe(): Promise<BrowserObservation>;
  navigate(url: string): Promise<BrowserObservation>;
  click(selector: string): Promise<BrowserObservation>;
  fill(selector: string, value: string): Promise<BrowserObservation>;
  select(selector: string, value: string): Promise<BrowserObservation>;
  press(selector: string, key: string): Promise<BrowserObservation>;
  scroll(distance: number): Promise<BrowserObservation>;
  wait(selector: string): Promise<BrowserObservation>;
  upload(selector: string, filePath: string): Promise<BrowserObservation>;
  download(selector: string, directory: string): Promise<{ observation: BrowserObservation; filePath: string; sha256: string; bytes: number }>;
  viewport(width: number, height: number): Promise<BrowserObservation>;
  screenshot(path: string): Promise<BrowserObservation>;
  videoFrames(selector: string): Promise<{ duration: number; width: number; height: number; frames: string[] }>;
  contrast(selector: string): Promise<{ foreground: string; background: string; ratio: number }>;
  textOf(selector: string): Promise<string | null>;
  valueOf(selector: string): Promise<string | null>;
}

function assertLoopback(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("Alpha's first browser adapter accepts only local HTTP endpoints");
  }
}

export function discoverBrowserWebSocket(cdpUrl: string): Promise<string> {
  assertLoopback(cdpUrl);
  return new Promise((resolve, reject) => {
    const request = get(new URL("/json/version", cdpUrl), response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => body += chunk);
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`CDP discovery returned HTTP ${response.statusCode}`));
        try {
          const endpoint = (JSON.parse(body) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
          if (!endpoint?.startsWith("ws://127.0.0.1:")) throw new Error("CDP discovery returned a non-loopback WebSocket");
          resolve(endpoint);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(2_000, () => request.destroy(new Error("CDP discovery timed out")));
    request.on("error", reject);
  });
}

export class VisibleBrowser {
  private readonly sessionId = randomUUID();
  private holder: "alpha" | "user" = "alpha";
  private emulatedViewport = false;
  private readonly consoleErrors: string[] = [];
  private readonly failedRequests: string[] = [];
  private snapshot = 0;
  private documentEpoch = 0;
  get documentIdentity(): string { return `${this.sessionId}:${this.documentEpoch}:${this.page.url()}`; }
  private refs = new Map<string, { frame: Frame; epoch: number; fingerprint: string }>();

  private constructor(private readonly browser: Browser, private readonly page: Page, private readonly scope: "preview" | "web") {
    page.on("framenavigated", () => { this.documentEpoch++; this.refs.clear(); });
    page.on("console", message => {
      if (message.type() === "error") this.consoleErrors.push(message.text());
    });
    page.on("pageerror", error => this.consoleErrors.push(error instanceof Error ? error.message : String(error)));
    page.on("requestfailed", request => {
      const reason = request.failure()?.errorText ?? "unknown";
      if (reason === "net::ERR_ABORTED" && new URL(request.url()).pathname.endsWith(".mp4")) return;
      this.failedRequests.push(`${request.method()} ${request.url()}: ${reason}`);
    });
  }

  static async connect(cdpUrl: string, target: string, exactTargetId = false, scope: "preview" | "web" = "preview"): Promise<VisibleBrowser> {
    const webSocket = await discoverBrowserWebSocket(cdpUrl);
    const browser = await puppeteer.connect({ browserWSEndpoint: webSocket, defaultViewport: null, protocolTimeout: 60_000 });
    try {
      const pages = await browser.pages();
      const matches = await Promise.all(pages.map(async page => {
        const session = await page.createCDPSession();
        try {
          const info = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
          return { page, title: await page.title(), url: page.url(), targetId: info.targetInfo?.targetId };
        } finally { await session.detach(); }
      }));
      const selected = matches.find(item => exactTargetId ? item.targetId === target : item.title.includes(target) || item.url.includes(target));
      if (!selected) throw new Error(`Visible target not found: ${target}`);
      return new VisibleBrowser(browser, selected.page, scope);
    } catch (error) {
      await browser.disconnect();
      throw error;
    }
  }

  takeOver(): void {
    this.holder = "user";
  }

  returnControl(): void {
    this.holder = "alpha";
  }

  async observe(): Promise<BrowserObservation> {
    this.snapshot++;
    const snapshot = this.snapshot;
    this.refs.clear();
    const main = this.page.mainFrame();
    const origin = (() => { try { return new URL(main.url()).origin; } catch { return ""; } })();
    const sameOrigin = (frame: Frame): boolean => {
      if (frame === main) return true;
      if (frame.url().startsWith("about:srcdoc")) return !!frame.parentFrame() && sameOrigin(frame.parentFrame()!);
      try { return new URL(frame.url()).origin === origin; } catch { return false; }
    };
    const frames = [main, ...this.page.frames().filter(frame => frame !== main && sameOrigin(frame))];
    const captures = await Promise.all(frames.map(async (frame, frameIndex) => {
      try {
        const content = await frame.evaluate(({ snapshot, frameIndex }) => {
          const selector = "button,input,textarea,select,a,[role=button],[role=link],[contenteditable=true]";
          const roots: Array<Document | ShadowRoot> = [document];
          const controls: Array<{ tag: string; id: string; name: string; label: string; text: string; role: string; disabled: boolean; ref: string }> = [];
          for (let rootIndex = 0; rootIndex < roots.length && rootIndex < 30; rootIndex++) {
            const root = roots[rootIndex];
            for (const element of root.querySelectorAll(selector)) {
              if (controls.length >= 120) break;
              if (!element.checkVisibility({ checkVisibilityCSS: true })) continue;
              const ref = `e${snapshot}-${frameIndex}-${controls.length + 1}`;
              element.setAttribute("data-alpha-target", `alpha-ref-${ref}`);
              controls.push({ tag: element.tagName.toLowerCase(), id: element.id, name: element.getAttribute("name") ?? "", label: element.getAttribute("aria-label") ?? "", text: (element.textContent ?? "").trim().slice(0, 160), role: element.getAttribute("role") ?? element.tagName.toLowerCase(), disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true", ref });
            }
            for (const element of root.querySelectorAll("*")) if (element.shadowRoot) roots.push(element.shadowRoot);
          }
          const values = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")]
            .filter(element => element.checkVisibility({ checkVisibilityCSS: true }) && !(element instanceof HTMLInputElement && ["password", "hidden", "file"].includes(element.type)))
            .map(element => element.value).filter(Boolean);
          return { text: [document.body?.innerText ?? "", ...roots.slice(1).map(root => root.textContent ?? ""), ...values].join("\n").slice(0, 12_000), controls };
        }, { snapshot, frameIndex });
        return { frame, content };
      } catch { return null; }
    }));
    const controls = captures.flatMap(capture => capture ? capture.content.controls.map(control => {
      this.refs.set(control.ref, { frame: capture.frame, epoch: this.documentEpoch, fingerprint: JSON.stringify([control.tag, control.id, control.name, control.label, control.text]) });
      return { ...control, frame: capture.frame.url() };
    }) : []).slice(0, 200);
    const content = await this.page.evaluate(() => ({
      viewport: { width: window.innerWidth, height: window.innerHeight, horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth },
      brokenImages: [...document.images].filter(image => image.complete && image.naturalWidth === 0).map(image => image.currentSrc || image.src).slice(0, 20),
    }));
    return {
      title: await this.page.title(),
      url: this.page.url(),
      ...content,
      text: captures.map(capture => capture?.content.text ?? "").filter(Boolean).join("\n").slice(0, 12_000),
      controls,
      snapshotId: `${this.documentEpoch}:${this.snapshot}`,
      consoleErrors: this.consoleErrors.slice(-50),
      failedRequests: this.failedRequests.slice(-50),
    };
  }

  async navigate(url: string): Promise<BrowserObservation> {
    this.assertAlpha();
    if (this.scope === "preview") assertLoopback(url);
    else await assertPublicWebUrl(url);
    await this.page.goto(url, { waitUntil: "load", timeout: 10_000 });
    return this.observe();
  }

  async click(selector: string): Promise<BrowserObservation> {
    this.assertAlpha();
    const resolved = await this.resolve(selector);
    const handle = await resolved.frame.$(resolved.selector);
    if (!handle) throw new Error("Element disappeared before click");
    await handle.evaluate(element => {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) throw new Error(`Element is not visible: ${element.tagName}`);
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const root = element.getRootNode();
      const hit = root instanceof ShadowRoot ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
      if (!rect.width || !rect.height || !hit || (hit !== element && !element.contains(hit))) throw new Error(`Element is obscured: ${element.tagName}`);
      if (!(element instanceof HTMLElement)) throw new Error(`Element cannot be clicked: ${element.tagName}`);
    });
    const box = await handle.boundingBox();
    if (!box) throw new Error("Element has no clickable bounds");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.bringToFront();
    // Move first so Chromium routes the following click into the embedded WebContentsView.
    await this.page.mouse.move(x, y);
    await new Promise(resolve => setTimeout(resolve, 50));
    await this.page.mouse.click(x, y);
    return this.observe();
  }

  async fill(selector: string, value: string): Promise<BrowserObservation> {
    this.assertAlpha();
    const resolved = await this.resolve(selector);
    const handle = await resolved.frame.$(resolved.selector);
    if (!handle) throw new Error("Fill control disappeared");
    await handle.evaluate((element, nextValue) => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("Fill requires a text control");
      if (element.disabled || element.readOnly || !element.checkVisibility({ checkVisibilityCSS: true })) throw new Error("Fill control is unavailable");
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const root = element.getRootNode();
      const hit = root instanceof ShadowRoot ? root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!rect.width || !rect.height || hit !== element) throw new Error("Fill control is obscured");
      if (nextValue.length > 10_000) throw new Error("Fill value is too long");
    }, value);
    const box = await handle.boundingBox();
    if (!box) throw new Error("Fill control has no bounds");
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("A");
    await this.page.keyboard.up("Control");
    await this.page.keyboard.type(value);
    if (await handle.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : null) !== value) throw new Error("Fill did not produce the expected value");
    return this.observe();
  }

  async select(selector: string, value: string): Promise<BrowserObservation> {
    this.assertAlpha();
    const resolved = await this.resolve(selector);
    const selected = await resolved.frame.select(resolved.selector, value);
    if (!selected.includes(value)) throw new Error(`Option not found: ${value}`);
    return this.observe();
  }

  async press(selector: string, key: string): Promise<BrowserObservation> {
    this.assertAlpha();
    if (!/^[A-Za-z0-9+]{1,40}$/.test(key)) throw new Error("Invalid keyboard key");
    const resolved = await this.resolve(selector);
    await resolved.frame.focus(resolved.selector);
    await this.page.keyboard.press(key as KeyInput);
    return this.observe();
  }

  async scroll(distance: number): Promise<BrowserObservation> {
    this.assertAlpha();
    if (!Number.isFinite(distance) || Math.abs(distance) > 2000) throw new Error("Scroll distance is out of range");
    await this.page.evaluate(amount => window.scrollBy({ top: amount, behavior: "auto" }), distance);
    return this.observe();
  }

  async wait(selector: string): Promise<BrowserObservation> {
    this.assertAlpha();
    if (/^e\d+-\d+(?:-\d+)?$/.test(selector)) throw new Error("Wait requires a CSS selector; observe again for a fresh element reference");
    await this.page.waitForSelector(selector, { visible: true, timeout: 10_000 });
    return this.observe();
  }

  async upload(selector: string, filePath: string): Promise<BrowserObservation> {
    this.assertAlpha();
    const resolved = await this.resolve(selector);
    const input = await resolved.frame.$(resolved.selector) as ElementHandle<HTMLInputElement> | null;
    if (!input || !await input.evaluate(element => element instanceof HTMLInputElement && element.type === "file")) throw new Error("Upload requires a file input");
    await input.uploadFile(filePath);
    return this.observe();
  }

  async download(selector: string, directory: string): Promise<{ observation: BrowserObservation; filePath: string; sha256: string; bytes: number }> {
    this.assertAlpha();
    await mkdir(directory, { recursive: true });
    const session = await this.page.createCDPSession();
    try {
      await session.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
      await this.click(selector);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const names = await readdir(directory);
        const finished = names.find(name => !name.endsWith(".crdownload") && !name.endsWith(".tmp"));
        if (finished) {
          const filePath = join(directory, finished);
          const first = await stat(filePath);
          if (first.size > 50_000_000) throw new Error("Browser download exceeds 50 MB");
          await new Promise(resolve => setTimeout(resolve, 100));
          const second = await stat(filePath);
          if (first.size === second.size && second.isFile()) {
            const body = await readFile(filePath);
            return { observation: await this.observe(), filePath, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Browser download did not finish within 15 seconds");
    } finally {
      await session.send("Page.setDownloadBehavior", { behavior: "default" }).catch(() => undefined);
      await session.detach();
    }
  }

  async viewport(width: number, height: number): Promise<BrowserObservation> {
    this.assertAlpha();
    if (width < 240 || height < 240 || width > 3000 || height > 3000) throw new Error("Viewport is out of range");
    await this.page.setViewport({ width, height, deviceScaleFactor: 1 });
    this.emulatedViewport = true;
    return this.observe();
  }

  async contrast(selector: string): Promise<{ foreground: string; background: string; ratio: number }> {
    const colors = await this.page.$eval(selector, element => {
      const style = getComputedStyle(element);
      let parent: Element | null = element;
      let background = "rgb(255, 255, 255)";
      while (parent) {
        const candidate = getComputedStyle(parent).backgroundColor;
        if (candidate !== "transparent" && !candidate.endsWith(", 0)")) {
          background = candidate;
          break;
        }
        parent = parent.parentElement;
      }
      return { foreground: style.color, background };
    });
    const luminance = (color: string): number => {
      const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!values || values.length !== 3) throw new Error(`Cannot measure color: ${color}`);
      const channels = values.map(value => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(colors.foreground);
    const background = luminance(colors.background);
    return { ...colors, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
  }

  async textOf(selector: string): Promise<string | null> {
    return this.page.evaluate(selector => {
      const element = document.querySelector(selector);
      if (!element?.checkVisibility({ checkVisibilityCSS: true })) return null;
      const controls = [element, ...element.querySelectorAll("input,textarea,select")]
        .filter(control => control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)
        .filter(control => control.checkVisibility({ checkVisibilityCSS: true }) && !(control instanceof HTMLInputElement && ["password", "hidden", "file"].includes(control.type)))
        .map(control => control.value).filter(Boolean);
      return [element instanceof HTMLElement ? element.innerText : element.textContent ?? "", ...controls].join("\n");
    }, selector);
  }

  async valueOf(selector: string): Promise<string | null> {
    return this.page.evaluate(selector => {
      const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
      return element?.checkVisibility({ checkVisibilityCSS: true }) && "value" in element ? element.value : null;
    }, selector);
  }

  async videoFrames(selector: string): Promise<{ duration: number; width: number; height: number; frames: string[] }> {
    this.assertAlpha();
    return this.page.$eval(selector, async element => {
      if (!(element instanceof HTMLVideoElement)) throw new Error("Video frame selector must target a video element");
      if (element.readyState < 1) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Video metadata timed out")), 10_000);
        element.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
        element.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Video metadata failed to load")); }, { once: true });
        element.load();
      });
      if (element.error || !Number.isFinite(element.duration) || element.duration <= 0 || !element.videoWidth || !element.videoHeight) throw new Error("Video has no decodable duration or dimensions");
      const duration = element.duration;
      const width = element.videoWidth;
      const height = element.videoHeight;
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(width, 960);
      canvas.height = Math.round(canvas.width * height / width);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Video canvas is unavailable");
      const frames: string[] = [];
      for (const time of [0.1, duration / 2, Math.max(0.1, duration - 0.2)]) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Video seek timed out")), 10_000);
          element.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
          element.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Video seek failed")); }, { once: true });
          element.currentTime = Math.min(time, Math.max(0, duration - 0.05));
        });
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/png").split(",", 2)[1]);
      }
      element.pause();
      return { duration, width, height, frames };
    });
  }

  async screenshot(path: string): Promise<BrowserObservation> {
    this.assertAlpha();
    await this.page.evaluate(() => window.scrollTo(0, 0));
    const image = await this.page.screenshot({ type: "png", fullPage: true });
    await writeFile(path, image);
    return this.observe();
  }

  async disconnect(): Promise<void> {
    // The preview is also what the user sees; hand it back at the pane's real size rather than a narrow test viewport.
    if (this.emulatedViewport) await this.page.setViewport(null).catch(() => undefined);
    await this.browser.disconnect();
  }

  private assertAlpha(): void {
    if (this.holder !== "alpha") throw new Error("User controls the preview; Alpha must wait for returnControl");
  }

  private async resolve(selector: string): Promise<{ frame: Frame; selector: string }> {
    const item = this.refs.get(selector);
    if (!item) {
      if (/^e\d+-\d+(?:-\d+)?$/.test(selector)) throw new Error("Element reference is stale; observe again");
      const matches = await this.page.$$(selector);
      if (matches.length !== 1) throw new Error(`Selector must match exactly one element; matched ${matches.length}`);
      return { frame: this.page.mainFrame(), selector };
    }
    if (item.epoch !== this.documentEpoch) throw new Error("Element reference is stale after navigation");
    const resolved = `pierce/[data-alpha-target="alpha-ref-${selector}"]`;
    const target = await item.frame.$(resolved);
    if (!target) throw new Error("Element reference is stale; observe again");
    const same = await target.evaluate(element => JSON.stringify([element.tagName.toLowerCase(), element.id, element.getAttribute("name") ?? "", element.getAttribute("aria-label") ?? "", (element.textContent ?? "").trim().slice(0, 160)]));
    if (same !== item.fingerprint) throw new Error("Element changed since observation; observe again");
    return { frame: item.frame, selector: resolved };
  }
}
