import { expect, test } from "bun:test";
import { api } from "../desktop/ui/src/api/client";
import type { TaskList, TaskView } from "../desktop/ui/src/api/types";
import { refreshTasks, resumeTask, store, syncSelected } from "../desktop/ui/src/state/workbench";

test("older task-list responses cannot revive a finished operation", async () => {
  const original = api.tasks;
  const pending: Array<(value: TaskList) => void> = [];
  api.tasks = () => new Promise(resolve => pending.push(resolve));
  try {
    store.set({ selectedId: null, starting: null, activeTaskId: null, activeRunId: null, serverOperation: null });
    const old = refreshTasks();
    const latest = refreshTasks();
    pending[1]({ tasks: [], activeTaskId: null, activeRunId: null, operation: null });
    await latest;
    pending[0]({ tasks: [], activeTaskId: "task-old", activeRunId: "run-old", operation: null });
    await old;
    expect(store.get().activeRunId).toBeNull();
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
  api.tasks = async () => ({ tasks: [], activeTaskId: "task-a", activeRunId: "run-a", operation: null });
  api.activity = async () => [];
  api.reviews = async () => [];
  try {
    store.set({ selectedId: "task-b", task: { id: "task-b", status: "active" } as TaskView, pending: null });
    expect(await resumeTask("approved", "task-a")).toBe(true);
    expect(String(resumed)).toBe("task-a");
    expect(store.get().selectedId).toBe("task-b");
  } finally { api.task = taskRequest; api.resume = resumeRequest; api.tasks = tasksRequest; api.activity = activityRequest; api.reviews = reviewsRequest; }
});
