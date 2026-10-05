import { createInterface } from "node:readline";
const emit = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
emit({ type: "ready" });
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "bash") {
    setTimeout(() => emit({ type: "response", id: command.id, success: true, data: {} }), 80);
  } else {
    emit({ type: "response", id: command.id, success: true, data: {} });
    if (command.type === "prompt") {
      setTimeout(() => emit({ type: "prompt_result", id: "unrelated", status: "completed", sessionSettled: true }), 10);
      setTimeout(() => emit({ type: "prompt_result", id: command.id, status: "error", error: { message: "model failed" }, sessionSettled: false }), 30);
      setTimeout(() => emit({ type: "session_settled" }), 90);
    }
  }
});
