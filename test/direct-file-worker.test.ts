import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function call(cwd: string, roots: string[], action: string, args: Record<string, unknown>, editMode?: string) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/runtime/sandbox-file-worker.ts")], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify({ cwd, roots, action, args, editMode, nativePath: resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-natives/native/index.js") }));
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = stdout.split(/\r?\n/).find(item => item.startsWith("__ALPHA_FILE_RESULT__"));
  if (!line) throw new Error(`Worker emitted no result: ${stderr}`);
  return { ...JSON.parse(line.slice("__ALPHA_FILE_RESULT__".length)) as { text?: string; error?: string }, exit };
}

test("worker reads Hashline text and applies an exact-tag edit", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-file-worker-"));
  folders.push(folder);
  const file = join(folder, "note.txt");
  await writeFile(file, "first\nsecond\n");
  const read = await call(folder, [folder], "read", { path: file });
  expect(read.exit).toBe(0);
  const header = read.text?.match(/\[[^\]]+#([0-9a-f]{4})\]/i)?.[0];
  expect(header).toBeDefined();
  const edit = await call(folder, [folder], "edit", { input: `*** Begin Patch\n${header}\nPUT 2.=2:\n+changed\n*** End Patch` });
  expect(edit.error).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe("first\nchanged\n");
});

test("worker follows the session's edit format when it is not Hashline", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-file-worker-"));
  folders.push(folder);
  const file = join(folder, "note.md");
  await writeFile(file, "# Title\nold line\n");
  const read = await call(folder, [folder], "read", { path: file }, "replace");
  // Plain text to quote from: no Hashline header or line anchors.
  expect(read.text).toBe("# Title\nold line");
  const edit = await call(folder, [folder], "edit", { path: file, old_string: "old line", new_string: "new line" }, "replace");
  expect(edit.error).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe("# Title\nnew line\n");
  const outside = await mkdtemp(join(tmpdir(), "alpha-file-outside-"));
  folders.push(outside);
  await writeFile(join(outside, "x.md"), "keep\n");
  const denied = await call(folder, [folder], "edit", { path: join(outside, "x.md"), old_string: "keep", new_string: "gone" }, "replace");
  expect(denied.error).toContain("outside mounted folders");
});

test("worker rejects writes outside mounts and known credential reads", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-file-worker-"));
  const outside = await mkdtemp(join(tmpdir(), "alpha-file-outside-"));
  folders.push(folder, outside);
  const denied = await call(folder, [folder], "write", { path: join(outside, "escape.txt"), content: "bad" });
  expect(denied.error).toContain("outside mounted folders");
  const secret = join(folder, ".env");
  await writeFile(secret, "secret");
  const read = await call(folder, [folder], "read", { path: secret });
  expect(read.error).toContain("credential");
  const link = join(folder, "linked");
  await symlink(outside, link, "junction");
  const throughLink = await call(folder, [folder], "write", { path: join(link, "escape.txt"), content: "bad" });
  expect(throughLink.error).toContain("junction");
});
