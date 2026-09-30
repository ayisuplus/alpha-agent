import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSnapshots } from "../src/native/project-snapshots";
async function removeFixture(root: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rm(root, { recursive: true, force: true }); return; }
    catch (error) { if (attempt >= 10 || !["EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await Bun.sleep(200); }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alpha-snapshot-")), project = join(root, "project"), data = join(root, "data"); await mkdir(project); await mkdir(data);
  const git = (...args: string[]) => { const process = Bun.spawnSync(["git", ...args], { cwd: project, windowsHide: true }); if (process.exitCode) throw new Error(new TextDecoder().decode(process.stderr)); return new TextDecoder().decode(process.stdout); };
  git("init"); await writeFile(join(project, "keep.txt"), "BASE\r\n"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "baseline");
  await writeFile(join(project, "keep.txt"), "STAGED\r\n"); git("add", "keep.txt"); await writeFile(join(project, "keep.txt"), "USER_UNSTAGED\r\n");
  await writeFile(join(project, "用户材料.txt"), "USER_UNTRACKED\r\n");
  return { root, project, data, git, snapshots: new ProjectSnapshots(data), close: () => removeFixture(root) };
}
test("independent Git snapshots undo/redo binary and deleted files while preserving original staged and unstaged changes", async () => {
  const f = await fixture();
  try {
    const index = f.git("ls-files", "--stage"), start = await f.snapshots.begin(f.project, "session-a");
    await writeFile(join(f.project, "keep.txt"), "AGENT_EDIT\n"); await unlink(join(f.project, "用户材料.txt")); await writeFile(join(f.project, "new.bin"), Buffer.from([0, 255, 42]));
    await f.snapshots.finish(f.project, "session-a", "completed");
    const preview = await f.snapshots.preview(f.project, start.id); expect(preview.conflicts).toEqual([]); expect(preview.diff).toContain("USER_UNSTAGED");
    expect((await f.snapshots.restore(f.project, start.id)).restored).toBe(true);
    expect(await readFile(join(f.project, "keep.txt"), "utf8")).toBe("USER_UNSTAGED\r\n"); expect(await readFile(join(f.project, "用户材料.txt"), "utf8")).toBe("USER_UNTRACKED\r\n");
    expect(await readFile(join(f.project, "new.bin")).then(() => true, () => false)).toBe(false); expect(f.git("ls-files", "--stage")).toBe(index); expect(f.git("show", ":keep.txt")).toContain("STAGED");
    const restored = (await new ProjectSnapshots(f.data).list(f.project)).restorations[0];
    expect((await f.snapshots.restore(f.project, restored.id, true)).restored).toBe(true);
    expect(await readFile(join(f.project, "keep.txt"), "utf8")).toBe("AGENT_EDIT\n"); expect([...await readFile(join(f.project, "new.bin"))]).toEqual([0, 255, 42]); expect(f.git("ls-files", "--stage")).toBe(index);
  } finally { await f.close(); }
}, 60_000);
test("a user edit after preview stops the entire restore; another session's later edits also conflict", async () => {
  const f = await fixture();
  try {
    const first = await f.snapshots.begin(f.project, "session-a"); await writeFile(join(f.project, "keep.txt"), "A"); await f.snapshots.finish(f.project, "session-a", "completed");
    expect((await f.snapshots.preview(f.project, first.id)).conflicts).toEqual([]);
    await writeFile(join(f.project, "用户材料.txt"), "USER_AFTER_PREVIEW");
    expect(await f.snapshots.restore(f.project, first.id)).toMatchObject({ restored: false, conflicts: ["用户材料.txt"] }); expect(await readFile(join(f.project, "keep.txt"), "utf8")).toBe("A");
    const second = await f.snapshots.begin(f.project, "session-b"); await writeFile(join(f.project, "keep.txt"), "B"); await f.snapshots.finish(f.project, "session-b", "completed");
    expect((await f.snapshots.restore(f.project, first.id)).restored).toBe(false); expect((await f.snapshots.restore(f.project, second.id)).restored).toBe(true);
    expect(await readFile(join(f.project, "用户材料.txt"), "utf8")).toBe("USER_AFTER_PREVIEW");
  } finally { await f.close(); }
}, 60_000);
test("cold recovery never treats edits made after an unrecorded crash as old task output", async () => {
  const f = await fixture();
  try {
    const first = await f.snapshots.begin(f.project, "session-a"); await writeFile(join(f.project, "keep.txt"), "USER_DURING_DOWNTIME");
    const recovered = new ProjectSnapshots(f.data), second = await recovered.begin(f.project, "session-a");
    await writeFile(join(f.project, "keep.txt"), "NEW_TASK"); await recovered.finish(f.project, "session-a", "completed");
    expect(await recovered.restore(f.project, first.id).catch(error => error.message)).toContain("settled task");
    expect((await recovered.restore(f.project, second.id)).restored).toBe(true); expect(await readFile(join(f.project, "keep.txt"), "utf8")).toBe("USER_DURING_DOWNTIME");
  } finally { await f.close(); }
}, 60_000);
test("Windows managed workspaces with long Alpha data paths still create and restore independent Git objects", async () => {
  const f = await fixture();
  try {
    const snapshots = new ProjectSnapshots(join(f.data, "long-workspace-".repeat(10))), turn = await snapshots.begin(f.project, "long-path");
    await writeFile(join(f.project, "keep.txt"), "LONG_PATH_EFFECT"); await snapshots.finish(f.project, "long-path", "completed");
    expect((await snapshots.restore(f.project, turn.id)).restored).toBe(true); expect(await readFile(join(f.project, "keep.txt"), "utf8")).toBe("USER_UNSTAGED\r\n");
  } finally { await f.close(); }
}, 60_000);
test("snapshots of plain folders exclude Alpha data and refuse linked directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-snapshot-links-")), outside = join(root, "outside"), project = join(root, "project"); await mkdir(outside); await mkdir(project); const data = join(project, ".alpha"); await mkdir(data);
  try {
    await writeFile(join(project, "safe.txt"), "SAFE"); await writeFile(join(data, "private.txt"), "EXCLUDE");
    const snapshots = new ProjectSnapshots(data), turn = await snapshots.begin(project, "test"); expect(Object.keys(turn.start.files)).toEqual(["safe.txt"]);
    await symlink(outside, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(await snapshots.finish(project, "test", "completed").catch(error => error.message)).toContain("linked/non-file");
  } finally { await unlink(join(project, "linked")).catch(() => rmdir(join(project, "linked")).catch(() => undefined)); await removeFixture(root); }
});
