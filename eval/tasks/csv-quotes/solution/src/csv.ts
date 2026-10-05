/** Splits one CSV line into its fields: quoted fields may hold commas, and "" inside quotes is one quote. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") { fields.push(field); field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("Unterminated quoted field");
  fields.push(field);
  return fields;
}
