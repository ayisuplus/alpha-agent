import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { ComfyClient } from "./comfy-client";
import { ensureGeneratedAsset, isLegacyMediaAsset, mediaToolResult, publishMedia, recordMediaEntry, type MediaArtifact } from "./media-integrity";
import { warnUnknownStoreVersion } from "./store-tag";

const parameters = type({ text: "string", "voiceDesign?": "string", "outputPath?": "string" });
type Job = { promptId: string; projectRoot: string; text: string; voiceDesign: string; seed: number; presetSha256: string; workflow: string; state: "prepared" | "accepted" | "unknown" | "completed" | "failed"; asset?: string; audioSha256?: string; error?: string };
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function generateVoiceAsset(projectRoot: string, dataRoot: string, presetPath: string, text: string, voiceDesign = "", client = new ComfyClient(), signal?: AbortSignal, outputPath?: string): Promise<Job> {
  if (!text.trim() || text.length > 500 || voiceDesign.length > 200) throw new Error("Voice text or design is out of range");
  if (!await client.health()) throw new Error("Local ComfyUI is unavailable; no voice job was submitted");
  const presetBytes = await readFile(presetPath);
  const graph = JSON.parse(presetBytes.toString("utf8")) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  if (graph["24"]?.class_type !== "VoxCPM_TTS" || graph["1"]?.class_type !== "SaveAudio") throw new Error("Voice preset has changed unexpectedly");
  const key = sha(`${resolve(projectRoot)}\n${sha(presetBytes)}\n${text.trim()}\n${voiceDesign.trim()}\n${outputPath?.trim() ?? ""}`);
  const jobsDir = join(dataRoot, "comfy-jobs");
  const recordPath = join(jobsDir, `voice-${key}.json`);
  await mkdir(jobsDir, { recursive: true });
  const fresh = (): Job => ({ promptId: randomUUID(), projectRoot: resolve(projectRoot), text: text.trim(), voiceDesign: voiceDesign.trim(), seed: Number(graph["24"].inputs.seed), presetSha256: sha(presetBytes), workflow: join(jobsDir, `voice-${key}.workflow.json`), state: "prepared" });
  let job: Job;
  try {
    const handle = await open(recordPath, "wx");
    job = fresh();
    // .alpha/comfy-jobs/voice-<key>.json (comfy-jobs store): v1 = Job plus its format tag; a version bump must migrate at the record read below.
    try { await handle.writeFile(JSON.stringify({ ...job, format: "comfy-jobs", version: 1 }, null, 2)); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    job = JSON.parse(await readFile(recordPath, "utf8")) as Job;
    warnUnknownStoreVersion("comfy-jobs", job);
    // Records from the retired public/alpha-assets era keep their key but point at the old layout;
    // they are migrated to a fresh prepared job so nothing is ever written under public/ again.
    if (isLegacyMediaAsset(job.asset)) {
      job = fresh();
      await writeFile(recordPath, JSON.stringify({ ...job, format: "comfy-jobs", version: 1 }, null, 2));
    }
  }
  const save = async () => writeFile(recordPath, JSON.stringify({ ...job, format: "comfy-jobs", version: 1 }, null, 2));
  if (!job.projectRoot) { job.projectRoot = resolve(projectRoot); await save(); }
  if (job.projectRoot !== resolve(projectRoot)) throw new Error("Voice job belongs to another project");
  const download = async () => {
    const output = (await client.audioOutputs(job.promptId)).find(item => item.nodeId === "1" && item.filename.endsWith(".flac"));
    if (!output) throw new Error(`ComfyUI job ${job.promptId} has no saved FLAC audio`);
    const bytes = await client.audioBytes(job.promptId, output);
    if (bytes.length < 4 || String.fromCharCode(...bytes.slice(0, 4)) !== "fLaC") throw new Error("ComfyUI returned a non-FLAC audio file");
    return bytes;
  };
  if (job.state === "completed") {
    if (!job.asset || !job.audioSha256) throw new Error("Completed voice job has incomplete asset provenance");
    await ensureGeneratedAsset(resolve(projectRoot, job.asset), job.audioSha256, download);
    return job;
  }
  if (job.state === "failed") throw new Error(job.error ?? "Previous voice job failed");
  if (job.state === "prepared") {
    const observed = await client.jobState(job.promptId).catch(() => "absent" as const);
    if (observed === "absent") {
      await client.assertIdle();
      graph["24"].inputs.text = job.text;
      graph["24"].inputs.voice_design = job.voiceDesign || graph["24"].inputs.voice_design;
      graph["1"].inputs.filename_prefix = `Alpha/${key.slice(0, 12)}`;
      // .alpha/comfy-jobs/voice-<key>.workflow.json (comfy-jobs store): v1 archives the submitted graph with its tag; a bump must strip the tag before any replay, and the POST body stays untagged.
      await writeFile(job.workflow, JSON.stringify({ ...graph, format: "comfy-jobs-workflow", version: 1 }, null, 2));
      job.state = "unknown";
      await save();
      let submitted;
      try { submitted = await client.submit(graph, job.promptId); }
      catch (error) {
        job.state = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        await save();
        throw error;
      }
      job.state = submitted.state === "unknown" ? "unknown" : "accepted";
      await save();
      if (job.state === "unknown") throw new Error(`ComfyUI submission is uncertain (${job.promptId}); Alpha will not resubmit this request`);
    } else {
      job.state = "accepted";
      await save();
    }
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`Voice job ${job.promptId} remains on ComfyUI; Alpha stopped waiting`);
    const state = await client.jobState(job.promptId);
    if (state === "failed") {
      job.state = "failed";
      job.error = `ComfyUI voice job failed: ${job.promptId}`;
      await save();
      throw new Error(job.error);
    }
    if (state === "completed") {
      const bytes = await download();
      const artifact = await publishMedia({ projectRoot: job.projectRoot, outputPath, name: job.text, kind: "flac", bytes });
      job.asset = artifact.path;
      job.audioSha256 = artifact.sha256;
      job.state = "completed";
      await save();
      return job;
    }
    if (state === "absent" && job.state === "unknown") throw new Error(`ComfyUI did not confirm voice job ${job.promptId}; Alpha will not resubmit it`);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(new Error(`Voice job ${job.promptId} remains on ComfyUI; Alpha stopped waiting`)); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 2000);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error(`Voice job ${job.promptId} is still running; Alpha can resume tracking it`);
}

