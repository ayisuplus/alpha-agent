/** Electron UI proof against real native OMP/worktree/search/PTY/snapshot routes. */
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const fixture = JSON.parse(readFileSync(process.env.ALPHA_FIXTURE_STARTUP, "utf8"));
const url = `http://127.0.0.1:${fixture.port}/ui/`, evidence = path.resolve(process.env.ALPHA_EVIDENCE_DIR);
mkdirSync(evidence, { recursive: true }); app.setPath("userData", path.join(evidence, "project-electron-profile"));
const storage = require("../desktop/state-storage.cjs").stateStorage(mkdtempSync(path.join(evidence, "project-storage-proof-")));
let window, page;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = async code => { const result = await page.executeJavaScript(`(() => { try { return (${code}); } catch (error) { return { __probeError: String(error.stack ?? error) }; } })()`); if (result?.__probeError) throw new Error(result.__probeError); return result; };
async function until(code) { for (let attempt = 0; attempt < 600; attempt++) { if (await evaluate(code)) return; await sleep(100); } throw new Error("UI timed out: " + code); }
const click = text => evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(item => !item.disabled && item.textContent.trim() === ${JSON.stringify(text)}); if (!node) throw new Error('Missing enabled button: ' + ${JSON.stringify(text)}); node.click(); })()`);
const input = (selector, text) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(text)}); node.dispatchEvent(new Event('input', {bubbles:true})); })()`);
ipcMain.handle("alpha:server-token", () => fixture.token);
ipcMain.on("alpha:storage", (event, operation, key, value) => { try { event.returnValue = { value: storage[operation](key, value) }; } catch (error) { event.returnValue = { error: error.message }; } });
ipcMain.on("alpha:notify", () => {}); ipcMain.on("alpha:attention", () => {});
ipcMain.handle("alpha:browser-host-status", () => ({ available: false, reason: "Fixture has no browser host" }));
app.whenReady().then(async () => {
  const result = { runtime: process.versions.electron, search: false, tabs: false, lineReference: false, feedback: false, terminals: false, snapshots: false, conflict: false, projects: false };
  try {
    window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { preload: path.resolve("desktop/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    page = window.webContents; page.setBackgroundThrottling(false); await page.loadURL(url);
    await until("[...document.querySelectorAll('button')].some(node => node.textContent.includes('产品体验验证'))"); await evaluate("[...document.querySelectorAll('button')].find(node => node.textContent.includes('产品体验验证')).click()");
    await until("document.querySelector('.native-plan-bar button') && !document.querySelector('.native-plan-bar button').disabled");
    await evaluate("document.querySelector('button[aria-label=\"打开文件栏\"]').click()"); await until("document.querySelector('input[aria-label=\"搜索项目文件\"]')");
    await input('input[aria-label="搜索项目文件"]', "app.ts"); await until("[...document.querySelectorAll('.native-file button')].some(node => node.textContent === 'app.ts')"); await click("app.ts"); await until("document.querySelector('.native-numbered-lines')"); result.search = true;
    await click("引用行范围"); await until("document.querySelector('[data-testid=\"composer\"]')?.value.includes('app.ts:1-1')"); result.lineReference = true;
    await click("文件列表"); await input('input[aria-label="搜索项目文件"]', "材料"); await until("[...document.querySelectorAll('.native-file button')].some(node => node.textContent === '材料.txt')"); await click("材料.txt"); await until("document.querySelectorAll('.native-file-tabs > span').length === 2"); result.tabs = true;
    await evaluate("document.querySelector('.native-workspace button[role=\"tab\"][aria-label=\"审查\"]')?.click() || [...document.querySelectorAll('.native-workspace button')].find(node => node.textContent === '审查').click()");
    await until("document.querySelector('.native-diff-file summary')"); await evaluate("document.querySelector('.native-diff-file summary').click()"); await until("document.querySelector('.native-diff-line-comment')"); await evaluate("document.querySelector('.native-diff-line-comment').click()");
    await input('textarea[aria-label="行级反馈"]', "LINE_FEEDBACK_PROOF"); await click("加入输入框"); await until("document.querySelector('[data-testid=\"composer\"]')?.value.includes('LINE_FEEDBACK_PROOF')"); result.feedback = true;
    await evaluate("[...document.querySelectorAll('.native-workspace button')].find(node => node.textContent === '终端').click()"); await click("新终端"); await until("document.querySelector('.xterm') && document.body.innerText.includes('终端 1')"); await click("新终端"); await until("document.body.innerText.includes('终端 2')"); result.terminals = true;
    await click("关闭此终端"); await until("!document.body.innerText.includes('终端 2')"); await click("关闭此终端");
    const userTurns = await evaluate("document.querySelectorAll('.native-message.user').length");
    await input('[data-testid="composer"]', "验证代码"); await until("!document.querySelector('button[aria-label=\"发送\"]').disabled"); await evaluate("document.querySelector('button[aria-label=\"发送\"]').click()");
    await until(`document.querySelectorAll('.native-message.user').length > ${userTurns} && !document.querySelector('.native-stop') && document.querySelector('.native-status').textContent.includes('本轮结束')`);
    await evaluate("[...document.querySelectorAll('.native-workspace button')].find(node => node.textContent === '审查').click()");
    await until("[...document.querySelectorAll('.native-snapshot button')].some(node => node.textContent === '预览撤销' && !node.disabled)"); await click("预览撤销"); await until("document.querySelector('[aria-modal=\"true\"]')?.textContent.includes('你好，Alpha') && [...document.querySelectorAll('button')].some(node => node.textContent === '确认撤销' && !node.disabled)"); await click("确认撤销"); await until("!document.querySelector('[aria-modal=\"true\"]') && document.body.innerText.includes('预览重做')");
    await click("预览重做"); await until("[...document.querySelectorAll('button')].some(node => node.textContent === '确认重做' && !node.disabled)"); await click("确认重做"); await until("!document.querySelector('[aria-modal=\"true\"]')"); result.snapshots = true;
    await click("预览撤销"); await until("[...document.querySelectorAll('button')].some(node => node.textContent === '确认撤销' && !node.disabled)");
    const editedFile = path.join(fixture.project, "app.ts"), userEdit = 'export const greeting = "USER_AFTER_PREVIEW";\n'; writeFileSync(editedFile, userEdit);
    await click("确认撤销"); await until("document.querySelector('[aria-modal=\"true\"] [role=alert]')?.textContent.includes('恢复已停止') && [...document.querySelectorAll('[aria-modal=\"true\"] button')].some(node => node.textContent === '确认撤销' && node.disabled)");
    if (readFileSync(editedFile, "utf8") !== userEdit) throw new Error("Snapshot conflict overwrote the later user edit"); result.conflict = true;
    writeFileSync(path.join(evidence, "snapshot-conflict-electron.png"), (await page.capturePage()).toPNG()); await click("取消"); await until("!document.querySelector('[aria-modal=\"true\"]')");
    await click("项目"); await until("document.querySelector('[aria-modal=\"true\"]')?.textContent.includes('项目与工作树') && document.body.innerText.includes('创建工作树')");
    const branch = `alpha/ui-proof-${Date.now()}`; await input('input[placeholder="alpha/my-task"]', branch); await until("[...document.querySelectorAll('button')].some(node => node.textContent === '创建工作树' && !node.disabled)"); await click("创建工作树");
    await until(`[...document.querySelectorAll('.native-project-item')].some(node => node.textContent.includes(${JSON.stringify(branch)})) && [...document.querySelectorAll('[aria-modal="true"] button')].some(node => node.textContent === '关闭' && !node.disabled)`); result.projects = true; await click("关闭"); await until("!document.querySelector('[aria-modal=\"true\"]')"); await sleep(200);
    writeFileSync(path.join(evidence, "project-workbench-electron.png"), (await page.capturePage()).toPNG());
    const errors = await evaluate("[...document.querySelectorAll('.native-error')].map(node => node.textContent)"); if (errors.length) throw new Error(errors.join("\n"));
    if (Object.values(result).some(value => value === false)) throw new Error("Project desktop assertions failed");
    writeFileSync(path.join(evidence, "project-ui-result.json"), JSON.stringify({ ...result, status: "passed" }, null, 2)); console.log("ALPHA_PROJECT_UI_OK"); app.exit(0);
  } catch (error) { writeFileSync(path.join(evidence, "project-ui-error.txt"), String(error.stack ?? error) + "\n" + await evaluate("[...document.querySelectorAll('.native-error')].map(node => node.textContent).join('\\n') + '\\n' + document.body.innerText").catch(() => "")); writeFileSync(path.join(evidence,"project-ui-result.json"),JSON.stringify({...result,status:"failed",error:String(error)},null,2)); console.error(error); app.exit(1); }
});
