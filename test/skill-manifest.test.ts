import { expect, test } from "bun:test";
import { frontmatterField, frontmatterList } from "../src/runtime/skill-manifest";

const SKILL = `---
name: write-articles
description: "Write and edit articles"
requires-tools: [edit, write]
requires-services: tavily
conflicts-with: ghost-writer
---

# Body
Body lines never count: requires-tools: [nuke]
`;

test("scalar fields read from the header block only", () => {
  expect(frontmatterField(SKILL, "name")).toBe("write-articles");
  expect(frontmatterField(SKILL, "description")).toBe("Write and edit articles");
  expect(frontmatterField(SKILL, "requires-services")).toBe("tavily");
  expect(frontmatterField(SKILL, "missing")).toBeUndefined();
  // The body line must not register as a field value.
  expect(frontmatterList(SKILL, "requires-tools")).toEqual(["edit", "write"]);
});

test("lists accept bracketed, quoted and plain forms", () => {
  expect(frontmatterList('---\nconflicts-with: ["a", "b"]\n---', "conflicts-with")).toEqual(["a", "b"]);
  expect(frontmatterList('---\nrequires-tools: alpha_build, alpha_check\n---', "requires-tools")).toEqual(["alpha_build", "alpha_check"]);
  expect(frontmatterList('---\nrequires-tools: \n---', "requires-tools")).toEqual([]);
  expect(frontmatterList("no frontmatter at all", "requires-tools")).toEqual([]);
});
