import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SettingsError, SettingsStore, WorkbenchMeta, mergeSettings } from "../src/runtime/settings";

test("settings updates are validated, clamped and persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-settings-"));
  try {
    const store = new SettingsStore(root);
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
    const saved = await store.update({ budget: { maxToolCalls: 5_000, wallTimeMinutes: 0 }, generation: { comfyUrl: "http://localhost:8190/path", video: false }, plugins: { comfyui: false }, ui: { scale: 1.2, fontSize: "lg" } });
    expect(saved.budget).toEqual({ maxToolCalls: 400, wallTimeMinutes: 1, maxTotalToolCalls: 1200, totalWallTimeMinutes: 120 });
    expect(saved.generation).toMatchObject({ comfyUrl: "http://127.0.0.1:8190", image: true, video: false });
    expect(saved.plugins.comfyui).toBe(false);
    expect(saved.ui).toMatchObject({ scale: 1.2, fontSize: "lg", sidebarCollapsed: false });
    expect(await new SettingsStore(root).get()).toEqual(saved);

    await expect(store.update({ generation: { comfyUrl: "http://example.com:8188" } })).rejects.toBeInstanceOf(SettingsError);
    await expect(store.update({ plugins: { comfyui: "yes" } })).rejects.toBeInstanceOf(SettingsError);
    await expect(store.update({ model: { default: "no-slash" } })).rejects.toBeInstanceOf(SettingsError);
    await expect(store.update({ model: { translation: "no-slash" } })).rejects.toBeInstanceOf(SettingsError);
    await expect(store.update({ ui: { fontSize: "huge" } })).rejects.toBeInstanceOf(SettingsError);
    await expect(store.update(null)).rejects.toBeInstanceOf(SettingsError);
    expect((await store.update({ model: { default: "openrouter/anthropic/claude" } })).model.default).toBe("openrouter/anthropic/claude");
    expect((await store.update({ model: { translation: "deepseek/deepseek-flash" } })).model.translation).toBe("deepseek/deepseek-flash");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a hand-edited settings file keeps its valid values and falls back for the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-settings-"));
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ budget: { maxToolCalls: "many", wallTimeMinutes: 30 }, generation: { comfyUrl: "https://remote.example" }, ui: "broken" }));
    const loaded = await new SettingsStore(root).get();
    expect(loaded.budget).toEqual({ maxToolCalls: 120, wallTimeMinutes: 30, maxTotalToolCalls: 1200, totalWallTimeMinutes: 120 });
    expect(loaded.generation.comfyUrl).toBe(DEFAULT_SETTINGS.generation.comfyUrl);
    expect(loaded.plugins.comfyui).toBe(true);
    expect(loaded.ui).toEqual(DEFAULT_SETTINGS.ui);
    await writeFile(join(root, "settings.json"), "{ not json");
    expect(await new SettingsStore(root).get()).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, {}, true)).toEqual(DEFAULT_SETTINGS);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workbench task metadata stores only meaningful values", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-meta-"));
  try {
    const meta = new WorkbenchMeta(root);
    expect(await meta.update("task-1", { title: "  食谱   收藏  ", pinned: true })).toEqual({ title: "食谱 收藏", pinned: true });
    expect(await meta.update("task-1", { pinned: false, archived: true })).toEqual({ title: "食谱 收藏", archived: true });
    expect(await new WorkbenchMeta(root).get("task-1")).toEqual({ title: "食谱 收藏", archived: true });
    expect(await meta.update("task-1", { title: "", archived: false })).toEqual({});
    expect(JSON.parse(await readFile(join(root, "workbench.json"), "utf8"))).toEqual({ tasks: {} });
    await expect(meta.update("task-1", { pinned: "yes" })).rejects.toBeInstanceOf(SettingsError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
