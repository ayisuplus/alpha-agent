import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeneralWorkspace, verifyGeneralDeliverable } from "../src/runtime/general-work";
import { DEFAULT_MODEL, runTask } from "../src/runtime/omp-runner";

const root = await mkdtemp(join(tmpdir(), "alpha-general-probe-"));
const productsRoot = join(root, "products");
const dataRoot = join(root, "data");
await mkdir(productsRoot);

for (const taskType of ["file-work", "research"] as const) {
  const objective = taskType === "file-work"
    ? "Create a DOCX named probe-report with title 'Probe Report' and one paragraph 'Alpha file task works.' using alpha_document. Write alpha-deliverable.json that names the exact returned outputs path. Do not use a browser."
    : "Read https://www.iana.org/domains/reserved using alpha_source. Write a short Markdown report in outputs/research.md stating that IANA documents reserved example domains, citing the archived source ID. Write alpha-deliverable.json listing outputs/research.md with that source ID. Do not use a browser.";
  const ledger = await createGeneralWorkspace({ taskType, objective, productsRoot, dataRoot, modelSelector: DEFAULT_MODEL });
  try {
    const completed = await runTask({ projectRoot: ledger.state.projectRoot, dataRoot, objective, existingLedger: ledger, modelSelector: DEFAULT_MODEL, maxToolCalls: 30, wallTimeMs: 180_000, plugins: { comfyui: false }, onEvent: event => { if (event.type === "tool-end" || event.type === "status") console.log(JSON.stringify({ taskType, event: event.type, tool: event.value, error: event.error ?? false })); } });
    await verifyGeneralDeliverable(completed, dataRoot);
    console.log(JSON.stringify({ taskType, taskId: completed.state.id, status: completed.state.status, evidence: completed.state.evidence.map(item => ({ kind: item.kind, hash: item.contentHash, source: item.source })), runs: completed.state.runs, root }));
  } catch (error) {
    console.error(JSON.stringify({ taskType, taskId: ledger.state.id, error: error instanceof Error ? error.message : String(error), root }));
    throw error;
  }
}
