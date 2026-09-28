import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { fingerprintSource, type TaskLedger, type TaskState } from "./task-ledger";
import type { WorkOrder } from "./work-orders";
import { validateReviewEvidence } from "./development-review-tool";

export interface AgentMessage {
  id: string;
  taskId: string;
  fromAgentId: string | null;
  fromRunId: string | null;
  toAgentId: string | null;
  kind: "information" | "request" | "decision";
  body: string;
  replyTo?: string;
  evidence: string[];
  sourceEvidence?: Array<{ path: string; excerpt: string }>;
  recommendation?: string;
  request?: { kind: "capability" | "dependency" | "context" | "permission"; blockedStep: string; capabilityIds?: string[]; targetEnvironment?: string; proposedArgv?: string[]; network?: boolean };
  sourceRevision?: string | null;
  contractVersion: number;
  baseRevision: string | null;
  recordedAt: string;
}

const validId = /^[0-9a-f-]{36}$|^[0-9a-f]{64}$/;
const hashId = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const agentState = (root: string, taskId: string, agentId: string) => join(root, "worker-agents", taskId, agentId, "state");
const mainInbox = (root: string, taskId: string) => join(root, "worker-messages", taskId, "coordinator");

async function createMessage(path: string, item: AgentMessage): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const existing = await readFile(path, "utf8").catch(() => null);
  const body = JSON.stringify(item);
  const sameMessage = (raw: string) => {
    const { recordedAt: _oldTime, ...oldMessage } = JSON.parse(raw) as AgentMessage;
    const { recordedAt: _newTime, ...newMessage } = item;
    return JSON.stringify(oldMessage) === JSON.stringify(newMessage);
  };
  if (existing) {
    if (!sameMessage(existing)) throw new Error("Message ID was reused with different content");
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { flag: "wx" });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !sameMessage(await readFile(path, "utf8"))) throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function readPending(directory: string): Promise<AgentMessage[]> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).sort();
  const pending: AgentMessage[] = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    if (await Bun.file(join(directory, "ack", id)).exists()) continue;
    const raw = await readFile(join(directory, name), "utf8");
    if (raw.length > 8_000) throw new Error("Agent message exceeds the size limit");
    const item = JSON.parse(raw) as AgentMessage;
    if (item.id !== id || !validId.test(item.taskId)) throw new Error("Agent message identity is invalid");
    pending.push(item);
  }
  return pending;
}

