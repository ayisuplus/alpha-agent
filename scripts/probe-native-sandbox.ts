import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifySandbox } from "../src/runtime/sandbox-exec";

const root = await mkdtemp(join(tmpdir(), "alpha-native-sandbox-"));
const project = join(root, "project");
const dataRoot = join(root, "data");
await Promise.all([mkdir(project), mkdir(dataRoot)]);
try {
  await verifySandbox({ cwd: project, roots: [project], dataRoot, signal: new AbortController().signal });
  console.log(JSON.stringify({ ok: true, project: resolve(project), probes: ["inside write", "outside write denied", "credential read denied", "network denied", "child process denied"] }));
} finally {
  if (!resolve(root).startsWith(resolve(tmpdir()) + "\\alpha-native-sandbox-")) throw new Error("Probe cleanup path is invalid");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.error("Probe temporary directory could not be removed:", error));
}
