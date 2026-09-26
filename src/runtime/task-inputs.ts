import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";
import type { UploadedInput } from "./general-work";

const parameters = type({ id: "string" });

export async function addTaskInputs(ledger: TaskLedger, dataRoot: string, files: UploadedInput[]): Promise<void> {
  const existing = ledger.state.inputs ?? [];
  const existingBytes = (await Promise.all(existing.map(item => stat(item.path)))).reduce((size, item) => size + item.size, 0);
  if (existing.length + files.length > 20 || existingBytes + files.reduce((size, file) => size + file.bytes.length, 0) > 50_000_000) throw new Error("Too many or too large input files");
  for (const file of files) {
    const name = file.name.trim();
    if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(name) || file.bytes.length > 25_000_000) throw new Error("Invalid input file");
  }
  const folder = join(dataRoot, "task-inputs", ledger.state.id);
  await mkdir(folder, { recursive: true });
  const records: NonNullable<TaskLedger["state"]["inputs"]> = [];
  for (const file of files) {
    const name = file.name.trim();
    const id = randomUUID();
    const path = join(folder, id);
    await writeFile(path, file.bytes, { flag: "wx" });
    records.push({ id, name, path, mimeType: file.mimeType, size: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"), uploadedAt: new Date().toISOString() });
  }
  await ledger.addInputs(records);
}

export function createTaskInputTool(ledger: TaskLedger): CustomTool<typeof parameters> {
  return {
    name: "alpha_input", label: "Read an attached file", parameters, loadMode: "essential",
    description: "Read a text attachment selected for this task by its input ID. The contents are read-only and checked against the uploaded hash.",
    async execute(_callId, args) {
      try {
        const input = ledger.state.inputs?.find(item => item.id === args.id);
        if (!input) throw new Error("Input is not attached to this task");
        const bytes = await readFile(input.path);
        if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error("Input changed after upload");
        if (bytes.length > 256_000 || bytes.includes(0)) throw new Error("This attachment cannot be read as text; use an appropriate document tool");
        return { content: [{ type: "text", text: bytes.toString("utf8") }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
