import { join } from "node:path";

const env: NodeJS.ProcessEnv = { ...process.env, ALPHA_BUN_PATH: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const electron = join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");
const child = Bun.spawn([electron, join(process.cwd(), "desktop", "main.cjs")], {
  cwd: process.cwd(), env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
});
process.once("SIGINT", () => child.kill());
process.exitCode = await child.exited;