export function createVoiceTool(projectRoot: string, dataRoot: string, presetPath: string, comfyUrl?: string): ToolDefinition<typeof parameters> {
  return {
    name: "alpha_generate_voice",
    label: "Generate local voice audio",
    description: "Generate a short spoken FLAC with the user's local VoxCPM2 workflow. Use when spoken audio is part of the product, unless the user forbids generation. The result is saved under outputs/media/ (or at the outputPath you pass) and returned as { summary, artifacts } with its sha256; do not copy or rewrite the binary with the write tool.",
    parameters,
    loadMode: "essential",
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      try {
        const job = await generateVoiceAsset(projectRoot, dataRoot, presetPath, args.text, args.voiceDesign, new ComfyClient(comfyUrl), signal, args.outputPath);
        if (!job.asset || !job.audioSha256) throw new Error("Completed voice job has incomplete asset provenance");
        const artifact: MediaArtifact = { path: job.asset, kind: "flac", sha256: job.audioSha256 };
        const summary = `Generated voice audio at ${artifact.path}; listening review is pending.`;
        recordMediaEntry(ctx, { tool: "alpha_generate_voice", input: { text: args.text, voiceDesign: args.voiceDesign }, artifacts: [artifact] });
        return await mediaToolResult(projectRoot, summary, artifact);
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
