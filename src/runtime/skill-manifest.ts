/**
 * SKILL.md frontmatter: the one parser for `requires-tools`, `requires-services`, `conflicts-with` and the metadata
 * fields. Both call shapes in the codebase hand in a full SKILL.md document, so only the `---` header block is read;
 * a field line outside it never counts. Values accept plain, quoted, or `[a, b]` list forms.
 */

export function frontmatterField(text: string, key: string): string | undefined {
  const header = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (header === undefined) return undefined;
  const value = new RegExp(`^${key}:\\s*(.*)$`, "mi").exec(header)?.[1]?.trim();
  return value ? value.replace(/^["'](.*)["']$/, "$1").trim() : undefined;
}

export function frontmatterList(text: string, key: string): string[] {
  const value = frontmatterField(text, key);
  if (!value) return [];
  return value.replace(/^\[|\]$/g, "").split(/[,\s]+/).map(item => item.replace(/^['"]|['"]$/g, "").trim()).filter(Boolean);
}
