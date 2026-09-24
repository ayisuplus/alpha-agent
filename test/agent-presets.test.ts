import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPresetStore } from "../src/runtime/agent-presets";
import { workerSystemPrompt } from "../src/runtime/omp-runner";
import { resolveWorkOrders } from "../src/runtime/work-order-tool";
import { fingerprintSource } from "../src/runtime/task-ledger";
import { executeWorkOrders, type WorkOrder } from "../src/runtime/work-orders";

test("role copies persist, edits create a new snapshot, and disabled roles leave the next catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-presets-"));
  try {
    const store = new AgentPresetStore(root);
    const initial = await store.list();
    expect(initial.map(item => item.id)).toEqual(["general", "frontend", "backend", "ui-designer", "test-automation"]);
    expect(initial.find(item => item.id === "frontend")?.source?.revision).toBe("053ddbbf392a1688fc7043d81529f47ef2cf86c8");
    const original = await store.get("frontend");
    const copy = await store.copy("frontend");
    expect(copy.hash).not.toBe(original.hash);
    const frozen = (await store.enabled()).find(item => item.id === copy.id)!;
    const renamed = await store.update(copy.id, { name: "项目前端" });
    expect(renamed.hash).not.toBe(frozen.hash);
    const changed = await store.update(copy.id, { name: "项目前端", description: "负责组件", instructions: "只做分配的组件改动。" });
    expect(changed.hash).not.toBe(frozen.hash);
    expect(frozen.instructions).toBe(original.instructions);
    expect((await store.get("frontend")).hash).toBe(original.hash);
    expect((await new AgentPresetStore(root).get(copy.id)).name).toBe("项目前端");
    await Promise.all([store.setEnabled("frontend", false), store.setEnabled("backend", false)]);
    expect((await new AgentPresetStore(root).enabled()).map(item => item.id)).not.toContain("frontend");
    expect((await new AgentPresetStore(root).enabled()).map(item => item.id)).not.toContain("backend");
    await expect(store.setEnabled("general", false)).rejects.toThrow("必须保持可用");
    await expect(store.update("frontend", { instructions: "改掉内置内容" })).rejects.toThrow("先复制");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker receives only its selected full role and merge records the frozen version", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-preset-workers-"));
  try {
    const product = join(root, "product");
    await mkdir(join(product, "src"), { recursive: true });
    await writeFile(join(product, "src", "front.txt"), "old");
    await writeFile(join(product, "src", "back.txt"), "old");
    const presets = await new AgentPresetStore(join(root, "state")).enabled();
    const orders: WorkOrder[] = resolveWorkOrders([
      { id: "front", objective: "Edit frontend", ownedPaths: ["src/front.txt"], resources: ["front"], presetId: "frontend" },
      { id: "back", objective: "Edit backend", ownedPaths: ["src/back.txt"], resources: ["back"], presetId: "backend" },
    ], presets);
    const frontPrompt = workerSystemPrompt(orders[0], orders[0].preset).join("\n");
    expect(frontPrompt).toContain(orders[0].preset!.instructions);
    expect(frontPrompt).not.toContain(orders[1].preset!.instructions);
    expect(frontPrompt).toContain("src/front.txt");
    expect(frontPrompt).toContain("Do not edit alpha-verification.json");
    expect(() => resolveWorkOrders([{ ...orders[0], presetId: "missing" }], presets)).toThrow("不存在或未启用");
    expect(() => workerSystemPrompt(orders[0])).toThrow("快照缺失");
    const report = await executeWorkOrders({
      projectRoot: product, dataRoot: join(root, "state"), taskId: "11111111-1111-4111-8111-111111111111", baseRevision: await fingerprintSource(product), orders,
      async runWorker(order, directory) {
        await writeFile(join(directory, order.ownedPaths[0]), order.preset!.name);
        return { evidence: [], unresolved: [] };
      },
    });
    expect(report.status).toBe("merged");
    expect(report.presets?.front.hash).toBe(orders[0].preset!.hash);
    expect(report.presets?.back.id).toBe("backend");
    expect(await readFile(join(product, "src", "front.txt"), "utf8")).toBe("前端开发");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workbench API lists, copies and edits roles while rejecting another origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-presets-api-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "server.ts")], {
      cwd: root, env: { ...process.env, ALPHA_WORKSPACE_ROOT: root }, stdout: "pipe", stderr: "pipe",
    });
    if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output unavailable");
    const reader = child.stdout.getReader();
    const timeout = setTimeout(() => child?.kill(), 15_000);
    let output = "";
    let port: string | undefined;
    try {
      while (!port) {
        const next = await reader.read();
        if (next.done) break;
        output += new TextDecoder().decode(next.value);
        port = /ALPHA_SERVER_READY (\d+)/.exec(output)?.[1];
      }
    } finally { clearTimeout(timeout); }
    if (!port) throw new Error(`Server did not start: ${output}`);
    const base = `http://127.0.0.1:${port}`;
    const json = { "content-type": "application/json", origin: base };
    const listed = await fetch(`${base}/api/agent-presets`).then(response => response.json()) as { presets: Array<{ id: string; instructions?: string }> };
    expect(listed.presets.find(item => item.id === "frontend")?.instructions).toBeUndefined();
    const detail = await fetch(`${base}/api/agent-presets/frontend`).then(response => response.json()) as { preset: { instructions: string } };
    expect(detail.preset.instructions).toContain("页面逻辑");
    const copied = await fetch(`${base}/api/agent-presets/frontend/copy`, { method: "POST", headers: json, body: "{}" }).then(response => response.json()) as { preset: { id: string } };
    const id = copied.preset.id;
    const forbidden = await fetch(`${base}/api/agent-presets/${id}`, { method: "PUT", headers: { ...json, origin: "http://other.invalid" }, body: "{}" });
    expect(forbidden.status).toBe(403);
    const saved = await fetch(`${base}/api/agent-presets/${id}`, { method: "PUT", headers: json, body: JSON.stringify({ name: "产品前端", description: "实现页面", instructions: "详细的项目角色要求" }) });
    expect(saved.status).toBe(200);
    const toggled = await fetch(`${base}/api/agent-presets/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ enabled: false }) });
    expect(toggled.status).toBe(200);
    const restored = await new AgentPresetStore(join(root, ".alpha")).get(id);
    expect(restored).toMatchObject({ name: "产品前端", enabled: false, instructions: "详细的项目角色要求" });
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
