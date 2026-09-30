/** Real Electron renderer against an isolated Alpha sidecar (probe-workbench-ui). */
const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const url = process.env.ALPHA_PREVIEW_URL;
if (!url || !process.env.ALPHA_EVIDENCE_DIR) throw new Error("ALPHA_PREVIEW_URL and ALPHA_EVIDENCE_DIR required");
const evidence = path.resolve(process.env.ALPHA_EVIDENCE_DIR);
mkdirSync(evidence, { recursive: true });
app.setPath("userData", path.join(evidence, "electron-profile"));
let window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
  const page = window.webContents;
  page.setBackgroundThrottling(false);
  const failures = [];
  page.on("console-message", event => { if (event.level === "error") failures.push(event.message); });
  const evaluate = code => page.executeJavaScript(code);
  async function until(code) { for (let attempt = 0; attempt < 900; attempt++) { if (await evaluate(code)) return; if (attempt % 100 === 0) writeFileSync(path.join(evidence, "extension-ui-progress.txt"), code + "\n" + await evaluate("document.body.innerText.slice(0, 1000)")); await pause(100); } throw new Error("UI condition timed out: " + code); }
  const click = text => evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)}); if (!node) throw new Error('Missing button: ' + ${JSON.stringify(text)}); node.click(); })()`);
  try {
    await page.loadURL(url);
    await until("document.querySelector('.native-sidebar') && [...document.querySelectorAll('button')].some(node => node.textContent.includes('产品体验验证'))");
    await evaluate("[...document.querySelectorAll('button')].find(node => node.textContent.includes('产品体验验证')).click()");
    await until("document.querySelector('[data-testid=\"composer\"]')");
    await evaluate("document.querySelector('button[aria-label=\"设置\"]').click()");
    await click("技能");
    await until("document.querySelector('input[aria-label=\"搜索技能\"]') && document.querySelector('.native-extension-row')");
    const skillCount = await evaluate("document.querySelectorAll('.native-extension-row').length");
    if (skillCount < 30) throw new Error("Bundled runtime skills missing");
    const firstSkill = await evaluate("document.querySelector('.native-extension-row button').textContent");
    await click(firstSkill);
    await until("document.querySelector('textarea[aria-label=\"扩展内容\"]')?.value.includes('---')");
    await until("document.querySelectorAll('.native-extension-row').length === 1 && document.querySelector('input[aria-label=\"扩展名称\"]').value.length > 0 && !document.querySelector('.native-extension-row button').disabled");
    await pause(300);
    writeFileSync(path.join(evidence, "skills-dom.txt"), await evaluate("document.body.innerText"));
    writeFileSync(path.join(evidence, "skills-electron.png"), (await page.capturePage()).toPNG());
    await click("MCP");
    await until("document.querySelector('input[aria-label=\"搜索MCP\"]')");
    await click("刷新状态");
    await until("document.querySelector('button').disabled === false");
    writeFileSync(path.join(evidence, "mcp-electron.png"), (await page.capturePage()).toPNG());
    await click("插件");
    await until("[...document.querySelectorAll('.native-extension-row')].some(node => node.textContent.includes('Alpha'))");
    writeFileSync(path.join(evidence, "plugins-electron.png"), (await page.capturePage()).toPNG());
    const overflow = await evaluate("document.documentElement.scrollWidth > innerWidth");
    if (overflow) throw new Error("Renderer horizontal overflow");
    writeFileSync(path.join(evidence, "extension-ui-result.json"), JSON.stringify({ runtime: process.versions.electron, skillCount, firstSkill, overflow, failures, status: "passed" }, null, 2));
    console.log("ALPHA_EXTENSION_UI_OK"); app.exit(0);
  } catch (error) { writeFileSync(path.join(evidence, "extension-ui-error.txt"), String(error.stack ?? error)); console.error(error); app.exit(1); }
});
