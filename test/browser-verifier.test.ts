import { expect, test } from "bun:test";
import { parsePlan } from "../src/runtime/browser-verifier";

const steps = [
  { action: "fill", selector: "#name", value: "Alpha {{nonce}}" },
  { action: "click", selector: "#save" },
  { action: "expectText", text: "Alpha {{nonce}}" },
  { action: "viewport", width: 375, height: 812 },
  { action: "contrast", selector: "#save", minRatio: 4.5 },
  { action: "reload" },
  { action: "expectText", text: "Alpha {{nonce}}" },
];

test("a persistence task requires a real interaction, assertions, reload and narrow viewport", () => {
  expect(parsePlan({ steps }, "新增素材并在刷新后保存").steps).toHaveLength(7);
  expect(() => parsePlan({ steps: steps.filter(step => step.action !== "reload") }, "新增素材并在刷新后保存")).toThrow("reload");
  expect(() => parsePlan({ steps: steps.filter(step => step.action !== "click") }, "新增素材并保存")).toThrow("interactive");
  expect(() => parsePlan({ steps: steps.filter(step => step.action !== "expectText") }, "新增素材并保存")).toThrow("assertions");
  expect(() => parsePlan({ steps: [...steps, { action: "expectText", text: "line-through", checkStyle: true }] }, "新增素材并保存")).toThrow("unsupported field");
});

test("an input value is an explicit outcome assertion", () => {
  const inputSteps = steps.map(step => step.action === "expectText" ? { action: "expectValue", selector: "#name", value: "Alpha {{nonce}}" } : step);
  expect(parsePlan({ steps: inputSteps }, "刷新后保存").steps).toHaveLength(7);
  expect(parsePlan({ steps: [...inputSteps, { action: "expectValue", selector: "#name", value: "" }] }, "刷新后保存").steps).toHaveLength(8);
  expect(() => parsePlan({ steps: [...inputSteps, { action: "expectValue", selector: "#name", value: 3 }] }, "刷新后保存")).toThrow("Value assertion");
});

test("a button-only product can verify a changed result without a form", () => {
  const clickOnly = steps.filter(step => step.action !== "fill");
  expect(parsePlan({ steps: clickOnly }, "点击切换短语").steps).toHaveLength(6);
});

test("a video product must verify decodable frames in the preview", () => {
  expect(() => parsePlan({ steps }, "构建一个带原创视频的页面")).toThrow("decoded video frame");
  expect(parsePlan({ steps: [...steps, { action: "video", selector: "#hero-video" }] }, "构建一个带原创视频的页面").steps).toHaveLength(8);
});
