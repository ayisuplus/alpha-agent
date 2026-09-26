import { MCPPermissionStore } from "../../src/runtime/mcp-permissions";

const [root, taskId] = process.argv.slice(2);
await new MCPPermissionStore(root).begin(taskId, "mcp__alpha_sample_echo__send", "request", { taskId });
