import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { compareVersions, latestOmpVersion, OmpUpdateMonitor } from "../src/native/omp-update-monitor";

test("compares stable OMP versions numerically", () => {
  expect(compareVersions("18.4.10", "18.4.3")).toBe(1);
  expect(compareVersions("18.4.3", "18.4.3")).toBe(0);
  expect(compareVersions("18.3.9", "18.4.3")).toBe(-1);
});

test("requires all four official npm packages to publish one coherent version", async () => {
  const urls: string[] = [];
  const same = async (url: string) => { urls.push(url); return Response.json({ version: "18.5.0" }); };
  expect(await latestOmpVersion(same)).toBe("18.5.0");
  expect(urls).toHaveLength(4);
  expect(urls.every(url => url.startsWith("https://registry.npmjs.org/@oh-my-pi%2F"))).toBe(true);
  let count = 0;
  const partial = async () => Response.json({ version: ++count === 4 ? "18.4.3" : "18.5.0" });
  expect(latestOmpVersion(partial)).rejects.toThrow("still publishing");
});

test("records a new release and remembers that the desktop announced it", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-omp-update-test-"));
  try {
    let calls = 0;
    const fetcher = async () => { calls++; return Response.json({ version: "18.5.0" }); };
    const monitor = new OmpUpdateMonitor("18.4.3", root, fetcher);
    await monitor.start();
    const available = monitor.status();
    expect(available.available).toBe(true);
    expect(available.latest).toBe("18.5.0");
    expect(calls).toBe(4);
    await monitor.markNotified("18.5.0");
    expect(monitor.status().notifiedVersion).toBe("18.5.0");
    const resumed = new OmpUpdateMonitor("18.4.3", root, fetcher);
    await resumed.start();
    expect(resumed.status().notifiedVersion).toBe("18.5.0");
    expect(calls).toBe(8);
  } finally {
    const actual = await realpath(root);
    if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error("Update test directory left temp root");
    await rm(actual, { recursive: true, force: true });
  }
});
