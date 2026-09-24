import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = import.meta.dir;
const output = join(root, "dist");
if (resolve(output) !== resolve(root, "dist")) throw new Error("Invalid build output");
await rm(output, { recursive: true, force: true });
await cp(join(root, "src"), output, { recursive: true });
if (existsSync(join(root, "public"))) await cp(join(root, "public"), output, { recursive: true });
console.log(`Built ${output}`);
