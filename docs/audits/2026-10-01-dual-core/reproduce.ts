/** Read-only diagnostic probes for the audited HEAD. Prints observations, not acceptance results. */
import { resolve } from "node:path";
import { RpcProcess } from "../../../src/native/rpc-process";
import { buildLaunchEnv } from "../../../src/native/launch";
import { applyEvent, buildFrame, emptyState, type TianshuEvent } from "../../../src/native/tianshu/state";
import { classifyVerificationFamilies, isGitMutationCommand } from "../../../src/native/tianshu/change-class";

const root = resolve(import.meta.dir, "../../..");
const tool = (toolName: string, isError: boolean, path?: string, command?: string): TianshuEvent => ({
  type: "tool-result", at: 1, toolName, toolCallId: "probe", isError, path, command,
  errorDigest: isError ? "same-error" : undefined,
});
function fold(events: TianshuEvent[]) {
  return events.reduce((state, event) => applyEvent(state, event).state, emptyState());
}
const passedThenFailed = fold([
  tool("write", false, "src/a.ts"), tool("bash", false, undefined, "bun test"),
  tool("bash", true, undefined, "bun test"), { type: "assistant-message", at: 1, text: "测试全绿。" },
]);
const oldClaim = fold([
  tool("write", false, "src/a.ts"), tool("bash", false, undefined, "bun test"),
  { type: "assistant-message", at: 1, text: "测试全绿。" }, tool("write", false, "src/b.ts"),
]);
const failureLoop = fold([
  tool("bash", true, undefined, "bun test"), tool("read", false, "src/a.ts"),
  tool("bash", true, undefined, "bun test"),
]);
const env = buildLaunchEnv({
  appRoot: root, cwd: root, sessionDir: root, sessionId: "probe", dataRoot: root, mode: "rpc",
}, { HTTPS_PROXY: "http://127.0.0.1:9999", NO_PROXY: "localhost,127.0.0.1", OMP_PROFILE: "probe" });
console.log(JSON.stringify({
  passedThenFailed: { issues: passedThenFailed.claimIssues, unverifiedMutation: buildFrame(passedThenFailed).facts.unverifiedMutation },
  oldClaimAfterNewWrite: { issues: oldClaim.claimIssues },
  failedReadFailed: { failureCount: failureLoop.failure?.count },
  echoIsVerification: classifyVerificationFamilies("echo bun test"),
  gitMutation: { resetHard: isGitMutationCommand("git reset --hard HEAD"), commitOnly: isGitMutationCommand("git commit -m probe") },
  launchEnv: { proxyPreserved: "HTTPS_PROXY" in env, bypassPreserved: "NO_PROXY" in env, profilePreserved: "OMP_PROFILE" in env },
}, null, 2));

// Exact native local-builtin response contract; no model, user config, filesystem writes or services.
const worker = `import {createInterface} from 'node:readline';
console.log(JSON.stringify({type:'ready'}));
for await (const line of createInterface({input:process.stdin})) {
  const command=JSON.parse(line);
  console.log(JSON.stringify({type:'response',id:command.id,command:command.type,success:true,data:{agentInvoked:false}}));
}`;
const rpc = new RpcProcess({ cwd: root, argv: ["-e", worker], env: {} });
try {
  await rpc.ready;
  await rpc.command({ type: "prompt", message: "/tools" });
  const pendingAfterLocalCommand = rpc.hasPendingWork;
  const receipt = await rpc.startPrompt("/tools");
  let completionSettled = false;
  void receipt.completion.then(() => { completionSettled = true; }, () => undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(JSON.stringify({ localBuiltin: { pendingAfterLocalCommand, completionSettledAfterResponse: completionSettled } }, null, 2));
} finally {
  await rpc.stop();
}
