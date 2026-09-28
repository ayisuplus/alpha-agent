import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promptHash, readPromptBlob } from "./prompt-blobs";
import { computeCompletionGaps } from "./task-completion";
import { eventLogPath, foldTask, readEvents, taskLogDir } from "./task-events";
import type { TaskState } from "./task-ledger";

/** The state the model saw at one step: objective, contract version, gaps, plan steps, pause/stop codes. */
export interface ReplayState {
  objective: string;
  contractVersion: number;
  gaps: string[];
  steps: string[];
  status: string;
  phase?: string;
  /** Why a `needs-input` task waited, when the step found one. */
  pauseReason?: string;
  /** Why a `stopped` task stopped, when the step found one. */
  stopReason?: string;
}

/** One `step/context` event rebuilt from the log and cross-checked against its stored task context block. */
export interface ReplayRow {
  seq: number;
  at: string;
  stage: string;
  model: string;
  systemTokens: number;
  toolTokens: number;
  taskContextBytes: number;
  taskContextHash: string;
  promptHash: string;
  toolNames: string[];
  /** The state the model saw: objective, contract version, gaps, plan steps, pause/stop codes. */
  state: ReplayState;
  /** Whether the stored block still hashes to `taskContextHash` and still names that state's objective. */
  verified: boolean;
  problem?: string;
  /** First line of the stored task context block, for a human reader. */
  preview: string;
}

/** The exact objective line `taskPrompt` emits; the stored block must still carry it for the rebuilt state. */
function objectiveLine(state: TaskState): string {
  return `Current objective v${state.contractVersion ?? 1}: ${state.objective}`;
}

function stateView(state: TaskState): ReplayState {
  return {
    objective: state.objective,
    contractVersion: state.contractVersion ?? 1,
    gaps: computeCompletionGaps(state),
    steps: (state.cognition?.steps ?? []).map(step => `${step.id} [${step.mode}/${step.status}] ${step.objective}`),
    status: state.status,
    ...(state.phase ? { phase: state.phase } : {}),
    ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
    ...(state.stop ? { stopReason: state.stop.reason } : {}),
  };
}

/**
 * Rebuilds what the model saw at every `step/context` event of one task and cross-checks it against the stored task
 * context block: the block must still hash to `taskContextHash` and must still carry the objective line for the state
 * at that point in the log. Read-only: it never writes the ledger or the blob store. A task whose log holds no
 * `step/context` event replays to an empty list; a task id without an event log is an error, not an empty replay.
 */
export async function replayTaskContexts(dataRoot: string, taskId: string): Promise<ReplayRow[]> {
  const dir = taskLogDir(join(dataRoot, "tasks", `${taskId}.json`));
  const log = eventLogPath(dir);
  if (!(await stat(log).then(() => true, () => false))) throw new Error(`任务事件日志不存在：${log}`);
  const events = await readEvents(dir, 0);
  const rows: ReplayRow[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type !== "step/context") continue;
    const payload = event.payload;
    const before = foldTask(events.slice(0, index));
    const problems: string[] = [];
    const text = await readPromptBlob(dataRoot, payload.taskContextHash);
    if (text === null) {
      problems.push(`存储块缺失：prompt-blobs/${payload.taskContextHash}.txt`);
    } else {
      const actual = promptHash(text);
      if (actual !== payload.taskContextHash) problems.push(`存储块内容哈希不符：实际 ${actual}，日志记录 ${payload.taskContextHash}`);
      // A block that is a task prompt must name the objective of the state at that step; a follow-up question block
      // has no objective line, so the hash alone binds it.
      const lines = text.split(/\r?\n/);
      const objective = lines.find(line => line.startsWith("Current objective v"));
      const expected = objectiveLine(before);
      if (objective !== undefined && objective !== expected) problems.push(`存储块目标行不符：${objective}，该步应为 ${expected}`);
    }
    rows.push({
      seq: event.seq,
      at: event.at,
      stage: payload.stage,
      model: payload.model,
      systemTokens: payload.systemTokens,
      toolTokens: payload.toolTokens,
      taskContextBytes: payload.taskContextBytes,
      taskContextHash: payload.taskContextHash,
      promptHash: payload.promptHash,
      toolNames: payload.toolNames,
      state: stateView(before),
      verified: problems.length === 0,
      ...(problems.length ? { problem: problems.join("；") } : {}),
      preview: text === null ? "" : (text.split(/\r?\n/)[0] ?? ""),
    });
  }
  return rows;
}
