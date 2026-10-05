import { afterEach, expect, test } from "bun:test";
import { setUiLanguage, t, tf } from "../desktop/ui/src/app/ui-language";
import { desktopCommands } from "../desktop/ui/src/app/desktop-commands";
afterEach(() => setUiLanguage("zh"));
test("English UI preserves native command ids, user material and interpolation bytes", () => {
  setUiLanguage("en");
  expect(t("批准并清空上下文执行")).toBe("Approve and execute with cleared context");
  expect(t("modelRoles.plan")).toBe("modelRoles.plan");
  expect(tf`关闭 ${"文件{0}：$&.txt"}`).toBe("Close 文件{0}：$&.txt");
  expect(t("用户提供的完整句子，保留原文。")).toBe("用户提供的完整句子，保留原文。");
  for (const command of desktopCommands) { expect(t(command.description)).toBe(command.en); expect(command.name).toMatch(/^[a-z]+$/); }
  setUiLanguage("zh"); expect(tf`搜索${"MCP"}…`).toBe("搜索MCP…");
});
