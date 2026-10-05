import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { ComfyClient } from "./comfy-client";
import { ensureGeneratedAsset, ensureMediaPreview, isLegacyMediaAsset, mediaToolResult, publishMedia, recordMediaEntry, type MediaArtifact } from "./media-integrity";
import { warnUnknownStoreVersion } from "./store-tag";

const parameters = type({ prompt: "string", "aspect?": "'square' | 'landscape'", "outputPath?": "string" });
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type Job = { promptId: string; projectRoot: string; prompt: string; seed: number; presetSha256: string; workflow: string; state: "prepared" | "accepted" | "unknown" | "completed" | "failed"; asset?: string; preview?: string; imageSha256?: string; error?: string };
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function generateImageAsset(projectRoot: string, dataRoot: string, presetPath: string, prompt: string, client = new ComfyClient(), signal?: AbortSignal, aspect: "square" | "landscape" = "square", outputPath?: string): Promise<Job> {
  if (!prompt.trim() || prompt.length > 2000) throw new Error("Image prompt must contain 1-2000 characters");
  if (!await client.health()) throw new Error("Local ComfyUI is unavailable; no image job was submitted");
  const presetBytes = await readFile(presetPath);
  const graph = JSON.parse(presetBytes.toString("utf8")) as Graph;
  if (graph["19"]?.class_type !== "CLIPTextEncode" || graph["18"]?.class_type !== "KSampler" || graph["28"]?.class_type !== "EasySizeSimpleSetting" || graph["31"]?.class_type !== "SaveImage") throw new Error("Image preset has changed unexpectedly");
  if (aspect !== "square" && aspect !== "landscape") throw new Error("Unsupported image aspect");
  const key = sha(`${resolve(projectRoot)}\n${sha(presetBytes)}\n${aspect}\n${prompt.trim()}\n${outputPath?.trim() ?? ""}`);
  const jobsDir = join(dataRoot, "comfy-jobs");
  const recordPath = join(jobsDir, `${key}.json`);
  await mkdir(jobsDir, { recursive: true });
  const fresh = (): Job => ({ promptId: randomUUID(), projectRoot: resolve(projectRoot), prompt: prompt.trim(), seed: Math.floor(Math.random() * 2 ** 48), presetSha256: sha(presetBytes), workflow: join(jobsDir, `${key}.workflow.json`), state: "prepared" });
  let job: Job;
  try {
    const handle = await open(recordPath, "wx");
    job = fresh();
    // .alpha/comfy-jobs/<key>.json (comfy-jobs store): v1 = Job plus its format tag; a version bump must migrate at the record read below.
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
  if (job.projectRoot !== resolve(projectRoot)) throw new Error("Image job belongs to another project");
  const download = async () => {
    const output = (await client.imageOutputs(job.promptId)).find(item => item.nodeId === "31");
    if (!output) throw new Error(`ComfyUI job ${job.promptId} has no saved image`);
    const bytes = await client.imageBytes(job.promptId, output);
    if (bytes.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) throw new Error("ComfyUI returned a non-PNG image");
    return bytes;
  };
  if (job.state === "completed") {
    if (!job.asset || !job.imageSha256) throw new Error("Completed image job has incomplete asset provenance");
    const target = resolve(projectRoot, job.asset);
    await ensureGeneratedAsset(target, job.imageSha256, download);
    job.preview = await ensureMediaPreview(projectRoot, target, "png");
    return job;
  }
  if (job.state === "failed") throw new Error(job.error ?? "Previous image job failed");
  if (job.state === "prepared") {
    // A previous process may have submitted before dying; reconcile before any POST.
    const observed = await client.jobState(job.promptId).catch(() => "absent" as const);
    if (observed === "absent") {
      await client.assertIdle();
      graph["19"].inputs.text = job.prompt;
      graph["18"].inputs.seed = job.seed;
      graph["28"].inputs.FLUX = aspect === "landscape" ? "1280×720 (16:9)" : "1024×1024 (1:1)";
      graph["31"].inputs.filename_prefix = `Alpha/${key.slice(0, 12)}`;
      // .alpha/comfy-jobs/<key>.workflow.json (comfy-jobs store): v1 archives the submitted graph with its tag; a bump must strip the tag before any replay, and the POST body stays untagged.
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
    if (signal?.aborted) throw new Error(`Image job ${job.promptId} remains on ComfyUI; Alpha stopped waiting`);
    const state = await client.jobState(job.promptId);
    if (state === "failed") {
      job.state = "failed";
      job.error = `ComfyUI job failed: ${job.promptId}`;
      await save();
      throw new Error(job.error);
    }
    if (state === "completed") {
      const bytes = await download();
      const artifact = await publishMedia({ projectRoot: job.projectRoot, outputPath, name: job.prompt, kind: "png", bytes });
      job.asset = artifact.path;
      job.preview = artifact.preview;
      job.imageSha256 = artifact.sha256;
      job.state = "completed";
      await save();
      return job;
    }
    if (state === "absent" && job.state === "unknown") throw new Error(`ComfyUI did not confirm image job ${job.promptId}; Alpha will not resubmit it`);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(new Error(`Image job ${job.promptId} remains on ComfyUI; Alpha stopped waiting`)); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 2000);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error(`Image job ${job.promptId} is still running; Alpha can resume tracking it`);
}

export function createImageTool(projectRoot: string, dataRoot: string, presetPath: string, comfyUrl?: string): ToolDefinition<typeof parameters> {
  return {
    name: "alpha_generate_image",
    label: "Generate local product image",
    description: "Generate an original PNG with the user's local ComfyUI using Alpha's validated Flux2 preset. Use aspect=landscape for a 16:9 video reference or wide product visual; the default is square. The result is saved under outputs/media/ (or at the outputPath you pass) and returned as { summary, artifacts } with its sha256 and a thumbnail. Do not retry an uncertain job with a changed prompt merely to force submission.",
    parameters,
    loadMode: "essential",
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      try {
        const job = await generateImageAsset(projectRoot, dataRoot, presetPath, args.prompt, new ComfyClient(comfyUrl), signal, args.aspect ?? "square", args.outputPath);
        if (!job.asset || !job.imageSha256) throw new Error("Completed image job has incomplete asset provenance");
        const artifact: MediaArtifact = { path: job.asset, kind: "png", sha256: job.imageSha256, ...(job.preview ? { preview: job.preview } : {}) };
        const summary = `Generated image at ${artifact.path}.`;
        recordMediaEntry(ctx, { tool: "alpha_generate_image", input: { prompt: args.prompt, aspect: args.aspect ?? "square" }, artifacts: [artifact] });
        return await mediaToolResult(projectRoot, summary, artifact);
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
