import { expect, test } from "bun:test";
import { prohibitionViolations, statedProhibitions } from "../src/runtime/stated-prohibitions";

test("quoted prohibition terms are read from the objective", () => {
  expect(statedProhibitions("为一款 500ml 的保温杯写一段电商详情页的产品介绍。不要使用“最”“第一”“国家级”“顶级”这类绝对化用语。直接给出正文即可。")).toEqual(["最", "第一", "国家级", "顶级"]);
});

test("a declined request is not a prohibition", () => {
  expect(statedProhibitions("直接回答即可，不需要生成文件。")).toEqual([]);
  expect(statedProhibitions("不要生成文件，用一句话回答。")).toEqual([]);
});

test("an unquoted prohibition needs an enumeration of at least two terms", () => {
  expect(statedProhibitions("避免出现色情、暴力内容。")).toEqual(["色情", "暴力"]);
  expect(statedProhibitions("不要使用绝对化用语。")).toEqual([]);
});

test("terms dedupe across clauses and violations follow the objective's order", () => {
  const terms = statedProhibitions("标题禁止“震惊”。正文禁止使用“震惊”“第一”。");
  expect(terms).toEqual(["震惊", "第一"]);
  expect(prohibitionViolations("第一眼很震惊，但没有别的问题。", terms)).toEqual(["震惊", "第一"]);
  expect(prohibitionViolations("文案干净。", terms)).toEqual([]);
});
