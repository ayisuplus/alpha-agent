import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ActivityKind = "status" | "tool" | "text" | "error" | "guidance";

export interface ActivityEntry {
  id: string;
  taskId: string;
  operationId: string | null;
  kind: ActivityKind;
  value: string;
  recordedAt: string;
  contractVersion: number;
  revision: string | null;
  previewId: string | null;
  callId?: string;
  target?: string;
  intent?: string;
  error?: boolean;
}

export type ActivityInput = Omit<ActivityEntry, "id" | "taskId" | "recordedAt">;

export class TaskActivity {
  private pending: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(dataRoot: string, readonly taskId: string) {
    this.file = join(dataRoot, "activity", `${taskId}.jsonl`);
  }

  create(input: ActivityInput): ActivityEntry {
    return { ...input, id: randomUUID(), taskId: this.taskId, recordedAt: new Date().toISOString() };
  }

  write(entry: ActivityEntry): Promise<void> {
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`);
    });
    return this.pending;
  }

  append(input: ActivityInput): Promise<void> {
    return this.write(this.create(input));
  }

  async read(): Promise<ActivityEntry[]> {
    await this.pending;
    const contents = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = contents.split("\n").filter(Boolean);
    return lines.flatMap(line => {
      try { return [JSON.parse(line) as ActivityEntry]; }
      catch { return []; }
    });
  }
}
