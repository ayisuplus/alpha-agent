import { describe, expect, test } from "bun:test";
import { absoluteArtifactPath } from "../desktop/ui/src/app/NativeThread";
import { handleUiFrame } from "../desktop/ui/src/app/useSession";

describe("artifact paths resolve against the session project", () => {
  test("relative tool outputs become project-absolute, user paths pass through", () => {
    expect(absoluteArtifactPath("outputs\\media\\a.png", "E:\\proj")).toBe("E:\\proj\\outputs\\media\\a.png");
    expect(absoluteArtifactPath("outputs/report.docx", "E:/proj/")).toBe("E:/proj\\outputs/report.docx");
    expect(absoluteArtifactPath("E:\\elsewhere\\x.pdf", "E:\\proj")).toBe("E:\\elsewhere\\x.pdf");
    expect(absoluteArtifactPath("/tmp/x.pdf", "E:\\proj")).toBe("/tmp/x.pdf");
    expect(absoluteArtifactPath("outputs/a.png", undefined)).toBe("outputs/a.png");
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
