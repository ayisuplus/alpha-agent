import { expect, test } from "bun:test";
import { ComfyClient } from "../src/runtime/comfy-client";
import { generateImageAsset } from "../src/runtime/image-tool";
import { generateVoiceAsset } from "../src/runtime/voice-tool";
import { generateVideoCandidate } from "../src/runtime/video-tool";
import { assertGeneratedAssetsIntact } from "../src/runtime/media-integrity";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lost submit response is reconciled without submitting the workflow twice", async () => {
  const promptId = crypto.randomUUID();
  let submissions = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/prompt" && request.method === "POST") {
        submissions++;
        return Response.json({ prompt_id: promptId });
      }
      if (url.pathname === `/history/${promptId}`) return Response.json({});
      if (url.pathname === "/queue") return Response.json({ queue_running: [], queue_pending: [[1, promptId, {}]] });
      return new Response("missing", { status: 404 });
    },
  });
  try {
    const fetcher = async (input: string, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (init?.method === "POST") throw new Error("connection dropped after submit");
      return response;
    };
    const client = new ComfyClient(`http://127.0.0.1:${server.port}`, fetcher);
    expect(await client.submit({ "1": { class_type: "Test", inputs: {} } }, promptId)).toEqual({ promptId, state: "accepted" });
    expect(submissions).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("only image outputs belonging to the requested job can be fetched", async () => {
  const promptId = crypto.randomUUID();
  let views = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/history/${promptId}`) return Response.json({ [promptId]: { status: { status_str: "success" }, outputs: {
        "42": { images: [
          { filename: "sample 1.png", subfolder: "alpha/task", type: "output" },
          { filename: "preview.png", subfolder: "", type: "temp" },
          { filename: "../other.png", subfolder: "", type: "output" },
          { filename: "absolute.png", subfolder: "/outside", type: "output" },
        ] },
      } } });
      if (url.pathname === "/view") {
        views++;
        if (url.searchParams.get("filename") !== "sample 1.png" || url.searchParams.get("subfolder") !== "alpha/task" || url.searchParams.get("type") !== "output") return new Response("wrong output", { status: 404 });
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
      }
      return new Response("missing", { status: 404 });
    },
  });
  try {
    const client = new ComfyClient(`http://127.0.0.1:${server.port}`);
    const outputs = await client.imageOutputs(promptId);
    expect(outputs).toEqual([{ nodeId: "42", filename: "sample 1.png", subfolder: "alpha/task", type: "output" }]);
    expect([...await client.imageBytes(promptId, outputs[0])]).toEqual([137, 80, 78, 71]);
    await expect(client.imageBytes(promptId, { ...outputs[0], filename: "other.png" })).rejects.toThrow("does not belong");
    expect(views).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("a mismatched ComfyUI prompt ID is a hard failure", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request) { return new URL(request.url).pathname === "/prompt" ? Response.json({ prompt_id: crypto.randomUUID() }) : Response.json({}); },
  });
  try {
    const client = new ComfyClient(`http://127.0.0.1:${server.port}`);
    await expect(client.submit({ "1": { class_type: "Test", inputs: {} } }, crypto.randomUUID())).rejects.toThrow("mismatched prompt ID");
  } finally {
    server.stop(true);
  }
});

test("Alpha does not enqueue media while another local ComfyUI job owns the queue", async () => {
  const client = new ComfyClient("http://127.0.0.1:8188", async input => {
    if (new URL(input).pathname === "/queue") return Response.json({ queue_running: [[1, "another-job"]], queue_pending: [] });
    throw new Error("unexpected request");
  });
  await expect(client.assertIdle()).rejects.toThrow("busy");
});

