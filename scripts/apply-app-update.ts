import { resolve } from "node:path";
import { runAppUpdateHelper } from "../src/native/app-update-installer";
export * from "../src/native/app-update-installer";
if (import.meta.main) {
  try { await runAppUpdateHelper(resolve(process.argv[2] ?? "")); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
