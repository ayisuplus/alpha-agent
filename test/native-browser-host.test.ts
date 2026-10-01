import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

// Real Chromium proves target ownership and actual trusted DOM side effects.
const root = resolve(import.meta.dir, "..");
let host: ReturnType<typeof spawn>, control: ReturnType<typeof connect>, endpoint: string;
let workspace: string;
const browsers: Browser[] = [];
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html>
  <button id="click" onclick="count++;trusted=event.isTrusted">Click</button>
  <button id="disabled" disabled onclick="count++">Disabled</button>
  <a id="popup" target="_blank" href="/popup">Popup</a><input id="text">
  <script>window.count=0;window.trusted=false;</script>`, { headers: { "content-type": "text/html" } }) });

async function startHost(port = 0) {
  const env: NodeJS.ProcessEnv = { ...process.env, ALPHA_WORKSPACE_ROOT: workspace }; delete env.ELECTRON_RUN_AS_NODE;
  host = spawn(join(root, "node_modules/electron/dist/electron.exe"), [join(root, "desktop/browser-host.cjs"), "--cdp-port", String(port)], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const ready = await new Promise<{ cdp: number; control: number }>((resolveReady, reject) => {
    let output = "", errors = "";
    const timeout = setTimeout(() => reject(Error(`Browser startup timeout: ${errors}`)), 25_000);
    host.once("exit", code => { clearTimeout(timeout); reject(Error(`Browser exited ${code}: ${errors}`)); });
    host.stderr!.on("data", chunk => { errors += String(chunk); });
    host.stdout!.on("data", chunk => { output += String(chunk); const hit = /ALPHA_BROWSER_HOST_READY (\d+) (\d+)/.exec(output); if (hit) { clearTimeout(timeout); resolveReady({ cdp: Number(hit[1]), control: Number(hit[2]) }); } });
  });
  endpoint = `http://127.0.0.1:${ready.cdp}`;
  control = connect({ host: "127.0.0.1", port: ready.control }); await once(control, "connect");
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "alpha-browser-repair-"));
  await startHost();
}, 30_000);

afterAll(async () => {
  await releaseAllTabs({ kill: false }); await disposeAllVmContexts();
  await Promise.all(browsers.map(browser => browser.disconnect()));
  fixture.stop(true);
  if (host && host.exitCode === null) {
    const exited = once(host, "exit"); control?.end('{"op":"quit"}\n');
    const timeout = setTimeout(() => host.kill(), 3000); await exited; clearTimeout(timeout);
  }
});

async function owned(id: string) {
  const response = await fetch(`${endpoint}/sessions/${id}`, { method: "POST" });
  expect(response.status).toBe(200);
  const { cdpUrl } = await response.json() as { cdpUrl: string };
  const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
  browsers.push(browser); return browser;
}

async function rejects(operation: Promise<unknown>, reason: RegExp) {
  let rejected = "";
  try { await operation; } catch (error) { rejected = String(error); }
  expect(rejected).toMatch(reason);
}

test("sessions receive different pages and cannot attach another session's target", async () => {
  const a = await owned("session-a"), b = await owned("session-b");
  const [pa] = await a.pages(), [pb] = await b.pages();
  await pa!.goto(`${fixture.url}first`); await pb!.goto(`${fixture.url}second`);
  expect(pa!.url()).toBe(`${fixture.url}first`);
  expect(pb!.url()).toBe(`${fixture.url}second`);
  const cb = await pb!.createCDPSession();
  const target = (await cb.send("Target.getTargetInfo")).targetInfo.targetId;
  const ca = await pa!.createCDPSession();
  await rejects(ca.send("Target.attachToTarget", { targetId: target, flatten: true }), /owner|session/i);
  await ca.detach(); await cb.detach();
}, 30_000);

