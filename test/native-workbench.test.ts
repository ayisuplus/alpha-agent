import { describe, expect, test } from "bun:test";
import { atBottom, clearSentDraft, diffFiles, draftVersion, errorHelp, groupSessions, promptText, readDraft, shouldSubmit, subscribeDraft, writeDraft } from "../desktop/ui/src/app/workbench-state";
import type { SessionItem } from "../desktop/ui/src/app/native-api";

describe("workbench input preservation", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  test("restores session text, paths and image bytes without mixing sessions", () => {
    values.set("alpha-composer:restored", JSON.stringify({ text: "未发送内容", paths: ["E:\\资料\\计划.docx", 42], model: "p/m" }));
    expect(readDraft("restored", storage)).toEqual({ text: "未发送内容", paths: ["E:\\资料\\计划.docx"], model: "p/m", thinking: undefined, cwd: undefined });
    writeDraft("session-one", { text: "任务一", paths: [], image: { name: "a.png", mimeType: "image/png", data: "aW1hZ2U=" } }, storage);
    values.set("alpha-composer:restarted-image", values.get("alpha-composer:session-one")!);
    expect(readDraft("restarted-image", storage).image?.data).toBe("aW1hZ2U=");
    expect(readDraft("session-two", storage).text).toBe("");
  });
  test("image-only input and path-only input create nonempty native prompts", () => {
    expect(promptText({ text: "", paths: [], image: { name: "a.png", data: "a", mimeType: "image/png" } })).toBe("请分析这张图片。");
    expect(promptText({ text: "", paths: ["E:\\文档 a.docx"] })).toContain('"E:\\\\文档 a.docx"');
    expect(promptText({ text: "  ", paths: [] })).toBe("");
  });
  test("restored drafts retain the working directory and reject malformed saved choices", () => {
    values.set("alpha-composer:with-cwd", JSON.stringify({ text: "任务", paths: [], cwd: "E:\\项目", model: { invalid: true }, thinking: 10 }));
    expect(readDraft("with-cwd", storage)).toEqual({ text: "任务", paths: [], cwd: "E:\\项目", model: undefined, thinking: undefined });
  });
  test("a storage failure preserves the live draft and reports that restart persistence failed", () => {
    const full = { ...storage, setItem() { throw new Error("full"); } };
    expect(writeDraft("full", { text: "不能丢失", paths: [] }, full)).toBe(false);
    expect(readDraft("full", full).text).toBe("不能丢失");
  });
  test("Chinese composition, plain Enter and newline combinations never submit", () => {
    const key = { key: "Enter", ctrlKey: true, metaKey: false, shiftKey: false, isComposing: false };
    expect(shouldSubmit(key)).toBe(true);
    expect(shouldSubmit({ ...key, isComposing: true })).toBe(false);
    expect(shouldSubmit({ ...key, ctrlKey: false })).toBe(false);
    expect(shouldSubmit({ ...key, shiftKey: true })).toBe(false);
    expect(shouldSubmit({ ...key, ctrlKey: false, metaKey: true })).toBe(true);
  });
  test("late send completion cannot erase a draft edited by a remounted composer", () => {
    writeDraft("slow-send", { text: "已提交", paths: [] }, storage);
    const sent = draftVersion("slow-send");
    const seen: string[] = [];
    const unsubscribe = subscribeDraft("slow-send", draft => seen.push(draft.text));
    writeDraft("slow-send", { text: "设置往返后的新内容", paths: [] }, storage);
    expect(clearSentDraft("slow-send", sent, storage)).toBeNull();
    expect(readDraft("slow-send", storage).text).toBe("设置往返后的新内容");
    expect(clearSentDraft("slow-send", draftVersion("slow-send"), storage)).toBe(true);
    expect(seen).toEqual(["设置往返后的新内容", ""]);
    unsubscribe();
    writeDraft("slow-send", { text: "独立草稿", paths: [] }, storage);
    expect(seen).toHaveLength(2);
  });
});

test("reading old content does not qualify for following the live tail", () => {
  expect(atBottom(500, 1500, 600)).toBe(false);
  expect(atBottom(900, 1500, 600)).toBe(true);
  expect(atBottom(0, 200, 600)).toBe(true);
});

test("file differences retain Chinese paths, spaces, multiple files and accurate line counts", () => {
  const files = diffFiles("diff --git a/中文 a.txt b/中文 a.txt\n--- a/中文 a.txt\n+++ b/中文 a.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ");
  expect(files.map(file => [file.path, file.added, file.removed])).toEqual([["中文 a.txt", 1, 1], ["b.png", 0, 0]]);
  expect(files[0].lines).toContain("-old");
});

test("project grouping normalizes Windows paths and keeps pinned sessions ahead of newer ones", () => {
  const row = (id: string, cwd: string, updatedAt: string): SessionItem => ({ id, cwd, title: id, createdAt: updatedAt, updatedAt });
  const groups = groupSessions([row("new", "E:\\Project", "2026-09-30"), row("pinned", "e:/project/", "2026-09-29"), row("other", "E:\\other", "2026-09-30")], ["pinned"]);
  expect(groups).toHaveLength(2);
  expect(groups[0].rows.map(item => item.id)).toEqual(["pinned", "new"]);
});

test("network recovery asks the user to reconcile state before resending; credentials lead to model settings", () => {
  expect(errorHelp("无法连接 Alpha 本机服务").hint).toContain("先刷新状态");
  expect(errorHelp("HTTP 401").section).toBe("model");
  expect(errorHelp("ComfyUI 工作流不可用").section).toBe("capabilities");
  expect(errorHelp("当前模型不支持图片，请选择支持图片的模型。").hint).toContain("支持图片");
});
