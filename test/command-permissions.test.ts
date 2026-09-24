import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandApprovalStore, commandRisk } from "../src/runtime/command-approval";
import { configuredChecks, runCodeCheck } from "../src/runtime/code-check";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

test("a completed command gets a new one-time approval record", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  const store = new CommandApprovalStore(folder);
  const argv = [process.execPath, "-e", 'console.log("ALPHA_OK")'];
  const permission = { mode: "full" as const, roots: [folder] };
  const first = await store.execute("task", folder, argv, "check", undefined, permission);
  expect(first.status).toBe("complete");
  expect(first.result?.exitCode).toBe(0);
  const repeat = await store.execute("task", folder, argv, "check", undefined, permission);
  expect(repeat.status).toBe("complete");
  expect(repeat.id).not.toBe(first.id);
});

test("ask mode waits for a user decision", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  const store = new CommandApprovalStore(folder);
  const request = await store.execute("task", folder, [process.execPath, "--version"], "other", undefined, { mode: "ask", roots: [folder] });
  expect(request.status).toBe("pending");
  const approved = await store.decide("task", request.id, true);
  expect(approved.review?.reviewer).toBe("user");
  expect(approved.status).toBe("approved");
});

test("high-risk commands stay with user even in full mode", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  const store = new CommandApprovalStore(folder);
  expect(commandRisk(["powershell", "-Command", "Remove-Item", "x"])).toBe("high");
  expect(commandRisk(["powershell", "-Command", "Get-Content C:\\Users\\me\\.ssh\\id_rsa"])).toBe("high");
  const request = await store.execute("task", folder, ["powershell", "-Command", "Remove-Item", "x"], "other", undefined, { mode: "full", roots: [folder] });
  expect(request.status).toBe("pending");
});

test("auto review denial cannot execute a command", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  const store = new CommandApprovalStore(folder);
  const request = await store.execute("task", folder, [process.execPath, "-e", 'console.log("ALPHA_OK")'], "other", undefined,
    { mode: "auto", roots: [folder] }, async () => ({ decision: "deny", reason: "Unnecessary command" }));
  expect(request.status).toBe("denied");
  expect(request.review?.reviewer).toBe("independent-agent");
});

test("auto review timeout leaves the exact command pending", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  const store = new CommandApprovalStore(folder);
  const argv = [process.execPath, "-e", 'console.log("NO_EXECUTION")'];
  const request = await store.execute("task", folder, argv, "other", undefined,
    { mode: "auto", roots: [folder] }, async () => { throw new Error("review timed out"); });
  expect(request.status).toBe("pending");
  expect(request.reason).toContain("review timed out");
  expect(request.result).toBeUndefined();
});

test("network escalation stays with the user in restricted modes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  const store = new CommandApprovalStore(folder);
  const request = await store.execute("task", folder, [process.execPath, "--version"], "other", undefined,
    { mode: "auto", roots: [folder] }, async () => ({ decision: "approve", reason: "not reached" }), true);
  expect(request.status).toBe("pending");
  expect(request.risk).toBe("high");
  expect(request.network).toBe(true);
});

test("a changed package script invalidates its command approval", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  await writeFile(join(folder, "package.json"), JSON.stringify({ scripts: { clean: "rimraf dist" } }));
  const store = new CommandApprovalStore(folder);
  const argv = [process.execPath, "run", "clean"];
  const first = await store.execute("task", folder, argv, "other", undefined, { mode: "full", roots: [folder] });
  expect(first.status).toBe("pending");
  expect(first.scriptCommand).toBe("rimraf dist");
  await store.decide("task", first.id, true);
  await writeFile(join(folder, "package.json"), JSON.stringify({ scripts: { clean: "echo changed" } }));
  const changed = await store.execute("task", folder, argv, "other", undefined, { mode: "ask", roots: [folder] });
  expect(changed.id).not.toBe(first.id);
  expect(changed.status).toBe("pending");
});

test("configured destructive check requires an approval receipt", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alpha-command-"));
  folders.push(folder);
  await writeFile(join(folder, "package.json"), JSON.stringify({ scripts: { check: "rimraf dist" } }));
  const checks = await configuredChecks(folder);
  await expect(runCodeCheck(folder, folder, "task", "check", checks, undefined, { mode: "full", roots: [folder] })).rejects.toThrow("high-risk");
});
