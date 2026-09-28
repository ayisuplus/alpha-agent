import type { AgentMessage } from "../../agent-mailbox";
import type { TaskState } from "../../task-ledger";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/**
 * Mailbox family: agent messages and their acknowledgements (docs/cognitive-state-machine-plan-2026-09-28.md P3).
 * The files under `worker-messages`/`worker-agents` stay the transport the worker children poll; these events are
 * the durable record that lets a restart rebuild who has what pending via `pendingFromState`.
 */

/** The content check `createMessage` uses on the file transport: identical in everything except the timestamp. */
function sameContent(existing: AgentMessage, candidate: AgentMessage): boolean {
  const { recordedAt: _existingTime, ...restExisting } = existing;
  const { recordedAt: _candidateTime, ...restCandidate } = candidate;
  return JSON.stringify(restExisting) === JSON.stringify(restCandidate);
}

export const mailboxReducers: FamilyReducers = {
  // A replayed `collect()` redelivers the same message; identical content folds to a no-op, a reused id is a bug.
  "worker/message-queued": (state, event) => {
    const existing = (state.workerMessages ?? []).find(message => message.id === event.payload.message.id);
    if (existing) {
      if (!sameContent(existing, event.payload.message)) throw new InvariantError("apply/message-id-reused", "Message ID was reused with different content");
      return;
    }
    (state.workerMessages ??= []).push(event.payload.message);
  },

  "worker/message-acknowledged": (state, event) => {
    const { id, agentId, acknowledgedAt } = event.payload;
    if ((state.workerMessageAcks ?? []).some(ack => ack.id === id && ack.agentId === agentId)) return;
    if (!(state.workerMessages ?? []).some(message => message.id === id)) throw new InvariantError("apply/message-unknown", "Acknowledged a message that was never queued");
    (state.workerMessageAcks ??= []).push({ id, agentId, acknowledgedAt });
  },
};