test("clicks reach each native view without manual takeover and disabled clicks reject", async () => {
  const a = await owned("click-a"), b = await owned("click-b");
  const [pa] = await a.pages(), [pb] = await b.pages();
  await pa!.goto(fixture.url.href); await pb!.goto(fixture.url.href);
  for (let index = 0; index < 5; index++) {
    await Promise.all([pa!.click("#click"), pb!.click("#click")]);
  }
  expect(await pa!.evaluate("({count,trusted})")).toEqual({ count: 5, trusted: true });
  expect(await pb!.evaluate("({count,trusted})")).toEqual({ count: 5, trusted: true });
  await rejects(pa!.click("#disabled"), /disabled/i);
  expect(await pa!.evaluate("count")).toBe(5);
}, 30_000);

test("new pages and popup links remain owned by their opener's session", async () => {
  const a = await owned("popup-a"), b = await owned("popup-b");
  const created = await a.newPage(); await created.goto(fixture.url.href);
  const popup = a.waitForTarget(target => target.url() === `${fixture.url}popup`, { timeout: 5000 }).catch(error => { throw error; });
  await created.click("#popup");
  expect((await popup).opener()).toBe(created.target());
  expect((await b.pages()).map(page => page.url())).not.toContain(`${fixture.url}popup`);
  const popupPage = await (await popup).page();
  await created.click("#click");
  expect(await created.evaluate("count")).toBe(1);
  const nested = a.waitForTarget(target => target.opener() === popupPage!.target(), { timeout: 1500 });
  void nested.catch(() => undefined);
  await popupPage!.click("#popup");
  expect((await nested).opener()).toBe(popupPage!.target());
  expect((await b.pages()).map(page => page.url())).not.toContain(`${fixture.url}popup`);
}, 30_000);

test("manual takeover blocks automated input until handback", async () => {
  const browser = await owned("takeover"); const [page] = await browser.pages(); await page!.goto(fixture.url.href);
  const session = await page!.createCDPSession(); const targetId = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  control.write(`${JSON.stringify({ op: "show", x: -31000, y: -31000, width: 640, height: 480, targetId })}\n`);
  await Bun.sleep(200);
  await rejects(page!.click("#click"), /takeover|manual/i);
  expect(await page!.evaluate("count")).toBe(0);
  control.write('{"op":"hide"}\n'); await Bun.sleep(200);
  await page!.click("#click"); expect(await page!.evaluate("count")).toBe(1);
  await session.detach();
}, 30_000);

test("the installed native OMP browser uses the owned endpoint for effective clicks and iframe input", async () => {
  const result = await fetch(`${endpoint}/sessions/omp-real`, { method: "POST" });
  const { cdpUrl } = await result.json() as { cdpUrl: string };
  const session = { cwd: root, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*",
    settings: Settings.isolated({ "browser.enabled": true, "browser.cdpUrl": cdpUrl, "browser.cmux": false, "browser.relay": false, "tools.maxTimeout": 0 }) } as ToolSession;
  const prelude = createBrowserPrelude(session), name = "omp-real";
  const invoke = (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: name });
  await invoke({ action: "open", name, url: fixture.url.href, timeout: 15 });
  const clicked = await invoke({ action: "run", name, code: "await tab.click('#click'); return await tab.evaluate('({count,trusted})');", timeout: 10 });
  expect((clicked.details as { value?: unknown } | undefined)?.value).toEqual({ count: 1, trusted: true });
  await rejects(invoke({ action: "run", name, code: "await tab.click('#disabled');", timeout: 5 }), /disabled/i);
  const frame = await invoke({ action: "run", name, code: `await tab.evaluate(\"document.body.insertAdjacentHTML('beforeend','<iframe src=\\\"${fixture.url}frame\\\"></iframe>')\"); await new Promise(r=>setTimeout(r,300)); const f=await tab.frame('iframe'); await f.click('#click'); return await f.evaluate('({count,trusted})');`, timeout: 10 });
  expect((frame.details as { value?: unknown } | undefined)?.value).toEqual({ count: 1, trusted: true });
}, 30_000);

