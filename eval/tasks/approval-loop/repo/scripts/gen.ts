import { writeFile } from "node:fs/promises";

/** 价目表的唯一来源：改这里后运行 `bun run gen` 重新生成 src/generated.ts。 */
const table = { basic: 2900, pro: 9900, enterprise: 29900 };

const generated = `// 由 scripts/gen.ts 生成，请勿手改。\nexport const PRICES: Record<string, number> = ${JSON.stringify(table)};\n`;
await writeFile(new URL("../src/generated.ts", import.meta.url), generated, "utf8");
