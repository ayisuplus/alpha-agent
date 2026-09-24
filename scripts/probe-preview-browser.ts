import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishLocalPreview } from "../src/runtime/local-preview";
import { fingerprintSource } from "../src/runtime/task-ledger";

const root = await mkdtemp(join(tmpdir(), "alpha-preview-browser-"));
let stop: (() => void) | undefined;
try {
  const projectRoot = join(root, "product");
  const buildDir = join(projectRoot, "dist");
  await mkdir(buildDir, { recursive: true });
  await writeFile(join(projectRoot, "source.txt"), "revision-1");
  await writeFile(join(buildDir, "index.html"), "<title>alpha-preview-probe</title><button id='increment'>Increment</button><strong id='count'>0</strong><script>let n=0;document.getElementById('increment').onclick=()=>{document.getElementById('count').textContent=String(++n)}</script>");
  const revision = await fingerprintSource(projectRoot);
  const instance = await publishLocalPreview({ projectRoot, buildDir, dataRoot: join(root, "alpha-data"), revision });
  stop = instance.stop;
  process.env.ALPHA_PREVIEW_URL = instance.record.url;
  await import("./probe-browser");
  console.log(JSON.stringify({ previewId: instance.record.id, revision, browserVerified: true }));
} finally {
  stop?.();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