test("native page screencasts continue after background clicks", async () => {
  const browser = await owned("frames"); const [page] = await browser.pages(); await page!.goto(fixture.url.href);
  const cdp = await page!.createCDPSession(); let frames = 0;
  cdp.on("Page.screencastFrame", frame => { frames++; void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  await page!.click("#click");
  await Bun.sleep(300); expect(frames).toBeGreaterThan(0);
  expect(await page!.evaluate("count")).toBe(1);
  await cdp.send("Page.stopScreencast"); await cdp.detach();
}, 15_000);

test("opening another view does not leave the previously active page's input underneath it", async () => {
  const browser = await owned("layer-change"); const [page] = await browser.pages(); await page!.goto(fixture.url.href);
  await page!.click("#click");
  const added = await browser.newPage(); await added.goto(fixture.url.href);
  await page!.click("#click");
  expect(await page!.evaluate("count")).toBe(2);
  await added.close();
  await page!.click("#click"); expect(await page!.evaluate("count")).toBe(3);
}, 15_000);

test("a rejected Chromium input does not strand another session's mouse", async () => {
  const a = await owned("input-error-a"), b = await owned("input-error-b");
  const [pa] = await a.pages(), [pb] = await b.pages(); await pa!.goto(fixture.url.href); await pb!.goto(fixture.url.href);
  const cdp = await pa!.createCDPSession();
  await rejects(cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 20, button: "invalid" } as never), /button|parameters/i);
  const click = pb!.click("#click"); void click.catch(() => undefined);
  await Promise.race([click, Bun.sleep(1500).then(() => { throw Error("Rejected input stranded the other session"); })]);
  expect(await pb!.evaluate("count")).toBe(1); await cdp.detach();
}, 10_000);

test("detaching an interrupted mouse gesture releases another session's input", async () => {
  const a = await owned("detach-a"), b = await owned("detach-b");
  const [pa] = await a.pages(), [pb] = await b.pages(); await pa!.goto(fixture.url.href); await pb!.goto(fixture.url.href);
  const cdp = await pa!.createCDPSession();
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 20, button: "left", clickCount: 1 });
  await cdp.detach();
  const click = pb!.click("#click"); void click.catch(() => undefined);
  await Promise.race([click, Bun.sleep(1500).then(() => { throw Error("Detached gesture stranded another session"); })]);
  expect(await pb!.evaluate("count")).toBe(1);
}, 10_000);

test("host restart preserves session endpoints and login profile while reopening only requested views", async () => {
  const response = await fetch(`${endpoint}/sessions/restart-a`, { method: "POST" });
  const { cdpUrl } = await response.json() as { cdpUrl: string };
  const browser = await owned("restart-a"); const [page] = await browser.pages();
  await page!.goto(fixture.url.href);
  await page!.setCookie({ name: "login", value: "shared-login", url: fixture.url.href, expires: Math.floor(Date.now() / 1000) + 3600 });
  await releaseAllTabs({ kill: false }); await disposeAllVmContexts();
  await Promise.all(browsers.map(item => item.disconnect()));
  const port = Number(new URL(endpoint).port), exited = once(host, "exit");
  control.end('{"op":"quit"}\n'); await exited;
  await startHost(port);
  expect(await (await fetch(`${endpoint}/json/list`)).json()).toEqual([]);
  const allocated = await (await fetch(`${endpoint}/sessions/restart-a`, { method: "POST" })).json() as { cdpUrl: string };
  expect(allocated.cdpUrl).toBe(cdpUrl);
  const restored = await owned("restart-a"), other = await owned("restart-b");
  const [ownPage] = await restored.pages(), [otherPage] = await other.pages();
  await ownPage!.goto(fixture.url.href); await otherPage!.goto(fixture.url.href);
  expect((await otherPage!.cookies()).some(cookie => cookie.name === "login" && cookie.value === "shared-login")).toBe(true);
  await Promise.all([ownPage!.click("#click"), otherPage!.click("#click")]);
  expect(await ownPage!.evaluate("count")).toBe(1);
  expect(await otherPage!.evaluate("count")).toBe(1);
}, 30_000);
