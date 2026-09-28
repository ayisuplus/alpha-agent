import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMailbox, type AgentMessage, createWorkerMailboxTools, pendingFromState } from "../src/runtime/agent-mailbox";
import { mailboxReducers } from "../src/runtime/task-events/apply/mailbox";
import { InvariantError } from "../src/runtime/task-events/errors";
import { readEvents, taskLogDir } from "../src/runtime/task-events/log";
import type { TaskEventOf, TaskEventType } from "../src/runtime/task-events/types";
import { TaskLedger, type TaskState } from "../src/runtime/task-ledger";
import type { WorkOrder } from "../src/runtime/work-orders";

const AT = "2026-09-28T00:00:00.000Z";
const T1 = "2026-09-28T01:00:00.000Z";
const T2 = "2026-09-28T02:00:00.000Z";

function baseState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    objective: "Ship the feature",
    projectRoot: "/srv/project",
    criteria: [],
    status: "active",
    revision: "rev-1",
    evidence: [],
    preview: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function apply<Type extends TaskEventType>(state: TaskState, type: Type, payload: TaskEventOf<Type>["payload"]): void {
  const reducer = mailboxReducers[type] as ((state: TaskState, event: TaskEventOf<Type>) => void) | undefined;
  if (!reducer) throw new Error(`mailboxReducers has no reducer for ${type}`);
  reducer(state, { seq: 1, at: T1, actor: "runtime", type, payload });
}

function expectInvariant(fn: () => void, code: string, message: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InvariantError);
  expect((thrown as InvariantError).code).toBe(code);
  expect((thrown as InvariantError).message).toBe(message);
}

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "m1", taskId: "task-1", fromAgentId: "agent-1", fromRunId: "run-1", toAgentId: null,
    kind: "information", body: "Findings", evidence: [], contractVersion: 1, baseRevision: null,
    recordedAt: AT, ...overrides,
  };
}

describe("worker/message-queued", () => {
  test("appends the message and initializes the array", () => {
    const state = baseState();
    apply(state, "worker/message-queued", { message: message() });
    expect(state.workerMessages).toEqual([message()]);
    expect(state.updatedAt).toBe(AT);
  });

  test("redelivery of the same message with a new timestamp is a no-op", () => {
    const state = baseState();
    apply(state, "worker/message-queued", { message: message() });
    apply(state, "worker/message-queued", { message: message({ recordedAt: T1 }) });
    expect(state.workerMessages).toHaveLength(1);
    expect(state.workerMessages![0].recordedAt).toBe(AT);
  });

  test("a reused id with different content is rejected", () => {
    const state = baseState();
    apply(state, "worker/message-queued", { message: message() });
    expectInvariant(
      () => apply(state, "worker/message-queued", { message: message({ body: "Other findings", recordedAt: T1 }) }),
      "apply/message-id-reused",
      "Message ID was reused with different content",
    );
    expect(state.workerMessages).toHaveLength(1);
  });
});

describe("worker/message-acknowledged", () => {
  test("records the acknowledgement after the message was queued", () => {
    const state = baseState();
    apply(state, "worker/message-queued", { message: message() });
    apply(state, "worker/message-acknowledged", { id: "m1", agentId: null, acknowledgedAt: T1 });
    expect(state.workerMessageAcks).toEqual([{ id: "m1", agentId: null, acknowledgedAt: T1 }]);
  });

  test("the same recipient acknowledging twice is a no-op", () => {
    const state = baseState();
    apply(state, "worker/message-queued", { message: message() });
    apply(state, "worker/message-acknowledged", { id: "m1", agentId: null, acknowledgedAt: T1 });
    apply(state, "worker/message-acknowledged", { id: "m1", agentId: null, acknowledgedAt: T2 });
    expect(state.workerMessageAcks).toEqual([{ id: "m1", agentId: null, acknowledgedAt: T1 }]);
  });

  test("acknowledging a message that was never queued is rejected", () => {
    const state = baseState();
    expectInvariant(
      () => apply(state, "worker/message-acknowledged", { id: "m9", agentId: null, acknowledgedAt: T1 }),
      "apply/message-unknown",
      "Acknowledged a message that was never queued",
    );
    expect(state.workerMessageAcks).toBeUndefined();
  });
});

