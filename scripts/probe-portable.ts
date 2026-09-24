import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const portable = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2] || !await Bun.file(join(portable, "release.json")).exists()) throw new Error("Pass a built portable release directory");
const workspace = await mkdtemp(join(tmpdir(), "alpha-portable-probe-"));
const child = Bun.spawn([join(portable, "runtime", "bun.exe"), "run", "src/server.ts"], {
  cwd: portable,
  env: { ...process.env, ALPHA_WORKSPACE_ROOT: workspace },
  stdout: "pipe",
  stderr: "pipe",
});
try {
  const reader = child.stdout.getReader();
  let output = "";
  const ready = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Portable server exited before ready: ${output}`);
      output += new TextDecoder().decode(chunk.value);
      const match = /ALPHA_SERVER_READY (\d+)/.exec(output);
      if (match) return Number(match[1]);
    }
  })();
  const port = await Promise.race([ready, Bun.sleep(20_000).then(() => { throw new Error("Portable server startup timed out"); })]);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error("Portable health probe failed");
  console.log(JSON.stringify({ portable, port, health: "ok" }));
} finally {
  child.kill();
  await child.exited;
  const actual = await realpath(workspace);
  if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error(`Refusing to remove unexpected probe directory: ${actual}`);
  await rm(actual, { recursive: true, force: true });
}