test("an uncertain image submission is recorded and never posted twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-comfy-"));
  let posts = 0;
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname;
    if (path === "/system_stats") return Response.json({ devices: [] });
    if (path === "/prompt" && init?.method === "POST") { posts++; throw new Error("network lost"); }
    if (path.startsWith("/history/")) return Response.json({});
    if (path === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
    return new Response("missing", { status: 404 });
  };
  const client = new ComfyClient("http://127.0.0.1:8188", fetcher);
  const args = [join(root, "product"), join(root, "data"), join(import.meta.dir, "..", "presets", "flux2-image.api.json"), "A simple blue leaf", client] as const;
  try {
    await expect(generateImageAsset(...args)).rejects.toThrow("will not resubmit");
    await expect(generateImageAsset(...args)).rejects.toThrow("will not resubmit");
    expect(posts).toBe(1);
    // The persisted job record carries its store tag; the untagged case is covered by the build preflight test below.
    const records = (await readdir(join(root, "data", "comfy-jobs"))).filter(name => name.endsWith(".json") && !name.endsWith(".workflow.json"));
    expect(records).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, "data", "comfy-jobs", records[0]!), "utf8"))).toMatchObject({ format: "comfy-jobs", version: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio retrieval ignores temporary output and enforces job ownership", async () => {
  const promptId = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `/history/${promptId}`) return Response.json({ [promptId]: { outputs: { "1": { audio: [
      { filename: "preview.flac", subfolder: "", type: "temp" },
      { filename: "voice.flac", subfolder: "Alpha", type: "output" },
    ] } } } });
    if (url.pathname === "/view") return new Response(new Uint8Array([102, 76, 97, 67]), { headers: { "content-type": "audio/x-flac" } });
    return new Response("missing", { status: 404 });
  } });
  try {
    const client = new ComfyClient(`http://127.0.0.1:${server.port}`);
    const outputs = await client.audioOutputs(promptId);
    expect(outputs).toEqual([{ nodeId: "1", filename: "voice.flac", subfolder: "Alpha", type: "output" }]);
    expect([...await client.audioBytes(promptId, outputs[0])]).toEqual([102, 76, 97, 67]);
    await expect(client.audioBytes(promptId, { ...outputs[0], filename: "preview.flac" })).rejects.toThrow("does not belong");
  } finally { server.stop(true); }
});

test("an uncertain voice submission is not posted again", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-voice-"));
  let posts = 0;
  const client = new ComfyClient("http://127.0.0.1:8188", async (input, init) => {
    const path = new URL(input).pathname;
    if (path === "/system_stats") return Response.json({});
    if (path === "/prompt" && init?.method === "POST") { posts++; throw new Error("network lost"); }
    if (path.startsWith("/history/")) return Response.json({});
    if (path === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
    return new Response("missing", { status: 404 });
  });
  const args = [join(root, "product"), join(root, "data"), join(import.meta.dir, "..", "presets", "voxcpm2-voice.api.json"), "你好", "", client] as const;
  try {
    await expect(generateVoiceAsset(...args)).rejects.toThrow("will not resubmit");
    await expect(generateVoiceAsset(...args)).rejects.toThrow("will not resubmit");
    expect(posts).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reference upload is confined to Alpha input and checks the response", async () => {
  let uploaded = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/upload/image") return new Response("missing", { status: 404 });
    const form = await request.formData();
    const file = form.get("image") as File;
    uploaded = form.get("subfolder") === "Alpha" && form.get("type") === "input" && file.type === "image/png";
    return Response.json({ name: file.name, subfolder: "Alpha", type: "input" });
  } });
  try {
    const client = new ComfyClient(`http://127.0.0.1:${server.port}`);
    const filename = `alpha-${"a".repeat(64)}.png`;
    expect(await client.uploadImage(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), filename)).toBe(`Alpha/${filename}`);
    expect(uploaded).toBe(true);
    await expect(client.uploadImage(new Uint8Array([1, 2, 3]), filename)).rejects.toThrow("Reference must be a PNG");
  } finally { server.stop(true); }
});

test("video retrieval uses only final outputs owned by the requested job", async () => {
  const promptId = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `/history/${promptId}`) return Response.json({ [promptId]: { outputs: {
      "33": { gifs: [
        { filename: "preview.mp4", subfolder: "", type: "temp" },
        { filename: "final.mp4", subfolder: "Alpha", type: "output" },
      ] },
    } } });
    if (url.pathname === "/view") return new Response(new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0]), { headers: { "content-type": "video/mp4" } });
    return new Response("missing", { status: 404 });
  } });
  try {
    const client = new ComfyClient(`http://127.0.0.1:${server.port}`);
    const outputs = await client.videoOutputs(promptId);
    expect(outputs).toEqual([{ nodeId: "33", filename: "final.mp4", subfolder: "Alpha", type: "output" }]);
    expect([...await client.videoBytes(promptId, outputs[0])].slice(4, 8)).toEqual([102, 116, 121, 112]);
    await expect(client.videoBytes(promptId, { ...outputs[0], filename: "other.mp4" })).rejects.toThrow("does not belong");
  } finally { server.stop(true); }
});

