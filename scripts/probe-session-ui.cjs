/** Electron renderer + production preload/storage against the isolated native fixture. */
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const url = process.env.ALPHA_PREVIEW_URL, evidence = path.resolve(process.env.ALPHA_EVIDENCE_DIR);
if (!url) throw new Error("ALPHA_PREVIEW_URL required");
mkdirSync(evidence, { recursive: true }); app.setPath("userData", path.join(evidence, "session-electron-profile"));
app.on("window-all-closed", () => {});
const storage = require("../desktop/state-storage.cjs").stateStorage(mkdtempSync(path.join(evidence, "session-storage-proof-")));
let window, page;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => page.executeJavaScript(code);
async function until(code) { for (let attempt = 0; attempt < 600; attempt++) { if (await evaluate(code)) return; await sleep(100); } throw new Error("UI timed out: " + code); }
const click = text => evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)}); if (!node) throw new Error('Missing: ' + ${JSON.stringify(text)}); node.click(); })()`);
const input = (selector, text) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(text)}); node.dispatchEvent(new Event('input', {bubbles:true})); })()`);
const open = async () => {
  window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { preload: path.resolve("desktop/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
  page = window.webContents; page.setBackgroundThrottling(false); await page.loadURL(url);
  await until("document.querySelector('.native-sidebar') && [...document.querySelectorAll('button')].some(node => node.textContent.includes('产品体验验证'))");
};
ipcMain.handle("alpha:server-token", () => new URL(url).searchParams.get("token"));
ipcMain.on("alpha:storage", (event, operation, key, value) => { try { event.returnValue = { value: storage[operation](key, value) }; } catch (error) { event.returnValue = { error: error.message }; } });
ipcMain.on("alpha:notify", () => {}); ipcMain.on("alpha:attention", () => {});
ipcMain.handle("alpha:browser-host-status", () => ({ available: false, reason: "Fixture has no browser host" }));
app.whenReady().then(async () => {
  const result = { runtime: process.versions.electron, storageRestart: false, commands: false, history: false, progress: false, review: false, closeDoesNotApprove: false, approveClear: false };
  try {
    await open(); await evaluate("[...document.querySelectorAll('button')].find(node => node.textContent.includes('产品体验验证')).click()");
    await until("document.querySelector('[data-testid=\"composer\"]') && !document.querySelector('.native-plan-bar button').disabled");
    await input('[data-testid="composer"]', "COLD_DRAFT_EVIDENCE");
    await evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))], 'draft-proof.png', {type:'image/png'})); document.querySelector('.native-compose').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true})); })()`);
    await until("document.querySelector('.native-attachments img')"); window.destroy(); await open();
    await until("document.querySelector('[data-testid=\"composer\"]')?.value === 'COLD_DRAFT_EVIDENCE' && document.querySelector('.native-attachments img') && !document.querySelector('.native-plan-bar button').disabled"); result.storageRestart = true;
    await evaluate("document.querySelector('button[aria-label=\"移除图片 draft-proof.png\"]').click()");
    await evaluate("document.querySelector('button[aria-label=\"命令面板\"]').click()");
    await until("document.querySelector('input[aria-label=\"搜索命令\"]') && document.querySelectorAll('.native-command-results button').length > 10"); result.commands = true;
    await evaluate("[...document.querySelectorAll('.native-command-results button')].find(node => node.textContent.includes('会话树与历史导航')).click()");
    await until("document.querySelector('input[aria-label=\"搜索历史\"]')"); result.history = true;
    await click("Todo / 子任务 / 队列"); await until("document.body.innerText.includes('消息队列')"); result.progress = true; await click("关闭");
    await click("进入计划"); await until("document.body.innerText.includes('审阅计划')");
    await input('[data-testid="composer"]', "验证计划"); await evaluate("document.querySelector('button[aria-label=\"发送\"]').click()");
    await until("document.querySelector('textarea[aria-label=\"计划正文\"]')?.value.includes('Plan UI proof')"); result.review = true;
    const edited = await evaluate("document.querySelector('textarea[aria-label=\"计划正文\"]').value");
    await input('textarea[aria-label="计划正文"]', edited + "\nUI_REVIEW_EDIT_EVIDENCE\n"); await click("保存修改");
    await until("!document.querySelector('textarea[aria-label=\"计划正文\"]').disabled");
    writeFileSync(path.join(evidence, "plan-review-electron.png"), (await page.capturePage()).toPNG());
    await click("关闭审阅"); await until("!document.querySelector('[aria-modal=\"true\"]') && document.querySelector('.native-plan-bar').textContent.includes('暂停计划')"); result.closeDoesNotApprove = true;
    await click("审阅计划"); await until("document.querySelector('textarea[aria-label=\"计划正文\"]')?.value.includes('UI_REVIEW_EDIT_EVIDENCE')");
    await click("批准并清空上下文执行"); await until("!document.querySelector('[aria-modal=\"true\"]') && document.querySelector('.native-plan-bar').textContent.includes('进入计划') && document.querySelectorAll('.native-session-row').length >= 4"); result.approveClear = true;
    await until("document.querySelector('.native-thread')?.textContent.includes('本机测试响应已完成') || document.querySelector('.native-main').textContent.includes('本机测试响应已完成')");
    writeFileSync(path.join(evidence, "session-electron.png"), (await page.capturePage()).toPNG());
    const errors = await evaluate("[...document.querySelectorAll('.native-error')].map(node => node.textContent)"); if (errors.length) throw new Error(errors.join("\n"));
    writeFileSync(path.join(evidence, "session-ui-result.json"), JSON.stringify({ ...result, status: "passed" }, null, 2)); console.log("ALPHA_SESSION_UI_OK"); app.exit(0);
  } catch (error) { writeFileSync(path.join(evidence, "session-ui-error.txt"), String(error.stack ?? error) + "\n" + await evaluate("document.body.innerText").catch(() => "")); console.error(error); app.exit(1); }
});
