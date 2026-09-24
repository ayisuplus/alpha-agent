import { createServer } from "node:net";
import { join } from "node:path";

const server = createServer();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not choose a CDP port");
const port = address.port;
await new Promise<void>(resolve => server.close(() => resolve()));

const env: NodeJS.ProcessEnv = { ...process.env, ALPHA_CDP_PORT: String(port), ALPHA_BUN_PATH: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const electron = join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");
const child = Bun.spawn([electron, join(process.cwd(), "desktop", "main.cjs")], {
  cwd: process.cwd(), env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
});
process.once("SIGINT", () => child.kill());
process.exitCode = await child.exited;
