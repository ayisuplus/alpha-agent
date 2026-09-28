import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMailbox, createWorkerMailboxTools, pendingWorkerMessages } from "../src/runtime/agent-mailbox";
import { TaskLedger } from "../src/runtime/task-ledger";
import type { WorkOrder } from "../src/runtime/work-orders";
import { checkFileToolCall } from "../src/runtime/file-tool-guard";
import { createWorkerResultTool } from "../src/runtime/worker-result-tool";

test("subagent messages pass through the primary mailbox with durable IDs and explicit acknowledgements", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-agent-mailbox-"));
  try {
    const projectRoot = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "entry.txt"), "source");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Coordinate agents", projectRoot, taskType: "code-change", criteria: [{ id: "source", description: "Source", kind: "asset" }] });
    const agentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const preset = { id: "test-expert", name: "Test expert", description: "Test", instructions: "Test", hash: "a".repeat(64), skillIds: ["test:skill"], package: { revision: "b".repeat(64), skills: [{ id: "test:skill", hash: "c".repeat(64) }] } };
    const order: WorkOrder = { id: "research", objective: "Investigate", mode: "investigate", ownedPaths: [], readPaths: ["."], resources: ["research"], agentId, instanceId: runId, fullAccess: true, skillIds: ["test:skill"], expert: preset };
    const reads: string[] = [];
    await checkFileToolCall("alpha_send", {}, projectRoot, order, [], false, undefined, path => reads.push(path));
    await checkFileToolCall("alpha_inbox", {}, projectRoot, order, [], false, undefined, path => reads.push(path));
    expect(reads).toEqual([]);
    await ledger.queueWorker({ id: runId, order });
    const stateRoot = join(dataRoot, "worker-agents", ledger.state.id, agentId, "state");
    const [send, inbox] = createWorkerMailboxTools(stateRoot, ledger.state.id, order);
    const first = await send.execute("call-1", { kind: "request", body: "Need the acceptance boundary" }, undefined, undefined as never);
    expect(first.isError).toBeUndefined();
    expect((await send.execute("call-1", { kind: "request", body: "Need the acceptance boundary" }, undefined, undefined as never)).isError).toBeUndefined();
    const mailbox = new AgentMailbox(dataRoot, ledger);
    expect(await mailbox.collect()).toBe(true);
    expect(await mailbox.collect()).toBe(false);
    const messages = await mailbox.inbox();
    expect(messages).toHaveLength(1);
    expect(messages[0].fromAgentId).toBe(agentId);
    expect(messages[0].fromRunId).toBe(runId);
    expect(messages[0].toAgentId).toBeNull();
    const replyId = await mailbox.send(agentId, "decision", "Use the approved contract", "reply-1", messages[0].id);
    expect(await mailbox.send(agentId, "decision", "Use the approved contract", "reply-1", messages[0].id)).toBe(replyId);
    expect((await pendingWorkerMessages(stateRoot)).map(item => item.id)).toEqual([replyId]);
    expect((await inbox.execute("read-1", { ack: [replyId] }, undefined, undefined as never)).isError).toBeUndefined();
    expect(await pendingWorkerMessages(stateRoot)).toHaveLength(0);
    expect(await mailbox.inbox([messages[0].id])).toHaveLength(0);
    const outboxFile = join(stateRoot, "outbox", `${messages[0].id}.json`);
    const original = await readFile(outboxFile, "utf8");
    await writeFile(outboxFile, JSON.stringify({ ...JSON.parse(original), toAgentId: crypto.randomUUID() }));
    await expect(mailbox.collect()).rejects.toThrow("invalid provenance");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a worker escalates a false premise with a receipt and cannot complete before the answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-premise-escalation-"));
  try {
    const projectRoot = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "entry.txt"), "actual input differs from the order\n");
    const parent = await TaskLedger.create(dataRoot, { objective: "Use the actual input", projectRoot, taskType: "code-change", criteria: [{ id: "check", description: "Checked output", kind: "test" }] });
    const agentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const order: WorkOrder = { id: "inspect", objective: "Assume entry.txt contains old input", decisionReason: "Inspect an independent premise", mode: "investigate", ownedPaths: [], readPaths: ["entry.txt"], acceptance: ["Report the actual input"], resources: ["input"], agentId, instanceId: runId, fullAccess: true, contractVersion: 1, baseRevision: parent.state.revision ?? undefined };
    await parent.queueWorker({ id: runId, order });
    const stateRoot = join(dataRoot, "worker-agents", parent.state.id, agentId, "state");
    const worker = await TaskLedger.create(stateRoot, { objective: order.objective, projectRoot, taskType: "code-change", criteria: [{ id: "finding", description: "Report the actual input", kind: "asset" }] });
    const receiptId = await worker.recordWorkerCheckReceipt({ attemptId: runId, sourceRevision: worker.state.revision, passed: false, path: "check.log" });
    const [send, inbox] = createWorkerMailboxTools(stateRoot, parent.state.id, order, worker);
    const bad = await send.execute("bad", { kind: "request", body: "The premise is false", evidence: [crypto.randomUUID()] }, undefined, undefined as never);
    expect(bad.isError).toBe(true);
    const wrongExcerpt = await send.execute("wrong-excerpt", { kind: "request", body: "The premise is false", sourceEvidence: [{ path: "entry.txt", excerpt: "the assumed old input appears in this file" }] }, undefined, undefined as never);
    expect(wrongExcerpt.isError).toBe(true);
    const sent = await send.execute("request", { kind: "request", body: "entry.txt contains actual input; the old-input premise is false", evidence: [receiptId], sourceEvidence: [{ path: "entry.txt", excerpt: "actual input differs from the order" }], recommendation: "Revise the plan to use the actual input" }, undefined, undefined as never);
    expect(sent.isError).toBeUndefined();
    expect(worker.state.workerOutcome?.status).toBe("needs-context");
    const mailbox = new AgentMailbox(dataRoot, parent);
    await mailbox.collect();
    const [message] = await mailbox.inbox();
    expect(message).toMatchObject({ fromRunId: runId, evidence: [receiptId], sourceEvidence: [{ path: "entry.txt", excerpt: "actual input differs from the order" }], recommendation: "Revise the plan to use the actual input", contractVersion: 1 });
    expect(message.sourceRevision).toBe(worker.state.revision);
    const result = createWorkerResultTool(worker, order);
    expect((await result.execute("too-early", { status: "completed", findings: ["Found actual input"] }, undefined, undefined as never)).isError).toBe(true);
    expect((await result.execute("escalated", { status: "needs-context", findings: ["Premise changed; coordinator decision required"] }, undefined, undefined as never)).isError).toBeUndefined();
    await parent.reviseCognition({ summary: "Use actual input", reason: message.body, candidates: [], steps: [{ id: "recheck", objective: "Recheck against actual input", mode: "investigate", dependsOn: [], skillIds: [], status: "planned" }] });
    expect(parent.state.cognition?.amendments.at(-1)?.reason).toBe(message.body);
    expect(parent.completionGaps()).toContain("check");
    const replyId = await mailbox.send(agentId, "decision", "Use the revised plan", "reply", message.id);
    expect((await inbox.execute("read", { ack: [replyId] }, undefined, undefined as never)).isError).toBeUndefined();
    expect((await result.execute("answered", { status: "completed", findings: ["Actual input verified"] }, undefined, undefined as never)).isError).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("distinct coordinator decisions under one tool call id are all recorded and identical retries dedupe", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-decision-id-"));
  try {
    const projectRoot = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "entry.txt"), "source");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Coordinate agents", projectRoot, taskType: "code-change", criteria: [{ id: "source", description: "Source", kind: "asset" }] });
    const agentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const order: WorkOrder = { id: "job", objective: "Implement", mode: "implement", ownedPaths: [], readPaths: ["entry.txt"], resources: ["job"], acceptance: ["Implement the job"], agentId, instanceId: runId, fullAccess: true };
    await ledger.queueWorker({ id: runId, order });
    const mailbox = new AgentMailbox(dataRoot, ledger);
    const proceed = await mailbox.send(agentId, "decision", "Proceed with the install", "call-1");
    const denied = await mailbox.send(agentId, "decision", "User denied the installation command", "call-1");
    expect(denied).not.toBe(proceed);
    expect(await mailbox.send(agentId, "decision", "Proceed with the install", "call-1")).toBe(proceed);
  } finally { await rm(root, { recursive: true, force: true }); }
});
