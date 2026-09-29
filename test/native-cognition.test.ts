import { describe, expect, test } from "bun:test";
import { advanceTurn, assembleCognitiveFrame, classifyVerificationCommand, emptyCognitiveState, observeTool, renderCognitiveMirror } from "../src/native/tianshu-cognition";

describe("OMP cognitive mirror", () => {
  test("reports repeated observed failure without turning it into a gate", () => {
    const failed = { toolName: "bash", toolCallId: "a", isError: true, textDigest: "same" };
    const once = observeTool(emptyCognitiveState(), failed);
    expect(assembleCognitiveFrame(once).signals).toHaveLength(0);
    const twice = observeTool(once, { ...failed, toolCallId: "b" });
    const frame = assembleCognitiveFrame(twice);
    expect(frame.signals.map(signal => signal.key)).toEqual(["repeat-failure"]);
    expect(renderCognitiveMirror(frame)).toContain("建议先检查原因");
    expect(frame.quality.efe).toBe("missing");
  });

  test("only a successful observed check clears verification debt", () => {
    const edit = observeTool(emptyCognitiveState(), { toolName: "edit", toolCallId: "e", isError: false, textDigest: "sha" });
    expect(assembleCognitiveFrame(edit).signals.map(signal => signal.key)).toContain("verification-debt");
    const failedCheck = observeTool(edit, { toolName: "bash", toolCallId: "t1", isError: true, textDigest: "failed", verificationCommand: true });
    expect(assembleCognitiveFrame(failedCheck).signals.map(signal => signal.key)).toContain("verification-debt");
    const passed = observeTool(failedCheck, { toolName: "bash", toolCallId: "t2", isError: false, textDigest: "passed", verificationCommand: true });
    expect(assembleCognitiveFrame(passed).signals.map(signal => signal.key)).not.toContain("verification-debt");
    expect(classifyVerificationCommand("bun run check")).toBe(true);
    expect(classifyVerificationCommand("echo test")).toBe(false);
  });

  test("context pressure uses measured token counts", () => {
    const frame = assembleCognitiveFrame(advanceTurn(emptyCognitiveState(), { tokens: 80, contextWindow: 100 }));
    expect(frame.quality.context).toBe("measured");
    expect(frame.signals.map(signal => signal.key)).toContain("context-pressure");
  });
});
