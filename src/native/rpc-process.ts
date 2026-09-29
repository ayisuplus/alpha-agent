import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type Frame = Record<string, unknown> & { type: string; id?: string };
type Pending = { resolve(value: RpcResponse): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Chunk = { pieces: string[]; count: number };

/** One native OMP process owns one session. Alpha only transports its RPC frames. */
export class RpcProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  #pending = new Map<string, Pending>();
  #chunks = new Map<string, Chunk>();
  #sequence = 0;
  #closed = false;
  #stderr = "";

  constructor(options: { cwd: string; argv: string[]; env: Record<string, string> }) {
    super();
    this.child = spawn(process.execPath, options.argv, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.#stderr = (this.#stderr + chunk).slice(-4000); });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OMP did not become ready: ${this.#stderr}`)), 90_000);
      const onReady = (frame: Frame) => {
        if (frame.type !== "ready") return;
        clearTimeout(timer);
        this.off("frame", onReady);
        resolve();
      };
      this.on("frame", onReady);
      this.child.once("error", error => { clearTimeout(timer); reject(error); });
      this.child.once("exit", code => {
        clearTimeout(timer);
        this.#closed = true;
        const error = new Error(`OMP exited (${code}): ${this.#stderr}`);
        for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(error); this.#pending.delete(id); }
        this.emit("exit", error);
        reject(error);
      });
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      try { this.#receive(JSON.parse(line) as Frame); }
      catch (error) { this.emit("protocol_error", error); }
    });
  }

  #receive(frame: Frame): void {
    if (frame.type === "rpc_chunk") {
      const key = String(frame.chunkId);
      const count = Number(frame.count);
      const index = Number(frame.index);
      if (!Number.isInteger(count) || count < 1 || count > 4096 || !Number.isInteger(index) || index < 0 || index >= count) throw new Error("Invalid OMP chunk frame");
      const chunk = this.#chunks.get(key) ?? { pieces: Array<string>(count), count };
      chunk.pieces[index] = String(frame.data);
      this.#chunks.set(key, chunk);
      if (chunk.pieces.filter(piece => piece !== undefined).length === count) {
        this.#chunks.delete(key);
        this.#receive(JSON.parse(chunk.pieces.join("")) as Frame);
      }
      return;
    }
    if (frame.type === "response" && frame.id && this.#pending.has(frame.id)) {
      const pending = this.#pending.get(frame.id)!;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame as unknown as RpcResponse);
    }
    this.emit("frame", frame);
  }

  async command(command: RpcCommand, timeoutMs = 30_000): Promise<RpcResponse> {
    await this.ready;
    if (this.#closed) throw new Error("OMP session is closed");
    const id = `alpha-${++this.#sequence}`;
    const result = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`OMP ${command.type} timed out`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.sendFrame({ ...command, id });
    const response = await result;
    if (!response.success) throw new Error(response.error);
    return response;
  }

  sendFrame(frame: Record<string, unknown>): void {
    if (this.#closed) throw new Error("OMP session is closed");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.child.kill();
    await new Promise<void>(resolve => this.child.once("exit", () => resolve()));
  }
}
