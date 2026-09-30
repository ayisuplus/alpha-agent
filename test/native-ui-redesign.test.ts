import { describe, expect, test } from "bun:test";
import { buildItems, groupThreadItems } from "../desktop/ui/src/app/NativeThread";
import { evidenceLabel } from "../desktop/ui/src/app/workbench-state";
import type { NativeMessage } from "../desktop/ui/src/app/native-api";

describe("Alpha compact execution", () => {
  const messages: NativeMessage[] = [
    { role: "user", timestamp: 1, content: [{ type: "text", text: "生成报告" }] },
    { role: "assistant", timestamp: 2, content: [
      { type: "toolCall", id: "read", name: "read", arguments: { path: "材料.txt" } },
      { type: "toolCall", id: "write", name: "write", arguments: { path: "报告.md", content: "内容" } },
      { type: "toolCall", id: "fail", name: "bash", arguments: { command: "verify" } },
    ] },
    { role: "toolResult", toolCallId: "read", toolName: "read", timestamp: 3, content: [{ type: "text", text: "原始材料" }] },
    { role: "toolResult", toolCallId: "write", toolName: "write", timestamp: 4, content: [{ type: "text", text: "已生成报告" }] },
    { role: "toolResult", toolCallId: "fail", toolName: "bash", timestamp: 5, isError: true, content: [{ type: "text", text: "验证失败" }] },
    { role: "assistant", timestamp: 6, content: [{ type: "text", text: "请检查失败原因" }] },
  ];
  test("groups adjacent successes while keeping failures, running calls and answers in order", () => {
    const items = buildItems(messages, [{ toolCallId: "pending", toolName: "read", args: { path: "另一个文件" }, startedAt: 7 }], {}, []);
    const before = JSON.stringify(items);
    const rows = groupThreadItems(items);
    expect(rows.map(row => row.kind)).toEqual(["user", "toolGroup", "tool", "assistant", "tool"]);
    const group = rows[1];
    if (group.kind !== "toolGroup") throw new Error("Expected successes to be grouped");
    expect(group.tools.map(tool => tool.resultText)).toEqual(["原始材料", "已生成报告"]);
    expect(rows[2].kind === "tool" && rows[2].ok).toBe(false);
    expect(rows[4].kind === "tool" && rows[4].running).toBe(true);
    expect(JSON.stringify(items)).toBe(before);
  });
  test("single successes remain individual and no group spans a user turn", () => {
    const items = buildItems([messages[2]], [], {}, []);
    expect(groupThreadItems(items).some(row => row.kind === "toolGroup")).toBe(false);
    const separated = buildItems([
      { role: "toolResult", toolCallId: "a", toolName: "read", timestamp: 1, content: [] },
      { role: "user", timestamp: 2, content: [{ type: "text", text: "另一个任务" }] },
      { role: "toolResult", toolCallId: "b", toolName: "read", timestamp: 3, content: [] },
    ], [], {}, []);
    expect(groupThreadItems(separated).map(row => row.kind)).toEqual(["tool", "user", "tool"]);
  });
  test("grouped tools retain their artifact payload and original fields", () => {
    const tools = buildItems(messages, [], {}, []).filter(item => item.kind === "tool").filter(item => item.ok);
    tools[1].payload = { summary: "报告", artifacts: [{ path: "报告.md", kind: "markdown", sha256: "hash" }] };
    const group = groupThreadItems(tools)[0];
    if (group.kind !== "toolGroup") throw new Error("Expected group");
    expect(group.tools[1]).toBe(tools[1]);
    expect(group.tools[1].payload?.artifacts?.[0].path).toBe("报告.md");
  });
});

describe("Alpha evidence presentation", () => {
  test("old and new controlled prefixes share readable labels without changing embedded names", () => {
    expect(evidenceLabel("天枢 · 改后未验证 · 上下文 80%" )).toBe("运行检查 · 改后未验证 · 上下文 80%");
    expect(evidenceLabel("▌ 【天枢】请查看材料里的天枢案例")).toBe("请查看材料里的天枢案例");
    expect(evidenceLabel("【检查建议】验证失败")).toBe("验证失败");
    expect(evidenceLabel("用户提到天枢与 OMP")).toBe("用户提到天枢与 OMP");
  });
});