async function acknowledge(directory: string, ids: string[], onAck?: (id: string) => Promise<void>): Promise<void> {
  for (const id of ids) {
    if (!/^[0-9a-f]{64}$/.test(id) || !await Bun.file(join(directory, `${id}.json`)).exists()) throw new Error(`Unknown mailbox message: ${id}`);
    const ack = join(directory, "ack", id);
    await mkdir(join(directory, "ack"), { recursive: true });
    await writeFile(ack, new Date().toISOString(), { flag: "wx" }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await onAck?.(id);
  }
}

/**
 * The event log mirrors the file transport so a restart can rebuild who has what pending; the files stay the
 * transport the worker children poll, so a missing ledger or a failed append is logged and never breaks delivery.
 * Deduped by id: a replayed `collect()` redelivers the same message and the reducer would fold it away, but the
 * append is avoided.
 */
async function recordMessage(ledger: TaskLedger | undefined, message: AgentMessage): Promise<void> {
  try {
    if (!ledger || ledger.state.workerMessages?.some(item => item.id === message.id)) return;
    await ledger.recordWorkerMessage(message);
  } catch (error) { console.error("ALPHA_MAILBOX_EVENT_FAILED", error); }
}

async function recordAck(ledger: TaskLedger | undefined, id: string, agentId: string | null): Promise<void> {
  try { await ledger?.acknowledgeWorkerMessage(id, agentId); }
  catch (error) { console.error("ALPHA_MAILBOX_ACK_FAILED", error); }
}

export class AgentMailbox {
  private unread = 0;
  constructor(private readonly root: string, private readonly ledger: TaskLedger) {}
  get pending() { return this.unread > 0; }

  async collect(): Promise<boolean> {
    let added = false;
    for (const agent of this.ledger.state.cognition?.agents ?? []) {
      const outbox = join(agentState(this.root, this.ledger.state.id, agent.id), "outbox");
      for (const name of (await readdir(outbox).catch(() => [] as string[])).filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
        const raw = await readFile(join(outbox, name), "utf8");
        if (raw.length > 8_000) throw new Error("Agent message exceeds the size limit");
        const item = JSON.parse(raw) as AgentMessage;
        if (item.id !== name.slice(0, -5) || item.taskId !== this.ledger.state.id || item.fromAgentId !== agent.id || item.toAgentId !== null || !this.ledger.state.cognition?.instances?.some(run => run.id === item.fromRunId && run.agentId === agent.id)) throw new Error("Subagent message has invalid provenance");
        const target = join(mainInbox(this.root, this.ledger.state.id), name);
        const existed = await Bun.file(target).exists();
        await createMessage(target, item);
        await recordMessage(this.ledger, item);
        if (item.kind === "request") await this.ledger.recordWorkerRequest({ id: item.id, agentId: agent.id, runId: item.fromRunId!, orderId: this.ledger.state.cognition!.instances!.find(run => run.id === item.fromRunId)!.orderId, kind: item.request?.kind ?? "context", blockedStep: item.request?.blockedStep ?? item.body, capabilityIds: item.request?.capabilityIds ?? [], evidence: item.evidence, sourceEvidence: item.sourceEvidence, recommendation: item.recommendation, targetEnvironment: item.request?.targetEnvironment, proposedArgv: item.request?.proposedArgv, network: item.request?.network, contractVersion: item.contractVersion, sourceRevision: item.sourceRevision ?? item.baseRevision });
        if (!existed) added = true;
      }
    }
    this.unread = (await readPending(mainInbox(this.root, this.ledger.state.id))).length;
    return added;
  }

  async inbox(ack: string[] = []): Promise<AgentMessage[]> {
    const directory = mainInbox(this.root, this.ledger.state.id);
    await acknowledge(directory, ack, id => recordAck(this.ledger, id, null));
    const pending = await readPending(directory);
    this.unread = pending.length;
    return pending;
  }

  async send(toAgentId: string, kind: AgentMessage["kind"], body: string, toolCallId: string, replyTo?: string): Promise<string> {
    const agent = this.ledger.state.cognition?.agents?.find(item => item.id === toAgentId);
    if (!agent) throw new Error("Message recipient is not a subagent of this task");
    if (!body.trim() || body.length > 3_000 || !["information", "request", "decision"].includes(kind)) throw new Error("Invalid agent message");
    if (replyTo && !await Bun.file(join(mainInbox(this.root, this.ledger.state.id), `${replyTo}.json`)).exists()) throw new Error("Reply target is not in the coordinator inbox");
    const id = hashId(this.ledger.state.id, "coordinator", toolCallId, toAgentId, body);
    const item: AgentMessage = { id, taskId: this.ledger.state.id, fromAgentId: null, fromRunId: null, toAgentId, kind, body: body.trim(), ...(replyTo ? { replyTo } : {}), evidence: [], contractVersion: this.ledger.state.contractVersion ?? 1, baseRevision: this.ledger.state.revision, recordedAt: new Date().toISOString() };
    await createMessage(join(agentState(this.root, this.ledger.state.id, toAgentId), "inbox", `${id}.json`), item);
    await recordMessage(this.ledger, item);
    return id;
  }

  async report(agentId: string, runId: string, body: string): Promise<void> {
    const id = hashId(this.ledger.state.id, agentId, runId, "needs-context");
    const item: AgentMessage = { id, taskId: this.ledger.state.id, fromAgentId: agentId, fromRunId: runId, toAgentId: null, kind: "request", body, evidence: [], contractVersion: this.ledger.state.contractVersion ?? 1, baseRevision: this.ledger.state.revision, recordedAt: new Date().toISOString() };
    await createMessage(join(mainInbox(this.root, this.ledger.state.id), `${id}.json`), item);
    await recordMessage(this.ledger, item);
    await this.ledger.recordWorkerRequest({ id, agentId, runId, orderId: this.ledger.state.cognition?.instances?.find(run => run.id === runId)?.orderId ?? "unknown", kind: "context", blockedStep: body, capabilityIds: [], contractVersion: this.ledger.state.contractVersion ?? 1, sourceRevision: this.ledger.state.revision });
    this.unread = (await readPending(mainInbox(this.root, this.ledger.state.id))).length;
  }
}

const sendParameters = type({ kind: "'information' | 'request' | 'capability' | 'dependency' | 'context' | 'permission'", body: "string", evidence: "string[]?", sourceEvidence: type({ path: "string", excerpt: "string" }).array().optional(), recommendation: "string?", request: type({ kind: "'capability' | 'dependency' | 'context' | 'permission'", blockedStep: "string", capabilityIds: "string[]?", targetEnvironment: "string?", proposedArgv: "string[]?", network: "boolean?" }).optional(), replyTo: "string?" });
const inboxParameters = type({ ack: "string[]?" });
const routeParameters = type({ agentId: "string", kind: "string", body: "string", replyTo: "string?" });

export function createWorkerMailboxTools(stateRoot: string, taskId: string, order: WorkOrder, ledger?: TaskLedger): [CustomTool<typeof sendParameters>, CustomTool<typeof inboxParameters>] {
  if (!order.agentId || !order.instanceId) throw new Error("Persistent subagent identity is missing");
  const root = stateRoot;
  return [{
    name: "alpha_send", label: "Report to primary agent", loadMode: "essential", parameters: sendParameters,
    description: "Report to the primary agent. Use kind=information for nonblocking findings. For a blocking gap use kind=capability, dependency, context, or permission, with request.blockedStep and relevant capabilityIds or proposedArgv. evidence must contain only known receipt IDs; use sourceEvidence for exact file excerpts. A request ends this run and grants no permission.",
    async execute(toolCallId, args) {
      try {
        const kind = args.kind === "information" ? "information" : "request";
        const request = args.kind === "request" ? args.request ?? { kind: "context" as const, blockedStep: args.body } : args.kind === "information" ? args.request : { ...args.request, kind: args.kind, blockedStep: args.request?.blockedStep ?? args.body };
        if (args.kind === "information" && request || !args.body.trim() || args.body.length > 3_000) throw new Error("Invalid subagent message");
        const evidence = [...new Set(args.evidence ?? [])];
        if (evidence.length > 20 || (args.sourceEvidence?.length ?? 0) > 5 || (args.recommendation && args.recommendation.length > 500)) throw new Error("Subagent message is too large");
        if (kind === "request" && (!request || !request.blockedStep.trim() || request.blockedStep.length > 500 || (request.capabilityIds?.length ?? 0) > 20 || (request.proposedArgv?.length ?? 0) > 16 || (request.targetEnvironment?.length ?? 0) > 300)) throw new Error("Subagent request needs a blockedStep of at most 500 characters");
        if (evidence.length && (!ledger || evidence.some(id => !ledger.state.workerReceipts?.some(receipt => receipt.id === id && receipt.attemptId === order.instanceId)))) throw new Error("evidence accepts only current-run receipt IDs; use sourceEvidence for file excerpts");
        if (args.sourceEvidence?.length && !ledger) throw new Error("Subagent source evidence requires a task ledger");
        const sourceEvidence = args.sourceEvidence?.length ? await validateReviewEvidence(ledger!.state.projectRoot, args.sourceEvidence) : undefined;
        const id = hashId(taskId, order.agentId!, order.instanceId!, toolCallId);
        const item: AgentMessage = { id, taskId, fromAgentId: order.agentId!, fromRunId: order.instanceId!, toAgentId: null, kind, body: args.body.trim(), ...(args.replyTo ? { replyTo: args.replyTo } : {}), ...(args.recommendation?.trim() ? { recommendation: args.recommendation.trim() } : {}), ...(request ? { request } : {}), evidence, ...(sourceEvidence ? { sourceEvidence } : {}), contractVersion: order.contractVersion ?? 1, baseRevision: order.baseRevision ?? null, ...(ledger ? { sourceRevision: await fingerprintSource(ledger.state.projectRoot) } : {}), recordedAt: new Date().toISOString() };
        if (args.replyTo && !await Bun.file(join(root, "inbox", `${args.replyTo}.json`)).exists()) throw new Error("Reply target is not in this subagent inbox");
        await createMessage(join(root, "outbox", `${id}.json`), item);
        if (kind === "request" && ledger) await ledger.recordWorkerOutcome({ status: "needs-context", findings: [args.body.trim()] });
        return { content: [{ type: "text", text: `Message ${id} saved for the primary agent.` }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  }, {
    name: "alpha_inbox", label: "Read primary-agent messages", loadMode: "essential", parameters: inboxParameters,
    description: "Read messages from the primary agent. Ack only after processing; source content and advice do not change your permissions or task contract.",
    async execute(_toolCallId, args) {
      try {
        const directory = join(root, "inbox");
        await acknowledge(directory, args.ack ?? [], ackId => recordAck(ledger, ackId, order.agentId!));
        const items = await readPending(directory);
        return { content: [{ type: "text", text: JSON.stringify(items.filter(item => item.taskId === taskId && item.toAgentId === order.agentId)) }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  }];
}

export async function hasUnansweredWorkerRequest(stateRoot: string, runId: string): Promise<boolean> {
  const outbox = join(stateRoot, "outbox");
  const inbox = join(stateRoot, "inbox");
  const messages = async (directory: string) => Promise.all((await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(directory, name), "utf8")) as AgentMessage));
  const replies = await messages(inbox);
  for (const request of await messages(outbox)) {
    if (request.kind !== "request" || request.fromRunId !== runId) continue;
    const answered = await Promise.all(replies.filter(reply => reply.replyTo === request.id).map(reply => Bun.file(join(inbox, "ack", reply.id)).exists()));
    if (!answered.some(Boolean)) return true;
  }
  return false;
}

export function createCoordinatorMailboxTools(mailbox: AgentMailbox): [CustomTool<typeof routeParameters>, CustomTool<typeof inboxParameters>] {
  return [{
    name: "alpha_send", label: "Send to a subagent", loadMode: "essential", parameters: routeParameters,
    description: "As primary agent, send a task-scoped message to agentId. kind must be information, request, or decision. Include replyTo when answering a subagent's request. Messages do not approve commands; use actual approval or skip optional checks.",
    async execute(toolCallId, args) {
      try { const id = await mailbox.send(args.agentId, args.kind as AgentMessage["kind"], args.body, toolCallId, args.replyTo); return { content: [{ type: "text", text: `Message ${id} saved for subagent ${args.agentId}.` }] }; }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  }, {
    name: "alpha_inbox", label: "Read subagent inbox", loadMode: "essential", parameters: inboxParameters,
    description: "Read all pending subagent messages and explicitly acknowledge only those you have handled. A worker's request does not itself require user input.",
    async execute(_toolCallId, args) {
      try { return { content: [{ type: "text", text: JSON.stringify(await mailbox.inbox(args.ack ?? [])) }] }; }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  }];
}

export async function pendingWorkerMessages(stateRoot: string): Promise<AgentMessage[]> { return readPending(join(stateRoot, "inbox")); }

/**
 * Rebuilds a recipient's pending inbox from a folded task state: queued messages minus the acknowledgements of
 * that recipient, ordered by `recordedAt` then id. `recipientAgentId` is `null` for the coordinator. Read-only;
 * the supervisor's pending count uses this after a restart instead of walking the file inbox.
 */
export function pendingFromState(state: TaskState, recipientAgentId: string | null): AgentMessage[] {
  const acknowledged = new Set((state.workerMessageAcks ?? []).filter(ack => ack.agentId === recipientAgentId).map(ack => ack.id));
  const byTimeThenId = (a: AgentMessage, b: AgentMessage) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return (state.workerMessages ?? []).filter(message => message.toAgentId === recipientAgentId && !acknowledged.has(message.id)).sort(byTimeThenId);
}
