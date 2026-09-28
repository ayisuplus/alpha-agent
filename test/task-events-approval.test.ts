import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandApprovalStore, type CommandRequest } from "../src/runtime/command-approval";
import { TaskLedger, type TaskState } from "../src/runtime/task-ledger";
import { foldTask, readEvents, taskLogDir } from "../src/runtime/task-events";
import { WebApprovalRequired, WebPermissionStore, type WebApproval } from "../src/runtime/web-permissions";

/** The folded state carries the approval slices the owner will add to `TaskState`; the test reads them via a cast. */
type Folded = TaskState & { approvals?: CommandRequest[]; webApprovals?: WebApproval[] };

test("the approval lifecycle lands events in order and folds to the state the stores see", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "alpha-approval-events-"));
  try {
    const ledger = await TaskLedger.create(dataRoot, { objective: "test approvals", projectRoot: dataRoot, criteria: [], taskType: "general" });
    const taskId = ledger.state.id;
    const command = new CommandApprovalStore(dataRoot);
    const web = new WebPermissionStore(dataRoot);
    command.attach(ledger);
    web.attach(ledger);

    // Command lifecycle: request → decide → execute (runs a real command to completion).
    const argv = [process.execPath, "-e", 'console.log("ALPHA_OK")'];
    const request = await command.request(taskId, dataRoot, argv, "check");
    await command.decide(taskId, request.id, true);
    await command.execute(taskId, dataRoot, argv, "check", undefined, { mode: "full", roots: [dataRoot] });

    // Web lifecycle: require(write) → decide → beginWrite → finishWrite.
    let write: WebApproval;
    try { write = await web.require(taskId, "action:tab-1:click", "write", "req-1"); }
    catch (error) { write = (error as WebApprovalRequired).approval; }
    await web.decide(taskId, write.id, true);
    await web.beginWrite(taskId, write.id);
    await web.finishWrite(taskId, write.id, false);

    // (a) every transition lands in the task log, in order.
    const events = await readEvents(taskLogDir(ledger.file));
    expect(events.map(event => event.type)).toEqual([
      "task/created",
      "approval/requested", "approval/reviewed", "approval/claimed", "approval/finished",
      "web-approval/requested", "web-approval/decided", "web-approval/write-begun", "web-approval/write-finished",
    ]);

    // (b) the projection files keep their shape and are readable by the stores' own readers.
    const commandProjection = await command.list(taskId);
    expect(commandProjection).toHaveLength(1);
    expect(commandProjection[0]).toMatchObject({ id: request.id, taskId, purpose: "check", status: "complete", argv });
    expect(commandProjection[0].result?.exitCode).toBe(0);
    const webProjection = await web.list(taskId);
    expect(webProjection).toHaveLength(1);
    expect(webProjection[0]).toMatchObject({ id: write.id, taskId, kind: "write", scope: "action:tab-1:click", actionId: "req-1", status: "complete" });

    // (c) foldTask reproduces the state the stores see.
    const state = foldTask(events) as Folded;
    expect(state.approvals).toEqual(commandProjection);
    expect(state.webApprovals).toEqual(webProjection);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pre-event-log store files import once as origin events without touching the files", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "alpha-approval-import-"));
  try {
    const ledger = await TaskLedger.create(dataRoot, { objective: "import approvals", projectRoot: dataRoot, criteria: [], taskType: "general" });
    const taskId = ledger.state.id;

    // A command request and a web approval written directly by a build that predates the event log.
    const oldRequest: CommandRequest = { id: randomUUID(), taskId, cwd: "/proj", argv: ["echo", "hi"], purpose: "check", network: false, status: "pending", createdAt: new Date().toISOString(), reason: "Command is not a configured project check", risk: "normal" };
    await mkdir(join(dataRoot, "approvals", taskId), { recursive: true });
    const commandFile = join(dataRoot, "approvals", taskId, `${oldRequest.id}.json`);
    await writeFile(commandFile, JSON.stringify(oldRequest, null, 2));
    const oldWeb: WebApproval = { id: randomUUID(), taskId, kind: "write", scope: "action:tab-1:click", actionId: "req-1", status: "pending", requestedAt: new Date().toISOString() };
    await mkdir(join(dataRoot, "web-approvals"), { recursive: true });
    const webFile = join(dataRoot, "web-approvals", `${taskId}.json`);
    await writeFile(webFile, JSON.stringify([oldWeb], null, 2));
    const beforeCommand = await readFile(commandFile, "utf8");
    const beforeWeb = await readFile(webFile, "utf8");

    const command = new CommandApprovalStore(dataRoot);
    const web = new WebPermissionStore(dataRoot);
    command.attach(ledger);
    web.attach(ledger);
    await command.reconcile(taskId);
    await web.reconcile(taskId);
    await command.reconcile(taskId);
    await web.reconcile(taskId);
    const freshCommand = new CommandApprovalStore(dataRoot);
    const freshWeb = new WebPermissionStore(dataRoot);
    freshCommand.attach(ledger);
    freshWeb.attach(ledger);
    await freshCommand.reconcile(taskId);
    await freshWeb.reconcile(taskId);

    // The projections are unchanged and each import emitted its origin event exactly once across every store.
    expect(await readFile(commandFile, "utf8")).toBe(beforeCommand);
    expect(await readFile(webFile, "utf8")).toBe(beforeWeb);
    const events = await readEvents(taskLogDir(ledger.file));
    expect(events.filter(event => event.type === "approval/requested")).toHaveLength(1);
    expect(events.filter(event => event.type === "web-approval/requested")).toHaveLength(1);

    // The fold reproduces the imported records.
    const state = foldTask(events) as Folded;
    expect(state.approvals).toEqual([oldRequest]);
    expect(state.webApprovals).toEqual([oldWeb]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
