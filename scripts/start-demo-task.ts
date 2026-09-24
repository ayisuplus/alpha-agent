import puppeteer from "puppeteer-core";
import { discoverBrowserWebSocket } from "../src/runtime/visible-browser";

const port = Bun.argv[2];
if (!port) throw new Error("Usage: bun run scripts/start-demo-task.ts <cdp-port>");
const browser = await puppeteer.connect({ browserWSEndpoint: await discoverBrowserWebSocket(`http://127.0.0.1:${port}`), defaultViewport: null });
try {
  const pages = await browser.pages();
  const shell = (await Promise.all(pages.map(async page => ({ page, title: await page.title() })))).find(item => item.title === "Alpha 工作台")?.page;
  if (!shell) throw new Error("Alpha desktop shell not found");
  await shell.click("#brief");
  await shell.type("#brief", "请把当前空白 Web 模板构建为素材清单应用：可以新增素材名称和分类，可以按分类筛选，刷新页面后数据仍保存在本机；桌面和窄屏都可正常使用。完成后运行 bun run build。只修改当前产品目录。");
  await shell.click("button.primary");
  await Bun.sleep(500);
  console.log(JSON.stringify({ submitted: true, status: await shell.$eval(".state", node => node.textContent?.trim()) }));
} finally {
  await browser.disconnect();
}
