import { writeFile } from "node:fs/promises";
import { get } from "node:http";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

export interface BrowserObservation {
  title: string;
  url: string;
  text: string;
  controls: Array<{ tag: string; id: string; name: string; label: string; text: string }>;
  consoleErrors: string[];
  failedRequests: string[];
  brokenImages: string[];
  viewport: { width: number; height: number; horizontalOverflow: boolean };
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
  private holder: "alpha" | "user" = "alpha";
  private readonly consoleErrors: string[] = [];
  private readonly failedRequests: string[] = [];

  private constructor(private readonly browser: Browser, private readonly page: Page) {
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

  static async connect(cdpUrl: string, target: string): Promise<VisibleBrowser> {
    const webSocket = await discoverBrowserWebSocket(cdpUrl);
    const browser = await puppeteer.connect({ browserWSEndpoint: webSocket, defaultViewport: null, protocolTimeout: 60_000 });
    try {
      const pages = await browser.pages();
      const matches = await Promise.all(pages.map(async page => ({ page, title: await page.title(), url: page.url() })));
      const selected = matches.find(item => item.title.includes(target) || item.url.includes(target));
      if (!selected) throw new Error(`Visible target not found: ${target}`);
      return new VisibleBrowser(browser, selected.page);
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
    const content = await this.page.evaluate(() => ({
      text: [document.body?.innerText ?? "", ...[...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")]
        .filter(element => element.checkVisibility({ checkVisibilityCSS: true }) && !(element instanceof HTMLInputElement && ["password", "hidden", "file"].includes(element.type)))
        .map(element => element.value).filter(Boolean)].join("\n").slice(0, 12_000),
      controls: [...document.querySelectorAll("button,input,textarea,select,a")].slice(0, 100).map(element => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        name: element.getAttribute("name") ?? "",
        label: element.getAttribute("aria-label") ?? "",
        text: (element.textContent ?? "").trim().slice(0, 160),
      })),
      viewport: { width: window.innerWidth, height: window.innerHeight, horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth },
      brokenImages: [...document.images].filter(image => image.complete && image.naturalWidth === 0).map(image => image.currentSrc || image.src).slice(0, 20),
    }));
    return {
      title: await this.page.title(),
      url: this.page.url(),
      ...content,
      consoleErrors: this.consoleErrors.slice(-50),
      failedRequests: this.failedRequests.slice(-50),
    };
  }

  async navigate(url: string): Promise<BrowserObservation> {
    this.assertAlpha();
    assertLoopback(url);
    await this.page.goto(url, { waitUntil: "load", timeout: 10_000 });
    return this.observe();
  }

  async click(selector: string): Promise<BrowserObservation> {
    this.assertAlpha();
    await this.page.$eval(selector, element => {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) throw new Error(`Element is not visible: ${element.tagName}`);
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!rect.width || !rect.height || !hit || (hit !== element && !element.contains(hit))) throw new Error(`Element is obscured: ${element.tagName}`);
      if (!(element instanceof HTMLElement)) throw new Error(`Element cannot be clicked: ${element.tagName}`);
      element.click();
    });
    return this.observe();
  }

  async fill(selector: string, value: string): Promise<BrowserObservation> {
    this.assertAlpha();
    await this.page.$eval(selector, (element, nextValue) => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("Fill requires a text control");
      if (element.disabled || element.readOnly || !element.checkVisibility({ checkVisibilityCSS: true })) throw new Error("Fill control is unavailable");
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!rect.width || !rect.height || hit !== element) throw new Error("Fill control is obscured");
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (!setter) throw new Error("Fill control has no value setter");
      element.focus();
      setter.call(element, nextValue);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    return this.observe();
  }

  async select(selector: string, value: string): Promise<BrowserObservation> {
    this.assertAlpha();
    const selected = await this.page.select(selector, value);
    if (!selected.includes(value)) throw new Error(`Option not found: ${value}`);
    return this.observe();
  }

  async viewport(width: number, height: number): Promise<BrowserObservation> {
    this.assertAlpha();
    if (width < 240 || height < 240 || width > 3000 || height > 3000) throw new Error("Viewport is out of range");
    await this.page.setViewport({ width, height, deviceScaleFactor: 1 });
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
    await this.browser.disconnect();
  }

  private assertAlpha(): void {
    if (this.holder !== "alpha") throw new Error("User controls the preview; Alpha must wait for returnControl");
  }
}
