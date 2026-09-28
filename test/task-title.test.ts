import { expect, test } from "bun:test";
import { cleanTitle, generateTaskTitle } from "../src/runtime/task-title";

test("generated titles are one short line without decoration", () => {
  expect(cleanTitle("标题：「护手霜种草笔记」。\n")).toBe("护手霜种草笔记");
  expect(cleanTitle("\n  Fix sympy-12489 permutation  \nextra")).toBe("Fix sympy-12489 permutation");
  expect(cleanTitle("")).toBeNull();
  expect(cleanTitle("这是一个很长很长的回答，模型没有按要求只给出标题，而是开始解释它将如何完成这个任务的每一个步骤")).toBeNull();
});

test("the objective is sent as data to the chosen model", async () => {
  const calls: Array<{ model: string; input: string }> = [];
  const title = await generateTaskTitle("deepseek/deepseek-flash", "把附件整理成透视表", "/data", async (model, _system, input) => {
    calls.push({ model, input });
    return "销售数据透视表";
  });
  expect(title).toBe("销售数据透视表");
  expect(calls).toEqual([{ model: "deepseek/deepseek-flash", input: "把附件整理成透视表" }]);
});
