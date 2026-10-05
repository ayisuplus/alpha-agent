import { describe, expect, test } from "bun:test";
import { absoluteArtifactPath, buildItems } from "../desktop/ui/src/app/NativeThread";
import { handleUiFrame, reconcileLiveMessage } from "../desktop/ui/src/app/useSession";
import { withLiveMessage } from "../desktop/ui/src/app/workbench-state";

describe("artifact paths resolve against the session project", () => {
  test("settling retains the live answer until history contains its complete content", () => {
    const final = { role: "assistant", timestamp: 7, content: "长回答的完整末尾" };
    expect(reconcileLiveMessage(final, [])).toBe(final);
    expect(reconcileLiveMessage(final, [{ ...final, content: "长回答" }])).toBe(final);
    expect(reconcileLiveMessage(final, [{ ...final, timestamp: 6 }])).toBe(final);
    expect(reconcileLiveMessage(final, [final])).toBeNull();
    expect(reconcileLiveMessage(final, [{ ...final, content: "OMP 脱敏后的权威历史" }], true)).toBeNull();
  });
  test("live replacement keeps tool calls before their results even when native content differs", () => {
    const call = { role: "assistant", timestamp: 7, content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "材料.txt" } }] };
    const result = { role: "toolResult", timestamp: 8, toolCallId: "read-call", toolName: "read", content: "材料内容" };
    const merged = withLiveMessage([{ ...call, content: [] }, result], call);
    expect(merged).toEqual([call, result]);
    const items = buildItems(merged, [], {}, []);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("tool");
    expect(items[0].kind === "tool" && items[0].resultText).toBe("材料内容");
  });
  test("empty assistant failures remain visible and streaming text renders", () => {
    const items = buildItems([{ role: "assistant", content: [], errorMessage: "HTTP 401" }, { role: "assistant", content: "正在处理" }], [], {}, []);
    expect(items.some(item => "text" in item && item.text.includes("HTTP 401"))).toBe(true);
    expect(items.some(item => item.kind === "assistant" && item.text === "正在处理")).toBe(true);
  });
  test("user aborts retain partial text without being labeled as failures", () => {
    const message = { role: "assistant", content: "已生成的内容", stopReason: "aborted" as const, errorMessage: "Interrupted by user" };
    const items = buildItems([message], [], {}, []);
    expect(items.some(item => item.kind === "note" && item.text === "已停止生成")).toBe(true);
    expect(items.some(item => "text" in item && item.text.includes("执行失败"))).toBe(false);
    expect(items.some(item => item.kind === "assistant" && item.text === "已生成的内容")).toBe(true);
    expect(message.errorMessage).toBe("Interrupted by user");
  });
  test("relative tool outputs become project-absolute, user paths pass through", () => {
    expect(absoluteArtifactPath("outputs\\media\\a.png", "E:\\proj")).toBe("E:\\proj\\outputs\\media\\a.png");
    expect(absoluteArtifactPath("outputs/report.docx", "E:/proj/")).toBe("E:/proj\\outputs/report.docx");
    expect(absoluteArtifactPath("E:\\elsewhere\\x.pdf", "E:\\proj")).toBe("E:\\elsewhere\\x.pdf");
    expect(absoluteArtifactPath("/tmp/x.pdf", "E:\\proj")).toBe("/tmp/x.pdf");
    expect(absoluteArtifactPath("outputs/a.png", undefined)).toBe("outputs/a.png");
  });
  test("tool summaries show a readable target while details retain all native arguments", () => {
    const arguments_ = { action: "create", kind: "docx", name: "体验改进", content: "正文".repeat(100) };
    const items = buildItems([{ role: "assistant", content: [{ type: "toolCall", id: "office", name: "alpha_office", arguments: arguments_ }] }], [], {}, []);
    const tool = items.find(item => item.kind === "tool");
    expect(tool?.target).toBe("体验改进");
    expect(JSON.parse(tool?.args ?? "{}")).toEqual(arguments_);
    expect(tool?.running).toBe(true);
  });
});

describe("extension UI frames", () => {
  const makeSinks = () => {
    const seen: Record<string, unknown[]> = { dialog: [], cancel: [], url: [], notify: [], status: [], widget: [], title: [] };
    return {
      seen,
      sinks: {
        onDialog(request: unknown) { seen.dialog.push(request); },
        onCancel(targetId?: string) { seen.cancel.push(targetId ?? null); },
        onUrl(value: string) { seen.url.push(value); },
        onNotify(message: string) { seen.notify.push(message); },
        onStatus(key: string, text: string | undefined) { seen.status.push([key, text]); },
        onWidget(key: string, lines: string[] | undefined) { seen.widget.push([key, lines]); },
        onTitle(title: string) { seen.title.push(title); },
      },
    };
  };

  test("cancel frames reach the dialog sink so aborted dialogs can close", () => {
    const { seen, sinks } = makeSinks();
    handleUiFrame({ method: "select", id: "r1", title: "选择", options: [] }, sinks);
    expect(seen.dialog).toHaveLength(1);
    handleUiFrame({ method: "cancel", targetId: "r1" }, sinks);
    expect(seen.cancel).toEqual(["r1"]);
    handleUiFrame({ method: "cancel" }, sinks);
    expect(seen.cancel).toEqual(["r1", null]);
    // 其它帧不受影响
    handleUiFrame({ method: "setStatus", statusKey: "tianshu", statusText: "天枢 ✓" }, sinks);
    handleUiFrame({ method: "setWidget", widgetKey: "w", widgetLines: ["行"] }, sinks);
    handleUiFrame({ method: "setTitle", title: "Alpha · 会话" }, sinks);
    expect(seen.status).toEqual([["tianshu", "天枢 ✓"]]);
    expect(seen.widget).toEqual([["w", ["行"]]]);
    expect(seen.title).toEqual(["Alpha · 会话"]);
    expect(seen.dialog).toHaveLength(1);
  });
});