describe("pendingFromState", () => {
  test("is empty when nothing was queued", () => {
    expect(pendingFromState(baseState(), null)).toEqual([]);
  });

  test("subtracts the recipient's acknowledgements and orders by recordedAt then id", () => {
    const state = baseState({
      workerMessages: [
        message({ id: "b", recordedAt: T2 }),
        message({ id: "a", recordedAt: T1 }),
        message({ id: "c", recordedAt: T1 }),
        message({ id: "d", toAgentId: "agent-9", fromAgentId: null, fromRunId: null }),
      ],
      workerMessageAcks: [
        { id: "a", agentId: null, acknowledgedAt: T2 },
        { id: "d", agentId: null, acknowledgedAt: T2 },
      ],
    });
    expect(pendingFromState(state, null).map(item => item.id)).toEqual(["c", "b"]);
    // The coordinator acknowledging `d` does not consume it for its recipient.
    expect(pendingFromState(state, "agent-9").map(item => item.id)).toEqual(["d"]);
  });
});

test("the mailbox writes queue and ack events and pendingFromState rebuilds the file inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-mailbox-events-"));
  try {
    const projectRoot = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "entry.txt"), "source");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Coordinate agents", projectRoot, taskType: "code-change", criteria: [{ id: "source", description: "Source", kind: "asset" }] });
    const agentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const order: WorkOrder = { id: "research", objective: "Investigate", mode: "investigate", ownedPaths: [], readPaths: ["."], resources: ["research"], acceptance: ["Report findings"], agentId, instanceId: runId, fullAccess: true };
    await ledger.queueWorker({ id: runId, order });
    const stateRoot = join(dataRoot, "worker-agents", ledger.state.id, agentId, "state");
    const [workerSend, workerInbox] = createWorkerMailboxTools(stateRoot, ledger.state.id, order, ledger);
    expect((await workerSend.execute("call-1", { kind: "information", body: "First finding" }, undefined, undefined as never)).isError).toBeUndefined();
    expect((await workerSend.execute("call-2", { kind: "information", body: "Second finding" }, undefined, undefined as never)).isError).toBeUndefined();

    const mailbox = new AgentMailbox(dataRoot, ledger);
    expect(await mailbox.collect()).toBe(true);
    // A replayed collect() redelivers the same files without appending the events twice.
    expect(await mailbox.collect()).toBe(false);
    const pending = await mailbox.inbox();
    expect(pending).toHaveLength(2);
    const byId = (a: AgentMessage, b: AgentMessage) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    expect([...pendingFromState(ledger.state, null)].sort(byId)).toEqual(pending);

    const replyId = await mailbox.send(agentId, "decision", "Proceed", "reply-1");
    expect(pendingFromState(ledger.state, agentId).map(item => item.id)).toEqual([replyId]);
    expect((await workerInbox.execute("read-1", { ack: [replyId] }, undefined, undefined as never)).isError).toBeUndefined();
    expect(pendingFromState(ledger.state, agentId)).toEqual([]);
    expect(await mailbox.inbox(pending.map(item => item.id))).toHaveLength(0);
    expect(pendingFromState(ledger.state, null)).toEqual([]);

    // The files stay the transport: messages and ack markers are still on disk for the worker children.
    const coordinatorInbox = join(dataRoot, "worker-messages", ledger.state.id, "coordinator");
    expect(await Bun.file(join(coordinatorInbox, `${pending[0].id}.json`)).exists()).toBe(true);
    expect(await Bun.file(join(coordinatorInbox, "ack", pending[0].id)).exists()).toBe(true);
    expect(await Bun.file(join(stateRoot, "inbox", `${replyId}.json`)).exists()).toBe(true);
    expect(await Bun.file(join(stateRoot, "inbox", "ack", replyId)).exists()).toBe(true);

    const events = await readEvents(taskLogDir(ledger.file));
    const queued = events.filter((event): event is TaskEventOf<"worker/message-queued"> => event.type === "worker/message-queued");
    expect(queued).toHaveLength(3);
    expect([...queued.map(event => event.payload.message.id)].sort()).toEqual([...pending.map(item => item.id), replyId].sort());
    const acks = events.filter((event): event is TaskEventOf<"worker/message-acknowledged"> => event.type === "worker/message-acknowledged");
    expect(acks).toHaveLength(3);
    expect(acks[0].payload).toMatchObject({ id: replyId, agentId });
    expect(acks.slice(1).map(event => event.payload)).toEqual(pending.map(item => ({ id: item.id, agentId: null, acknowledgedAt: expect.any(String) })));
  } finally { await rm(root, { recursive: true, force: true }); }
});
