import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../src/runtime/projects";

test("projects persist direct folder mounts and invalidate an old mount version", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-projects-"));
  try {
    const data = join(root, "data");
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(data), mkdir(first), mkdir(second)]);
    const store = new ProjectStore(data);
    const created = await store.create("Example");
    const mounted = await store.mount(created.id, first);
    expect(mounted.mounts.map(item => item.path)).toEqual([first]);
    expect((await new ProjectStore(data).get(created.id))?.mounts).toEqual(mounted.mounts);
    expect(await store.roots(created.id, mounted.version)).toEqual([first]);
    const changed = await store.mount(created.id, second);
    await expect(store.roots(created.id, mounted.version)).rejects.toThrow("changed");
    expect((await store.unmount(created.id, changed.mounts[0].id)).mounts).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mounts reject UNC, drive roots, overlapping folders and directory links", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-mounts-"));
  try {
    const data = join(root, "data");
    const source = join(root, "source");
    await Promise.all([mkdir(data), mkdir(source)]);
    const store = new ProjectStore(data);
    const project = await store.create("Example");
    await expect(store.mount(project.id, data)).rejects.toThrow("task data");
    await expect(store.mount(project.id, process.cwd())).rejects.toThrow("executable");
    await expect(store.mount(project.id, "\\\\host\\share")).rejects.toThrow("local Windows");
    await expect(store.mount(project.id, "C:\\")).rejects.toThrow("drive root");
    await store.mount(project.id, source);
    const nested = join(source, "nested");
    await mkdir(nested);
    await expect(store.mount(project.id, nested)).rejects.toThrow("overlap");
    const link = join(root, "link");
    await symlink(source, link, "junction");
    await expect(store.mount(project.id, link)).rejects.toThrow("junction");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("projects.json carries its store tag and an untagged document still loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-projects-tag-"));
  try {
    const data = join(root, "data");
    await mkdir(data);
    const store = new ProjectStore(data);
    await store.create("Example");
    const saved = JSON.parse(await readFile(join(data, "projects.json"), "utf8")) as { format?: string; version?: number; projects?: unknown[] };
    expect(saved.format).toBe("projects");
    expect(saved.version).toBe(1);
    expect(saved.projects).toHaveLength(1);
    // A legacy document is the bare record array; it must still load.
    await writeFile(join(data, "projects.json"), JSON.stringify([{ id: "legacy", name: "Legacy", version: 1, mounts: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]));
    expect((await store.list()).map(item => item.id)).toEqual(["legacy"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
