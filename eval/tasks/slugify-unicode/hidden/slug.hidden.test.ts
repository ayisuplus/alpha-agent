import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test("runs of spaces and punctuation become one hyphen, trimmed at both ends", () => {
  expect(slugify("  Hello,   World!  ")).toBe("hello-world");
  expect(slugify("a -- b")).toBe("a-b");
  expect(slugify("...Ready?")).toBe("ready");
});

test("Chinese characters are kept", () => {
  expect(slugify("你好 World!")).toBe("你好-world");
  expect(slugify("100% 纯棉 T恤")).toBe("100-纯棉-t恤");
});

test("accents are removed from Latin letters", () => {
  expect(slugify("Café Crème")).toBe("cafe-creme");
});

test("a title with nothing usable gives an empty slug", () => {
  expect(slugify("!!!")).toBe("");
  expect(slugify("")).toBe("");
});
