/** Diagnostic probe: real Alpha Electron host + installed OMP; isolated local pages and profile. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { officeDocumentPdf, officeRuntimeStatus } from "../../../src/native/capabilities/office/office-runtime";

const root = resolve(import.meta.dir, "../../..");
const childMode = process.argv.includes("--second-session");
const temp = childMode ? process.argv[process.argv.indexOf("--temp") + 1] : await mkdtemp(join(tmpdir(), "alpha-browser-office-audit-"));
const makeSession = (cdp: string): ToolSession => ({ cwd: temp, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings: Settings.isolated({ "browser.enabled": true, "browser.cdpUrl": cdp, "browser.cmux": false, "browser.relay": false, "tools.maxTimeout": 0 }) });
const makeDriver = (cdp: string, name: string) => {
  const session = makeSession(cdp);
  const prelude = createBrowserPrelude(session);
  const invoke = (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: name });
  const call = async (method: string, args: unknown[] = []) => (await invoke({ action: "call", name, chain: [{ method, args }], timeout: 8 })).details?.value;
  const run = async (code: string) => (await invoke({ action: "run", name, code, timeout: 8 })).details?.value;
  const open = (url: string) => invoke({ action: "open", name, url, timeout: 20 });
  return { invoke, call, run, open };
};
if (childMode) {
  const driver = makeDriver(process.argv[process.argv.indexOf("--cdp") + 1], "second-session");
  try { await driver.open(process.argv[process.argv.indexOf("--url") + 1]); console.log(JSON.stringify({ tabs: (await driver.invoke({ action: "tabs" })).details?.value })); }
  finally { await releaseAllTabs({ kill: false }); await disposeAllVmContexts(); }
  process.exit(0);
}

const html = `<!doctype html><meta charset="utf-8"><title>Alpha isolated browser audit</title>
<style>body{font:16px sans-serif;padding:20px}button{display:block;padding:14px;margin:12px}.duplicate{display:inline-block}#covered{position:fixed;right:20px;top:20px;width:130px;height:50px}#overlay{position:fixed;right:20px;top:20px;width:130px;height:50px;background:#ccd;z-index:9}iframe{display:block;margin-top:30px;width:500px;height:130px}</style>
<button id="normal">Normal</button><button id="disabled" disabled>Disabled</button><button id="covered">Covered</button><div id="overlay"></div>
<button id="stale">Stale target</button><button class="duplicate">First duplicate</button><button class="duplicate">Second duplicate</button>
<button id="moving">Moving target</button><input id="input"><a id="popup" target="_blank" href="/popup">New window</a><output id="result"></output>
<iframe src="/frame"></iframe><script>window.audit={normal:0,disabled:0,covered:0,stale:0,duplicate:[],moving:0,trusted:[]};for(const id of ['normal','disabled','covered','stale','moving'])document.getElementById(id).addEventListener('click',e=>{audit[id]++;audit.trusted.push(e.isTrusted);document.getElementById('result').textContent=JSON.stringify(audit)});document.querySelectorAll('.duplicate').forEach((b,i)=>b.onclick=()=>audit.duplicate.push(i));</script>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { const path = new URL(request.url).pathname; return new Response(path === "/frame" ? '<button id="inside" onclick="this.dataset.clicked=\'yes\'">Frame target</button>' : path === "/second" ? '<title>Second session</title><p>Second session changed this page</p>' : html, { headers: { "content-type": "text/html; charset=utf-8" } }); } });
const env = { ...process.env, ALPHA_WORKSPACE_ROOT: temp };
delete env.ELECTRON_RUN_AS_NODE;
let hostSource = join(root, "desktop/browser-host.cjs");
if (process.argv.includes("--single-view")) { hostSource = join(temp, "browser-host-single-view.cjs"); await writeFile(hostSource, (await readFile(join(root, "desktop/browser-host.cjs"), "utf8")).replace("const PAGE_COUNT = 3;", "const PAGE_COUNT = 1;")); }
const host = spawn(join(root, "node_modules/electron/dist/electron.exe"), [hostSource], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let control: ReturnType<typeof connect> | undefined;
const observations: Record<string, unknown> = { sourceHead: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(), runtimeDirectory: temp };
const capture = async (name: string, action: () => Promise<unknown>) => { try { observations[name] = { returned: await action() ?? null }; } catch (error) { observations[name] = { error: String(error) }; } console.log(name, JSON.stringify(observations[name])); };
try {
  const ready = await new Promise<{ cdp: number; control: number }>((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Alpha browser host startup timeout")), 25_000);
    host.once("exit", code => { clearTimeout(timeout); reject(new Error(`Host exited before ready: ${code}`)); });
    host.stdout.on("data", chunk => { output += String(chunk); const match = /ALPHA_BROWSER_HOST_READY (\d+) (\d+)/.exec(output); if (match) { clearTimeout(timeout); resolveReady({ cdp: Number(match[1]), control: Number(match[2]) }); } });
    host.stderr.on("data", chunk => writeFile(join(temp, "host-stderr.log"), String(chunk), { flag: "a" }));
  });
  control = connect({ host: "127.0.0.1", port: ready.control });
  await once(control, "connect");
  const cdp = `http://127.0.0.1:${ready.cdp}`;
  observations.chromium = await (await fetch(`${cdp}/json/version`)).json();
  const driver = makeDriver(cdp, "primary-session");
  await driver.open(`${server.url}main`);
  await capture("normalClick", async () => { await driver.call("click", ["#normal"]); return driver.call("evaluate", ["audit"]); });
  await capture("coveredClick", async () => { await driver.call("click", ["#covered"]); return driver.call("evaluate", ["audit.covered"]); });
  await capture("disabledClick", async () => { await driver.call("click", ["#disabled"]); return driver.call("evaluate", ["audit.disabled"]); });
  await capture("duplicateSelector", async () => { await driver.call("evaluate", ["document.querySelector('#overlay').remove();document.querySelector('#covered').remove()"]); await driver.call("click", [".duplicate"]); return driver.call("evaluate", ["audit.duplicate"]); });
  await capture("movingElement", async () => { await driver.call("evaluate", ["document.getElementById('moving').animate([{transform:'translateX(0px)'},{transform:'translateX(100px)'}],{duration:600,fill:'forwards'})"]); await driver.call("click", ["#moving"]); return driver.call("evaluate", ["audit.moving"]); });
  await capture("iframeClick", () => driver.run("const f=await tab.frame('iframe'); await f.click('#inside'); return await f.attr('#inside','data-clicked');"));
  await capture("staleHandle", () => driver.run("const o=await tab.observe(); const target=o.elements.find(e=>e.name==='Stale target'); if(!target)throw Error('Probe target missing'); await tab.evaluate(\"document.querySelector('#stale').remove()\"); await (await tab.id(target.id)).click(); return 'clicked';"));
  await capture("ariaClick", () => driver.run("const snapshot=await tab.ariaSnapshot(); const ref=/button \\\"Normal\\\".*?\\[ref=(e\\d+)\\]/.exec(snapshot)?.[1]; if(!ref)return {snapshot}; await (await tab.ref(ref)).click(); return await tab.evaluate('audit.normal');"));
  await capture("coordinateClick", async () => { const box = await driver.call("box", ["#normal"]) as { x: number; y: number; width: number; height: number }; await driver.call("clickAt", [box.x + box.width / 2, box.y + box.height / 2]); return driver.call("evaluate", ["audit.normal"]); });
  await capture("popupLink", async () => { const before = await (await fetch(`${cdp}/json/list`)).json() as unknown[]; await driver.call("click", ["#popup"]); await Bun.sleep(300); const after = await (await fetch(`${cdp}/json/list`)).json() as unknown[]; return { before: before.length, after: after.length, currentUrl: await driver.call("url") }; });
  observations.primaryTabs = (await driver.invoke({ action: "tabs" })).details?.value;
  await capture("pagesVisibility", () => driver.run("return await Promise.all((await browser.pages()).map(async p=>({url:p.url(),state:await p.evaluate('document.visibilityState')})));"));
  const screencastClick = () => driver.run("const c=await page.createCDPSession();let frames=0;c.on('Page.screencastFrame',f=>{frames++;void c.send('Page.screencastFrameAck',{sessionId:f.sessionId});});await c.send('Page.startScreencast',{format:'jpeg',quality:70,maxWidth:1280,maxHeight:1280});await tab.click('#normal');await new Promise(r=>setTimeout(r,400));await c.send('Page.stopScreencast');await c.detach();return {frames,audit:await tab.evaluate('audit')};");
  await capture("screencastBeforeActivation", screencastClick);
  await capture("afterCdpBringToFront", async () => { await driver.run("await page.bringToFront();"); await driver.call("click", ["#normal"]); return driver.call("evaluate", ["({audit,state:document.visibilityState,focused:document.hasFocus()})"]); });
  await capture("afterNativeTargetActivation", async () => {
    const targetId = (observations.primaryTabs as Array<{ targetId: string }>)[0].targetId;
    control!.write(`${JSON.stringify({ op: "show", x: -31000, y: -31000, width: 1280, height: 800, targetId })}\n`);
    await Bun.sleep(250); control!.write('{"op":"hide"}\n'); await Bun.sleep(250);
    await driver.call("click", ["#normal"]); await Bun.sleep(100);
    await driver.call("fill", ["#input", "keyboard input"]);
    return driver.call("evaluate", ["({audit,input:document.querySelector('#input').value})"]);
  });
  await capture("screencastAndClick", screencastClick);
  await capture("secondProcess", async () => {
    const result = await Bun.$`${process.execPath} ${import.meta.filename} --second-session --cdp ${cdp} --temp ${temp} --url ${`${server.url}second`}`.quiet();
    return { stdout: result.stdout.toString().trim(), primaryUrlAfterSecondSession: await driver.call("url") };
  });
  await capture("viewportAndHandback", async () => {
    const before = await driver.call("evaluate", ["({url:location.href,width:innerWidth,height:innerHeight})"]);
    control!.write(`${JSON.stringify({ op: "show", x: -31000, y: -31000, width: 640, height: 480 })}\n`);
    await Bun.sleep(250);
    const resized = await driver.call("evaluate", ["({url:location.href,width:innerWidth,height:innerHeight})"]);
    control!.write('{"op":"hide"}\n'); await Bun.sleep(250);
    return { before, resized, after: await driver.call("evaluate", ["({url:location.href,width:innerWidth,height:innerHeight})"]) };
  });
  await capture("eachNativeView", async () => {
    const urls = await driver.run(`const pages=await browser.pages();const urls=[];for(let i=0;i<pages.length;i++){const url=${JSON.stringify(server.url.href)}+'view-'+i;await pages[i].goto(url);urls.push(url);}return urls;`) as string[];
    const results = [];
    for (let index = 0; index < urls.length; index++) {
      const name = `view-${index}`; const viewDriver = makeDriver(cdp, name);
      await viewDriver.invoke({ action: "open", name, app: { target: urls[index] }, timeout: 20 });
      const tabs = (await viewDriver.invoke({ action: "tabs" })).details?.value as Array<{ name: string; targetId: string }>;
      const targetId = tabs.find(tab => tab.name === name)!.targetId;
      await viewDriver.call("click", ["#normal"]); const before = await viewDriver.call("evaluate", ["audit.normal"]);
      await viewDriver.run("await page.bringToFront();"); await viewDriver.call("click", ["#normal"]);
      const afterCdp = await viewDriver.call("evaluate", ["audit.normal"]);
      control!.write(`${JSON.stringify({ op: "show", x: -31000, y: -31000, width: 1280, height: 800, targetId })}\n`);
      await Bun.sleep(150); control!.write('{"op":"hide"}\n'); await Bun.sleep(150);
      await viewDriver.call("click", ["#normal"]); const afterNative = await viewDriver.call("evaluate", ["audit.normal"]);
      results.push({ index, targetId, before, afterCdp, afterNative });
    }
    return results;
  });
  await capture("officePreview", async () => {
    const path = join(temp, "office-structure.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Visible", { pageSetup: { printArea: "A1:B2" } });
    sheet.getCell("A1").value = "VISIBLE_PRINT_AREA";
    sheet.getCell("A2").value = 7; sheet.getCell("B2").value = { formula: "A2*3", result: 21 };
    sheet.getCell("B2").note = "FORMULA_REVIEW_COMMENT";
    sheet.getCell("A20").value = "OUTSIDE_PRINT_AREA";
    const hidden = workbook.addWorksheet("Hidden", { state: "hidden" }); hidden.getCell("A1").value = "HIDDEN_SHEET_CONTENT";
    await workbook.xlsx.writeFile(path);
    const hash = async () => new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");
    const originalHash = await hash(); const pdf = await officeDocumentPdf(path);
    const document = await getDocument({ data: pdf, useSystemFonts: true }).promise;
    let text = "";
    for (let page = 1; page <= document.numPages; page++) text += (await (await document.getPage(page)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
    const result = { engine: await officeRuntimeStatus(), originalUnchanged: originalHash === await hash(), pdfPages: document.numPages, text, hiddenSheetVisible: text.includes("HIDDEN_SHEET_CONTENT"), outsidePrintAreaVisible: text.includes("OUTSIDE_PRINT_AREA"), commentVisible: text.includes("FORMULA_REVIEW_COMMENT") };
    await document.destroy(); return result;
  });
} catch (error) { observations.probeFailure = String(error); process.exitCode = 1; }
finally {
  await releaseAllTabs({ kill: false }).catch(() => undefined); await disposeAllVmContexts().catch(() => undefined);
  control?.end('{"op":"quit"}\n'); server.stop(true);
  const exited = once(host, "exit").catch(() => undefined); const timeout = setTimeout(() => host.kill(), 3000); await exited; clearTimeout(timeout);
  const output = `observations-${process.argv.includes("--single-view") ? "single-view" : "three-views"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(join(import.meta.dir, output), `${JSON.stringify(observations, null, 2)}\n`);
  console.log("Observations:", join(import.meta.dir, output));
}
