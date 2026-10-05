import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { ComfyClient, type VideoOutput } from "./comfy-client";
import { ensureGeneratedAsset, ensureMediaPreview, isLegacyMediaAsset, mediaToolResult, publishMedia, recordMediaEntry, type MediaArtifact } from "./media-integrity";
import { warnUnknownStoreVersion } from "./store-tag";

const parameters = type({ referenceAsset: "string", prompt: "string", "outputPath?": "string" });
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type Job = {
  promptId: string;
  projectRoot: string;
  referenceAsset: string;
  referenceSha256: string;
  prompt: string;
  seed: number;
  presetSha256: string;
  workflow: string;
  state: "prepared" | "accepted" | "unknown" | "completed" | "failed";
  output?: VideoOutput;
  candidateAsset?: string;
  preview?: string;
  videoSha256?: string;
  visualReview?: "pending";
  error?: string;
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function generateVideoCandidate(projectRoot: string, dataRoot: string, presetPath: string, referenceAsset: string, prompt: string, client = new ComfyClient(), signal?: AbortSignal, outputPath?: string): Promise<Job> {
  if (!prompt.trim() || prompt.length > 2000) throw new Error("Video prompt must contain 1-2000 characters");
  const requestedReference = referenceAsset.trim();
  if (!requestedReference) throw new Error("Video reference must be a PNG path returned by alpha_generate_image");
  const referenceRoot = await realpath(projectRoot);
  const referencePath = await realpath(isAbsolute(requestedReference) ? resolve(requestedReference) : resolve(projectRoot, requestedReference)).catch(() => {
    throw new Error(`Video reference not found: ${requestedReference}. Pass the exact PNG path returned by alpha_generate_image`);
  });
  if (!isAbsolute(requestedReference)) {
    const rel = relative(referenceRoot, referencePath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Video reference must stay inside the project");
  }
  const reference = await readFile(referencePath);
  if (reference.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => reference[i] === value)) throw new Error("Video reference is not a PNG. Use the exact generated PNG path, not a placeholder file.");
  const width = reference.readUInt32BE(16);
  const height = reference.readUInt32BE(20);
  if (width < 512 || height < 288 || Math.abs(width / height - 16 / 9) > 0.04) throw new Error(`Video reference must be 16:9 landscape PNG; got ${width}x${height}`);
  if (!await client.health()) throw new Error("Local ComfyUI is unavailable; no video job was submitted");
  const presetBytes = await readFile(presetPath);
  const graph = JSON.parse(presetBytes.toString("utf8")) as Graph;
  if (graph["14"]?.class_type !== "LoadImage" || graph["16"]?.class_type !== "MiniMaxH3ReferenceToVideo" || graph["33"]?.class_type !== "VHS_VideoCombine" || graph["32"]?.class_type !== "TEFlashVSRRestore" || graph["13"]?.inputs.steps !== 8 || graph["32"]?.inputs.scale !== 2) throw new Error("Video preset has changed unexpectedly");
  const presetText = presetBytes.toString("utf8");
  if (presetText.includes("api_key") || presetText.includes("api.deepseek.com")) throw new Error("Video preset contains an external prompt service");
  const key = sha(`${resolve(projectRoot)}\n${sha(presetBytes)}\n${sha(reference)}\n${prompt.trim()}\n${outputPath?.trim() ?? ""}`);
  const jobsDir = join(dataRoot, "comfy-jobs");
  const recordPath = join(jobsDir, `video-${key}.json`);
  await mkdir(jobsDir, { recursive: true });
  const fresh = (): Job => ({ promptId: randomUUID(), projectRoot: resolve(projectRoot), referenceAsset: requestedReference, referenceSha256: sha(reference), prompt: prompt.trim(), seed: Math.floor(Math.random() * 2 ** 48), presetSha256: sha(presetBytes), workflow: join(jobsDir, `video-${key}.workflow.json`), state: "prepared" });
  let job: Job;
  try {
    const handle = await open(recordPath, "wx");
    job = fresh();
    // .alpha/comfy-jobs/video-<key>.json (comfy-jobs store): v1 = Job plus its format tag; a version bump must migrate at the record read below.
    try { await handle.writeFile(JSON.stringify({ ...job, format: "comfy-jobs", version: 1 }, null, 2)); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    job = JSON.parse(await readFile(recordPath, "utf8")) as Job;
    warnUnknownStoreVersion("comfy-jobs", job);
    // Records from the retired public/alpha-assets era keep their key but point at the old layout;
    // they are migrated to a fresh prepared job so nothing is ever written under public/ again.
    if (isLegacyMediaAsset(job.candidateAsset)) {
      job = fresh();
      await writeFile(recordPath, JSON.stringify({ ...job, format: "comfy-jobs", version: 1 }, null, 2));
    }
  }
  const save = async () => writeFile(recordPath, JSON.stringify({ ...job, format: "comfy-jobs", version: 1 }, null, 2));
  if (!job.projectRoot) { job.projectRoot = resolve(projectRoot); await save(); }
  if (job.projectRoot !== resolve(projectRoot)) throw new Error("Video job belongs to another project");
  const download = async () => {
    const output = job.output ?? (await client.videoOutputs(job.promptId)).find(item => item.nodeId === "33" && item.filename.endsWith(".mp4"));
    if (!output) throw new Error(`ComfyUI job ${job.promptId} has no final MP4 output`);
    const bytes = await client.videoBytes(job.promptId, output);
    if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") throw new Error("ComfyUI returned a non-MP4 video");
    return { output, bytes };
  };
  if (job.state === "completed") {
    if (!job.candidateAsset || !job.videoSha256) throw new Error("Completed video job has incomplete asset provenance");
    const target = resolve(projectRoot, job.candidateAsset);
    await ensureGeneratedAsset(target, job.videoSha256, async () => (await download()).bytes);
    job.preview = await ensureMediaPreview(projectRoot, target, "mp4");
    return job;
  }
  if (job.state === "failed") throw new Error(job.error ?? "Previous video job failed");
  if (job.state === "prepared") {
    const observed = await client.jobState(job.promptId).catch(() => "absent" as const);
    if (observed === "absent") {
      await client.assertIdle();
      const filename = `alpha-${sha(reference)}.png`;
      const uploaded = await client.uploadImage(reference, filename);
      graph["14"].inputs.image = uploaded;
      graph["16"].inputs.prompt = job.prompt;
      graph["8"].inputs.seed = job.seed;
      for (const nodeId of ["33", "44", "54", "57"]) graph[nodeId].inputs.filename_prefix = `Alpha/${key.slice(0, 12)}-${nodeId}`;
      // .alpha/comfy-jobs/video-<key>.workflow.json (comfy-jobs store): v1 archives the submitted graph with its tag; a bump must strip the tag before any replay, and the POST body stays untagged.
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
  const deadline = Date.now() + 720_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`Video job ${job.promptId} remains on ComfyUI; Alpha stopped waiting`);
    const state = await client.jobState(job.promptId);
    if (state === "failed") {
      job.state = "failed";
      job.error = `ComfyUI video job failed: ${job.promptId}`;
      await save();
      throw new Error(job.error);
    }
    if (state === "completed") {
      const { output, bytes } = await download();
      const artifact = await publishMedia({ projectRoot: job.projectRoot, outputPath, name: job.prompt, kind: "mp4", bytes });
      job.output = output;
      job.candidateAsset = artifact.path;
      job.preview = artifact.preview;
      job.videoSha256 = artifact.sha256;
      job.visualReview = "pending";
      job.state = "completed";
      await save();
      return job;
    }
    if (state === "absent" && job.state === "unknown") throw new Error(`ComfyUI did not confirm video job ${job.promptId}; Alpha will not resubmit it`);
    await new Promise<void>((resolveWait, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(new Error(`Video job ${job.promptId} remains on ComfyUI; Alpha stopped waiting`)); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolveWait(); }, 3_000);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error(`Video job ${job.promptId} is still running; Alpha can resume tracking it`);
}

export function createVideoTool(projectRoot: string, dataRoot: string, presetPath: string, comfyUrl?: string): ToolDefinition<typeof parameters> {
  return {
    name: "alpha_generate_video",
    label: "Generate local video candidate",
    description: "Generate a local H3/FlashVSR MP4 candidate from a 16:9 PNG. Pass the exact PNG path returned by alpha_generate_image; do not create a placeholder reference. This may take several minutes. The result is saved under outputs/media/ (or at the outputPath you pass) and returned as { summary, artifacts } with its sha256 and a thumbnail; it needs visual review before adoption.",
    parameters,
    loadMode: "essential",
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      try {
        const job = await generateVideoCandidate(projectRoot, dataRoot, presetPath, args.referenceAsset, args.prompt, new ComfyClient(comfyUrl), signal, args.outputPath);
        if (!job.candidateAsset || !job.videoSha256) throw new Error("Completed video job has incomplete asset provenance");
        const artifact: MediaArtifact = { path: job.candidateAsset, kind: "mp4", sha256: job.videoSha256, ...(job.preview ? { preview: job.preview } : {}) };
        const summary = `Generated video candidate at ${artifact.path}; visual review is pending before adoption.`;
        recordMediaEntry(ctx, { tool: "alpha_generate_video", input: { referenceAsset: args.referenceAsset, prompt: args.prompt }, artifacts: [artifact] });
        return await mediaToolResult(projectRoot, summary, artifact);
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
