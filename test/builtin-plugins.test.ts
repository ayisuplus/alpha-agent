import { expect, test } from "bun:test";
import { ComfyClient } from "../src/runtime/comfy-client";
import { comfyPlugin, createComfyPlugin, createComfyStatusTool } from "../src/plugins/comfyui";
import { builtinPlugins, loadBuiltinPlugins } from "../src/plugins";

const context = { projectRoot: "C:/alpha-product", dataRoot: "C:/alpha-data" };

test("ComfyUI is one built-in plugin with an independently switchable tool set", () => {
  expect(comfyPlugin).toMatchObject({ id: "comfyui", source: "builtin" });
  expect(builtinPlugins.map(plugin => plugin.id)).toEqual(["comfyui"]);
  const enabled = createComfyPlugin(context);
  expect(enabled.tools.map(tool => tool.name)).toEqual(["alpha_comfy_status", "alpha_generate_image", "alpha_generate_voice", "alpha_generate_video"]);
  expect(enabled.instructions.join("\n")).toContain("alpha_generate_image");

  const disabled = createComfyPlugin({ ...context, enabled: false });
  expect(disabled).toEqual({ tools: [], instructions: [] });
  expect(loadBuiltinPlugins({ ...context, enabled: { comfyui: false } })).toEqual(disabled);

  const imageOff = createComfyPlugin({ ...context, generation: { image: false, voice: true, video: true } });
  expect(imageOff.tools.map(tool => tool.name)).toEqual(["alpha_comfy_status", "alpha_generate_voice"]);
  expect(imageOff.instructions.join("\n")).not.toContain("call alpha_generate_image");
});

test("ComfyUI status tool reports the actual service state", async () => {
  const client = new ComfyClient("http://127.0.0.1:8188", async () => Response.json({ devices: [] }));
  const tool = createComfyStatusTool(client);
  const result = await tool.execute("status-test", {}, undefined, {} as never);
  expect(result.isError).toBeUndefined();
  expect(result.content).toEqual([{ type: "text", text: '{"online":true}' }]);
});
