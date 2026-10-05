import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test("simple titles become lowercase words", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});
