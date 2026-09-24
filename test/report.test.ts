import { expect, test } from "bun:test";
import type { ActivityEntry, ReviewSummary, TaskView } from "../desktop/ui/src/api/types";
import { buildTaskReport } from "../desktop/ui/src/state/report";

test("task report keeps goals, run model, current evidence and changed paths together", () => {
  const task: TaskView = {
    id: "task-1", objective: "制作收藏页并适配手机", originalObjective: "制作收藏页", contractVersion: 2,
    status: "complete", running: false, pendingCount: 0, updatedAt: "2026-09-24T02:00:00Z", createdAt: "2026-09-24T01:00:00Z",
    revision: "rev-2", projectRoot: "E:/products/task-1", acceptsGuidance: false, pending: [],
    criteria: [{ id: "build", description: "构建", kind: "build" }],
    contractHistory: [{ version: 1, objective: "制作收藏页", revisedAt: "2026-09-24T01:20:00Z" }],
    guidanceHistory: [], runs: [{ model: "provider/model", toolCalls: 2, elapsedMs: 1000, outcome: "returned", recordedAt: "2026-09-24T01:30:02Z" }],
    latestRun: null, lastFailure: null, reopenReason: null,
    evidence: [{ id: "ev-1", criterionId: "build", passed: true, source: "build.log", recordedAt: "2026-09-24T01:40:00Z", contractVersion: 2, revision: "rev-2", previewId: null, current: true }],
    screenshotUrl: null, preview: { id: "preview-1", url: "http://127.0.0.1:5000/", live: false },
  };
  const activity: ActivityEntry[] = [
    { id: "a", operationId: "op-1", kind: "status", value: "构建中", recordedAt: "2026-09-24T01:30:00Z", contractVersion: 2, revision: "rev-2", previewId: null },
    { id: "b", operationId: "op-1", kind: "tool", value: "write · 开始", recordedAt: "2026-09-24T01:30:01Z", contractVersion: 2, revision: "rev-2", previewId: null },
    { id: "c", operationId: "op-1", kind: "status", value: "已验收", recordedAt: "2026-09-24T01:30:03Z", contractVersion: 2, revision: "rev-2", previewId: null },
  ];
  const reviews: ReviewSummary[] = [{ operationId: "op-1", contractVersion: 2, revision: "rev-2", recordedAt: "2026-09-24T01:30:04Z", paths: ["src/App.tsx"] }];
  const report = buildTaskReport(task, activity, reviews);
  for (const expected of ["v1", "v2（当前）", "provider/model", "工具调用：1 次", "产品构建：通过（当前）", "build.log", "src/App.tsx", "http://127.0.0.1:5000/（已停止）"]) {
    expect(report).toContain(expected);
  }
});
