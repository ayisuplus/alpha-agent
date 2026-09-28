import { expect, test } from "bun:test";
import { api } from "../desktop/ui/src/api/client";
import type { OperationSnapshot, TaskList, TaskView } from "../desktop/ui/src/api/types";
import { browserOwner, isOccupied, previewLocked, refreshTasks, resumeTask, store, syncSelected, taskBusy, taskPhase } from "../desktop/ui/src/state/workbench";

const operation = (patch: Partial<OperationSnapshot>): OperationSnapshot => ({ id: crypto.randomUUID(), kind: "run", taskId: null, projectId: null, phase: "准备中", browserTaskId: null, cancellable: false, ...patch });

test("older task-list responses cannot revive a finished operation", async () => {
  const original = api.tasks;
  const pending: Array<(value: TaskList) => void> = [];
  api.tasks = () => new Promise(resolve => pending.push(resolve));
  try {
    store.set({ selectedId: null, starting: null, runs: [], operations: [] });
    const old = refreshTasks();
    const latest = refreshTasks();
    pending[1]({ tasks: [], runs: [], operations: [] });
    await latest;
    pending[0]({ tasks: [], runs: [{ runId: "run-old", taskId: "task-old", kind: "run" }], operations: [operation({ taskId: "task-old" })] });
    await old;
    expect(store.get().runs).toEqual([]);
    expect(store.get().operations).toEqual([]);
  } finally { api.tasks = original; }
});

test("older selected-task responses cannot replace a newer task state", async () => {
  const taskRequest = api.task;
  const activityRequest = api.activity;
  const reviewsRequest = api.reviews;
  const pending: Array<(value: TaskView) => void> = [];
  api.task = () => new Promise(resolve => pending.push(resolve));
  api.activity = async () => [];
  api.reviews = async () => [];
  try {
    store.set({ selectedId: "task-one", task: null, activity: [], reviews: [] });
    const old = syncSelected("task-one");
    const latest = syncSelected("task-one");
    pending[1]({ id: "task-one", status: "complete" } as TaskView);
    await latest;
    pending[0]({ id: "task-one", status: "active" } as TaskView);
    await old;
    expect(store.get().task?.status).toBe("complete");
  } finally { api.task = taskRequest; api.activity = activityRequest; api.reviews = reviewsRequest; }
});

test("an approval resumes its original task after the user selects another task", async () => {
  const taskRequest = api.task;
  const resumeRequest = api.resume;
  const tasksRequest = api.tasks;
  const activityRequest = api.activity;
  const reviewsRequest = api.reviews;
  let resumed: string | null = null;
  api.task = async id => ({ id, status: "needs-input" } as TaskView);
  api.resume = async id => { resumed = id; return { runId: "run-a" }; };
  api.tasks = async () => ({ tasks: [], runs: [{ runId: "run-a", taskId: "task-a", kind: "run" }], operations: [] });
  api.activity = async () => [];
  api.reviews = async () => [];
  try {
    store.set({ selectedId: "task-b", task: { id: "task-b", status: "active" } as TaskView, pending: null });
    expect(await resumeTask("approved", "task-a")).toBe(true);
    expect(String(resumed)).toBe("task-a");
    expect(store.get().selectedId).toBe("task-b");
  } finally { api.task = taskRequest; api.resume = resumeRequest; api.tasks = tasksRequest; api.activity = activityRequest; api.reviews = reviewsRequest; }
});

test("tasks running side by side keep their own busy state and phase", () => {
  store.set({
    pending: null, controlHolder: "alpha",
    runs: [{ runId: "run-a", taskId: "task-a", kind: "run" }, { runId: "run-b", taskId: "task-b", kind: "answer" }],
    operations: [operation({ taskId: "task-a", phase: "构建中" }), operation({ kind: "answer", taskId: "task-b", phase: "已回答" })],
  });
  const state = store.get();
  expect([taskBusy(state, "task-a"), taskBusy(state, "task-b"), taskBusy(state, "task-c")]).toEqual([true, true, false]);
  expect(taskPhase(state, "task-a")).toBe("构建中");
  // A settled phase is not shown as work in progress while the operation is being released.
  expect(taskPhase(state, "task-b")).toBeNull();
  expect(isOccupied(state, "task-c")).toBe(false);
  expect(isOccupied(state, "task-a")).toBe(true);
  // Model runs without the browser leave the preview free for the selected task.
  expect(browserOwner(state)).toBeNull();
  expect(previewLocked(state)).toBe(false);
});

test("only a task working in the browser reserves the preview", () => {
  store.set({ controlHolder: "alpha", runs: [], operations: [operation({ taskId: "task-a", phase: "构建中" }), operation({ kind: "verify", taskId: "task-c", phase: "浏览器验收", browserTaskId: "task-c" })] });
  expect(browserOwner(store.get())).toBe("task-c");
  expect(previewLocked(store.get())).toBe(true);
  store.set({ operations: [operation({ taskId: "task-d", phase: "浏览器验收" })] });
  expect(browserOwner(store.get())).toBe("task-d");
});

test("a started task opens once its own run reports the task it created, not another task's run", async () => {
  const tasksRequest = api.tasks;
  const taskRequest = api.task;
  const activityRequest = api.activity;
  const reviewsRequest = api.reviews;
  let runs: TaskList["runs"] = [{ runId: "run-other", taskId: "task-other", kind: "run" }, { runId: "run-new", taskId: null, kind: "run" }];
  api.tasks = async () => ({ tasks: [], runs, operations: [] });
  api.task = async id => ({ id, status: "active" } as TaskView);
  api.activity = async () => [];
  api.reviews = async () => [];
  try {
    store.set({ selectedId: null, task: null, panel: null, starting: { brief: "新任务", error: null, runId: "run-new" } });
    await refreshTasks();
    expect(store.get().selectedId).toBeNull();
    runs = [{ runId: "run-other", taskId: "task-other", kind: "run" }, { runId: "run-new", taskId: "task-new", kind: "run" }];
    await refreshTasks();
    expect(store.get().selectedId).toBe("task-new");
    expect(store.get().starting).toBeNull();
  } finally { api.tasks = tasksRequest; api.task = taskRequest; api.activity = activityRequest; api.reviews = reviewsRequest; }
});
