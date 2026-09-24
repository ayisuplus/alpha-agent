import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface MediaJob {
  projectRoot?: string;
  promptId?: string;
  state?: string;
  asset?: string;
  candidateAsset?: string;
  imageSha256?: string;
  audioSha256?: string;
  videoSha256?: string;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function ensureGeneratedAsset(path: string, expectedSha256: string, obtain: () => Promise<Uint8Array>): Promise<void> {
  const existing = await readFile(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing && sha(existing) === expectedSha256) {
    await chmod(path, 0o444);
    return;
  }
  const bytes = await obtain();
  if (sha(bytes) !== expectedSha256) throw new Error("ComfyUI output does not match the recorded generated asset hash");
  await mkdir(dirname(path), { recursive: true });
  await chmod(path, 0o666).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await writeFile(path, bytes);
  await chmod(path, 0o444);
}

export async function assertGeneratedAssetsIntact(projectRoot: string, dataRoot: string): Promise<void> {
  const jobsDir = join(dataRoot, "comfy-jobs");
  const entries = await readdir(jobsDir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of entries.filter(name => name.endsWith(".json") && !name.endsWith(".workflow.json"))) {
    const job = JSON.parse(await readFile(join(jobsDir, name), "utf8")) as MediaJob;
    if (job.projectRoot !== resolve(projectRoot) || job.state !== "completed") continue;
    const asset = job.asset ?? job.candidateAsset;
    const expected = job.imageSha256 ?? job.audioSha256 ?? job.videoSha256;
    if (!asset || !/^\/alpha-assets\/[0-9a-f]{64}\.(png|flac|mp4)$/.test(asset) || !expected) throw new Error(`Generated media job ${job.promptId ?? name} has incomplete provenance`);
    const bytes = await readFile(join(projectRoot, "public", asset.slice(1))).catch(() => null);
    const actual = bytes ? sha(bytes) : null;
    if (actual !== expected) throw new Error(`Generated media asset changed after ComfyUI job ${job.promptId ?? name}: ${asset}`);
  }
}
