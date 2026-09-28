import { expect, test } from "bun:test";
import { parseCsvLine } from "../src/csv";

test("quoted fields may contain commas", () => {
  expect(parseCsvLine('1,"Hello, world",3')).toEqual(["1", "Hello, world", "3"]);
});

test("doubled quotes inside a quoted field are one quote", () => {
  expect(parseCsvLine('"She said ""hi""",x')).toEqual(['She said "hi"', "x"]);
});

test("empty fields are kept, including a trailing one", () => {
  expect(parseCsvLine("a,,b,")).toEqual(["a", "", "b", ""]);
  expect(parseCsvLine("")).toEqual([""]);
});

test("spaces are part of the field", () => {
  expect(parseCsvLine(" a , b ")).toEqual([" a ", " b "]);
});

test("an unterminated quote is an error", () => {
  expect(() => parseCsvLine('"open,field')).toThrow();
});
