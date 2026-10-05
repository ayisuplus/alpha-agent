import { randomUUID } from "node:crypto";

export type JobState = "absent" | "queued" | "running" | "completed" | "failed";

export interface SubmittedJob {
  promptId: string;
  state: "accepted" | "unknown";
}

export interface ImageOutput {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: "output";
}

export type AudioOutput = ImageOutput;
export type VideoOutput = ImageOutput;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class ComfyClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:8188", private readonly fetcher: Fetcher = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("ComfyUI must be on loopback");
    this.baseUrl = url.origin;
  }

  async health(): Promise<boolean> {
    const response = await this.fetcher(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    return response?.ok === true;
  }

  async assertIdle(): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/queue`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`ComfyUI queue query failed: HTTP ${response.status}`);
    const queue = await response.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
    if ((queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0) > 0) throw new Error("Local ComfyUI is busy; Alpha did not submit a new media job");
  }

  async uploadImage(bytes: Uint8Array, filename: string): Promise<string> {
    if (bytes.length < 8 || bytes.length > 64 * 1024 * 1024 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) throw new Error("Reference must be a PNG under 64 MiB");
    if (!/^alpha-[0-9a-f]{64}\.png$/.test(filename)) throw new Error("Invalid Alpha reference filename");
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename);
    form.append("type", "input");
    form.append("subfolder", "Alpha");
    form.append("overwrite", "true");
    const response = await this.fetcher(`${this.baseUrl}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`ComfyUI image upload failed: HTTP ${response.status}`);
    const result = await response.json() as { name?: unknown; subfolder?: unknown; type?: unknown };
    if (result.name !== filename || result.subfolder !== "Alpha" || result.type !== "input") throw new Error("ComfyUI returned an unexpected upload location");
    return `Alpha/${filename}`;
  }

  async submit(graph: Record<string, unknown>, promptId: string = randomUUID()): Promise<SubmittedJob> {
    if (Object.keys(graph).length === 0) throw new Error("A configured ComfyUI API workflow is required");
    try {
      const response = await this.fetcher(`${this.baseUrl}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: "alpha-agent", prompt_id: promptId }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json() as { prompt_id?: string; error?: string };
      if (!response.ok) throw new Error(`ComfyUI rejected workflow: ${data.error ?? response.status}`);
      if (data.prompt_id !== promptId) throw new Error("ComfyUI returned a mismatched prompt ID");
      return { promptId, state: "accepted" };
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("ComfyUI rejected workflow") || error.message.startsWith("ComfyUI returned a mismatched prompt ID"))) throw error;
      const observed = await this.jobState(promptId).catch(() => "absent" as JobState);
      return { promptId, state: observed === "absent" ? "unknown" : "accepted" };
    }
  }

  async jobState(promptId: string): Promise<JobState> {
    const historyResponse = await this.fetcher(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(5_000) });
    if (!historyResponse.ok) throw new Error(`ComfyUI history query failed: HTTP ${historyResponse.status}`);
    const history = await historyResponse.json() as Record<string, { status?: { status_str?: string; completed?: boolean } }>;
    const item = history[promptId];
    if (item) return item.status?.status_str === "error" ? "failed" : "completed";

    const queueResponse = await this.fetcher(`${this.baseUrl}/queue`, { signal: AbortSignal.timeout(5_000) });
    if (!queueResponse.ok) throw new Error(`ComfyUI queue query failed: HTTP ${queueResponse.status}`);
    const queue = await queueResponse.json() as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    if (queue.queue_running?.some(row => row[1] === promptId)) return "running";
    if (queue.queue_pending?.some(row => row[1] === promptId)) return "queued";
    return "absent";
  }

  async history(promptId: string): Promise<unknown | null> {
    const response = await this.fetcher(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`ComfyUI history query failed: HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    return data[promptId] ?? null;
  }

  async imageOutputs(promptId: string): Promise<ImageOutput[]> {
    return this.mediaOutputs(promptId, "images");
  }

  async audioOutputs(promptId: string): Promise<AudioOutput[]> {
    return this.mediaOutputs(promptId, "audio");
  }

  async videoOutputs(promptId: string): Promise<VideoOutput[]> {
    return this.mediaOutputs(promptId, "gifs");
  }

  private async mediaOutputs(promptId: string, kind: "images" | "audio" | "gifs"): Promise<ImageOutput[]> {
    const entry = await this.history(promptId) as { status?: { status_str?: string }; outputs?: Record<string, { images?: unknown; audio?: unknown; gifs?: unknown }> } | null;
    if (entry?.status?.status_str === "error") throw new Error(`ComfyUI job failed: ${promptId}`);
    const items: ImageOutput[] = [];
    for (const [nodeId, output] of Object.entries(entry?.outputs ?? {})) {
      if (!Array.isArray(output[kind])) continue;
      for (const item of output[kind]) {
        if (!item || typeof item !== "object") continue;
        const value = item as { filename?: unknown; subfolder?: unknown; type?: unknown };
        if (value.type !== "output" || typeof value.filename !== "string" || !value.filename || value.filename === "." || value.filename === ".." || /[\\/:]/.test(value.filename)) continue;
        const subfolder = typeof value.subfolder === "string" ? value.subfolder : "";
        if (subfolder.includes(":") || (subfolder && subfolder.split(/[\\/]/).some(part => !part || part === ".." || part === "."))) continue;
        items.push({ nodeId, filename: value.filename, subfolder, type: "output" });
      }
    }
    return items;
  }

  async imageBytes(promptId: string, output: ImageOutput): Promise<Uint8Array> {
    return this.mediaBytes(promptId, output, "image");
  }

  async audioBytes(promptId: string, output: AudioOutput): Promise<Uint8Array> {
    return this.mediaBytes(promptId, output, "audio");
  }

  async videoBytes(promptId: string, output: VideoOutput): Promise<Uint8Array> {
    return this.mediaBytes(promptId, output, "video");
  }

  private async mediaBytes(promptId: string, output: ImageOutput, kind: "image" | "audio" | "video"): Promise<Uint8Array> {
    const outputs = kind === "image" ? await this.imageOutputs(promptId) : kind === "audio" ? await this.audioOutputs(promptId) : await this.videoOutputs(promptId);
    if (!outputs.some(item => item.nodeId === output.nodeId && item.filename === output.filename && item.subfolder === output.subfolder && item.type === output.type)) {
      throw new Error(`${kind[0].toUpperCase()}${kind.slice(1)} output does not belong to the ComfyUI job`);
    }
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: "output" });
    const response = await this.fetcher(`${this.baseUrl}/view?${query}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.headers.get("content-type")?.startsWith(`${kind}/`)) throw new Error(`ComfyUI ${kind} fetch failed: HTTP ${response.status}`);
    const limitMiB = kind === "image" ? 64 : kind === "audio" ? 128 : 512;
    const limit = limitMiB * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) throw new Error(`ComfyUI ${kind} exceeds ${limitMiB} MiB`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error(`ComfyUI ${kind} exceeds ${limitMiB} MiB`);
    return bytes;
  }
}
