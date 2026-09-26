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
  await writeFile(join(buildDir, "index.html"), `<title>alpha-preview-probe</title>
<button id="increment">Increment</button><strong id="count">0</strong>
<input id="query"><strong id="submitted"></strong>
<input id="upload" type="file"><strong id="uploaded"></strong>
<a id="download" href="data:text/plain,download-content" download="probe.txt">Download</a>
<div id="shadow-host"></div><iframe srcdoc="<button id='frame-button' onclick='this.textContent=&quot;Frame clicked&quot;'>Frame</button>"></iframe>
<script>
let n = 0;
document.getElementById('increment').onclick = () => { document.getElementById('count').textContent = String(++n); };
document.getElementById('query').onkeydown = event => { if (event.key === 'Enter') document.getElementById('submitted').textContent = event.target.value; };
document.getElementById('upload').onchange = event => { document.getElementById('uploaded').textContent = event.target.files[0]?.name || ''; };
const shadow = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
const button = document.createElement('button'); button.id = 'shadow-button'; button.textContent = 'Shadow'; button.onclick = () => button.textContent = 'Shadow clicked'; shadow.append(button);
</script>`);
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
