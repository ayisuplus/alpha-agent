import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent";

export type ToolCallEvent = { toolName: string; input: unknown };
export type ToolCallResult = { block?: boolean; reason?: string } | void;

/** Runs a guard's `tool_call` handler the way OMP would, so a test can assert the block decision per call. */
export function toolCallHandler(guard: PreparedExtension): (event: ToolCallEvent) => Promise<ToolCallResult> {
  let captured: ((event: ToolCallEvent) => Promise<ToolCallResult>) | undefined;
  const factory = guard.factory;
  if (!factory) throw new Error("file tool guard factory did not load");
  factory({ on: (name: string, handler: typeof captured) => { if (name === "tool_call") captured = handler; } } as never);
  if (!captured) throw new Error("tool_call hook did not load");
  return captured;
}