test("video reference aspect is checked before submitting and uncertain jobs are not resubmitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-video-"));
  const project = join(root, "product");
  const assetDir = join(project, "public", "alpha-assets");
  await mkdir(assetDir, { recursive: true });
  const png = (width: number, height: number) => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(bytes.buffer).setUint32(16, width);
    new DataView(bytes.buffer).setUint32(20, height);
    return bytes;
  };
  const referenceAsset = "/alpha-assets/reference.png";
  const referencePath = join(assetDir, "reference.png");
  const presetPath = join(import.meta.dir, "..", "presets", "h3-video.api.json");
  let posts = 0;
  const client = new ComfyClient("http://127.0.0.1:8188", async (input, init) => {
    const path = new URL(input).pathname;
    if (path === "/system_stats") return Response.json({});
    if (path.startsWith("/history/")) return Response.json({});
    if (path === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
    if (path === "/upload/image") return Response.json({ name: (init?.body as FormData).get("image") instanceof File ? ((init?.body as FormData).get("image") as File).name : "", subfolder: "Alpha", type: "input" });
    if (path === "/prompt") { posts++; throw new Error("network lost"); }
    return new Response("missing", { status: 404 });
  });
  try {
    await writeFile(referencePath, png(1024, 1024));
    await expect(generateVideoCandidate(project, join(root, "data"), presetPath, referenceAsset, "Slow camera move", client)).rejects.toThrow("16:9 landscape");
    expect(posts).toBe(0);
    await writeFile(referencePath, png(1280, 720));
    await expect(generateVideoCandidate(project, join(root, "data"), presetPath, referenceAsset, "Slow camera move", client)).rejects.toThrow("will not resubmit");
    await expect(generateVideoCandidate(project, join(root, "data"), presetPath, referenceAsset, "Slow camera move", client)).rejects.toThrow("will not resubmit");
    expect(posts).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a cancelled video wait resumes the same ComfyUI job without a second submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-video-resume-"));
  const project = join(root, "product");
  const assetDir = join(project, "public", "alpha-assets");
  await mkdir(assetDir, { recursive: true });
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(png.buffer).setUint32(16, 1280);
  new DataView(png.buffer).setUint32(20, 720);
  await writeFile(join(assetDir, "reference.png"), png);
  let promptId = "";
  let posts = 0;
  let finished = false;
  const client = new ComfyClient("http://127.0.0.1:8188", async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/system_stats") return Response.json({});
    if (url.pathname === `/history/${promptId}`) return Response.json(finished ? { [promptId]: { status: { status_str: "success" }, outputs: { "33": { gifs: [{ filename: "final.mp4", subfolder: "Alpha", type: "output" }] } } } } : {});
    if (url.pathname === "/queue") return Response.json({ queue_running: posts ? [[1, promptId]] : [], queue_pending: [] });
    if (url.pathname === "/upload/image") return Response.json({ name: ((init?.body as FormData).get("image") as File).name, subfolder: "Alpha", type: "input" });
    if (url.pathname === "/prompt") { posts++; promptId = (JSON.parse(String(init?.body)) as { prompt_id: string }).prompt_id; return Response.json({ prompt_id: promptId }); }
    if (url.pathname === "/view") return new Response(new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0]), { headers: { "content-type": "video/mp4" } });
    return new Response("missing", { status: 404 });
  });
  const args = [project, join(root, "data"), join(import.meta.dir, "..", "presets", "h3-video.api.json"), "/alpha-assets/reference.png", "Subtle sunlight changes", client] as const;
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 20);
    await expect(generateVideoCandidate(...args, controller.signal)).rejects.toThrow("stopped waiting");
    expect(posts).toBe(1);
    finished = true;
    const job = await generateVideoCandidate(...args);
    expect(job.state).toBe("completed");
    expect(job.candidateAsset).toMatch(/\.mp4$/);
    expect(posts).toBe(1);
    const assetPath = join(project, "public", job.candidateAsset!.slice(1));
    await chmod(assetPath, 0o666);
    await writeFile(assetPath, "placeholder");
    const restored = await generateVideoCandidate(...args);
    expect(restored.promptId).toBe(job.promptId);
    expect((await readFile(assetPath)).length).toBe(12);
    expect(posts).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("build preflight rejects a generated asset replaced after its ComfyUI job", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-media-integrity-"));
  const project = join(root, "product");
  const data = join(root, "data");
  const assetDir = join(project, "public", "alpha-assets");
  const jobsDir = join(data, "comfy-jobs");
  const name = `${"a".repeat(64)}.mp4`;
  await mkdir(assetDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  try {
    const bytes = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0]);
    await writeFile(join(assetDir, name), bytes);
    await writeFile(join(jobsDir, "video-test.json"), JSON.stringify({ projectRoot: project, promptId: "owned-job", state: "completed", candidateAsset: `/alpha-assets/${name}`, videoSha256: createHash("sha256").update(bytes).digest("hex") }));
    await assertGeneratedAssetsIntact(project, data);
    await writeFile(join(assetDir, name), "placeholder");
    await expect(assertGeneratedAssetsIntact(project, data)).rejects.toThrow("changed after ComfyUI job");
  } finally { await rm(root, { recursive: true, force: true }); }
});
