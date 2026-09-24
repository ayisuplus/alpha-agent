import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintSource } from "../src/runtime/task-ledger";
import { executeWorkOrders, recoverIncompleteMerges, type WorkOrder } from "../src/runtime/work-orders";

const orders: WorkOrder[] = [
  { id: "first", objective: "Change first module", ownedPaths: ["src/first.txt"], resources: ["module:first"] },
  { id: "second", objective: "Change second module", ownedPaths: ["src/second.txt"], resources: ["module:second"] },
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alpha-workers-test-"));
  const projectRoot = join(root, "product");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "first.txt"), "first-old");
  await writeFile(join(projectRoot, "src", "second.txt"), "second-old");
  await writeFile(join(projectRoot, "alpha-verification.json"), "{}");
  return { root, projectRoot, dataRoot: join(root, "state"), baseRevision: await fingerprintSource(projectRoot) };
}

test("two isolated workers merge only their owned changes", async () => {
  const input = await fixture();
  let active = 0;
  let peak = 0;
  try {
    const report = await executeWorkOrders({ ...input, taskId: "11111111-1111-4111-8111-111111111111", orders,
      async runWorker(order, directory) {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(10);
        await writeFile(join(directory, "src", `${order.id}.txt`), `${order.id}-new`);
        active--;
        return { evidence: [`${order.id}-result`], unresolved: [] };
      },
    });
    expect(report.status).toBe("merged");
    expect(report.elapsedMs).toBeGreaterThan(0);
    expect(peak).toBe(2);
    expect(report.committed).toEqual(["src/first.txt", "src/second.txt"]);
    expect(report.mergedRevision).toBe(await fingerprintSource(input.projectRoot));
    expect(await readFile(join(input.projectRoot, "src", "first.txt"), "utf8")).toBe("first-new");
    expect(await readFile(join(input.projectRoot, "src", "second.txt"), "utf8")).toBe("second-new");
    expect(JSON.parse(await readFile(join(report.workRoot, "merge.json"), "utf8")).status).toBe("merged");
  } finally {
    await rm(input.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an unowned worker edit is rejected before any merge", async () => {
  const input = await fixture();
  try {
    const report = await executeWorkOrders({ ...input, taskId: "22222222-2222-4222-8222-222222222222", orders,
      async runWorker(order, directory) {
        await writeFile(join(directory, order.id === "first" ? "alpha-verification.json" : "src/second.txt"), "changed");
        return { evidence: [], unresolved: [] };
      },
    });
    expect(report.status).toBe("rejected");
    expect(report.reason).toContain("unowned file");
    expect(report.committed).toEqual([]);
    expect(await fingerprintSource(input.projectRoot)).toBe(input.baseRevision);
  } finally {
    await rm(input.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("main-project changes and overlapping ownership prevent merge", async () => {
  const input = await fixture();
  try {
    await expect(executeWorkOrders({ ...input, taskId: "33333333-3333-4333-8333-333333333333", orders: [orders[0], { ...orders[1], ownedPaths: ["src/"] }],
      async runWorker() { throw new Error("must not run"); },
    })).rejects.toThrow("Conflicting");
    await expect(executeWorkOrders({ ...input, taskId: "33333333-3333-4333-8333-333333333333", orders: [orders[0], { ...orders[1], resources: ["module:first"] }],
      async runWorker() { throw new Error("must not run"); },
    })).rejects.toThrow("Conflicting resource");
    const report = await executeWorkOrders({ ...input, taskId: "33333333-3333-4333-8333-333333333333", orders,
      async runWorker(order, directory) {
        await writeFile(join(directory, "src", `${order.id}.txt`), `${order.id}-new`);
        if (order.id === "second") await writeFile(join(input.projectRoot, "src", "second.txt"), "user-edit");
        return { evidence: [], unresolved: [] };
      },
    });
    expect(report.status).toBe("rejected");
    expect(report.reason).toContain("Main project changed");
    expect(await readFile(join(input.projectRoot, "src", "first.txt"), "utf8")).toBe("first-old");
    expect(await readFile(join(input.projectRoot, "src", "second.txt"), "utf8")).toBe("user-edit");
  } finally {
    await rm(input.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("cancellation before merge leaves the main project untouched", async () => {
  const input = await fixture();
  const controller = new AbortController();
  try {
    const report = await executeWorkOrders({ ...input, taskId: "44444444-4444-4444-8444-444444444444", orders, signal: controller.signal,
      async runWorker(order, directory) {
        await writeFile(join(directory, "src", `${order.id}.txt`), `${order.id}-new`);
        if (order.id === "second") controller.abort(new Error("user cancelled"));
        return { evidence: [], unresolved: [] };
      },
    });
    expect(report.status).toBe("rejected");
    expect(report.reason).toContain("user cancelled");
    expect(report.committed).toEqual([]);
    expect(await fingerprintSource(input.projectRoot)).toBe(input.baseRevision);
  } finally {
    await rm(input.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an interrupted merge restores only journaled worker changes", async () => {
  const input = await fixture();
  const taskId = "55555555-5555-4555-8555-555555555555";
  const workRoot = join(input.dataRoot, "workers", taskId, "interrupted");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    await mkdir(join(workRoot, "base", "src"), { recursive: true });
    await writeFile(join(workRoot, "base", "src", "first.txt"), "first-old");
    await writeFile(join(workRoot, "base", "src", "second.txt"), "second-old");
    await writeFile(join(input.projectRoot, "src", "first.txt"), "first-new");
    await writeFile(join(workRoot, "merge.json"), JSON.stringify({ status: "merging", workRoot, planned: {
      "src/first.txt": { before: hash("first-old"), after: hash("first-new") },
      "src/second.txt": { before: hash("second-old"), after: hash("second-new") },
    }, committed: [] }));
    expect(await recoverIncompleteMerges(input.projectRoot, input.dataRoot, taskId)).toEqual([workRoot]);
    expect(await fingerprintSource(input.projectRoot)).toBe(input.baseRevision);
    const report = JSON.parse(await readFile(join(workRoot, "merge.json"), "utf8"));
    expect(report.status).toBe("rejected");
    expect(report.rolledBack).toEqual(["src/first.txt"]);
  } finally { await rm(input.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("recovery refuses to overwrite an independent edit", async () => {
  const input = await fixture();
  const taskId = "66666666-6666-4666-8666-666666666666";
  const workRoot = join(input.dataRoot, "workers", taskId, "interrupted");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    await mkdir(join(workRoot, "base", "src"), { recursive: true });
    await writeFile(join(workRoot, "base", "src", "first.txt"), "first-old");
    await writeFile(join(input.projectRoot, "src", "first.txt"), "user-edit");
    await writeFile(join(workRoot, "merge.json"), JSON.stringify({ status: "merging", workRoot, planned: {
      "src/first.txt": { before: hash("first-old"), after: hash("first-new") },
    }, committed: [] }));
    await expect(recoverIncompleteMerges(input.projectRoot, input.dataRoot, taskId)).rejects.toThrow("changed independently");
    expect(await readFile(join(input.projectRoot, "src", "first.txt"), "utf8")).toBe("user-edit");
  } finally { await rm(input.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
